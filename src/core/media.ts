// Pure logic of the video / mission module (no Electron): coverage projection, recommendation score,
// RSS parsing, parsing of external tool output. Tested in tests/media.test.ts.
import type { Token } from '../shared/types';
import type { RssEpisode } from '../shared/media';

export type WordSt = 'known' | 'learning' | 'ignored' | undefined;

// ---------------------------------------------------------------- coverage projection

/** Occurrences of each Chinese word in a transcript. */
export function tokenCounts(lines: Token[][]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) for (const t of l) if (t.han) m.set(t.t, (m.get(t.t) ?? 0) + 1);
  return m;
}

/** Coverage (known + learning + proper nouns) / total, same rules as analyseCoverage. */
export function coverageFromCounts(counts: Map<string, number>, status: (w: string) => WordSt, isProperNoun?: (w: string) => boolean): number {
  let total = 0;
  let ok = 0;
  for (const [w, n] of counts) {
    total += n;
    if (status(w) || isProperNoun?.(w)) ok += n;
  }
  return total ? ok / total : 1;
}

/** Status function where the given upcoming curriculum words are counted as 'learning'. */
export function projectStatus(base: (w: string) => WordSt, upcoming: Iterable<string>): (w: string) => WordSt {
  const up = new Set(upcoming);
  return (w) => base(w) ?? (up.has(w) ? 'learning' : undefined);
}

/**
 * Projected coverage day by day: at J+d the next `perDay × d` curriculum words are counted as 'learning'.
 * `upcoming` = next curriculum words in order (at least perDay × maxDays of them).
 */
export function projectCoverageSeries(
  counts: Map<string, number>,
  base: (w: string) => WordSt,
  upcoming: string[],
  perDay: number,
  maxDays: number,
  isProperNoun?: (w: string) => boolean,
): { days: number; coverage: number }[] {
  const out: { days: number; coverage: number }[] = [];
  // Incremental: walk the upcoming list once, adding the tokens they cover.
  let total = 0;
  let ok = 0;
  for (const [w, n] of counts) {
    total += n;
    if (base(w) || isProperNoun?.(w)) ok += n;
  }
  if (!total) return Array.from({ length: maxDays + 1 }, (_, d) => ({ days: d, coverage: 1 }));
  const seen = new Set<string>();
  let i = 0;
  for (let d = 0; d <= maxDays; d++) {
    const limit = Math.min(upcoming.length, Math.round(perDay * d));
    for (; i < limit; i++) {
      const w = upcoming[i];
      if (seen.has(w)) continue;
      seen.add(w);
      if (!base(w) && !isProperNoun?.(w)) ok += counts.get(w) ?? 0;
    }
    out.push({ days: d, coverage: ok / total });
  }
  return out;
}

/** Projected coverage at J+days. */
export function projectedCoverageAt(
  counts: Map<string, number>,
  base: (w: string) => WordSt,
  upcoming: string[],
  perDay: number,
  days: number,
  isProperNoun?: (w: string) => boolean,
): number {
  const s = projectCoverageSeries(counts, base, upcoming, perDay, days, isProperNoun);
  return s[s.length - 1].coverage;
}

/** First day at which the projected coverage reaches `threshold` (null if never within the series). */
export function readyInDays(series: { days: number; coverage: number }[], threshold = 0.9): number | null {
  for (const p of series) if (p.coverage >= threshold) return p.days;
  return null;
}

/**
 * Days of briefing needed to pre-teach `nNew` words when half of the daily new-word budget goes to the mission.
 * Always at least 1 (one night between briefing and field work so that memory consolidates).
 */
export function briefingDays(nNew: number, newWordsPerDay: number): number {
  const perDay = Math.max(1, newWordsPerDay / 2);
  return Math.max(1, Math.ceil(nNew / perDay));
}

// ---------------------------------------------------------------- recommendation score

export interface RecInput {
  projected3: number | null; // couverture projetée à J+3 (null = sous-titres pas encore analysés)
  durationSec: number | null;
  phase: number; // phase actuelle de l'apprenant
  sourcePhases: number[]; // phases conseillées pour la source
  themes: string[];
  interests: string[];
  watched?: number;
  hasMission?: boolean;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();

/** Number of themes that match an interest (substring match, accents ignored). */
export function themeMatches(themes: string[], interests: string[]): number {
  const it = interests.map(norm).filter(Boolean);
  let n = 0;
  for (const t of themes.map(norm)) if (t && it.some((i) => t.includes(i) || i.includes(t))) n++;
  return n;
}

/** Score in [0,1] for i+1 coverage: peak at 95 %, falls fast below, slowly above (too easy). */
export function coverageScore(p: number): number {
  if (p >= 0.95) return Math.max(0, 1 - (p - 0.95) * 4);
  return Math.max(0, 1 - (0.95 - p) / 0.2);
}

export function durationScore(sec: number | null, phase: number): number {
  if (!sec) return 0.5;
  const min = sec / 60;
  if (phase <= 1) return min <= 5 ? 1 : min <= 10 ? 0.75 : min <= 20 ? 0.4 : 0.15;
  if (phase === 2) return min <= 15 ? 1 : min <= 30 ? 0.7 : 0.4;
  return min <= 60 ? 1 : 0.7;
}

export function phaseScore(phase: number, sourcePhases: number[]): number {
  if (!sourcePhases.length) return 0.5;
  const d = Math.min(...sourcePhases.map((p) => Math.abs(p - phase)));
  return d === 0 ? 1 : d === 1 ? 0.5 : 0.1;
}

export function recommendationScore(i: RecInput): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  const cov = i.projected3 == null ? 0.35 : coverageScore(i.projected3);
  if (i.projected3 != null) {
    if (i.projected3 >= 0.93 && i.projected3 <= 0.98) reasons.push('Couverture idéale (i+1) d\'ici 3 jours');
    else if (i.projected3 > 0.98) reasons.push('Presque tout est connu : bonne révision');
    else if (i.projected3 < 0.8) reasons.push('Encore difficile : beaucoup de mots inconnus');
  } else reasons.push('Couverture inconnue : récupère les sous-titres');
  const dur = durationScore(i.durationSec, i.phase);
  if (i.durationSec && dur >= 0.75) reasons.push('Format court, adapté à ta phase');
  const ph = phaseScore(i.phase, i.sourcePhases);
  if (ph === 1) reasons.push('Source conseillée pour ta phase');
  const tm = themeMatches(i.themes, i.interests);
  const th = i.interests.length ? Math.min(1, tm / 1) : 0.5;
  if (tm > 0) reasons.push('Correspond à tes centres d\'intérêt');
  let score = 0.45 * cov + 0.2 * dur + 0.2 * ph + 0.15 * th;
  if (i.watched) score *= 0.3;
  if (i.hasMission) score *= 0.6; // déjà en préparation : moins utile de la recommander
  return { score: Math.round(score * 1000) / 1000, reasons };
}

// ---------------------------------------------------------------- dictionary helpers

/**
 * Proper noun heuristic from a CC-CEDICT style entry: capitalised pinyin (CEDICT convention for names)
 * and English definitions starting with a capital letter or "surname". Single characters must be
 * surname-only (王, 张… also have common meanings).
 */
export function looksProperNoun(word: string, pinyin: string | undefined, en: string[] | undefined): boolean {
  if (!en || !en.length || !pinyin) return false;
  if (!/^[A-Z]/.test(pinyin.trim())) return false;
  const first = en[0].trim();
  if ([...word].length === 1) return en.every((e) => /\bsurname\b/i.test(e));
  if (/\bsurname\b/i.test(first)) return true;
  return /^[A-Z]/.test(first) && !/^I\b/.test(first);
}

// ---------------------------------------------------------------- YouTube / tool output parsing

export function youtubeId(url: string): string | null {
  const m =
    url.match(/[?&]v=([A-Za-z0-9_-]{11})/) ||
    url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/) ||
    url.match(/youtube\.com\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

/** True when the URL points to a list of videos (channel / playlist) rather than one video. */
export function isYoutubeCollection(url: string): boolean {
  if (!/youtube\.com|youtu\.be/.test(url)) return false;
  if (youtubeId(url)) return false;
  return /[?&]list=|\/@|\/channel\/|\/c\/|\/user\//.test(url);
}

/** `[download]  42.3% of ...` → 42.3 */
export function parseYtdlpProgress(line: string): number | null {
  const m = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
  return m ? +m[1] : null;
}

/** `whisper_print_progress_callback: progress =  35%` → 35 */
export function parseWhisperProgress(line: string): number | null {
  const m = line.match(/progress\s*=\s*(\d+)%/);
  // whisper.cpp reports > 100 % when an initial prompt is used: clamp.
  return m ? Math.min(100, +m[1]) : null;
}

/** `Duration: 00:01:23.45,` in ffmpeg stderr → 83.45 */
export function parseFfmpegDuration(stderr: string): number {
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0;
}

/** ffmpeg progress `time=00:00:12.34` → 12.34 */
export function parseFfmpegTime(line: string): number | null {
  const m = line.match(/time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null;
}

/** "1:02:03", "12:34", "754" → seconds */
export function parseDurationStr(s: string | undefined | null): number {
  if (!s) return 0;
  const t = s.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(+t);
  const parts = t.split(':').map((x) => +x);
  if (parts.some((x) => Number.isNaN(x))) return 0;
  return parts.reduce((a, b) => a * 60 + b, 0);
}

export interface SubTrackInfo {
  subtitles: string[]; // langues des sous-titres manuels
  auto: string[]; // langues des sous-titres automatiques
  language?: string | null; // langue de la vidéo
}

const ZH_PRIORITY = ['zh-Hans', 'zh-CN', 'zh-SG', 'zh', 'zh-Hant', 'zh-TW', 'zh-HK'];
const zhRank = (l: string) => {
  const base = l.replace(/-orig$/, '');
  const i = ZH_PRIORITY.indexOf(base);
  return i < 0 ? (base.startsWith('zh') ? ZH_PRIORITY.length : 99) : i;
};

/**
 * Choose which Chinese subtitle track to request.
 * Manual subtitles first. For automatic captions, only accept Chinese ASR (original language),
 * never YouTube's machine translation of another language (auto-translated tracks are useless for learning).
 */
export function chooseSubTrack(info: SubTrackInfo): { lang: string; source: 'cc' | 'auto' } | null {
  const manual = info.subtitles.filter((l) => l.startsWith('zh')).sort((a, b) => zhRank(a) - zhRank(b));
  if (manual.length) return { lang: manual[0], source: 'cc' };
  const auto = info.auto.filter((l) => l.startsWith('zh'));
  const orig = auto.filter((l) => l.endsWith('-orig')).sort((a, b) => zhRank(a) - zhRank(b));
  if (orig.length) return { lang: orig[0], source: 'auto' };
  // No "-orig" marker anywhere: if the video language is Chinese, the zh auto track is the ASR one.
  const anyOrig = info.auto.some((l) => l.endsWith('-orig'));
  if (!anyOrig && (info.language ?? '').startsWith('zh') && auto.length) {
    return { lang: auto.sort((a, b) => zhRank(a) - zhRank(b))[0], source: 'auto' };
  }
  return null;
}

/** Is the language tag a traditional-script variant? */
export function isTraditionalTag(lang: string): 'tw' | 'hk' | 't' | null {
  const l = lang.replace(/-orig$/, '');
  if (/^zh-(TW|Hant-TW)$/i.test(l)) return 'tw';
  if (/^zh-(HK|MO|Hant-HK)$/i.test(l)) return 'hk';
  if (/^zh-Hant/i.test(l)) return 't';
  return null;
}

// ---------------------------------------------------------------- transcript post-processing

/** ASCII punctuation next to Chinese characters → full-width (Whisper often outputs "," and "?"). */
export function normalizeZhPunct(s: string): string {
  const map: Record<string, string> = { ',': '，', '?': '？', '!': '！', ':': '：', ';': '；', '.': '。' };
  return s
    .replace(/(\p{Script=Han})\s*([,?!:;.])(?!\d)/gu, (_, h, p) => h + map[p])
    .replace(/\s+(?=[，。？！：；])/g, '')
    .trim();
}

/**
 * Split long cues at sentence / clause punctuation, distributing the time proportionally to the number
 * of characters. Keeps lines short enough for sentence-by-sentence work (shadowing, mining).
 */
export function splitLongCues<T extends { start: number; end: number; text: string }>(cues: T[], maxChars = 24): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  for (const c of cues) {
    const text = c.text.trim();
    if ([...text].length <= maxChars) {
      out.push({ start: c.start, end: c.end, text });
      continue;
    }
    // sentences first (。！？), then clauses (，；：) if still too long
    const sentences = text.match(/[^。！？!?]+[。！？!?]*/g) ?? [text];
    const parts: string[] = [];
    for (const snt of sentences) {
      if ([...snt].length <= maxChars) {
        parts.push(snt);
        continue;
      }
      let cur = '';
      for (const cl of snt.match(/[^，；：,;:]+[，；：,;:]*/g) ?? [snt]) {
        if (cur && [...cur].length + [...cl].length > maxChars) {
          parts.push(cur);
          cur = '';
        }
        cur += cl;
      }
      if (cur) parts.push(cur);
    }
    // merge tiny fragments into their predecessor
    const merged: string[] = [];
    for (const p of parts.map((x) => x.trim()).filter(Boolean)) {
      if (merged.length && [...p].length < 4 && [...merged[merged.length - 1]].length + [...p].length <= maxChars + 6) merged[merged.length - 1] += p;
      else merged.push(p);
    }
    const total = merged.reduce((a, p) => a + [...p].length, 0) || 1;
    let t = c.start;
    for (const p of merged) {
      const d = ((c.end - c.start) * [...p].length) / total;
      out.push({ start: Math.round(t * 1000) / 1000, end: Math.round((t + d) * 1000) / 1000, text: p });
      t += d;
    }
  }
  return out;
}

// ---------------------------------------------------------------- RSS

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function tag(xml: string, name: string): string | null {
  const re = new RegExp(`<${name.replace(':', '\\:')}(?:\\s[^>]*)?>([\\s\\S]*?)</${name.replace(':', '\\:')}>`, 'i');
  const m = xml.match(re);
  return m ? decodeEntities(m[1]).trim() : null;
}

function attr(xml: string, name: string, at: string): string | null {
  const re = new RegExp(`<${name.replace(':', '\\:')}\\b[^>]*?\\b${at}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i');
  const m = xml.match(re);
  return m ? decodeEntities(m[2] ?? m[3] ?? '') : null;
}

const stripHtml = (s: string) =>
  decodeEntities(s.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

/** Minimal RSS 2.0 / iTunes podcast parser (no XML library needed). */
export function parseRss(xml: string): { title: string; image: string | null; episodes: RssEpisode[] } {
  const channelHead = xml.split(/<item[\s>]/i)[0];
  const title = tag(channelHead, 'title') ?? 'Podcast';
  const image = attr(channelHead, 'itunes:image', 'href') ?? tag(tag(channelHead, 'image') ?? '', 'url');
  const episodes: RssEpisode[] = [];
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  for (const it of items) {
    const url = attr(it, 'enclosure', 'url');
    if (!url) continue;
    const pd = tag(it, 'pubDate');
    const t = pd ? Date.parse(pd) : NaN;
    episodes.push({
      guid: tag(it, 'guid') ?? url,
      title: stripHtml(tag(it, 'title') ?? tag(it, 'itunes:title') ?? 'Épisode'),
      url,
      duration: parseDurationStr(tag(it, 'itunes:duration')),
      pubDate: Number.isNaN(t) ? 0 : t,
      image: attr(it, 'itunes:image', 'href') ?? image ?? null,
      description: stripHtml(tag(it, 'description') ?? tag(it, 'itunes:summary') ?? '').slice(0, 400),
    });
  }
  episodes.sort((a, b) => b.pubDate - a.pubDate);
  return { title: stripHtml(title), image: image ?? null, episodes };
}

/** Small stable hash (FNV-1a, hex) for ids derived from paths / URLs. */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let h2 = 0x12345678;
  for (let i = s.length - 1; i >= 0; i--) {
    h2 ^= s.charCodeAt(i);
    h2 = Math.imul(h2, 0x5bd1e995);
  }
  return ((h >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')).slice(0, 14);
}

// ------------------------------------------------------------------ player line tracking
type Span = { start: number; end: number };

/** Index of the line being played at time t: last segment whose start ≤ t (binary search), -1 before the first. */
export function segmentAt(segs: Span[], t: number): number {
  let lo = 0;
  let hi = segs.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid].start <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/**
 * Line-by-line mode: which line should trigger the next automatic pause after the current line changed to `i`.
 * A line that is still armed and has not ended keeps priority (overlapping cues), so its end pause is never lost.
 */
export function armLine(segs: Span[], armed: number | null, i: number, t: number): number | null {
  const a = armed != null ? segs[armed] : undefined;
  if (a && t >= a.start - 0.05 && t < a.end) return armed;
  return i >= 0 && t < segs[i].end ? i : null;
}

/** Playback step of the line-by-line mode (pure: the player applies the result). */
export function lineStep(segs: Span[], armed: number | null, prevIdx: number, t: number): { pauseAt: number | null; armed: number | null; idx: number; seekTo?: number } {
  if (armed != null && segs[armed] && t >= segs[armed].end) {
    // Pause on the line that just ended, which stays current (overlapping cues: the next one already started);
    // step back a hair so the playhead is inside it (contiguous cues: its end is the next line's start).
    const s = segs[armed];
    const seekTo = Math.max(s.start, s.end - 0.01);
    return { pauseAt: armed, armed: null, idx: armed, seekTo };
  }
  const idx = segmentAt(segs, t);
  return { pauseAt: null, armed: idx !== prevIdx ? armLine(segs, armed, idx, t) : armed, idx };
}
