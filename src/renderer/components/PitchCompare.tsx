// Comparaison de courbes mélodiques (F0) : référence (voix de synthèse ou extrait vidéo) vs voix de l'utilisateur.
// Utilisé par l'écran « Tons & oral » (shadowing) et par le lecteur vidéo (mode compact).
import { useCallback, useEffect, useRef, useState } from 'react';
import { call, fileUrl } from '../api';
import { playFile, stopAudio } from './common';
import { pitchTrack, toSemitones, similarity, contour, describeShape, type PitchPoint } from './pitch';

export interface PitchCompareProps {
  text: string;
  refPath?: string;
  refStart?: number;
  refEnd?: number;
  compact?: boolean;
  /** Appelé à chaque nouvel essai noté (score 0-100). */
  onScore?: (score: number) => void;
}

interface Analysed {
  track: PitchPoint[];
  duration: number;
}

let audioCtx: AudioContext | null = null;
function ac(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}

async function decode(bytes: ArrayBuffer): Promise<AudioBuffer> {
  return ac().decodeAudioData(bytes);
}

/** Charge un fichier local : fetch(file://) puis, à défaut, lecture via le processus principal. */
async function loadAudio(path: string): Promise<AudioBuffer> {
  try {
    const r = await fetch(fileUrl(path));
    if (!r.ok) throw new Error(String(r.status));
    return await decode(await r.arrayBuffer());
  } catch {
    const u8 = await call<Uint8Array>('tts:readAudio', path);
    return decode(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer);
  }
}

function mono(buf: AudioBuffer, start?: number, end?: number): Float32Array {
  const sr = buf.sampleRate;
  const a = Math.max(0, Math.floor((start ?? 0) * sr));
  const b = Math.min(buf.length, end != null ? Math.ceil(end * sr) : buf.length);
  const out = new Float32Array(Math.max(0, b - a));
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += d[a + i] / buf.numberOfChannels;
  }
  return out;
}

function analyse(x: Float32Array, sr: number): Analysed {
  return { track: pitchTrack(x, sr), duration: x.length / sr };
}

function micError(e: unknown): string {
  const name = (e as { name?: string })?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Accès au micro refusé. Autorise le micro pour Opération Mandarin (réglages du système), puis réessaie.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError')
    return 'Aucun micro détecté. Branche un micro ou un casque-micro, puis réessaie. (Tu peux quand même écouter la référence.)';
  if (name === 'NotReadableError') return 'Le micro est occupé par une autre application.';
  return `Micro indisponible : ${e instanceof Error ? e.message : String(e)}`;
}

const verdict = (s: number) => (s >= 80 ? ['Excellent', 'var(--ok)'] : s >= 62 ? ['Bien', 'var(--good)'] : s >= 42 ? ['À retravailler', 'var(--warn)'] : ['Recommence', 'var(--bad)']);

export function PitchCompare(props: PitchCompareProps) {
  const { text, refPath, refStart, refEnd, compact } = props;
  const [ref, setRef] = useState<Analysed | null>(null);
  const [refErr, setRefErr] = useState<string | null>(null);
  const [user, setUser] = useState<Analysed | null>(null);
  const [userUrl, setUserUrl] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [micErr, setMicErr] = useState<string | null>(null);
  const [score, setScore] = useState<number | null>(null);
  const [level, setLevel] = useState(0);
  const [busy, setBusy] = useState<'ref' | 'user' | null>(null);
  const playRef = useRef<() => Promise<void>>(async () => {});
  const recRef = useRef<{ stop: () => void } | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const onScore = useRef(props.onScore);
  onScore.current = props.onScore;

  // ----- chargement de la référence -----
  useEffect(() => {
    let alive = true;
    setRef(null);
    setRefErr(null);
    setUser(null);
    setScore(null);
    setUserUrl(null);
    (async () => {
      try {
        if (!refPath) {
          const r = await call<{ path: string } | null>('tts:speak', text);
          if (!r) throw new Error('Voix de synthèse indisponible (Piper non installé).');
          playRef.current = () => playFile(r.path);
          const buf = await loadAudio(r.path);
          if (alive) setRef(analyse(mono(buf), buf.sampleRate));
        } else {
          const s = refStart ?? 0;
          const e = refEnd ?? s + 5;
          const clip = await call<{ path: string } | null>('tts:clip', refPath, s, e).catch(() => null);
          if (clip) {
            playRef.current = () => playFile(clip.path);
            const buf = await loadAudio(clip.path);
            if (alive) setRef(analyse(mono(buf), buf.sampleRate));
          } else {
            playRef.current = () => playFile(refPath, 1, s, e);
            const buf = await loadAudio(refPath);
            if (alive) setRef(analyse(mono(buf, s, e), buf.sampleRate));
          }
        }
      } catch (e) {
        if (alive) setRefErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
      recRef.current?.stop();
    };
  }, [text, refPath, refStart, refEnd]);

  useEffect(() => () => {
    if (userUrl) URL.revokeObjectURL(userUrl);
  }, [userUrl]);

  const listenRef = async () => {
    setBusy('ref');
    try {
      await playRef.current();
    } finally {
      setBusy(null);
    }
  };

  // ----- enregistrement -----
  const record = useCallback(async () => {
    if (recording) {
      recRef.current?.stop();
      return;
    }
    setMicErr(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicErr('Micro non disponible sur ce système.');
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true, channelCount: 1 } });
    } catch (e) {
      setMicErr(micError(e));
      return;
    }
    stopAudio();
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(stream);
    const src = ac().createMediaStreamSource(stream);
    const an = ac().createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    let raf = 0;
    const meter = () => {
      an.getFloatTimeDomainData(buf);
      let s = 0;
      for (const v of buf) s += v * v;
      setLevel(Math.min(1, Math.sqrt(s / buf.length) * 6));
      raf = requestAnimationFrame(meter);
    };
    meter();
    const maxMs = Math.min(20000, ((ref?.duration ?? 3) + 1.5) * 1000);
    let timer = 0;
    const stop = () => {
      if (rec.state !== 'inactive') rec.stop();
    };
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      src.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      recRef.current = null;
      setRecording(false);
      setLevel(0);
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      if (!blob.size) return;
      setBusy('user');
      try {
        const ab = await decode(await blob.arrayBuffer());
        const u = analyse(mono(ab), ab.sampleRate);
        setUserUrl(URL.createObjectURL(blob));
        setUser(u);
        if (ref && u.track.some((p) => p.f0 != null)) {
          const sc = similarity(ref.track, u.track);
          setScore(sc);
          onScore.current?.(sc);
        } else setScore(null);
      } catch (e) {
        setMicErr(`Enregistrement illisible : ${e instanceof Error ? e.message : e}`);
      } finally {
        setBusy(null);
      }
    };
    recRef.current = { stop };
    rec.start();
    setRecording(true);
    timer = window.setTimeout(stop, maxMs);
  }, [recording, ref]);

  const replay = () => userUrl && playFile(userUrl);

  // ----- dessin -----
  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth || 600;
    const H = cv.clientHeight || 160;
    cv.width = W * dpr;
    cv.height = H * dpr;
    const g = cv.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const css = getComputedStyle(cv);
    const col = (v: string, d: string) => css.getPropertyValue(v).trim() || d;
    const RANGE = 9; // ± demi-tons affichés
    const pad = compact ? 4 : 8;
    const y = (st: number) => H / 2 - (Math.max(-RANGE, Math.min(RANGE, st)) / RANGE) * (H / 2 - pad);
    // grille : 0 et ±6 demi-tons
    g.strokeStyle = col('--line', '#2c3a47');
    g.lineWidth = 1;
    for (const s of [-6, 0, 6]) {
      g.setLineDash(s === 0 ? [] : [3, 4]);
      g.beginPath();
      g.moveTo(0, y(s));
      g.lineTo(W, y(s));
      g.stroke();
    }
    g.setLineDash([]);
    if (!compact) {
      g.fillStyle = col('--text-3', '#74828f');
      g.font = '11px sans-serif';
      g.fillText('aigu', 4, 12);
      g.fillText('grave', 4, H - 4);
    }
    const draw = (a: Analysed | null, color: string, width: number) => {
      if (!a) return;
      const pts = toSemitones(a.track);
      const v = pts.filter((p) => p.st != null);
      if (!v.length) return;
      const t0 = v[0].t;
      const t1 = v[v.length - 1].t;
      const span = Math.max(0.05, t1 - t0);
      g.strokeStyle = color;
      g.lineWidth = width;
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.beginPath();
      let pen = false;
      for (const p of pts) {
        if (p.t < t0 || p.t > t1) continue;
        if (p.st == null) {
          pen = false;
          continue;
        }
        const x = pad + ((p.t - t0) / span) * (W - 2 * pad);
        if (pen) g.lineTo(x, y(p.st));
        else g.moveTo(x, y(p.st));
        pen = true;
      }
      g.stroke();
    };
    draw(ref, col('--gold', '#e2b340'), compact ? 3 : 4);
    draw(user, col('--info', '#4a9eed'), compact ? 2 : 3);
  }, [ref, user, compact]);

  const [vLabel, vColor] = score != null ? verdict(score) : ['', ''];
  const hint =
    !compact && score != null && ref && user && [...text].filter((c) => /\p{Script=Han}/u.test(c)).length === 1
      ? (() => {
          const a = describeShape(contour(ref.track));
          const b = describeShape(contour(user.track));
          return a === b ? `Forme correcte : ${a}.` : `Référence : ${a} — toi : ${b}.`;
        })()
      : null;
  const noVoice = user && !user.track.some((p) => p.f0 != null);

  return (
    <div className={compact ? '' : 'card'} style={compact ? { display: 'flex', flexDirection: 'column', gap: 6 } : undefined}>
      <div className="row" style={{ gap: compact ? 6 : 10 }}>
        <button className={'btn' + (compact ? ' btn-sm' : '')} onClick={listenRef} disabled={!ref || busy === 'ref'} title="Écouter la référence">
          {busy === 'ref' ? '♪…' : '🔊'} {compact ? 'Réf.' : 'Écouter la référence'}
        </button>
        <button className={'btn ' + (recording ? 'btn-danger' : 'btn-primary') + (compact ? ' btn-sm' : '')} onClick={record} disabled={!ref && !refErr} title="Enregistrer ma voix">
          {recording ? '■ Arrêter' : '● ' + (compact ? 'Moi' : 'Enregistrer')}
        </button>
        <button className={'btn' + (compact ? ' btn-sm' : '')} onClick={replay} disabled={!userUrl || recording} title="Réécouter ma voix">
          ↺ {compact ? '' : 'Réécouter ma voix'}
        </button>
        {recording && (
          <div style={{ width: 60, height: 6, background: 'var(--bg-2)', borderRadius: 99, overflow: 'hidden', border: '1px solid var(--line)' }}>
            <div style={{ width: `${level * 100}%`, height: '100%', background: 'var(--ok)' }} />
          </div>
        )}
        <div className="spacer" />
        {score != null && !noVoice && (
          <span style={{ fontWeight: 700, color: vColor, fontVariantNumeric: 'tabular-nums' }} title="Similarité des courbes mélodiques">
            {score}/100 {!compact && <span className="small">· {vLabel}</span>}
          </span>
        )}
      </div>
      <canvas ref={canvas} style={{ width: '100%', height: compact ? 64 : 170, display: 'block', marginTop: compact ? 0 : 12, background: 'var(--bg-2)', borderRadius: 8 }} />
      <div className="row small" style={{ gap: 14, marginTop: compact ? 0 : 6 }}>
        <span style={{ color: 'var(--gold)' }}>━ référence</span>
        <span style={{ color: 'var(--info)' }}>━ ta voix</span>
        {!ref && !refErr && <span className="dim">analyse de la référence…</span>}
        {busy === 'user' && <span className="dim">analyse de ta voix…</span>}
        {hint && <span className="muted">{hint}</span>}
        {noVoice && <span className="wrong">Je n’ai pas entendu de voix : parle plus fort ou rapproche le micro.</span>}
      </div>
      {refErr && <div className="notice notice-warn small" style={{ marginTop: 6 }}>Référence indisponible : {refErr}</div>}
      {micErr && <div className="notice notice-bad small" style={{ marginTop: 6 }}>{micErr}</div>}
    </div>
  );
}
