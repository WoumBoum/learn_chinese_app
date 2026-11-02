// Mission video player: global listening pass (no subtitles), then intensive line-by-line pass
// with clickable words, optional pinyin over unknown words, hidden translation, loop, speed, shadowing.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { call, fileUrl } from '../api';
import { Markdown, Modal, toast, useKeys } from './common';
import { WordPopup } from './WordPopup';
import { PitchCompare } from './PitchCompare';
import { fmtTime } from './media';
import type { PlayerSegment, VideoInfo } from '../../shared/media';
import { lineStep, segmentAt } from '../../core/media';

const SPEEDS = [0.6, 0.75, 0.9, 1];

/** Checkbox that gives the focus back after a click, so Space / P / R… keep driving the player (useKeys ignores inputs). */
function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="row">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => {
          onChange(e.target.checked);
          e.currentTarget.blur();
        }}
      />{' '}
      {children}
    </label>
  );
}

export function Player({
  video,
  segments,
  aiOn,
  pinyinDefault,
  onSegmentsChanged,
}: {
  video: VideoInfo;
  segments: PlayerSegment[];
  aiOn: boolean;
  pinyinDefault: boolean;
  onSegmentsChanged: () => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [pass, setPass] = useState<1 | 2>(1);
  const [idx, setIdx] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [loop, setLoop] = useState(false);
  const [autoPause, setAutoPause] = useState(true);
  const [shadow, setShadow] = useState(false);
  const [showSubsP1, setShowSubsP1] = useState(false);
  const [pinyinOn, setPinyinOn] = useState(pinyinDefault);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [popup, setPopup] = useState<{ w: string; ctx: string } | null>(null);
  const [explain, setExplain] = useState<{ zh: string; md: string | null } | null>(null);
  const [pausedAtEnd, setPausedAtEndState] = useState<number | null>(null);
  const pausedRef = useRef<number | null>(null); // same as pausedAtEnd, read by the rAF loop
  const setPausedAtEnd = (i: number | null) => {
    pausedRef.current = i;
    setPausedAtEndState(i);
  };
  const [translating, setTranslating] = useState(false);
  const [mined, setMined] = useState<Set<number>>(new Set());
  const armed = useRef<number | null>(null); // line whose end triggers an automatic pause
  const loopIdx = useRef<number | null>(null);
  const idxRef = useRef(-1);
  const listRef = useRef<HTMLDivElement>(null);

  const seg = idx >= 0 ? segments[idx] : undefined;
  const lineMode = pass === 2 && (autoPause || shadow);

  // Time tracking loop (rAF while playing for precise line ends).
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const v = ref.current;
      if (v && segments.length) {
        const t = v.currentTime;
        let i: number;
        if (loop && loopIdx.current != null) {
          const s = segments[loopIdx.current];
          if (t >= s.end || t < s.start - 0.5) v.currentTime = s.start;
          i = segmentAt(segments, v.currentTime);
        } else if (lineMode && !v.paused) {
          // Contiguous cues (Whisper, split cues): the armed line keeps priority until its end → pause.
          const r = lineStep(segments, armed.current, idxRef.current, t);
          if (r.pauseAt != null) {
            v.pause();
            if (r.seekTo != null) v.currentTime = r.seekTo;
            setPausedAtEnd(r.pauseAt);
          }
          armed.current = r.armed;
          i = r.idx;
        } else if (v.paused && pausedRef.current != null) {
          // Automatic pause: the line that just ended stays current (overlapping cues: the next one already started).
          i = pausedRef.current;
        } else i = segmentAt(segments, t);
        if (i !== idxRef.current) {
          idxRef.current = i;
          setIdx(i);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [segments, loop, lineMode]);

  useEffect(() => {
    if (ref.current) ref.current.playbackRate = rate;
  }, [rate]);

  // keep the transcript list scrolled on the current line
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${idx}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [idx]);

  const playLine = useCallback(
    (i: number) => {
      const v = ref.current;
      if (!v || !segments.length) return;
      const j = Math.max(0, Math.min(segments.length - 1, i));
      v.currentTime = segments[j].start + 0.01;
      idxRef.current = j;
      setIdx(j);
      setPausedAtEnd(null);
      if (loop) loopIdx.current = j;
      armed.current = lineMode ? j : null;
      v.play().catch(() => {});
    },
    [segments, loop, lineMode],
  );

  const toggle = () => {
    const v = ref.current;
    if (!v) return;
    if (v.paused) {
      const ended = pausedRef.current;
      setPausedAtEnd(null);
      // resuming after an automatic pause: continue with the next line
      if (lineMode && ended != null && ended + 1 < segments.length) {
        playLine(ended + 1);
        return;
      }
      const i = segmentAt(segments, v.currentTime);
      if (lineMode && i >= 0 && v.currentTime >= segments[i].end - 0.02 && i + 1 < segments.length) {
        playLine(i + 1);
        return;
      }
      armed.current = lineMode && i >= 0 && v.currentTime < segments[i].end ? i : null;
      v.play().catch(() => {});
    } else v.pause();
  };

  const toggleLoop = () => {
    setLoop((l) => {
      loopIdx.current = !l ? Math.max(0, idx) : null;
      return !l;
    });
  };

  const cur = Math.max(0, idx);
  useKeys(
    {
      Space: toggle,
      r: () => playLine(cur),
      R: () => playLine(cur),
      ArrowLeft: () => playLine(cur - 1),
      ArrowRight: () => playLine(cur + 1),
      l: toggleLoop,
      L: toggleLoop,
      t: () => seg && reveal(seg.idx),
      p: () => setPinyinOn((x) => !x),
    },
    [segments, cur, loop, lineMode, seg],
  );

  const reveal = async (i: number) => {
    const s = segments.find((x) => x.idx === i);
    if (s?.fr) {
      setRevealed((r) => new Set(r).add(i));
      return;
    }
    if (!aiOn) return;
    setTranslating(true);
    try {
      await call('ai:translateLines', video.id);
      onSegmentsChanged();
      setRevealed((r) => new Set(r).add(i));
    } catch (e) {
      toast('⚠ Traduction impossible : ' + (e as Error).message);
    } finally {
      setTranslating(false);
    }
  };

  const mine = async (s: PlayerSegment) => {
    try {
      await call('study:mine', { videoId: video.id, zh: s.text, fr: s.fr ?? undefined, start: s.start, end: s.end });
      setMined((m) => new Set(m).add(s.idx));
      toast('Phrase minée : elle reviendra en carte d\'écoute');
    } catch (e) {
      toast('⚠ ' + (e as Error).message);
    }
  };

  const why = async (s: PlayerSegment) => {
    setExplain({ zh: s.text, md: null });
    const i = segments.indexOf(s);
    const context = segments
      .slice(Math.max(0, i - 2), i + 3)
      .map((x) => x.text)
      .join('\n');
    try {
      const md = await call<string>('ai:explainLine', s.text, context);
      setExplain({ zh: s.text, md });
    } catch (e) {
      setExplain({ zh: s.text, md: '⚠ ' + (e as Error).message });
    }
  };

  const showText = pass === 2 || showSubsP1;
  const hasFr = useMemo(() => segments.some((s) => s.fr), [segments]);
  const context = seg ? segments.slice(Math.max(0, idx - 1), idx + 2).map((s) => s.text).join(' ') : '';

  return (
    <div className="stack">
      <div className="row">
        <div className="mode-switch">
          <button className={pass === 1 ? 'active' : ''} onClick={() => setPass(1)}>
            Passe 1 · écoute globale
          </button>
          <button className={pass === 2 ? 'active' : ''} onClick={() => setPass(2)} disabled={!segments.length}>
            Passe 2 · phrase par phrase
          </button>
        </div>
        <span className="spacer" />
        <span className="small dim">Vitesse</span>
        {SPEEDS.map((r) => (
          <button key={r} className={'btn btn-sm' + (rate === r ? ' selected' : '')} onClick={() => setRate(r)}>
            {r}×
          </button>
        ))}
      </div>

      {pass === 1 && (
        <div className="notice small">
          Passe 1 : regarde tout sans sous-titres et sans pause. Cherche l'idée générale (qui ? où ? que se passe-t-il ?), même si tu ne comprends pas tout.
          {segments.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <Check checked={showSubsP1} onChange={setShowSubsP1}>
                Afficher quand même les sous-titres chinois
              </Check>
            </div>
          )}
        </div>
      )}

      <div style={{ background: '#000', borderRadius: 10, overflow: 'hidden', border: '1px solid var(--line)' }}>
        <video
          ref={ref}
          src={video.path ? fileUrl(video.path) : undefined}
          poster={video.audioOnly && video.thumbnail ? video.thumbnail : undefined}
          controls={pass === 1}
          style={{ width: '100%', maxHeight: video.audioOnly ? 220 : 460, display: 'block' }}
          onPlay={() => {
            setPlaying(true);
            pausedRef.current = null; // resumed from the native controls (pass 1): no longer at an automatic pause
          }}
          onPause={() => setPlaying(false)}
          onClick={pass === 2 ? toggle : undefined}
        />
      </div>

      {showText && seg && (
        <div className="card" style={{ textAlign: 'center' }}>
          <div className="small dim" style={{ marginBottom: 6 }}>
            Ligne {idx + 1}/{segments.length} · {fmtTime(seg.start)}
          </div>
          <div className="zh-line" style={{ fontSize: 32, lineHeight: pinyinOn ? 2.1 : 1.6 }}>
            {seg.tokens.map((t, k) =>
              t.han ? (
                <span
                  key={k}
                  className={'word-tok' + (t.status === 'new' ? ' new' : t.status === 'learning' ? ' learning' : '')}
                  onClick={() => {
                    ref.current?.pause();
                    setPopup({ w: t.t, ctx: seg.text });
                  }}
                >
                  {pinyinOn && t.status === 'new' && t.py ? (
                    <ruby>
                      {t.t}
                      <rt>{t.py}</rt>
                    </ruby>
                  ) : (
                    t.t
                  )}
                </span>
              ) : (
                <span key={k}>{t.t}</span>
              ),
            )}
          </div>
          <div style={{ minHeight: 30, marginTop: 8 }}>
            {revealed.has(seg.idx) && seg.fr ? (
              <div className="fr muted">{seg.fr}</div>
            ) : seg.fr || aiOn ? (
              <button className="btn btn-sm btn-ghost" disabled={translating} onClick={() => reveal(seg.idx)}>
                {translating ? 'Traduction…' : seg.fr ? 'Révéler la traduction (T)' : 'Traduire la vidéo avec l\'IA'}
              </button>
            ) : (
              <span className="small dim">Pas de traduction disponible (configure l'IA pour traduire les lignes)</span>
            )}
          </div>
          {pass === 2 && (
            <div className="row" style={{ justifyContent: 'center', marginTop: 10 }}>
              <button className="btn btn-sm" onClick={() => playLine(cur - 1)} title="Ligne précédente (←)">
                ◀
              </button>
              <button className="btn btn-sm" onClick={() => playLine(cur)} title="Rejouer la ligne (R)">
                ↻ Rejouer
              </button>
              <button className="btn btn-sm btn-primary" onClick={toggle} title="Lecture / pause (Espace)">
                {playing ? '❚❚ Pause' : '▶ Lecture'}
              </button>
              <button className="btn btn-sm" onClick={() => playLine(cur + 1)} title="Ligne suivante (→)">
                ▶▶
              </button>
              <button className={'btn btn-sm' + (loop ? ' selected' : '')} onClick={toggleLoop} title="Boucle sur la ligne (L)">
                ⟲ Boucle
              </button>
              <button className="btn btn-sm" disabled={mined.has(seg.idx)} onClick={() => mine(seg)}>
                {mined.has(seg.idx) ? '✓ Minée' : '⛏ Miner cette phrase'}
              </button>
              {aiOn && (
                <button className="btn btn-sm" onClick={() => why(seg)}>
                  Pourquoi ?
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {showText && !seg && segments.length > 0 && <div className="empty">Lance la lecture : la ligne en cours s'affichera ici.</div>}

      {pass === 2 && shadow && pausedAtEnd != null && segments[pausedAtEnd] && video.path && (
        <div className="card">
          <div className="card-title">Shadowing — répète la phrase, puis compare ta courbe de tons</div>
          <PitchCompare
            key={pausedAtEnd}
            text={segments[pausedAtEnd].text}
            refPath={video.path}
            refStart={segments[pausedAtEnd].start}
            refEnd={segments[pausedAtEnd].end}
            compact
          />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn btn-sm" onClick={() => playLine(pausedAtEnd)}>
              ↻ Réécouter
            </button>
            <button className="btn btn-sm btn-primary" onClick={() => playLine(pausedAtEnd + 1)}>
              Ligne suivante ▶
            </button>
          </div>
        </div>
      )}

      {pass === 2 && (
        <div className="row small">
          <Check checked={autoPause} onChange={setAutoPause}>
            Pause après chaque ligne
          </Check>
          <Check checked={shadow} onChange={setShadow}>
            Mode shadowing
          </Check>
          <Check checked={pinyinOn} onChange={setPinyinOn}>
            Pinyin au-dessus des mots inconnus (P)
          </Check>
          <span className="spacer" />
          <span className="dim">
            <span className="kbd">Espace</span> pause · <span className="kbd">R</span> rejouer · <span className="kbd">←</span>
            <span className="kbd">→</span> ligne · <span className="kbd">L</span> boucle{hasFr ? ' · ' : ''}
            {hasFr && <span className="kbd">T</span>}
            {hasFr && ' traduction'}
          </span>
        </div>
      )}

      {pass === 2 && segments.length > 0 && (
        <div className="card" style={{ padding: 8 }}>
          <div ref={listRef} style={{ maxHeight: 220, overflowY: 'auto' }}>
            {segments.map((s, i) => (
              <div
                key={s.idx}
                data-idx={i}
                onClick={() => playLine(i)}
                className="row hanzi"
                style={{
                  padding: '4px 8px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  flexWrap: 'nowrap',
                  background: i === idx ? 'var(--panel-2)' : undefined,
                  color: i === idx ? 'var(--text)' : 'var(--text-2)',
                }}
              >
                <span className="small dim" style={{ width: 48, fontFamily: 'var(--font)' }}>
                  {fmtTime(s.start)}
                </span>
                <span>{s.text}</span>
                {mined.has(s.idx) && <span className="small dim">⛏</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {popup && <WordPopup word={popup.w} context={popup.ctx || context} onClose={() => setPopup(null)} />}
      {explain && (
        <Modal onClose={() => setExplain(null)}>
          <div className="zh-line" style={{ marginBottom: 10 }}>
            {explain.zh}
          </div>
          {explain.md == null ? <div className="muted">L'IA analyse la phrase…</div> : <Markdown text={explain.md} />}
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            <button className="btn" onClick={() => setExplain(null)}>
              Fermer
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
