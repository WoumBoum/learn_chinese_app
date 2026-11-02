// Shared UI building blocks. Import from '../components/common'.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { call, fileUrl } from '../api';

// ---------- audio ----------
let currentAudio: HTMLAudioElement | null = null;
let currentDone: (() => void) | null = null;

/** Réponse de `tts:speak` : voix native, Tatoeba, Matcha ou Piper (fichier local en cache). */
export interface SpokenAudio {
  path: string;
  source?: 'native' | 'tatoeba' | 'matcha' | 'piper';
  rate?: number;
}

/** Speak Chinese text (native recording when available, else local TTS; cached). Resolves when playback ends.
 *  `rate` < 1 = slow mode: the audio is slowed at playback (pitch preserved), never re-synthesized slower. */
export async function speak(text: string, rate = 1): Promise<void> {
  let r: SpokenAudio | null = null;
  try {
    r = await call<SpokenAudio | null>('tts:speak', text);
  } catch (e) {
    console.warn('[audio]', e);
  }
  if (!r) return;
  await playFile(r.path, rate);
}

export function playFile(path: string, rate = 1, start?: number, end?: number): Promise<void> {
  stopAudio();
  return new Promise((resolve) => {
    const a = new Audio(fileUrl(path));
    let finished = false;
    const stop = () => {
      if (finished) return;
      finished = true;
      if (currentAudio === a) {
        currentAudio = null;
        currentDone = null;
      }
      resolve();
    };
    currentAudio = a;
    currentDone = stop;
    a.preservesPitch = true;
    a.playbackRate = rate;
    if (start != null) a.currentTime = start;
    a.onended = stop;
    a.onerror = stop;
    if (end != null)
      a.ontimeupdate = () => {
        if (a.currentTime >= end) {
          a.pause();
          stop();
        }
      };
    a.play().catch(stop);
  });
}

/** Arrête la lecture en cours (la promesse de playFile/speak correspondante se résout). */
export function stopAudio() {
  const a = currentAudio;
  const done = currentDone;
  currentAudio = null;
  currentDone = null;
  a?.pause();
  done?.();
}

export function AudioButton({ text, rate = 1, label, autoPlay, size = 'md' }: { text: string; rate?: number; label?: string; autoPlay?: boolean; size?: 'sm' | 'md' | 'lg' }) {
  const [busy, setBusy] = useState(false);
  const play = async () => {
    setBusy(true);
    try {
      await speak(text, rate);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (autoPlay) play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, autoPlay]);
  return (
    <button className={`btn ${size === 'sm' ? 'btn-sm' : size === 'lg' ? 'btn-lg' : ''}`} onClick={play} disabled={busy} title={rate < 1 ? 'Écouter lentement' : 'Écouter'}>
      {busy ? '♪…' : '🔊'} {label}
    </button>
  );
}

// ---------- markdown (tiny subset: paragraphs, **bold**, lists, `code`, ### headings) ----------
function inline(s: string): ReactNode[] {
  const parts = s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) return <strong key={i}>{p.slice(2, -2)}</strong>;
    if (p.startsWith('`') && p.endsWith('`')) return <code key={i}>{p.slice(1, -1)}</code>;
    return <span key={i}>{p}</span>;
  });
}

export function Markdown({ text }: { text: string }) {
  const blocks = text.replace(/\r/g, '').split(/\n{2,}/);
  return (
    <div className="md">
      {blocks.map((b, i) => {
        const lines = b.split('\n');
        if (lines.every((l) => /^\s*[-*•] /.test(l)))
          return (
            <ul key={i}>
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*[-*•] /, ''))}</li>
              ))}
            </ul>
          );
        if (/^#{1,4} /.test(b)) return <h3 key={i}>{inline(b.replace(/^#+ /, ''))}</h3>;
        return (
          <p key={i}>
            {lines.map((l, j) => (
              <span key={j}>
                {inline(l)}
                {j < lines.length - 1 && <br />}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}

// ---------- modal & toast ----------
/** Number of open modals: screen shortcuts (useKeys) are suspended while a modal is open. */
let openModals = 0;
export const modalOpen = () => openModals > 0;
const modalStack: (() => void)[] = [];

export function Modal({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    openModals++;
    const close = () => closeRef.current();
    modalStack.push(close);
    const k = (e: KeyboardEvent) => {
      // only the top-most modal reacts to Escape
      if (e.key === 'Escape' && modalStack[modalStack.length - 1] === close) {
        e.stopImmediatePropagation();
        close();
      }
    };
    window.addEventListener('keydown', k, true);
    return () => {
      openModals--;
      const i = modalStack.indexOf(close);
      if (i >= 0) modalStack.splice(i, 1);
      window.removeEventListener('keydown', k, true);
    };
  }, []);
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

let toastSetter: ((s: string | null) => void) | null = null;
export function toast(msg: string) {
  toastSetter?.(msg);
  setTimeout(() => toastSetter?.(null), 3500);
}
export function ToastHost() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    toastSetter = setMsg;
    return () => {
      toastSetter = null;
    };
  }, []);
  return msg ? <div className="toast">{msg}</div> : null;
}

export function ProgressBar({ value, ok }: { value: number; ok?: boolean }) {
  return (
    <div className={'progress' + (ok ? ' ok' : '')}>
      <div style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}

export function Loading({ text = 'Chargement…' }: { text?: string }) {
  return <div className="empty">{text}</div>;
}

export function ErrorBox({ error }: { error: unknown }) {
  return <div className="notice notice-bad">Erreur : {error instanceof Error ? error.message : String(error)}</div>;
}

/** Hook: load async data with reload. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): { data: T | undefined; error: unknown; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fn()
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e) => alive && setError(e))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, loading, reload: () => setN((x) => x + 1) };
}

/** Hook: keyboard shortcuts while mounted. */
export function useKeys(map: Record<string, () => void>, deps: unknown[] = []) {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (openModals > 0) return; // a dialog is open: shortcuts of the screen behind it are suspended
      const key = e.key === ' ' ? 'Space' : e.key;
      const fn = ref.current[key];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function fmtInterval(ms: number): string {
  const m = ms / 60000;
  if (m < 60) return `${Math.max(1, Math.round(m))} min`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)} h`;
  const d = h / 24;
  if (d < 30) return `${Math.round(d)} j`;
  if (d < 365) return `${Math.round(d / 30)} mois`;
  return `${(d / 365).toFixed(1)} an`;
}
