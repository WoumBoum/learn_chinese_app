// Une vidéo YouTube par mot / caractère — logique pure (sans E/S, sans horloge implicite, sans aléa).
// Score : port 1:1 de scripts/lib/word-video-score.mjs (spécification docs/word-videos.md §4) ; toute modification
// du score doit être faite dans LES DEUX fichiers (test de parité : tests/wordVideos.test.ts).
// En plus : lecture de l'index pré-calculé (resources/data/word-videos.json), ordre des candidats, cycle
// « vidéo suivante », libellés, limiteur de débit des recherches yt-dlp.

export type Slot = 'etymology' | 'usage';

/** py = pinyin accentué de w ; alt = graphies traditionnelles (CEDICT) acceptées dans les titres. */
export interface Target {
  w: string;
  py: string;
  slot: Slot;
  alt?: string[];
}

/** Champs utilisés d'une entrée yt-dlp `--flat-playlist -J`. */
export interface Entry {
  id: string;
  title: string;
  channel?: string | null;
  channel_id?: string | null;
  duration?: number | null;
  view_count?: number | null;
  description?: string | null;
  live_status?: string | null;
}

export interface ChannelInfo {
  channelId?: string;
  name?: string;
  weight: number;
  kind: 'etymology' | 'word' | 'mixed';
  language: string;
}

export interface Features {
  focus: number;
  pinyin: number;
  channel: number;
  slotKind: number;
  intent: number;
  duration: number;
  language: number;
  popularity: number;
}

export interface ScoreResult {
  score: number;
  f?: Features;
  neg?: boolean;
  offSlot?: boolean;
  rejected?: 'live' | 'target-not-in-title' | 'japanese' | 'blocked-channel';
}

export interface Ranked extends ScoreResult {
  entry: Entry;
}

export const HAN = /[㐀-鿿豈-﫿]/g;
const DELIMS = '[]【】「」『』“”"\'‘’()（）《》<>:：|｜/\\-–—_#,，.。!！?？ \t';

export const W: Features = {
  focus: 0.3,
  pinyin: 0.12,
  channel: 0.22,
  slotKind: 0.06,
  intent: 0.12,
  duration: 0.1,
  language: 0.04,
  popularity: 0.04,
};

const INTENT: Record<Slot, RegExp> = {
  etymology:
    /字源|字源|說文|说文|演变|演變|甲骨文|金文|象形|会意|會意|形声|形聲|origin|etymolog|\bevolution|story of|histoire|origine|pictogra|oracle|漢字的故事|汉字的故事|汉字趣谈|漢字趣談|造字|字的故事|primitive/i,
  usage: /例句|用法|怎么用|怎麼用|example|sentence|how to (use|say)|word of the day|每日一词|每日一詞|meaning|vocabulary|vocabulaire|signifie|phrases?|exemple|pronounce|dialogue/i,
};
const NEGATIVE =
  /podcast|英语|英語|英文|日文|日语|日語|한국어|韓語|vietsub|tiếng|sample (paper|exam)|样卷|樣卷|mock test|汉语水平考试|\btest\b|\bexam\b|\blive\b|直播|full course|compilation|合集|八卦|娱乐|娛樂|\bnews\b|新闻|新聞/i;
const JAPANESE = /[぀-ヿ]|kanji|JLPT|on'yomi|kun'yomi/i;

export function stripTones(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ü/g, 'v').toLowerCase();
}

export function latinNorm(s: string): string {
  return ` ${stripTones(s).replace(/[0-9]/g, '').replace(/[^a-zv]+/g, ' ').trim()} `;
}

export function pinyinHit(py: string, text: string): boolean {
  const syl = latinNorm(py).trim();
  if (!syl) return false;
  const t = latinNorm(text);
  const compact = syl.replace(/ /g, '');
  return t.includes(` ${syl} `) || t.includes(` ${compact} `);
}

export function hanChars(s: string): string[] {
  return [...new Set(s.match(HAN) ?? [])];
}

const isHanCh = (ch: string): boolean => /[㐀-鿿豈-﫿]/.test(ch);

export function focusScore(w: string, title: string): number {
  if (!title.includes(w)) return 0;
  let delimited = false;
  let isolated = false;
  for (let i = title.indexOf(w); i >= 0; i = title.indexOf(w, i + 1)) {
    const before = i === 0 ? ' ' : title[i - 1];
    const after = i + w.length >= title.length ? ' ' : title[i + w.length];
    if (!isHanCh(before) && !isHanCh(after)) isolated = true;
    if (DELIMS.includes(before) && DELIMS.includes(after)) delimited = true;
  }
  const others = hanChars(title).filter((c) => !w.includes(c)).length;
  const base = others <= 4 ? 1 : Math.max(0, 1 - (others - 4) / 16);
  const listLike = (title.match(/(?:^|[\s、,，/])[㐀-鿿](?=$|[\s、,，/])/g) ?? []).length >= 3;
  const v = delimited && !listLike ? Math.max(0.6, base) : base * 0.8;
  return (isolated ? v : v * 0.4) * (listLike ? 0.5 : 1);
}

export function durationScore(d: number | null | undefined): number {
  if (d == null || !(d > 0)) return 0.3;
  if (d < 12) return 0;
  if (d < 40) return (d - 12) / 28;
  if (d <= 420) return 1;
  if (d >= 1200) return 0;
  return 1 - (d - 420) / 780;
}

export function languageScore(title: string, channelLang?: string): number {
  if (channelLang === 'fr' || /\b(caract[eè]re|chinois|apprendre|le|la|les|du|des|signifie)\b/i.test(title)) return 1;
  if (channelLang === 'en' || /[a-z]{3,}/i.test(title)) return 0.6;
  return 0.3;
}

export function scoreCandidate(target: Target, e: Entry, channels: Record<string, ChannelInfo> = {}): ScoreResult {
  const title = e.title ?? '';
  const desc = e.description ?? '';
  if (e.live_status === 'is_live' || e.live_status === 'is_upcoming') return { score: 0, rejected: 'live' };
  const forms = [target.w, ...(target.alt ?? [])].filter((x) => x && title.includes(x));
  if (!forms.length) return { score: 0, rejected: 'target-not-in-title' };
  if (JAPANESE.test(title)) return { score: 0, rejected: 'japanese' };
  const ch = (e.channel_id && channels[e.channel_id]) || null;
  if (ch && ch.weight <= 0) return { score: 0, rejected: 'blocked-channel' };
  const f: Features = {
    focus: Math.max(...forms.map((x) => focusScore(x, title))),
    pinyin: pinyinHit(target.py, title) ? 1 : pinyinHit(target.py, desc) ? 0.5 : 0,
    channel: ch ? ch.weight : 0,
    slotKind: ch ? (ch.kind === 'mixed' ? 0.5 : ch.kind === (target.slot === 'etymology' ? 'etymology' : 'word') ? 1 : 0) : 0,
    intent: INTENT[target.slot].test(title) ? 1 : INTENT[target.slot].test(desc) ? 0.5 : 0,
    duration: durationScore(e.duration),
    language: languageScore(title, ch?.language),
    popularity: Math.min(1, Math.log10((e.view_count ?? 0) + 1) / 6),
  };
  let score = 0;
  for (const k of Object.keys(W) as (keyof Features)[]) score += W[k] * f[k];
  const neg = NEGATIVE.test(title);
  if (neg) score *= 0.3;
  const offSlot = f.intent === 0 && (target.slot === 'etymology' ? ch?.kind !== 'etymology' : ch?.kind === 'etymology');
  if (offSlot) score *= 0.7;
  return { score: Math.round(score * 1000) / 1000, f, neg, offSlot };
}

export function rankCandidates(target: Target, entries: Entry[], channels: Record<string, ChannelInfo> = {}, min = 0.35): Ranked[] {
  const best = new Map<string, Ranked>();
  for (const e of entries) {
    const r = scoreCandidate(target, e, channels);
    if (!(r.score >= min)) continue;
    const prev = best.get(e.id);
    if (!prev || prev.score < r.score) best.set(e.id, { ...r, entry: e });
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
}

export interface PlannedQuery {
  slot: Slot;
  target: string;
  query: string;
}

export function queriesFor(w: string, py: string): PlannedQuery[] {
  const chars = hanChars(w);
  const q: PlannedQuery[] = [];
  for (const c of chars) {
    q.push({ slot: 'etymology', target: c, query: `${c} Chinese character origin` });
    q.push({ slot: 'etymology', target: c, query: `${c} caractère chinois` });
  }
  q.push({ slot: 'usage', target: w, query: `${w} caractère chinois` });
  q.push({ slot: 'usage', target: w, query: `${w} ${stripTones(py).replace(/\s+/g, '')} Chinese word meaning example` });
  return q;
}

/** Requêtes d'une seule cible (mot → usage, caractère → etymology). */
export function queriesForTarget(target: string, slot: Slot, py: string): string[] {
  return queriesFor(target, py)
    .filter((q) => q.slot === slot && q.target === target)
    .map((q) => q.query);
}

// ---------------------------------------------------------------- ordre / sélection (partagé index + recherche)
/** Candidats de l'emplacement d'abord (par score), puis replis `offSlot` ; dédoublonné par id ; `max` premiers. */
export function orderForSlot<T extends { offSlot?: boolean; score: number; id: string }>(xs: T[], max = Infinity): T[] {
  const seen = new Set<string>();
  const out = xs.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
  out.sort((a, b) => Number(!!a.offSlot) - Number(!!b.offSlot) || b.score - a.score || a.id.localeCompare(b.id));
  return out.slice(0, max);
}

/** Titre normalisé (casse, espaces, ponctuation ignorés) pour repérer les doublons d'une même chaîne. */
export function titleKey(title: string): string {
  return title.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** Deux vidéos d'une même chaîne sur la même cible dont les durées diffèrent d'au plus 2 s : même vidéo republiée. */
export const DUP_DURATION_S = 2;

/**
 * Variété pour « Vidéo suivante » : supprime les doublons d'une même chaîne (même titre normalisé, ou même durée à
 * ±2 s — Chou Meizai publie chaque animation deux fois, titre anglais et titre chinois), puis au plus `perChannel`
 * vidéos par chaîne parmi les `max` premières (complété avec les autres s'il en manque). L'ordre est conservé.
 * Même algorithme que scripts/build-word-videos.mjs.
 */
export function diversify<T extends { channel: string; title: string; duration?: number | null }>(xs: T[], max: number, perChannel = 2): T[] {
  const kept: T[] = [];
  const uniq = xs.filter((x) => {
    const tk = titleKey(x.title);
    const d = Number(x.duration) || 0;
    const dup = kept.some(
      (y) => y.channel === x.channel && (titleKey(y.title) === tk || (d > 0 && (Number(y.duration) || 0) > 0 && Math.abs((Number(y.duration) || 0) - d) <= DUP_DURATION_S)),
    );
    if (!dup) kept.push(x);
    return !dup;
  });
  const n = new Map<string, number>();
  const first: T[] = [];
  const rest: T[] = [];
  for (const x of uniq) {
    const c = n.get(x.channel) ?? 0;
    if (c < perChannel && first.length < max) {
      first.push(x);
      n.set(x.channel, c + 1);
    } else rest.push(x);
  }
  const keep = new Set([...first, ...rest.slice(0, Math.max(0, max - first.length))]);
  return uniq.filter((x) => keep.has(x));
}

/** La cible apparaît-elle seule (pas à l'intérieur d'un mot) ? Les caractères de `own` (ses graphies) ne comptent pas comme voisins. */
export function isolatedIn(w: string, title: string, own: string[] = []): boolean {
  const near = (ch: string) => isHanCh(ch) && !own.includes(ch);
  for (let i = title.indexOf(w); i >= 0; i = title.indexOf(w, i + 1)) {
    const before = i === 0 ? ' ' : title[i - 1];
    const after = i + w.length >= title.length ? ' ' : title[i + w.length];
    if (!near(before) && !near(after)) return true;
  }
  return false;
}

/**
 * Après le score (sans toucher au score de référence) : sur l'emplacement « origine », une vidéo dont le caractère
 * n'apparaît qu'à l'intérieur d'un mot (機器人, 故事, 起源, 为什么…) parle d'autre chose que de ce caractère ; elle
 * devient un repli `offSlot` (×0,7) au lieu d'être présentée comme « Origine du caractère ».
 * Même algorithme que refineOffSlot() de scripts/build-word-videos.mjs.
 */
export function refineOffSlot<T extends { score: number; offSlot?: boolean; entry: Entry }>(target: Target, ranked: T[], min = 0.35): T[] {
  if (target.slot !== 'etymology') return ranked;
  const forms = [target.w, ...(target.alt ?? [])].filter(Boolean);
  return ranked
    .map((r) => {
      if (r.offSlot) return r;
      const title = String(r.entry.title ?? '');
      if (forms.some((x) => isolatedIn(x, title, forms))) return r;
      return { ...r, offSlot: true, score: Math.round(r.score * 700) / 1000 };
    })
    .filter((r) => r.score >= min)
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
}

/**
 * Mot d'un seul caractère : les deux emplacements viennent du même lot ; éviter la même vidéo en tête
 * (§4.4 : prendre le 2ᵉ choix pour « usage » s'il est identique au 1ᵉʳ « origine »).
 */
export function avoidSameTop<T extends { id: string }>(usage: T[], etymologyTopId: string | undefined): T[] {
  if (!etymologyTopId || usage.length < 2 || usage[0].id !== etymologyTopId) return usage;
  return [usage[1], usage[0], ...usage.slice(2)];
}

// ---------------------------------------------------------------- index pré-calculé (resources/data/word-videos.json)
/** [id, titre, durée (s), indice de chaîne, score × 1000, offSlot (1) ?] */
export type IndexRow = [string, string, number, number, number, (0 | 1)?];
export interface WordVideoIndex {
  v: 1;
  generated: string;
  channels: string[];
  t: Record<string, IndexRow[]>;
  /** graphies traditionnelles des caractères (CEDICT) */
  alt?: Record<string, string[]>;
}

export interface VideoCandidate {
  id: string;
  title: string;
  channel: string;
  duration: number;
  score: number;
  offSlot: boolean;
}

export function targetKey(target: string, slot: Slot): string {
  return `${slot === 'usage' ? 'u' : 'e'}:${target}`;
}

export function parseIndex(x: unknown): WordVideoIndex {
  const o = (x ?? {}) as Partial<WordVideoIndex>;
  if (o.v !== 1 || !o.t || typeof o.t !== 'object' || !Array.isArray(o.channels)) return { v: 1, generated: '', channels: [], t: {} };
  const alt = o.alt && typeof o.alt === 'object' ? o.alt : {};
  return { v: 1, generated: String(o.generated ?? ''), channels: o.channels.map(String), t: o.t, alt };
}

/** Graphies traditionnelles d'une cible : variantes du caractère, ou mot recomposé avec la 1ʳᵉ variante de chaque caractère. */
export function altFor(target: string, alt: Record<string, string[]> = {}): string[] {
  const chars = [...target];
  if (chars.length === 1) return alt[target] ?? [];
  const t = chars.map((c) => alt[c]?.[0] ?? c).join('');
  return t !== target ? [t] : [];
}

export function indexLookup(idx: WordVideoIndex, target: string, slot: Slot): VideoCandidate[] {
  const rows = idx.t[targetKey(target, slot)];
  if (!Array.isArray(rows)) return [];
  const out: VideoCandidate[] = [];
  for (const r of rows) {
    if (!Array.isArray(r) || typeof r[0] !== 'string' || !/^[\w-]{11}$/.test(r[0])) continue;
    out.push({ id: r[0], title: String(r[1] ?? ''), channel: idx.channels[r[3]] ?? '', duration: Number(r[2]) || 0, score: (Number(r[4]) || 0) / 1000, offSlot: r[5] === 1 });
  }
  return out;
}

// ---------------------------------------------------------------- cycle « vidéo suivante » / « pas pertinente »
export type VideoStatus = 'ok' | 'skipped' | 'hidden' | 'broken';
export interface CycleRow {
  id: string;
  rank: number;
  status: VideoStatus | string;
}

/** Vidéo courante : premier rang `ok` ; si toutes les utilisables sont « passées », on recommence au début. */
export function currentOf<T extends CycleRow>(rows: T[]): T | null {
  const usable = rows.filter((r) => r.status === 'ok' || r.status === 'skipped').sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  return usable.find((r) => r.status === 'ok') ?? usable[0] ?? null;
}

/**
 * Effet de « Vidéo suivante » : nouveaux statuts {id → statut}. La vidéo courante devient `skipped` ; si plus
 * aucune n'est `ok`, toutes les `skipped` sauf celle-ci redeviennent `ok` (on boucle).
 */
export function skipCurrent<T extends CycleRow>(rows: T[]): Map<string, VideoStatus> {
  const cur = currentOf(rows);
  const changes = new Map<string, VideoStatus>();
  if (!cur) return changes;
  changes.set(cur.id, 'skipped');
  const okLeft = rows.some((r) => r.id !== cur.id && r.status === 'ok');
  if (!okLeft) for (const r of rows) if (r.id !== cur.id && r.status === 'skipped') changes.set(r.id, 'ok');
  return changes;
}

export function usableCount(rows: CycleRow[]): number {
  return rows.filter((r) => r.status === 'ok' || r.status === 'skipped').length;
}

// ---------------------------------------------------------------- libellés (FR)
const WRITING = /how to write|stroke|笔顺|筆順|笔画|筆畫|écrire|ecrire|calligraph|书法|書法/i;
export function slotLabel(slot: Slot, offSlot: boolean, title = ''): string {
  if (!offSlot) return slot === 'etymology' ? 'Origine du caractère' : 'Le mot en contexte';
  if (slot === 'usage') return 'Origine du caractère';
  return WRITING.test(title) ? 'Écriture' : 'Le caractère en vidéo';
}

/**
 * Choix IA utile ? Seulement quand les règles hésitent : ≥ 2 candidats et deux premiers scores proches (les deux
 * emplacements). Évite un appel payant à chaque mot affiché.
 */
export function shouldAskAi(_slot: Slot, scores: number[], closeDelta = 0.05): boolean {
  if (scores.length < 2) return false;
  const [a, b] = [...scores].sort((x, y) => y - x);
  return a - b <= closeDelta;
}

/** Valide la réponse IA (objet déjà extrait) contre les candidats proposés. */
export function validateAiPick(x: unknown, candidates: { id: string; duration?: number }[]): { id: string; startSec: number | null; reason: string } {
  const o = (x && typeof x === 'object' && !Array.isArray(x) ? x : {}) as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id.trim() : '';
  const c = candidates.find((k) => k.id === id);
  if (!c) throw new Error(`id « ${id || '?'} » absent des candidats`);
  let startSec: number | null = null;
  const s = Number(o.startSec);
  if (o.startSec != null && Number.isFinite(s) && s > 0) {
    startSec = Math.floor(s);
    if (c.duration && startSec >= c.duration) startSec = null;
  }
  return { id, startSec, reason: typeof o.reason === 'string' ? o.reason.trim().slice(0, 300) : '' };
}

// ---------------------------------------------------------------- recherche yt-dlp : limiteur et erreurs
/**
 * Nature d'un échec de recherche, d'après le texte BRUT de yt-dlp (pas sa traduction FR, dont les mots
 * « introuvable » / « robot » / « cookies » brouilleraient le classement).
 *  - missing  : yt-dlp absent → arrêt pour la session ;
 *  - blocked  : 403/429/bot-check → arrêt pour la session (insister aggraverait le blocage) ;
 *  - cookies  : option « Cookies du navigateur » mal réglée → pause courte (l'utilisateur peut corriger) ;
 *  - network  : hors ligne, DNS, délai → pause (nouvel essai après quelques minutes ou au retour du réseau) ;
 *  - other    : autre échec (yt-dlp obsolète, JSON illisible, 5xx) → requête ratée, pause après plusieurs d'affilée.
 */
export type YtErrorKind = 'missing' | 'blocked' | 'cookies' | 'network' | 'other';
export function classifyYtError(raw: string): YtErrorKind {
  if (/^yt-dlp introuvable|spawn \S*yt-dlp\S* ENOENT/i.test(raw)) return 'missing';
  if (/cookies database|could not find .*cookies|cookies-from-browser|failed to (?:load|decrypt|read) cookies|cookie file/i.test(raw)) return 'cookies';
  if (/HTTP Error 40[3]|HTTP Error 429|\b403\b|\b429\b|Forbidden|Too Many Requests|confirm you.?re not a bot|Sign in to confirm/i.test(raw)) return 'blocked';
  if (
    /getaddrinfo|Name or service not known|Temporary failure in name resolution|nodename nor servname|Network is unreachable|No route to host|timed out|délai dépassé|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|Connection (?:refused|reset)|Unable to download (?:webpage|API page)|urlopen error/i.test(
      raw,
    )
  )
    return 'network';
  return 'other';
}

/** Erreur qui arrête les recherches pour toute la session (yt-dlp absent, 403/429/bot-check). */
export function isStoppingYtError(raw: string): boolean {
  const k = classifyYtError(raw);
  return k === 'missing' || k === 'blocked';
}

/** Pause des recherches après un échec (ms) ; 0 = pas de pause. `streak` = échecs « other » d'affilée. */
export const NETWORK_PAUSE_MS = 10 * 60_000;
export const COOKIES_PAUSE_MS = 5 * 60_000;
export const OTHER_PAUSE_MS = 30 * 60_000;
export const OTHER_STREAK = 3;
export function pauseFor(kind: YtErrorKind, streak = 1): number {
  if (kind === 'network') return NETWORK_PAUSE_MS;
  if (kind === 'cookies') return COOKIES_PAUSE_MS;
  if (kind === 'other') return streak >= OTHER_STREAK ? OTHER_PAUSE_MS : 0;
  return 0;
}

/** Message FR affiché quand la recherche est arrêtée ou en pause (d'après le texte brut de l'échec). */
export function stopMessage(raw: string): string {
  switch (classifyYtError(raw)) {
    case 'missing':
      return 'Recherche de vidéos indisponible : yt-dlp est absent.';
    case 'blocked':
      return 'YouTube limite les recherches pour le moment : nouvel essai à la prochaine session.';
    case 'cookies':
      return 'Recherche de vidéos en pause : impossible de lire les cookies du navigateur choisi (option « Cookies du navigateur », onglet Ajouter).';
    case 'network':
      return 'Hors ligne ou YouTube injoignable : nouvel essai automatique dans quelques minutes.';
    default:
      return 'La recherche de vidéos échoue (yt-dlp à mettre à jour ?) : nouvel essai plus tard.';
  }
}

/**
 * Au plus une requête toutes les `intervalMs` (global). stop() = arrêt pour la session ; pause(ms) = arrêt
 * temporaire (réseau, cookies…), levé à l'échéance ou par resume().
 */
export class RateLimiter {
  private last = -Infinity;
  stopped: string | null = null;
  private pausedUntil = -Infinity;
  private pauseReason: string | null = null;
  constructor(
    public intervalMs = 5000,
    private now: () => number = Date.now,
  ) {}
  /** En pause en ce moment ? */
  paused(): boolean {
    return this.pauseReason != null && this.now() < this.pausedUntil;
  }
  /** Raison (texte brut) de l'arrêt ou de la pause en cours, sinon null. */
  blockedReason(): string | null {
    return this.stopped ?? (this.paused() ? this.pauseReason : null);
  }
  /** Délai (ms) avant la prochaine requête autorisée (Infinity si arrêté). */
  waitMs(): number {
    if (this.stopped) return Infinity;
    const t = this.now();
    return Math.max(0, this.last + this.intervalMs - t, this.paused() ? this.pausedUntil - t : 0);
  }
  /** Réserve le créneau si autorisé maintenant. */
  tryTake(): boolean {
    if (this.waitMs() > 0) return false;
    this.last = this.now();
    return true;
  }
  stop(reason: string): void {
    if (!this.stopped) this.stopped = reason;
  }
  pause(ms: number, reason: string): void {
    if (!(ms > 0)) return;
    this.pausedUntil = Math.max(this.paused() ? this.pausedUntil : -Infinity, this.now() + ms);
    this.pauseReason = reason;
  }
  /** Lève la pause (retour du réseau, réglage corrigé) ; l'arrêt de session reste. */
  resume(): void {
    this.pausedUntil = -Infinity;
    this.pauseReason = null;
  }
}

/** Entrées d'un `yt-dlp -J --flat-playlist "ytsearchN:…"` (ignore les entrées sans id ni titre). */
export function parseSearchEntries(json: unknown): Entry[] {
  const o = (json ?? {}) as { entries?: unknown[] };
  const out: Entry[] = [];
  for (const raw of o.entries ?? []) {
    const e = (raw ?? {}) as Record<string, unknown>;
    if (typeof e.id !== 'string' || !/^[\w-]{11}$/.test(e.id) || typeof e.title !== 'string') continue;
    out.push({
      id: e.id,
      title: e.title,
      channel: typeof e.channel === 'string' ? e.channel : typeof e.uploader === 'string' ? e.uploader : null,
      channel_id: typeof e.channel_id === 'string' ? e.channel_id : null,
      duration: typeof e.duration === 'number' ? e.duration : null,
      view_count: typeof e.view_count === 'number' ? e.view_count : null,
      description: typeof e.description === 'string' ? e.description : null,
      live_status: typeof e.live_status === 'string' ? e.live_status : null,
    });
  }
  return out;
}

/** URL d'intégration youtube-nocookie (§6.4). */
export const APP_REFERRER = 'https://app.operation-mandarin/';
export function embedUrl(id: string, start?: number | null): string {
  const p = new URLSearchParams({ enablejsapi: '1', rel: '0', playsinline: '1', cc_load_policy: '1', hl: 'fr', widget_referrer: APP_REFERRER });
  if (start && start > 0) p.set('start', String(Math.floor(start)));
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?${p.toString()}`;
}

// ---------------------------------------------------------------- lecteur intégré : erreurs, durées de vie
/**
 * Codes onError du lecteur IFrame : 100 (vidéo supprimée / privée), 101 et 150 (intégration refusée par
 * l'auteur) → la vidéo est inutilisable : « broken » (persisté, expire). 2 (paramètre), 5 (erreur HTML5) et 153
 * (configuration du client / Referer) dépendent de l'environnement : rien n'est persisté, on propose YouTube.
 */
export type PlayerErrorKind = 'broken' | 'transient' | 'ignore';
export function playerErrorKind(code: unknown): PlayerErrorKind {
  const n = Number(code);
  if (n === 100 || n === 101 || n === 150) return 'broken';
  if (n === 2 || n === 5 || n === 153) return 'transient';
  return 'ignore';
}
/** Une vidéo « broken » redevient candidate après 30 jours (blocage par IP, VPN, réglage du lecteur…). */
export const BROKEN_TTL_MS = 30 * 86_400_000;
/** Une recherche terminée (même sans résultat) est refaite après 90 jours (docs/word-videos.md §5.3). */
export const SEARCHED_TTL_MS = 90 * 86_400_000;
