// Une vidéo YouTube par mot (« usage ») / par caractère (« etymology »).
// Ordre : cache utilisateur (table word_videos) → index pré-calculé (resources/data/word-videos.json) → recherche
// yt-dlp « flat » en arrière-plan (≤ 1 requête / 5 s ; arrêt pour la session au 1ᵉʳ 403/429/bot-check ou si yt-dlp
// manque ; pause de quelques minutes si hors ligne) → rien. Les cibles affichées passent devant le pré-chargement.
// Une recherche n'est marquée « faite » que si toutes ses requêtes ont abouti (refaite après 90 jours).
// Choix IA facultatif en arrière-plan quand les règles hésitent : appliqué à l'affichage SUIVANT (pas d'échange
// de vidéo sous les yeux de l'utilisateur), jamais s'il a déjà fait « suivante » / « pas pertinente ».
// Sans Electron : testable avec des dépendances factices.
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../../core/db';
import {
  BROKEN_TTL_MS,
  RateLimiter,
  SEARCHED_TTL_MS,
  altFor,
  classifyYtError,
  currentOf,
  diversify,
  indexLookup,
  orderForSlot,
  parseIndex,
  parseSearchEntries,
  pauseFor,
  queriesForTarget,
  rankCandidates,
  refineOffSlot,
  shouldAskAi,
  skipCurrent,
  slotLabel,
  stopMessage,
  usableCount,
  type ChannelInfo,
  type Entry,
  type Slot,
  type VideoCandidate,
  type WordVideoIndex,
} from '../../core/wordVideos';
import { findBin, runOk } from './proc';
import { jsRuntimeArgs } from './ytdlp';

export type { Slot } from '../../core/wordVideos';

export interface WordVideo {
  id: string;
  title: string;
  channel: string;
  duration: number;
  start?: number;
  offSlot?: boolean;
  label: string;
}

export interface WordVideoResult {
  video: WordVideo | null;
  alternatives: number;
  pending: boolean;
  source: 'cache' | 'index' | 'search' | 'ai' | 'none';
  error?: string;
  /** Recherches en pause (réseau…) : délai avant la fin de la pause, pour que l'écran affiché se recharge seul. */
  retryInMs?: number;
}

export interface WordVideoAi {
  configured(): boolean;
  pick(target: string, slot: Slot, candidates: { id: string; title: string; channel?: string; duration?: number }[]): Promise<{ id: string; startSec: number | null }>;
}

export interface WordVideoDeps {
  db: Db;
  /** index pré-calculé (chargé paresseusement) */
  index: () => WordVideoIndex;
  /** catalogue des chaînes, par channel_id */
  channels: () => Record<string, ChannelInfo>;
  /** pinyin (accentué ou numérique) d'une cible */
  pinyin: (target: string) => string;
  /** recherche « flat » yt-dlp ; lève une Error portant le texte BRUT de yt-dlp en cas d'échec */
  search: (query: string) => Promise<Entry[]>;
  ai?: WordVideoAi;
  emit: (channel: string, payload: unknown) => void;
  limiter?: RateLimiter;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (...a: unknown[]) => void;
}

interface Row {
  video_id: string;
  title: string;
  channel: string;
  duration: number;
  score: number;
  rank: number;
  source: string;
  start: number | null;
  status: string;
  off_slot: number;
  id: string; // = video_id (pour currentOf)
}

const SEARCH_MIN = 0.35; // seuil d'acceptation de la recherche (§4.3)
const SEARCH_KEEP = 8;
const SEARCHED = '__searched__'; // ligne sentinelle : recherche terminée pour la cible

const key = (target: string, slot: Slot) => `${slot}:${target}`;

export class WordVideoService {
  readonly limiter: RateLimiter;
  private queue: { target: string; slot: Slot }[] = [];
  private queued = new Set<string>();
  private running = false;
  private current: string | null = null;
  /** échecs « other » d'affilée (yt-dlp obsolète…) */
  private otherStreak = 0;
  private aiTried = new Set<string>();
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  /** promesse du worker en cours (tests) */
  idle: Promise<void> = Promise.resolve();

  constructor(private d: WordVideoDeps) {
    this.now = d.now ?? Date.now;
    this.limiter = d.limiter ?? new RateLimiter(5000, this.now);
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  // ---------------------------------------------------------------- lecture
  private rows(target: string, slot: Slot): Row[] {
    return this.d.db
      .all<Omit<Row, 'id'>>(
        "SELECT video_id, title, channel, duration, score, rank, source, start, status, off_slot FROM word_videos WHERE target=? AND slot=? AND video_id<>? ORDER BY rank, video_id",
        [target, slot, SEARCHED],
      )
      .map((r) => ({ ...r, id: r.video_id }));
  }

  /** Recherche déjà faite (toutes ses requêtes abouties) il y a moins de 90 jours ? Marqueur périmé → supprimé. */
  private searched(target: string, slot: Slot): boolean {
    const m = this.d.db.get<{ fetched_at: number | null }>('SELECT fetched_at FROM word_videos WHERE target=? AND slot=? AND video_id=?', [target, slot, SEARCHED]);
    if (!m) return false;
    if (m.fetched_at != null && this.now() - m.fetched_at < SEARCHED_TTL_MS) return true;
    this.d.db.run('DELETE FROM word_videos WHERE target=? AND slot=? AND video_id=?', [target, slot, SEARCHED]);
    return false;
  }

  /** Les vidéos « broken » redeviennent candidates après 30 jours (et celles marquées sans date). */
  private expireBroken(target: string, slot: Slot): void {
    this.d.db.run("UPDATE word_videos SET status='ok', status_at=NULL WHERE target=? AND slot=? AND status='broken' AND (status_at IS NULL OR status_at<?)", [
      target,
      slot,
      this.now() - BROKEN_TTL_MS,
    ]);
  }

  private insert(target: string, slot: Slot, cands: VideoCandidate[], source: 'index' | 'search', rank0: number): number {
    const have = new Set(this.rows(target, slot).map((r) => r.video_id));
    const fresh = cands.filter((c) => !have.has(c.id));
    if (!fresh.length) return 0;
    const ts = this.now();
    this.d.db.tx(() => {
      fresh.forEach((c) =>
        this.d.db.run(
          'INSERT OR IGNORE INTO word_videos(target,slot,video_id,title,channel,duration,score,rank,source,start,status,fetched_at,off_slot) VALUES(?,?,?,?,?,?,?,?,?,NULL,?,?,?)',
          [target, slot, c.id, c.title, c.channel, Math.round(c.duration || 0), c.score, rank0 + cands.indexOf(c), source, 'ok', ts, c.offSlot ? 1 : 0],
        ),
      );
    });
    return fresh.length;
  }

  private setStatus(target: string, slot: Slot, id: string, status: string): void {
    this.d.db.run('UPDATE word_videos SET status=?, status_at=? WHERE target=? AND slot=? AND video_id=?', [status, this.now(), target, slot, id]);
  }

  private toVideo(r: Row, slot: Slot): WordVideo {
    const offSlot = r.off_slot === 1;
    const v: WordVideo = { id: r.video_id, title: r.title, channel: r.channel, duration: r.duration || 0, label: slotLabel(slot, offSlot, r.title) };
    if (offSlot) v.offSlot = true;
    if (r.start && r.start > 0) v.start = r.start;
    return v;
  }

  private static valid(target: string, slot: Slot): boolean {
    return !!target && (slot === 'usage' || slot === 'etymology');
  }

  private invalid(): WordVideoResult {
    return { video: null, alternatives: 0, pending: false, source: 'none', error: 'Cible invalide.' };
  }

  /** Vidéo à afficher pour une cible. Ne bloque jamais sur le réseau ni l'IA. */
  forTarget(target: string, slot: Slot): WordVideoResult {
    return this.view(String(target ?? '').trim(), slot, true);
  }

  private view(target: string, slot: Slot, askAi: boolean): WordVideoResult {
    if (!WordVideoService.valid(target, slot)) return this.invalid();
    this.expireBroken(target, slot);
    const before = this.rows(target, slot);
    let fromIndex = 0;
    try {
      fromIndex = this.insert(target, slot, indexLookup(this.d.index(), target, slot), 'index', 0);
    } catch (e) {
      this.d.log?.('[video] index', e);
    }
    const rows = fromIndex ? this.rows(target, slot) : before;
    const cur = currentOf(rows);
    if (!cur) {
      const pending = this.ensureSearch(target, slot, true);
      const why = pending ? null : this.limiter.blockedReason();
      // simple pause (pas un arrêt de session 403/429) : le renderer réessaie une fois à son expiration
      const retryInMs = why && !this.limiter.stopped ? this.limiter.waitMs() : 0;
      return {
        video: null,
        alternatives: 0,
        pending,
        source: 'none',
        ...(why ? { error: stopMessage(why) } : {}),
        ...(retryInMs > 0 && Number.isFinite(retryInMs) ? { retryInMs } : {}),
      };
    }
    if (askAi) this.maybeAi(target, slot, rows);
    const source: WordVideoResult['source'] = cur.source === 'ai' ? 'ai' : before.some((r) => r.video_id === cur.video_id) ? 'cache' : (cur.source as 'index' | 'search');
    return { video: this.toVideo(cur, slot), alternatives: usableCount(rows) - 1, pending: this.queued.has(key(target, slot)), source };
  }

  /** « Vidéo suivante » : la courante est passée, on boucle quand toutes l'ont été. */
  next(target: string, slot: Slot): WordVideoResult {
    target = String(target ?? '').trim();
    if (!WordVideoService.valid(target, slot)) return this.invalid();
    this.expireBroken(target, slot);
    const rows = this.rows(target, slot);
    const changes = skipCurrent(rows);
    if (changes.size) this.d.db.tx(() => changes.forEach((st, id) => this.setStatus(target, slot, id, st)));
    if (usableCount(rows) < 2) this.ensureSearch(target, slot, true);
    return this.view(target, slot, false);
  }

  /**
   * « Pas pertinente » (hidden, définitif) ou lecture impossible (broken : vidéo supprimée / intégration refusée,
   * redevient candidate après 30 jours) ; renvoie la suivante.
   */
  hide(target: string, slot: Slot, id: string, reason: 'irrelevant' | 'broken'): WordVideoResult {
    target = String(target ?? '').trim();
    if (!WordVideoService.valid(target, slot)) return this.invalid();
    this.setStatus(target, slot, id, reason === 'broken' ? 'broken' : 'hidden');
    const rows = this.rows(target, slot);
    if (usableCount(rows) < 2) this.ensureSearch(target, slot, true);
    return this.view(target, slot, false);
  }

  /** Recherches arrêtées pour la session ou en pause ? */
  blocked(): boolean {
    return this.limiter.blockedReason() != null;
  }

  /** Retour du réseau (événement « online » du renderer) : lever la pause ; l'arrêt de session (403/429) reste. */
  resume(): boolean {
    this.limiter.resume();
    this.otherStreak = 0;
    return !this.limiter.stopped;
  }

  // ---------------------------------------------------------------- pré-chargement
  /** Cible déjà servie (cache, index) ou déjà cherchée ? */
  covered(target: string, slot: Slot): boolean {
    if (usableCount(this.rows(target, slot)) > 0) return true;
    if (indexLookup(this.d.index(), target, slot).length) return true;
    return this.searched(target, slot);
  }

  /** Mots → cibles (usage du mot + origine de chaque caractère) ; met en file celles sans vidéo. Renvoie le nombre mis en file. */
  prefetch(words: string[]): number {
    let n = 0;
    for (const w of words) {
      const t = String(w ?? '').trim();
      if (!t) continue;
      const targets: [string, Slot][] = [[t, 'usage'], ...[...new Set(t.match(/[㐀-鿿豈-﫿]/g) ?? [])].map((c): [string, Slot] => [c, 'etymology'])];
      for (const [x, s] of targets) if (!this.covered(x, s) && this.ensureSearch(x, s)) n++;
    }
    return n;
  }

  // ---------------------------------------------------------------- recherche de repli (arrière-plan)
  /**
   * Met une recherche en file si utile et possible. true = en file / en cours. `urgent` (cible affichée à l'écran) :
   * passe devant le pré-chargement.
   */
  ensureSearch(target: string, slot: Slot, urgent = false): boolean {
    const k = key(target, slot);
    if (this.queued.has(k)) {
      if (urgent && this.current !== k) {
        const i = this.queue.findIndex((j) => key(j.target, j.slot) === k);
        if (i > 0) this.queue.unshift(...this.queue.splice(i, 1));
      }
      return true;
    }
    if (this.blocked() || this.searched(target, slot)) return false;
    this.queued.add(k);
    if (urgent) this.queue.unshift({ target, slot });
    else this.queue.push({ target, slot });
    if (!this.running) this.idle = this.pump();
    return true;
  }

  pendingCount(): number {
    return this.queue.length + (this.current ? 1 : 0);
  }

  private async pump(): Promise<void> {
    this.running = true;
    try {
      while (this.queue.length && !this.blocked()) {
        const job = this.queue.shift()!;
        const k = key(job.target, job.slot);
        this.current = k;
        try {
          await this.searchTarget(job.target, job.slot);
        } catch (e) {
          this.d.log?.('[video] search', e);
        }
        this.current = null;
        this.queued.delete(k);
        this.d.emit('video:updated', { target: job.target, slot: job.slot });
      }
    } finally {
      // arrêt ou pause : vider la file et prévenir les écrans en attente (ils afficheront le message)
      this.current = null;
      for (const job of this.queue.splice(0)) {
        this.queued.delete(key(job.target, job.slot));
        this.d.emit('video:updated', { target: job.target, slot: job.slot });
      }
      this.running = false;
    }
  }

  private async takeSlot(): Promise<boolean> {
    for (;;) {
      if (this.blocked()) return false;
      if (this.limiter.tryTake()) return true;
      await this.sleep(Math.min(this.limiter.waitMs(), 60_000));
    }
  }

  private async searchTarget(target: string, slot: Slot): Promise<void> {
    const py = this.d.pinyin(target);
    const t = { w: target, py, slot, alt: altFor(target, this.d.index().alt) };
    const entries: Entry[] = [];
    // « complète » = toutes les requêtes ont abouti ; sinon pas de marqueur, la cible sera recherchée à nouveau.
    let complete = true;
    for (const q of queriesForTarget(target, slot, py)) {
      if (!(await this.takeSlot())) {
        complete = false;
        break;
      }
      try {
        entries.push(...(await this.d.search(q)));
        this.otherStreak = 0;
      } catch (e) {
        complete = false;
        const raw = e instanceof Error ? e.message : String(e);
        const kind = classifyYtError(raw);
        this.d.log?.('[video] requête', q, kind, raw);
        if (kind === 'missing' || kind === 'blocked') {
          this.limiter.stop(raw);
          break;
        }
        if (kind === 'other') this.otherStreak++;
        const ms = pauseFor(kind, this.otherStreak);
        if (ms > 0) {
          this.limiter.pause(ms, raw);
          break;
        }
      }
    }
    const channels = this.d.channels();
    const ranked = refineOffSlot(t, rankCandidates(t, entries, channels, SEARCH_MIN), SEARCH_MIN).map(
      (r): VideoCandidate => ({
        id: r.entry.id,
        title: r.entry.title,
        channel: (r.entry.channel_id && channels[r.entry.channel_id]?.name?.trim()) || r.entry.channel || '',
        duration: r.entry.duration ?? 0,
        score: r.score,
        offSlot: !!r.offSlot,
      }),
    );
    const best = diversify(orderForSlot(ranked), SEARCH_KEEP);
    this.insert(target, slot, best, 'search', 100);
    if (complete)
      this.d.db.run(
        "INSERT OR REPLACE INTO word_videos(target,slot,video_id,title,channel,duration,score,rank,source,start,status,fetched_at) VALUES(?,?,?,'','',0,0,999999,'search',NULL,'searched',?)",
        [target, slot, SEARCHED, this.now()],
      );
  }

  // ---------------------------------------------------------------- choix IA (arrière-plan, une fois par cible, scores proches)
  private maybeAi(target: string, slot: Slot, rows: Row[]): void {
    const ai = this.d.ai;
    const k = key(target, slot);
    if (!ai || this.aiTried.has(k) || rows.some((r) => r.source === 'ai')) return;
    let configured = false;
    try {
      configured = ai.configured();
    } catch {
      configured = false;
    }
    if (!configured) return;
    const usable = rows.filter((r) => r.status === 'ok' || r.status === 'skipped');
    if (!shouldAskAi(slot, usable.map((r) => r.score))) return;
    this.aiTried.add(k);
    const cands = usable.slice(0, 6).map((r) => ({ id: r.video_id, title: r.title, channel: r.channel, duration: r.duration }));
    void (async () => {
      try {
        const p = await ai.pick(target, slot, cands);
        if (!cands.some((c) => c.id === p.id)) return;
        // L'utilisateur a déjà choisi (suivante, pas pertinente…) : son choix l'emporte.
        if (this.d.db.get("SELECT 1 FROM word_videos WHERE target=? AND slot=? AND video_id<>? AND status IN ('skipped','hidden','broken')", [target, slot, SEARCHED])) return;
        // L'élue passe en tête (rang -1) pour l'affichage SUIVANT ; pas d'événement : la vidéo déjà à l'écran ne
        // change pas sous les yeux de l'utilisateur.
        this.d.db.run("UPDATE word_videos SET rank=-1, source='ai', start=? WHERE target=? AND slot=? AND video_id=? AND status='ok'", [
          p.startSec && p.startSec > 0 ? Math.floor(p.startSec) : null,
          target,
          slot,
          p.id,
        ]);
      } catch (e) {
        this.d.log?.('[video] IA', e instanceof Error ? e.message : e);
      }
    })();
  }
}

// ---------------------------------------------------------------- dépendances réelles
/** Index pré-calculé, chargé une fois (absent → index vide). */
export function loadIndex(dataDir: string): () => WordVideoIndex {
  let idx: WordVideoIndex | null = null;
  return () => {
    if (!idx) {
      try {
        idx = parseIndex(JSON.parse(fs.readFileSync(path.join(dataDir, 'word-videos.json'), 'utf8')));
      } catch {
        idx = parseIndex(null);
      }
    }
    return idx;
  };
}

export function loadChannels(contentDir: string): () => Record<string, ChannelInfo> {
  let ch: Record<string, ChannelInfo> | null = null;
  return () => {
    if (!ch) {
      ch = {};
      try {
        const cat = JSON.parse(fs.readFileSync(path.join(contentDir, 'catalog', 'word-video-channels.json'), 'utf8')) as ChannelInfo[];
        for (const c of cat) if (c.channelId) ch[c.channelId] = c;
      } catch {
        /* catalogue absent : scores sans poids de chaîne */
      }
    }
    return ch;
  };
}

/** `yt-dlp -J --flat-playlist "ytsearch10:<q>"` — métadonnées seulement, jamais de téléchargement. */
export function ytSearch(binDir: string, cookiesBrowser?: () => string | undefined, n = 10): (query: string) => Promise<Entry[]> {
  return async (query) => {
    const bin = findBin(binDir, 'yt-dlp');
    if (!bin) throw new Error('yt-dlp introuvable');
    const args = ['--no-warnings', '--no-color', '--ignore-config', ...jsRuntimeArgs(), '-J', '--flat-playlist'];
    const cb = cookiesBrowser?.();
    if (cb) args.push('--cookies-from-browser', cb);
    args.push(`ytsearch${n}:${query}`);
    // Message BRUT (403/429, cookies, réseau…) : classé par classifyYtError, traduit par stopMessage.
    const r = await runOk(bin, args, { timeoutMs: 60_000, env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : undefined });
    try {
      return parseSearchEntries(JSON.parse(r.stdout));
    } catch (e) {
      throw new Error(`réponse yt-dlp illisible : ${e instanceof Error ? e.message : String(e)}`);
    }
  };
}
