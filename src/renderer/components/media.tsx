// Shared UI pieces of the video / mission module (cards, coverage bars, progress hook).
import { useEffect, useState } from 'react';
import { call, fileUrl, listen } from '../api';
import { ProgressBar, toast } from './common';
import type { MediaProgress, VideoInfo } from '../../shared/media';

export const pct = (x: number | null | undefined, digits = 0) => (x == null ? '—' : `${(x * 100).toFixed(digits)} %`);

export function fmtDuration(sec: number | null | undefined): string {
  if (!sec) return '—';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h} h ${String(m).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

/** Timestamp in a media file (0:00 is a valid value). */
export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s % 60).padStart(2, '0')}`;
}

export function fmtDate(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, 12).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
}

export const STAGE_LABEL: Record<MediaProgress['stage'], string> = {
  meta: 'Métadonnées',
  subs: 'Sous-titres',
  download: 'Téléchargement',
  convert: 'Conversion audio',
  transcribe: 'Transcription',
  model: 'Modèle Whisper',
  export: 'Export MP3',
  scan: 'Scan',
  done: 'Terminé',
  error: 'Erreur',
};

export const MISSION_STATUS: Record<string, { label: string; cls: string }> = {
  planned: { label: 'Planifiée', cls: 'tag-info' },
  briefing: { label: 'Briefing en cours', cls: 'tag-warn' },
  ready: { label: 'Prête', cls: 'tag-ok' },
  done: { label: 'Terminée', cls: '' },
};

export const SUBS_LABEL: Record<string, string> = { cc: 'Sous-titres CC', auto: 'Sous-titres auto', whisper: 'Transcription Whisper' };

/** Live progress of background jobs (download, transcription…) pushed by the main process. */
export function useMediaProgress(): Record<string, MediaProgress> {
  const [jobs, setJobs] = useState<Record<string, MediaProgress>>({});
  useEffect(() => {
    let alive = true;
    call<MediaProgress[]>('media:jobs')
      .then((l) => alive && setJobs(Object.fromEntries(l.map((j) => [j.id, j]))))
      .catch(() => {});
    const off = listen<MediaProgress>('media:progress', (p) => {
      setJobs((j) => {
        const n = { ...j };
        if (p.stage === 'done' || p.stage === 'error') delete n[p.id];
        else n[p.id] = p;
        return n;
      });
    });
    return () => {
      alive = false;
      off();
    };
  }, []);
  return jobs;
}

export function JobProgress({ p, onCancel }: { p?: MediaProgress; onCancel?: () => void }) {
  if (!p) return null;
  return (
    <div className="col" style={{ gap: 4 }}>
      <div className="row small muted">
        <span>
          {STAGE_LABEL[p.stage]}
          {p.message ? ` — ${p.message}` : ''}
        </span>
        <span className="spacer" />
        <span>{p.pct >= 0 ? `${Math.round(p.pct)} %` : '…'}</span>
        {onCancel && (
          <button className="btn btn-ghost btn-sm" onClick={onCancel}>
            Annuler
          </button>
        )}
      </div>
      <ProgressBar value={p.pct >= 0 ? p.pct / 100 : 0.05} />
    </div>
  );
}

/** Current vs projected coverage (J+3) with the 95 % target line. */
export function CoverageBars({ now, projected, small }: { now: number | null; projected: number | null; small?: boolean }) {
  if (now == null) return <div className="small dim">Couverture inconnue (pas encore de sous-titres)</div>;
  const color = (x: number) => (x >= 0.95 ? 'var(--ok)' : x >= 0.85 ? 'var(--warn)' : 'var(--bad)');
  const bar = (label: string, v: number) => (
    <div className="row" style={{ gap: 8 }}>
      <span className="small dim" style={{ width: small ? 70 : 92 }}>
        {label}
      </span>
      <div style={{ flex: 1, position: 'relative', height: 8, background: 'var(--bg-2)', borderRadius: 99, border: '1px solid var(--line)' }}>
        <div style={{ width: `${Math.min(100, v * 100)}%`, height: '100%', background: color(v), borderRadius: 99 }} />
        <div title="Objectif 95 %" style={{ position: 'absolute', left: '95%', top: -3, bottom: -3, width: 2, background: 'var(--text-3)' }} />
      </div>
      <span className="small" style={{ width: 52, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        {pct(v)}
      </span>
    </div>
  );
  return (
    <div className="col" style={{ gap: 4 }}>
      {bar('Actuelle', now)}
      {projected != null && bar('Projetée J+3', projected)}
    </div>
  );
}

export function Thumb({ src, audio, w = 168 }: { src: string | null; audio?: boolean; w?: number }) {
  const [bad, setBad] = useState(false);
  const h = Math.round((w * 9) / 16);
  const style = { width: w, height: h, borderRadius: 8, objectFit: 'cover' as const, flexShrink: 0, background: 'var(--bg-2)', border: '1px solid var(--line)' };
  if (!src || bad)
    return (
      <div className="center hanzi" style={{ ...style, fontSize: 30, color: 'var(--text-3)' }}>
        {audio ? '♫' : '▶'}
      </div>
    );
  return <img src={/^https?:/.test(src) ? src : fileUrl(src)} style={style} onError={() => setBad(true)} alt="" />;
}

/** Returned by an action the user cancelled (e.g. closed a file dialog): `attempt` shows no success toast. */
export const CANCELLED = Symbol('cancelled');

/** Run an async action with a toast on error; returns true on success (false on error or CANCELLED). */
export async function attempt(fn: () => Promise<unknown>, okMsg?: string): Promise<boolean> {
  try {
    if ((await fn()) === CANCELLED) return false;
    if (okMsg) toast(okMsg);
    return true;
  } catch (e) {
    toast('⚠ ' + (e instanceof Error ? e.message : String(e)));
    return false;
  }
}

/** Import a .srt/.vtt for a video via the file dialog; CANCELLED when the dialog is closed. */
export async function importSubs(id: string): Promise<unknown> {
  return (await call('media:importSubs', id)) ?? CANCELLED;
}

export async function aiConfigured(): Promise<boolean> {
  try {
    const s = await call<{ configured: boolean }>('ai:status');
    return !!s?.configured;
  } catch {
    return false;
  }
}

export const KIND_LABEL: Record<VideoInfo['kind'], string> = { youtube: 'YouTube', local: 'Fichier local', rss: 'Podcast', other: 'Web' };
