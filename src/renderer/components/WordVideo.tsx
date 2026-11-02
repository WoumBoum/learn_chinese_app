// Vidéo YouTube d'un mot (slot « usage ») ou d'un caractère (slot « etymology »).
// Vignette d'abord (aucune requête YouTube avant le clic), puis <iframe> youtube-nocookie (Referer injecté par le
// processus principal, CSP frame-src). Erreur du lecteur (postMessage onError) : vidéo supprimée / intégration
// refusée (100/101/150) → « broken » (30 jours) et suivante ; erreur liée à l'environnement (2/5/153), ou plusieurs
// vidéos qui échouent d'affilée (IP, VPN…) → rien n'est écarté, on propose « Ouvrir sur YouTube ».
import { useCallback, useEffect, useRef, useState } from 'react';
import { embedUrl, playerErrorKind } from '../../core/wordVideos';
import { call, listen } from '../api';
import { toast } from './common';
import './WordVideo.css';

export interface WordVideoProps {
  /** mot (slot usage) ou caractère unique (slot etymology) */
  target: string;
  slot: 'usage' | 'etymology';
  /** affichage réduit (popup, fiche caractère) */
  compact?: boolean;
}

interface Video {
  id: string;
  title: string;
  channel: string;
  duration: number;
  start?: number;
  offSlot?: boolean;
  label: string;
}
interface Result {
  video: Video | null;
  alternatives: number;
  pending: boolean;
  source: 'cache' | 'index' | 'search' | 'ai' | 'none';
  error?: string;
  retryInMs?: number;
}

const YT_ORIGINS = ['https://www.youtube-nocookie.com', 'https://www.youtube.com'];

/**
 * Échecs de lecture d'affilée dans la session, sur des vidéos différentes (remis à zéro dès qu'une vidéo joue).
 * À partir de ENV_FAILS, c'est l'environnement (IP signalée, VPN, réseau) et non les vidéos : on n'écarte plus rien.
 */
const session = { fails: 0, lastFailed: '' };
const ENV_FAILS = 2;

function fmtDuration(s: number): string {
  if (!s || s <= 0) return '';
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return m ? `${m} min ${String(r).padStart(2, '0')}` : `${r} s`;
}

function useOnline(): boolean {
  const [on, setOn] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  useEffect(() => {
    const up = () => setOn(true);
    const down = () => setOn(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return on;
}

export function WordVideo({ target, slot, compact }: WordVideoProps) {
  const [res, setRes] = useState<Result | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [thumbOk, setThumbOk] = useState(true);
  /** lecture intégrée impossible ici (message FR) : la vidéo reste, « Ouvrir sur YouTube » est proposé */
  const [playErr, setPlayErr] = useState<string | null>(null);
  const online = useOnline();
  const frame = useRef<HTMLIFrameElement | null>(null);
  const vid = res?.video?.id;
  /** Le focus est dans le lecteur (clic sur pause, sous-titres, volume…) : le rendre au document. */
  const releaseFocus = useCallback(() => {
    if (frame.current && document.activeElement === frame.current) frame.current.blur();
  }, []);
  // Chaque requête prend un numéro ; seule la plus récente (pour la cible courante) est affichée.
  const seq = useRef(0);

  const show = useCallback((r: Result) => {
    setRes(r);
    setFailed(null);
    setPlaying(false);
    setThumbOk(true);
    setPlayErr(null);
  }, []);

  const load = useCallback(() => {
    const n = ++seq.current;
    call<Result>('video:forTarget', target, slot)
      .then((r) => n === seq.current && show(r))
      .catch((e) => n === seq.current && setFailed(e instanceof Error ? e.message : String(e)));
  }, [target, slot, show]);

  useEffect(() => {
    setRes(null);
    setFailed(null);
    setPlaying(false);
    setPlayErr(null);
    load();
    return () => {
      seq.current++; // réponses en vol de l'ancienne cible ignorées
    };
  }, [load]);

  // Retour du réseau : lever la pause des recherches côté processus principal, puis recharger.
  const wasOnline = useRef(online);
  useEffect(() => {
    if (online && !wasOnline.current) {
      call('video:resume')
        .catch(() => undefined)
        .finally(() => load());
    }
    wasOnline.current = online;
  }, [online, load]);

  // Recherches en pause (DNS / YouTube injoignable alors que navigator.onLine reste vrai) : un seul rechargement à la
  // fin de la pause — c'est lui qui relance la recherche (limiteur global : pas de rafale) ; nouvel échec → nouvelle pause.
  useEffect(() => {
    if (!res || res.video || res.pending || !res.retryInMs) return;
    const t = window.setTimeout(load, res.retryInMs + 1000);
    return () => window.clearTimeout(t);
  }, [res, load]);

  // Recherche terminée / choix IA : recharger, sauf pendant la lecture (ne pas couper la vidéo).
  const playingRef = useRef(false);
  playingRef.current = playing;
  useEffect(
    () =>
      listen<{ target: string; slot: string }>('video:updated', (p) => {
        if (p && p.target === target && p.slot === slot && !playingRef.current) load();
      }),
    [target, slot, load],
  );

  const act = async (channel: 'video:next' | 'video:hide', ...extra: unknown[]) => {
    if (busy) return;
    setBusy(true);
    const n = ++seq.current;
    try {
      const before = res?.video?.id;
      const r = await call<Result>(channel, target, slot, ...extra);
      if (n !== seq.current) return; // cible changée (ou rechargement plus récent) entre-temps
      show(r);
      if (channel === 'video:next' && r.video?.id === before && !r.pending) toast('Pas d’autre vidéo pour l’instant.');
    } catch (e) {
      if (n === seq.current) toast(`Vidéo : ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // Lecteur : poignée de main « listening » (API iframe par postMessage, sans script YouTube), écoute de onError.
  useEffect(() => {
    if (!playing || !vid) return;
    const id = Math.floor(Math.random() * 1e9);
    let heard = false;
    let tries = 0;
    const post = (msg: object) => {
      try {
        frame.current?.contentWindow?.postMessage(JSON.stringify({ ...msg, id, channel: 'widget' }), YT_ORIGINS[0]);
      } catch {
        /* frame pas prête */
      }
    };
    const hello = window.setInterval(() => {
      if (heard || ++tries > 15) return window.clearInterval(hello);
      post({ event: 'listening' });
    }, 700);
    const onMsg = (e: MessageEvent) => {
      if (!YT_ORIGINS.includes(e.origin) || e.source !== frame.current?.contentWindow) return;
      let d: { event?: string; info?: unknown } | null = null;
      try {
        d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
      } catch {
        return;
      }
      if (!d || typeof d !== 'object') return;
      if (!heard) {
        heard = true;
        post({ event: 'command', func: 'addEventListener', args: ['onError'] });
        post({ event: 'command', func: 'addEventListener', args: ['onStateChange'] });
      }
      if (d.event === 'onReady') post({ event: 'command', func: 'playVideo', args: [] });
      if (d.event === 'onStateChange') {
        const st = Number(d.info);
        if (st === 1) session.fails = 0; // une vidéo joue : l'environnement va bien
        // lecture lancée / en pause / finie : rendre le clavier à l'app (raccourcis, Échap des fenêtres) — une
        // <iframe> d'une autre origine garde les touches pour elle
        if (st === 0 || st === 1 || st === 2 || st === 5) window.setTimeout(releaseFocus, 0);
      }
      if (d.event === 'onError') {
        const kind = playerErrorKind(d.info);
        if (kind === 'ignore') return;
        if (session.lastFailed !== vid) {
          session.fails++;
          session.lastFailed = vid;
        }
        setPlaying(false);
        if (session.fails >= ENV_FAILS) {
          setPlayErr('La lecture intégrée échoue sur plusieurs vidéos (connexion, VPN ?) : regarde-la sur YouTube.');
        } else if (kind === 'broken') {
          toast('Cette vidéo n’est plus disponible ici : passage à la suivante.');
          void act('video:hide', vid, 'broken');
        } else {
          setPlayErr(`Lecture intégrée impossible ici (erreur ${Number(d.info)}) : regarde-la sur YouTube.`);
        }
      }
    };
    window.addEventListener('message', onMsg);
    return () => {
      window.clearInterval(hello);
      window.removeEventListener('message', onMsg);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, vid]);

  const cls = `wv${compact ? ' wv-compact' : ''}`;
  const head = slot === 'etymology' ? `Origine du caractère ${target}` : 'Le mot en contexte';

  if (failed) return null; // module vidéo indisponible : se masquer proprement
  if (!res)
    return (
      <div className={cls}>
        <div className="wv-state muted small">Recherche de la vidéo…</div>
      </div>
    );
  const v = res.video;
  if (!v) {
    const text = res.pending
      ? 'Recherche en cours d’une vidéo sur YouTube…'
      : !online
        ? 'Hors ligne : les vidéos YouTube s’afficheront une fois connecté.'
        : res.error || `Pas encore de vidéo pour ${slot === 'etymology' ? 'ce caractère' : 'ce mot'}.`;
    return (
      <div className={cls}>
        {!compact && <div className="wv-head small muted">{head}</div>}
        <div className={`wv-state small ${res.pending ? '' : 'muted'}`}>
          {res.pending && <span className="wv-spin" aria-hidden />}
          {text}
        </div>
      </div>
    );
  }

  const open = () => {
    const url = `https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}${v.start ? `&t=${Math.floor(v.start)}s` : ''}`;
    call('core:openExternal', url).catch(() => toast('Impossible d’ouvrir le navigateur.'));
  };

  return (
    <div className={cls}>
      <div className="wv-head">
        <span className={`tag ${v.offSlot ? 'tag-warn' : 'tag-info'}`}>{v.label}</span>
        {!compact && <span className="small muted">{v.offSlot ? `(à défaut d’une vidéo « ${head} »)` : slot === 'etymology' ? target : ''}</span>}
        {res.pending && (
          <span className="small muted">
            <span className="wv-spin" aria-hidden /> recherche en cours…
          </span>
        )}
      </div>
      <div className="wv-body">
        <div className="wv-media" onMouseLeave={releaseFocus}>
          {playing ? (
            <iframe
              ref={frame}
              className="wv-frame"
              src={embedUrl(v.id, v.start)}
              title={v.title}
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              referrerPolicy="strict-origin-when-cross-origin"
              allowFullScreen
            />
          ) : (
            <button
              type="button"
              className="wv-thumb"
              onClick={() => (online ? setPlaying(true) : toast('Hors ligne : connecte-toi pour regarder la vidéo.'))}
              title={online ? 'Lire la vidéo' : 'Hors ligne'}
            >
              {thumbOk && online ? (
                <img src={`https://i.ytimg.com/vi/${encodeURIComponent(v.id)}/mqdefault.jpg`} alt="" loading="lazy" onError={() => setThumbOk(false)} />
              ) : (
                <span className="wv-thumb-ph">{online ? 'YouTube' : 'Hors ligne'}</span>
              )}
              {online && <span className="wv-play" aria-hidden />}
              {v.duration > 0 && <span className="wv-dur">{fmtDuration(v.duration)}</span>}
            </button>
          )}
        </div>
        <div className="wv-meta">
          <div className="wv-title">{v.title}</div>
          <div className="small muted">
            {v.channel}
            {v.duration > 0 ? ` · ${fmtDuration(v.duration)}` : ''}
            {v.start ? ` · à partir de ${fmtDuration(v.start)}` : ''}
          </div>
          {!online && <div className="small wv-off">Hors ligne : la vidéo sera visible une fois connecté.</div>}
          {online && playErr && <div className="small wv-off">{playErr}</div>}
          <div className="wv-actions">
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => act('video:next')}>
              Vidéo suivante
            </button>
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => act('video:hide', v.id, 'irrelevant')}>
              Pas pertinente
            </button>
            <button type="button" className={`btn btn-sm ${playErr ? '' : 'btn-ghost'}`} onClick={open}>
              Ouvrir sur YouTube
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
