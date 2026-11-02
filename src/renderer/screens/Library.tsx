// « Missions vidéo » : recommandations, bibliothèque, écoute extensive, catalogue des sources, ajout.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { call, fileUrl } from '../api';
import { useNav } from '../App';
import { ErrorBox, Loading, toast, useAsync } from '../components/common';
import {
  attempt,
  CoverageBars,
  fmtDate,
  fmtDuration,
  importSubs,
  JobProgress,
  KIND_LABEL,
  MISSION_STATUS,
  pct,
  SUBS_LABEL,
  Thumb,
  useMediaProgress,
} from '../components/media';
import type { BinStatus, MediaPrefs, MediaProgress, RecItem, RssEpisode, VideoInfo } from '../../shared/media';
import type { CatalogSource, Mission } from '../../shared/types';

type Tab = 'reco' | 'library' | 'listening' | 'sources' | 'add';
const TABS: { id: Tab; label: string }[] = [
  { id: 'reco', label: 'Recommandées' },
  { id: 'library', label: 'Ma bibliothèque' },
  { id: 'listening', label: 'Écoute extensive' },
  { id: 'sources', label: 'Catalogue des sources' },
  { id: 'add', label: 'Ajouter' },
];

type MissionRow = Mission & { title: string; thumbnail: string | null; remaining: number };

export function Library(props: Record<string, unknown>) {
  const initial = (typeof props.tab === 'string' && TABS.some((t) => t.id === props.tab) ? props.tab : 'reco') as Tab;
  const [tab, setTab] = useState<Tab>(initial);
  const jobs = useMediaProgress();
  const [rev, setRev] = useState(0);
  const bump = () => setRev((r) => r + 1);

  // Reload lists when a background job finishes.
  const prevJobs = useRef(0);
  useEffect(() => {
    const n = Object.keys(jobs).length;
    if (n < prevJobs.current) bump();
    prevJobs.current = n;
  }, [jobs]);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Missions vidéo</div>
          <div className="page-sub">
            Vidéos, dessins animés et podcasts chinois. Le vocabulaire est pré-enseigné quelques jours avant pour viser ~95 % de mots compris le jour J.
          </div>
        </div>
      </div>
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={'tab' + (tab === t.id ? ' active' : '')} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {(tab === 'reco' || tab === 'library') && <MissionsStrip rev={rev} />}
      {tab === 'reco' && <Recommended jobs={jobs} rev={rev} onChanged={bump} />}
      {tab === 'library' && <MyLibrary jobs={jobs} rev={rev} onChanged={bump} />}
      {tab === 'listening' && <Listening rev={rev} jobs={jobs} />}
      {tab === 'sources' && <Sources jobs={jobs} onChanged={bump} goLibrary={() => setTab('library')} />}
      {tab === 'add' && <AddMedia jobs={jobs} onAdded={() => (bump(), setTab('library'))} />}
    </div>
  );
}

// ------------------------------------------------------------------ active missions
function MissionsStrip({ rev }: { rev: number }) {
  const { go } = useNav();
  const { data } = useAsync(() => call<MissionRow[]>('media:missions'), [rev]);
  const active = (data ?? []).filter((m) => m.status !== 'done');
  if (!active.length) return null;
  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <div className="card-title">Missions en cours</div>
      <div className="list">
        {active.map((m) => {
          const st = MISSION_STATUS[m.status];
          return (
            <div key={m.id} className="list-item clickable" onClick={() => go('mission', { missionId: m.id })}>
              <Thumb src={m.thumbnail} w={88} />
              <div className="col" style={{ gap: 2, flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.title}</div>
                <div className="small muted">
                  Visionnage prévu {fmtDate(m.planned_date)} · {m.preteach.filter((p) => p.status === 'new').length} mots au briefing
                  {m.remaining ? ` · ${m.remaining} à apprendre` : ' · vocabulaire prêt'}
                </div>
              </div>
              <span className={'tag ' + st.cls}>{st.label}</span>
              <button className="btn btn-sm btn-primary">Ouvrir</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ video card
function VideoCard({ v, job, onChanged, extra }: { v: VideoInfo; job?: MediaProgress; onChanged: () => void; extra?: ReactNode }) {
  const { go } = useNav();
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    await attempt(fn, ok);
    setBusy(false);
    onChanged();
  };
  const working = busy || !!job;
  const needsPrep = !v.segCount || !v.hasFile;
  const plan = () =>
    run(async () => {
      const m = await call<Mission>('media:planMission', v.id);
      go('mission', { missionId: m.id });
    });
  return (
    <div className="card" style={{ padding: 14 }}>
      <div className="row" style={{ alignItems: 'flex-start', gap: 14, flexWrap: 'nowrap' }}>
        <Thumb src={v.thumbnail} audio={v.audioOnly || v.kind === 'rss'} />
        <div className="col" style={{ flex: 1, minWidth: 0, gap: 6 }}>
          <div style={{ fontWeight: 600, lineHeight: 1.3 }}>{v.title}</div>
          <div className="row small" style={{ gap: 6 }}>
            <span className="tag">{KIND_LABEL[v.kind]}</span>
            <span className="tag">{fmtDuration(v.duration)}</span>
            {v.subs_source && <span className="tag tag-info">{SUBS_LABEL[v.subs_source]}</span>}
            {v.hasFile ? <span className="tag tag-ok">Hors-ligne</span> : <span className="tag">Non téléchargée</span>}
            {v.watched > 0 && <span className="tag tag-ok">Vue {v.watched > 1 ? `${v.watched}×` : ''}</span>}
            {v.mission && <span className={'tag ' + MISSION_STATUS[v.mission.status].cls}>Mission : {MISSION_STATUS[v.mission.status].label.toLowerCase()}</span>}
            {v.themes.slice(0, 3).map((t) => (
              <span key={t} className="tag">
                {t}
              </span>
            ))}
          </div>
          {v.segCount > 0 && <CoverageBars now={v.coverage} projected={v.projected3} small />}
          {v.segCount > 0 && (
            <div className="small muted">
              {v.preteachCount ? `${v.preteachCount} mots à pré-enseigner` : 'Aucun mot à pré-enseigner'}
              {v.readyInDays != null ? ` · ${v.readyInDays === 0 ? 'prête dès aujourd\'hui' : `prête dans ${v.readyInDays} jour${v.readyInDays > 1 ? 's' : ''}`}` : ' · encore trop difficile'}
              {` · ${v.segCount} lignes`}
            </div>
          )}
          {v.summary && <div className="small muted">{v.summary}</div>}
          {v.error && !job && <div className="notice notice-warn small">{v.error}</div>}
          {job && <JobProgress p={job} onCancel={() => call('media:cancel', v.id)} />}
          {extra}
          <div className="row" style={{ gap: 6, marginTop: 2 }}>
            {needsPrep && (
              <button
                className="btn btn-sm"
                disabled={working}
                title="Sous-titres chinois (CC/auto), téléchargement ≤ 480p, et transcription Whisper si aucun sous-titre"
                onClick={() => run(() => call('media:prepare', v.id), 'Vidéo prête')}
              >
                ⇣ Préparer
              </button>
            )}
            {v.segCount > 0 && (
              <button className="btn btn-sm btn-primary" disabled={working} onClick={v.mission ? () => go('mission', { missionId: v.mission!.id }) : plan}>
                {v.mission ? 'Ouvrir la mission' : 'Préparer la mission'}
              </button>
            )}
            <button className="btn btn-sm" disabled={working && !v.hasFile} onClick={() => go('mission', v.mission ? { missionId: v.mission.id, step: 'field' } : { videoId: v.id, step: 'field' })}>
              ▶ Regarder
            </button>
            <MoreMenu v={v} disabled={working} run={run} />
          </div>
        </div>
      </div>
    </div>
  );
}

function MoreMenu({ v, disabled, run }: { v: VideoInfo; disabled: boolean; run: (fn: () => Promise<unknown>, ok?: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const item = (label: string, fn: () => Promise<unknown>, ok?: string, show = true) =>
    show ? (
      <button
        className="btn btn-ghost btn-sm"
        style={{ justifyContent: 'flex-start' }}
        onClick={() => {
          setOpen(false);
          run(fn, ok);
        }}
      >
        {label}
      </button>
    ) : null;
  return (
    <span style={{ position: 'relative' }}>
      <button className="btn btn-sm btn-ghost" disabled={disabled} onClick={() => setOpen((o) => !o)}>
        ⋯
      </button>
      {open && (
        <div className="col card" style={{ position: 'absolute', zIndex: 20, top: 34, left: 0, padding: 6, gap: 2, minWidth: 260, boxShadow: '0 8px 24px rgba(0,0,0,.4)' }}>
          {item('Récupérer les sous-titres YouTube', () => call('media:fetchSubs', v.id), 'Sous-titres récupérés', v.kind === 'youtube' || v.kind === 'other')}
          {item('Télécharger la vidéo (≤ 480p)', () => call('media:download', v.id), 'Téléchargement terminé', !v.hasFile && v.kind !== 'local')}
          {item(v.segCount ? 'Re-transcrire avec Whisper' : 'Transcrire avec Whisper', () => call('media:transcribe', v.id), 'Transcription terminée')}
          {item('Importer un fichier .srt / .vtt…', () => importSubs(v.id), 'Sous-titres importés')}
          {item('Exporter l\'audio en MP3', async () => {
            const r = await call<{ path: string }>('media:exportAudio', v.id);
            toast('MP3 exporté : ' + r.path);
          })}
          {item('Ouvrir sur le web', () => call('core:openExternal', v.url), undefined, /^https?:/.test(v.url))}
          {item('Supprimer de la bibliothèque', async () => {
            if (window.confirm(`Supprimer « ${v.title} » et ses fichiers téléchargés ?`)) await call('media:remove', v.id);
          })}
        </div>
      )}
    </span>
  );
}

// ------------------------------------------------------------------ recommended
function Recommended({ jobs, rev, onChanged }: { jobs: Record<string, MediaProgress>; rev: number; onChanged: () => void }) {
  const { data, error, loading } = useAsync(() => call<RecItem[]>('media:recommend'), [rev]);
  const [adding, setAdding] = useState<string | null>(null);
  if (loading && !data) return <Loading text="Calcul des recommandations…" />;
  if (error) return <ErrorBox error={error} />;
  const items = data ?? [];
  if (!items.length) return <div className="empty">Aucune recommandation pour l'instant : ajoute une vidéo ou scanne une source du catalogue.</div>;
  const add = async (r: RecItem) => {
    setAdding(r.key);
    await attempt(async () => {
      const [v] = await call<VideoInfo[]>('media:add', r.url);
      if (v) await call('media:fetchSubs', v.id).catch(() => {});
    }, 'Vidéo ajoutée à ta bibliothèque');
    setAdding(null);
    onChanged();
  };
  return (
    <div className="stack">
      <div className="notice small">
        Classement : couverture projetée à J+3 proche de 95 % (input compréhensible), durée adaptée à ta phase, source conseillée pour ton niveau et tes centres d'intérêt.
      </div>
      {items.map((r) =>
        r.video ? (
          <VideoCard
            key={r.key}
            v={r.video}
            job={jobs[r.key]}
            onChanged={onChanged}
            extra={<Reasons r={r} />}
          />
        ) : (
          <div key={r.key} className="card" style={{ padding: 14 }}>
            <div className="row" style={{ alignItems: 'flex-start', gap: 14, flexWrap: 'nowrap' }}>
              <Thumb src={r.thumbnail} />
              <div className="col" style={{ flex: 1, minWidth: 0, gap: 6 }}>
                <div style={{ fontWeight: 600 }}>{r.title}</div>
                <div className="row small" style={{ gap: 6 }}>
                  <span className="tag">Catalogue</span>
                  {r.sourceName && <span className="tag">{r.sourceName}</span>}
                  <span className="tag">{fmtDuration(r.durationSec)}</span>
                  {r.themes.slice(0, 3).map((t) => (
                    <span key={t} className="tag">
                      {t}
                    </span>
                  ))}
                </div>
                <Reasons r={r} />
                <div className="row">
                  <button className="btn btn-sm btn-primary" disabled={adding === r.key} onClick={() => add(r)}>
                    {adding === r.key ? 'Ajout…' : '+ Ajouter et analyser'}
                  </button>
                  <button className="btn btn-sm btn-ghost" onClick={() => call('core:openExternal', r.url)}>
                    Voir sur YouTube
                  </button>
                </div>
              </div>
            </div>
          </div>
        ),
      )}
    </div>
  );
}

function Reasons({ r }: { r: RecItem }) {
  return (
    <div className="row small" style={{ gap: 6 }}>
      <span className="tag tag-info" title="Score de recommandation">
        ★ {Math.round(r.score * 100)}
      </span>
      {r.reasons.map((x) => (
        <span key={x} className="dim">
          · {x}
        </span>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ my library
function MyLibrary({ jobs, rev, onChanged }: { jobs: Record<string, MediaProgress>; rev: number; onChanged: () => void }) {
  const { data, error, loading } = useAsync(() => call<VideoInfo[]>('media:list'), [rev]);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'ready' | 'todo' | 'watched'>('all');
  const list = useMemo(
    () =>
      (data ?? []).filter((v) => {
        if (q && !v.title.toLowerCase().includes(q.toLowerCase())) return false;
        if (filter === 'ready') return v.segCount > 0;
        if (filter === 'todo') return !v.segCount;
        if (filter === 'watched') return v.watched > 0;
        return true;
      }),
    [data, q, filter],
  );
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data?.length) return <div className="empty">Ta bibliothèque est vide. Ajoute une vidéo YouTube, un flux de podcast ou un fichier local (onglet « Ajouter »), ou scanne une source du catalogue.</div>;
  return (
    <div className="stack">
      <div className="row">
        <input placeholder="Rechercher un titre…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
        <div className="mode-switch">
          {(
            [
              ['all', 'Toutes'],
              ['ready', 'Analysées'],
              ['todo', 'À préparer'],
              ['watched', 'Vues'],
            ] as const
          ).map(([k, l]) => (
            <button key={k} className={filter === k ? 'active' : ''} onClick={() => setFilter(k)}>
              {l}
            </button>
          ))}
        </div>
      </div>
      {list.map((v) => (
        <VideoCard key={v.id} v={v} job={jobs[v.id]} onChanged={onChanged} />
      ))}
      {!list.length && <div className="empty">Aucune vidéo ne correspond.</div>}
    </div>
  );
}

// ------------------------------------------------------------------ extensive listening
type QueueItem = VideoInfo & { exported: string | null };

function Listening({ rev, jobs }: { rev: number; jobs: Record<string, MediaProgress> }) {
  const { data, error, loading, reload } = useAsync(() => call<QueueItem[]>('media:listeningQueue'), [rev]);
  const [current, setCurrent] = useState<QueueItem | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const startedAt = useRef<number | null>(null);
  const total = useRef(0);
  /** Minutes listened since this screen was opened (all chunks, pauses included): validates the plan block at 5 min. */
  const session = useRef(0);
  const marked = useRef(false);
  // Read by flush() from the unmount cleanup, which only sees the first render's closure.
  const curRef = useRef<QueueItem | null>(null);
  curRef.current = current;
  const [rate, setRate] = useState(1);

  const flush = () => {
    if (startedAt.current != null) {
      total.current += (Date.now() - startedAt.current) / 60000;
      startedAt.current = null;
    }
    if (total.current >= 0.5) {
      const m = Math.round(total.current * 10) / 10;
      total.current = 0;
      session.current += m;
      call('core:logActivity', 'listening', m, { videoId: curRef.current?.id }).catch(() => {});
    }
    if (session.current >= 5 && !marked.current) {
      marked.current = true;
      call('core:markBlockDone', 'listening').catch(() => {});
    }
  };
  useEffect(() => () => flush(), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, [rate, current]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const items = data ?? [];
  return (
    <div className="stack">
      <div className="notice small">
        Écoute extensive : réécoute en fond les vidéos déjà travaillées (trajets, ménage…). Le vocabulaire est connu, ton oreille s'habitue au débit réel. Le temps d'écoute est comptabilisé.
      </div>
      {current && (
        <div className="card highlight">
          <div className="card-title">En écoute</div>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>{current.title}</div>
          <audio
            ref={audioRef}
            src={fileUrl(current.path!)}
            controls
            autoPlay
            style={{ width: '100%' }}
            onPlay={() => (startedAt.current = Date.now())}
            onPause={flush}
            onEnded={flush}
          />
          <div className="row" style={{ marginTop: 8 }}>
            <span className="small dim">Vitesse</span>
            {[0.75, 0.9, 1, 1.15].map((r) => (
              <button key={r} className={'btn btn-sm' + (rate === r ? ' selected' : '')} onClick={() => setRate(r)}>
                {r}×
              </button>
            ))}
          </div>
        </div>
      )}
      {!items.length && <div className="empty">Rien à réécouter pour l'instant : termine une mission vidéo, elle apparaîtra ici.</div>}
      {items.map((v) => (
        <div key={v.id} className="list-item">
          <Thumb src={v.thumbnail} audio w={88} />
          <div className="col" style={{ flex: 1, gap: 2, minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>{v.title}</div>
            <div className="small muted">
              {fmtDuration(v.duration)} · couverture {pct(v.coverage)} {v.exported ? '· MP3 exporté' : ''}
            </div>
            {jobs[v.id] && <JobProgress p={jobs[v.id]} />}
          </div>
          <button
            className="btn btn-sm btn-primary"
            onClick={() => {
              flush();
              setCurrent(v);
            }}
          >
            ▶ Écouter
          </button>
          {v.exported ? (
            <button className="btn btn-sm" onClick={() => call('media:showInFolder', v.exported)}>
              Ouvrir le dossier
            </button>
          ) : (
            <button
              className="btn btn-sm"
              disabled={!!jobs[v.id]}
              onClick={() =>
                attempt(async () => {
                  const r = await call<{ path: string }>('media:exportAudio', v.id);
                  toast('MP3 exporté : ' + r.path);
                  reload();
                })
              }
            >
              Exporter MP3
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ catalogue
type SourceRow = CatalogSource & { scanned: number };

const KIND_SRC: Record<string, string> = { youtube_channel: 'Chaîne YouTube', youtube_playlist: 'Playlist YouTube', podcast_rss: 'Podcast (RSS)' };
const SUBS_SRC: Record<string, string> = { cc: 'Sous-titres CC', embedded: 'Sous-titres incrustés', none: 'Sans sous-titres', unknown: 'Sous-titres : ?' };

function Sources({ jobs, onChanged, goLibrary }: { jobs: Record<string, MediaProgress>; onChanged: () => void; goLibrary: () => void }) {
  const { data, error, loading, reload } = useAsync(() => call<{ phase: number; phaseName: string; interests: string[]; sources: SourceRow[] }>('media:sources'), []);
  const [phaseFilter, setPhaseFilter] = useState<number | 'all'>('all');
  const [result, setResult] = useState<Record<string, string>>({});
  useEffect(() => {
    if (data && phaseFilter === 'all') setPhaseFilter(data.phase);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const d = data!;
  const scan = async (s: SourceRow) => {
    setResult((r) => ({ ...r, [s.id]: '' }));
    try {
      const r = await call<{ added: number; withSubs: number; errors: string[]; note: string }>('media:scanSource', s.id, 8);
      setResult((x) => ({
        ...x,
        [s.id]: `${r.added} élément(s) ajouté(s), ${r.withSubs} avec sous-titres chinois.${r.note ? ' ' + r.note : ''}${r.errors.length ? ' ⚠ ' + r.errors.join(' ') : ''}`,
      }));
    } catch (e) {
      setResult((x) => ({ ...x, [s.id]: '⚠ ' + (e as Error).message }));
    }
    reload();
    onChanged();
  };
  const phases = [0, 1, 2, 3];
  const shown = d.sources.filter((s) => phaseFilter === 'all' || s.phases.includes(phaseFilter) || (!s.phases.length && phaseFilter === 3));
  return (
    <div className="stack">
      <div className="row">
        <span className="muted small">Tu es en {d.phaseName}. Phases :</span>
        <div className="mode-switch">
          <button className={phaseFilter === 'all' ? 'active' : ''} onClick={() => setPhaseFilter('all')}>
            Toutes
          </button>
          {phases.map((p) => (
            <button key={p} className={phaseFilter === p ? 'active' : ''} onClick={() => setPhaseFilter(p)}>
              Phase {p}
            </button>
          ))}
        </div>
      </div>
      <div className="grid-2">
        {shown.map((s) => {
          const job = jobs['scan:' + s.id];
          const match = d.interests.some((i) => s.themes.some((t) => t.toLowerCase().includes(i.toLowerCase())));
          return (
            <div key={s.id} className={'card' + (s.phases.includes(d.phase) ? ' highlight' : '')} style={{ padding: 14 }}>
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <div style={{ fontWeight: 600, flex: 1 }}>{s.name}</div>
                <span className="tag">{KIND_SRC[s.kind] ?? s.kind}</span>
              </div>
              <div className="row small" style={{ gap: 6, margin: '6px 0' }}>
                <span className="tag tag-info">{s.type}</span>
                <span className="tag">Phases {s.phases.length ? s.phases.join(', ') : '?'}</span>
                <span className="tag">{SUBS_SRC[s.hasChineseSubs] ?? s.hasChineseSubs}</span>
                {match && <span className="tag tag-ok">Tes intérêts</span>}
                {s.scanned > 0 && <span className="tag">{s.scanned} dans ta bibliothèque</span>}
              </div>
              <div className="row small" style={{ gap: 6 }}>
                {s.themes.map((t) => (
                  <span key={t} className="dim">
                    #{t}
                  </span>
                ))}
              </div>
              <div className="small muted" style={{ margin: '8px 0' }}>
                {s.notes}
              </div>
              {job && <JobProgress p={job} onCancel={() => call('media:cancel', 'scan:' + s.id)} />}
              {result[s.id] && <div className="small notice" style={{ margin: '6px 0' }}>{result[s.id]}</div>}
              <div className="row">
                <button className="btn btn-sm btn-primary" disabled={!!job} onClick={() => scan(s)} title={s.kind === 'podcast_rss' ? 'Ajoute les 8 derniers épisodes' : 'Liste les 8 dernières vidéos et récupère seulement leurs sous-titres pour calculer la couverture'}>
                  {job ? 'Scan…' : 'Scanner'}
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => call('core:openExternal', s.url)}>
                  Ouvrir
                </button>
                {s.scanned > 0 && (
                  <button className="btn btn-sm btn-ghost" onClick={goLibrary}>
                    Voir dans la bibliothèque
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ add
function AddMedia({ jobs, onAdded }: { jobs: Record<string, MediaProgress>; onAdded: () => void }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [rssUrl, setRssUrl] = useState('');
  const [feed, setFeed] = useState<{ title: string; image: string | null; episodes: RssEpisode[] } | null>(null);
  const [nEp, setNEp] = useState(5);
  const prefsQ = useAsync(() => call<MediaPrefs>('media:prefs'), []);
  const binQ = useAsync(() => call<BinStatus>('media:binStatus'), []);
  const sources = useAsync(() => call<{ sources: SourceRow[] }>('media:sources'), []);

  const addUrl = async () => {
    setBusy(true);
    setErr(null);
    try {
      const vids = await call<VideoInfo[]>('media:add', url.trim());
      toast(`${vids.length} élément(s) ajouté(s)`);
      // Single video: fetch its subtitles right away to compute coverage.
      if (vids.length === 1 && vids[0].kind === 'youtube') await call('media:fetchSubs', vids[0].id).catch((e) => toast('⚠ ' + (e as Error).message));
      setUrl('');
      onAdded();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const listRss = async (u = rssUrl) => {
    setBusy(true);
    setErr(null);
    setFeed(null);
    try {
      setFeed(await call('media:rssEpisodes', u.trim()));
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const addRss = async () => {
    setBusy(true);
    try {
      const v = await call<VideoInfo[]>('media:addRss', rssUrl.trim(), nEp);
      toast(`${v.length} épisode(s) ajouté(s) : télécharge et transcris-les depuis la bibliothèque`);
      onAdded();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const addLocal = async () => {
    setErr(null);
    try {
      const v = await call<VideoInfo[]>('media:addLocal');
      if (v.length) {
        toast(`${v.length} fichier(s) importé(s)${v.some((x) => x.segCount) ? ' avec sous-titres' : ''}`);
        onAdded();
      }
    } catch (e) {
      setErr(e);
    }
  };
  const setPrefs = async (p: Partial<MediaPrefs>) => {
    await call('media:setPrefs', p);
    prefsQ.reload();
  };
  const prefs = prefsQ.data;
  const bin = binQ.data;
  const modelJob = prefs ? jobs['model:' + prefs.whisperModel] : undefined;
  const podcasts = (sources.data?.sources ?? []).filter((s) => s.kind === 'podcast_rss');

  return (
    <div className="stack">
      {err != null && <ErrorBox error={err} />}
      <div className="card">
        <div className="card-title">Vidéo, playlist ou chaîne YouTube</div>
        <div className="row">
          <input
            style={{ flex: 1, minWidth: 280 }}
            placeholder="https://www.youtube.com/watch?v=…  (ou une playlist / chaîne : 15 dernières vidéos)"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && url.trim() && addUrl()}
          />
          <button className="btn btn-primary" disabled={busy || !url.trim()} onClick={addUrl}>
            {busy ? 'Analyse…' : 'Ajouter'}
          </button>
        </div>
        <div className="small dim" style={{ marginTop: 8 }}>
          Les sous-titres chinois (manuels, sinon automatiques en chinois — jamais les traductions automatiques) sont récupérés pour calculer la couverture. Sans sous-titres, la vidéo sera transcrite localement par Whisper.
        </div>
      </div>

      <div className="card">
        <div className="card-title">Podcast (flux RSS)</div>
        <div className="row">
          <input style={{ flex: 1, minWidth: 280 }} placeholder="https://…/rss" value={rssUrl} onChange={(e) => setRssUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && rssUrl.trim() && listRss()} />
          <button className="btn" disabled={busy || !rssUrl.trim()} onClick={() => listRss()}>
            Lister les épisodes
          </button>
        </div>
        {podcasts.length > 0 && (
          <div className="row small" style={{ marginTop: 8 }}>
            <span className="dim">Du catalogue :</span>
            {podcasts.map((p) => (
              <button
                key={p.id}
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  setRssUrl(p.url);
                  listRss(p.url);
                }}
              >
                {p.name}
              </button>
            ))}
          </div>
        )}
        {feed && (
          <div className="stack" style={{ marginTop: 12 }}>
            <div className="row">
              <strong>{feed.title}</strong>
              <span className="dim small">{feed.episodes.length} épisodes</span>
              <span className="spacer" />
              <span className="small">Ajouter les</span>
              <select value={nEp} onChange={(e) => setNEp(+e.target.value)}>
                {[1, 3, 5, 10, 20].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <span className="small">derniers</span>
              <button className="btn btn-primary btn-sm" disabled={busy} onClick={addRss}>
                Ajouter
              </button>
            </div>
            <div className="list" style={{ maxHeight: 260, overflowY: 'auto' }}>
              {feed.episodes.slice(0, 20).map((e) => (
                <div key={e.guid} className="list-item small">
                  <div className="col" style={{ gap: 0, flex: 1 }}>
                    <span>{e.title}</span>
                    <span className="dim">
                      {e.pubDate ? new Date(e.pubDate).toLocaleDateString('fr-FR') : ''} · {fmtDuration(e.duration)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title">Fichier local</div>
        <div className="row">
          <button className="btn" onClick={addLocal}>
            Choisir une vidéo ou un audio…
          </button>
          <span className="small dim">mp4, webm, mkv, mp3, m4a, wav… Un fichier .srt / .vtt du même nom est importé automatiquement (ex. episode.mp4 + episode.srt ou episode.zh.srt).</span>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Options de téléchargement et transcription</div>
        {!prefs ? (
          <Loading />
        ) : (
          <div className="stack">
            <div className="row">
              <span style={{ width: 230 }}>Cookies du navigateur</span>
              <select value={prefs.cookiesBrowser} onChange={(e) => setPrefs({ cookiesBrowser: e.target.value as MediaPrefs['cookiesBrowser'] })}>
                <option value="">Aucun</option>
                <option value="firefox">Firefox</option>
                <option value="chrome">Chrome</option>
                <option value="chromium">Chromium</option>
                <option value="brave">Brave</option>
                <option value="edge">Edge</option>
                <option value="vivaldi">Vivaldi</option>
                <option value="opera">Opera</option>
              </select>
              <span className="small dim">À activer si YouTube demande de « confirmer que tu n'es pas un robot » : utilise ta session YouTube du navigateur (--cookies-from-browser).</span>
            </div>
            <div className="row">
              <span style={{ width: 230 }}>Modèle Whisper</span>
              <select value={prefs.whisperModel} onChange={(e) => setPrefs({ whisperModel: e.target.value as MediaPrefs['whisperModel'] })}>
                <option value="base">base (~142 Mo, rapide)</option>
                <option value="small">small (~466 Mo, plus précis)</option>
              </select>
              {bin && (bin.models[prefs.whisperModel] ? <span className="tag tag-ok">Téléchargé</span> : <span className="tag tag-warn">Non téléchargé</span>)}
              {bin && !bin.models[prefs.whisperModel] && !modelJob && (
                <button className="btn btn-sm" onClick={() => attempt(() => call('media:downloadModel', prefs.whisperModel), 'Modèle téléchargé').then(() => binQ.reload())}>
                  Télécharger maintenant
                </button>
              )}
            </div>
            {modelJob && <JobProgress p={modelJob} onCancel={() => call('media:cancel', 'model:' + prefs.whisperModel)} />}
            <label className="row">
              <input type="checkbox" checked={prefs.autoDownload} onChange={(e) => setPrefs({ autoDownload: e.target.checked })} />
              <span>« Préparer » télécharge aussi la vidéo (≤ 480p) pour la regarder hors-ligne</span>
            </label>
            {bin && (
              <div className="row small" style={{ gap: 6 }}>
                <span className="dim">Outils :</span>
                <span className={'tag ' + (bin.ytdlp ? 'tag-ok' : 'tag-bad')}>yt-dlp {bin.ytdlp ?? 'absent'}</span>
                <span className={'tag ' + (bin.ffmpeg ? 'tag-ok' : 'tag-bad')}>ffmpeg {bin.ffmpeg ? 'OK' : 'absent'}</span>
                <span className={'tag ' + (bin.whisper ? 'tag-ok' : 'tag-bad')}>whisper.cpp {bin.whisper ? 'OK' : 'absent'}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
