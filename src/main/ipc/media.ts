// Video / podcast missions: ingestion (yt-dlp, local files, RSS), subtitles (CC, auto, Whisper),
// lexical coverage & pre-teaching, missions, recommendations, extensive listening.
import fs from 'node:fs';
import path from 'node:path';
import { app, dialog, shell, type OpenDialogOptions } from 'electron';
import { pinyin } from 'pinyin-pro';
import type { Ctx } from '../ctx';
import { handle } from '../ctx';
import { analyseCoverage } from '../../core/coverage';
import { parseSubtitles } from '../../core/subtitles';
import { isHan, segment } from '../../core/nlp';
import { addDays, dayKey, daysBetween } from '../../core/time';
import {
  briefingDays,
  chooseSubTrack,
  isTraditionalTag,
  isYoutubeCollection,
  looksProperNoun,
  normalizeZhPunct,
  splitLongCues,
  parseRss,
  projectCoverageSeries,
  projectStatus,
  readyInDays as readyIn,
  recommendationScore,
  shortHash,
  tokenCounts,
  youtubeId,
  type WordSt,
} from '../../core/media';
import type { CatalogSource, CoverageReport, Mission, PreteachWord, Token, VideoRow } from '../../shared/types';
import type {
  BinStatus,
  CoverageInfo,
  MediaKind,
  MediaPrefs,
  MediaProgress,
  MissionDetail,
  PlayerSegment,
  QuizQuestion,
  RecItem,
  RssEpisode,
  VideoInfo,
} from '../../shared/media';
import * as yt from '../services/ytdlp';
import { probe, toMp3, toWav16k } from '../services/ffmpeg';
import { ensureModel, hasModel, modelJob, transcribe as whisperTranscribe, whisperRuns, type WhisperSize } from '../services/whisper';
import { cancelDownload, downloadFile, fetchText } from '../services/http';
import { cancelJob, findBin } from '../services/proc';
import { toSimplified } from '../services/opencc';

type DbVideo = Omit<VideoRow, 'themes'> & { themes: string };
type DbMission = Omit<Mission, 'preteach'> & { preteach: string };

const DEFAULT_PREFS: MediaPrefs = { cookiesBrowser: '', whisperModel: 'small', autoDownload: true };
const PROJECTION_DAYS = 30;
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)$/i;
const MEDIA_EXT = /\.(mp4|m4v|webm|mkv|mov|avi|mp3|m4a|aac|ogg|oga|opus|wav|flac)$/i;

// ------------------------------------------------------------------ jobs & progress
const jobs = new Map<string, MediaProgress>();
const busy = new Set<string>();

function emit(ctx: Ctx, p: MediaProgress) {
  if (p.stage === 'done' || p.stage === 'error') jobs.delete(p.id);
  else jobs.set(p.id, p);
  ctx.emit('media:progress', p);
}

/** Throttled progress reporter for one job. */
function reporter(ctx: Ctx, id: string) {
  let last = 0;
  let lastStage = '';
  return (stage: MediaProgress['stage'], pct: number, message?: string) => {
    const now = Date.now();
    if (stage === lastStage && now - last < 250 && pct < 100) return;
    last = now;
    lastStage = stage;
    emit(ctx, { id, stage, pct: Math.round(pct * 10) / 10, message });
  };
}

async function exclusive<T>(ctx: Ctx, id: string, fn: () => Promise<T>): Promise<T> {
  if (busy.has(id)) throw new Error('Une opération est déjà en cours pour cet élément.');
  busy.add(id);
  try {
    const r = await fn();
    emit(ctx, { id, stage: 'done', pct: 100 });
    return r;
  } catch (e) {
    emit(ctx, { id, stage: 'error', pct: 0, message: e instanceof Error ? e.message : String(e) });
    throw e;
  } finally {
    busy.delete(id);
  }
}

// ------------------------------------------------------------------ prefs & rows
function prefs(ctx: Ctx): MediaPrefs {
  return { ...DEFAULT_PREFS, ...ctx.db.getSetting<Partial<MediaPrefs>>('mediaPrefs', {}) };
}

function ytOpts(ctx: Ctx, job?: string): yt.YtOpts {
  return { binDir: ctx.paths.bin, cookiesBrowser: prefs(ctx).cookiesBrowser || undefined, job };
}

function kindOf(v: { id: string; url: string }): MediaKind {
  if (v.id.startsWith('local-')) return 'local';
  if (v.id.startsWith('rss-')) return 'rss';
  if (v.id.startsWith('yt-') || youtubeId(v.url)) return 'youtube';
  return 'other';
}

function rawVideo(ctx: Ctx, id: string): DbVideo {
  const v = ctx.db.get<DbVideo>('SELECT * FROM videos WHERE id=?', [id]);
  if (!v) throw new Error('Vidéo introuvable');
  return v;
}

function parseThemes(s: string | null | undefined): string[] {
  try {
    const t = JSON.parse(s || '[]');
    return Array.isArray(t) ? t.map(String) : [];
  } catch {
    return [];
  }
}

function setVideo(ctx: Ctx, id: string, fields: Partial<Record<keyof DbVideo, unknown>>) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  ctx.db.run(`UPDATE videos SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE id=?`, [...keys.map((k) => fields[k as keyof DbVideo] as never), id]);
}

function base(ctx: Ctx, id: string) {
  return path.join(ctx.paths.media, id);
}

function metaFile(ctx: Ctx, id: string) {
  return base(ctx, id) + '.meta.json';
}

function readMeta<T = Record<string, unknown>>(ctx: Ctx, id: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(metaFile(ctx, id), 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeMeta(ctx: Ctx, id: string, m: Record<string, unknown>) {
  fs.writeFileSync(metaFile(ctx, id), JSON.stringify({ ...(readMeta(ctx, id) ?? {}), ...m }, null, 1));
}

// ------------------------------------------------------------------ analysis (coverage, projection)
interface Analysis {
  status: (w: string) => WordSt;
  isProper: (w: string) => boolean;
  rank: (w: string) => number;
  upcoming: string[];
  perDay: number;
}

function analysisCtx(ctx: Ctx): Analysis {
  const st = ctx.cur.wordStatus();
  const perDay = Math.max(1, ctx.settings().newWordsPerDay);
  const upcoming = ctx.cur.nextWords(Math.ceil(perDay * PROJECTION_DAYS)).map((w) => w.w);
  return {
    status: (w) => st.get(w),
    isProper: (w) => {
      if (ctx.content.wordMap.has(w)) return false;
      const d = ctx.content.dict[w];
      return !!d && looksProperNoun(w, d.p, d.e);
    },
    rank: (w) => ctx.content.wordMap.get(w)?.rank ?? 1e9,
    upcoming,
    perDay,
  };
}

const tokenCache = new Map<string, Token[][]>();

function lines(ctx: Ctx, id: string): Token[][] {
  let l = tokenCache.get(id);
  if (!l) {
    l = ctx.db.all<{ tokens: string }>('SELECT tokens FROM segments WHERE video_id=? ORDER BY idx', [id]).map((r) => JSON.parse(r.tokens) as Token[]);
    tokenCache.set(id, l);
  }
  return l;
}

function analyse(ctx: Ctx, a: Analysis, id: string): CoverageInfo | null {
  const l = lines(ctx, id);
  if (!l.length) return null;
  const report = analyseCoverage(l, { status: a.status, gloss: (w) => ctx.content.gloss(w), isProperNoun: a.isProper, rank: a.rank, target: 0.95, maxWords: 40 });
  const series = projectCoverageSeries(tokenCounts(l), a.status, a.upcoming, a.perDay, PROJECTION_DAYS, a.isProper);
  let ready = report.coverage >= 0.9 ? 0 : readyIn(series, 0.9);
  // With a mission briefing the missing words are taught directly: often much faster than waiting for the curriculum.
  if (report.afterPreteach >= 0.9) {
    const b = briefingDays(report.preteach.length, a.perDay);
    if (ready == null || b < ready) ready = b;
  }
  return { ...report, projected: series, readyInDays: ready };
}

function storeCoverage(ctx: Ctx, id: string, c: CoverageInfo | null) {
  if (!c) return;
  const p3 = c.projected[Math.min(3, c.projected.length - 1)].coverage;
  setVideo(ctx, id, { coverage: c.coverage, projected_coverage: p3 });
}

function activeMission(ctx: Ctx, videoId: string): DbMission | undefined {
  return ctx.db.get<DbMission>("SELECT * FROM missions WHERE video_id=? AND status!='done' ORDER BY created DESC LIMIT 1", [videoId]);
}

function toInfo(ctx: Ctx, v: DbVideo, a?: Analysis): VideoInfo {
  const segCount = ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM segments WHERE video_id=?', [v.id])?.n ?? 0;
  const hasFile = !!v.path && fs.existsSync(v.path);
  const c = a && segCount ? analyse(ctx, a, v.id) : null;
  const m = activeMission(ctx, v.id);
  return {
    ...v,
    themes: parseThemes(v.themes),
    kind: kindOf(v),
    segCount,
    hasFile,
    audioOnly: !!v.path && AUDIO_EXT.test(v.path),
    coverage: c ? c.coverage : v.coverage,
    preteachCount: c ? c.preteach.length : null,
    projected3: c ? c.projected[3].coverage : v.projected_coverage,
    readyInDays: c ? c.readyInDays : null,
    mission: m ? { id: m.id, status: m.status, planned_date: m.planned_date } : null,
  };
}

function info(ctx: Ctx, id: string): VideoInfo {
  return toInfo(ctx, rawVideo(ctx, id), analysisCtx(ctx));
}

// ------------------------------------------------------------------ subtitles ingestion
/** Parse, convert to simplified, segment and store subtitle text for a video; updates coverage. */
export function ingestSubtitles(ctx: Ctx, id: string, src: string, o: { variant: 'tw' | 'hk' | 't' | null; source: 'cc' | 'auto' | 'whisper' }): number {
  // Rolling-caption dedup only for YouTube auto-captions (imported CC files: auto-detected from the VTT tags);
  // never for Whisper, whose repeated / suffix lines are real dialogue.
  const rolling = o.source === 'auto' ? true : o.source === 'whisper' ? false : undefined;
  let cues = parseSubtitles(src, { rolling }).filter((c) => isHan(c.text));
  // Whisper pads the last window to 30 s: clamp cue times to the real media duration.
  const dur = rawVideo(ctx, id).duration;
  if (dur > 0) cues = cues.filter((c) => c.start < dur).map((c) => ({ ...c, end: Math.min(c.end, dur) }));
  if (o.source === 'whisper' || o.source === 'auto') cues = splitLongCues(cues.map((c) => ({ ...c, text: normalizeZhPunct(c.text) })));
  if (!cues.length) throw new Error('Le fichier de sous-titres ne contient aucune ligne en chinois.');
  const dict = (w: string) => !!ctx.content.dict[w];
  ctx.db.tx(() => {
    ctx.db.run('DELETE FROM segments WHERE video_id=?', [id]);
    cues.forEach((c, i) => {
      const text = (o.variant ? toSimplified(c.text, o.variant) : c.text).replace(/\s+/g, ' ').trim();
      const tokens = segment(text, dict).map((t) => ({ t: t.t, han: t.han }));
      ctx.db.run('INSERT INTO segments(video_id,idx,start,end,text,tokens,fr) VALUES(?,?,?,?,?,?,NULL)', [id, i, c.start, c.end, text, JSON.stringify(tokens)]);
    });
  });
  tokenCache.delete(id);
  const v = rawVideo(ctx, id);
  setVideo(ctx, id, { subs_source: o.source, status: v.status === 'listed' || v.status === 'error' ? (v.path ? 'ready' : 'subs') : v.status, error: null });
  storeCoverage(ctx, id, analyse(ctx, analysisCtx(ctx), id));
  // New transcript: refresh the word list of a mission whose briefing has not started yet.
  const m = activeMission(ctx, id);
  if (m && m.status === 'planned') planMission(ctx, id, m.planned_date);
  return cues.length;
}

/** Same-name subtitle files next to a local media file (video.srt, video.zh.srt, video.zh-Hans.vtt…). */
function sidecarSubs(file: string): string | null {
  const dir = path.dirname(file);
  const stem = path.basename(file).replace(/\.[^.]+$/, '');
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const subs = names.filter((n) => n.startsWith(stem + '.') && /\.(srt|vtt)$/i.test(n));
  if (!subs.length) return null;
  const score = (n: string) => (/\.(zh|chs|zh-hans|zh-cn|cn|sc)\./i.test(n) ? 0 : n === stem + '.srt' || n === stem + '.vtt' ? 1 : /zh|ch/i.test(n) ? 2 : 3);
  subs.sort((a, b) => score(a) - score(b));
  return path.join(dir, subs[0]);
}

// ------------------------------------------------------------------ ingestion entry points
function insertVideo(ctx: Ctx, row: { id: string; url: string; title: string; source_id?: string | null; duration?: number; thumbnail?: string | null; path?: string | null; status?: VideoRow['status']; themes?: string[] }) {
  ctx.db.run(
    `INSERT INTO videos(id,url,title,source_id,duration,path,status,error,added_at,themes,thumbnail,watched)
     VALUES(?,?,?,?,?,?,?,NULL,?,?,?,0)
     ON CONFLICT(id) DO UPDATE SET title=excluded.title, duration=CASE WHEN excluded.duration>0 THEN excluded.duration ELSE videos.duration END,
       thumbnail=COALESCE(excluded.thumbnail, videos.thumbnail), source_id=COALESCE(videos.source_id, excluded.source_id)`,
    [
      row.id,
      row.url,
      row.title,
      row.source_id ?? null,
      row.duration ?? 0,
      row.path ?? null,
      row.status ?? 'listed',
      Date.now(),
      JSON.stringify(row.themes ?? []),
      row.thumbnail ?? null,
    ],
  );
}

function starterFor(ctx: Ctx, url: string) {
  const id = youtubeId(url);
  return ctx.content.catalog.starterVideos.find((s) => (id ? youtubeId(s.url) === id : s.url === url));
}

function sourceForUrl(ctx: Ctx, url: string): CatalogSource | undefined {
  return ctx.content.catalog.sources.find((s) => s.url === url || s.url.replace(/\/videos$/, '') === url.replace(/\/videos$/, ''));
}

async function addYoutube(ctx: Ctx, url: string, sourceId?: string | null): Promise<string> {
  const m = await yt.fetchMeta(url, ytOpts(ctx, 'add'));
  const id = 'yt-' + m.id;
  const st = starterFor(ctx, m.webpage_url);
  insertVideo(ctx, {
    id,
    url: m.webpage_url,
    title: m.title,
    duration: m.duration,
    thumbnail: m.thumbnail,
    source_id: sourceId ?? st?.sourceId ?? null,
    themes: st?.themes,
  });
  writeMeta(ctx, id, { subs: m.subs, channel: m.channel, language: m.language });
  return id;
}

async function addFlat(ctx: Ctx, url: string, n: number, sourceId: string | null): Promise<string[]> {
  const r = await yt.listFlat(url, n, ytOpts(ctx, 'scan'));
  const ids: string[] = [];
  for (const e of r.entries) {
    const id = 'yt-' + e.id;
    insertVideo(ctx, { id, url: e.url, title: e.title, duration: e.duration, thumbnail: e.thumbnail ?? `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`, source_id: sourceId });
    ids.push(id);
  }
  return ids;
}

async function addRss(ctx: Ctx, url: string, n: number, sourceId: string | null): Promise<string[]> {
  const xml = await fetchText(url);
  const feed = parseRss(xml);
  if (!feed.episodes.length) throw new Error('Aucun épisode audio trouvé dans ce flux RSS.');
  const ids: string[] = [];
  for (const ep of feed.episodes.slice(0, n)) {
    const id = 'rss-' + shortHash(ep.guid || ep.url);
    insertVideo(ctx, { id, url: ep.url, title: `${ep.title} — ${feed.title}`, duration: ep.duration, thumbnail: ep.image, source_id: sourceId ?? 'rss:' + shortHash(url) });
    writeMeta(ctx, id, { feed: url, feedTitle: feed.title, description: ep.description, pubDate: ep.pubDate });
    ids.push(id);
  }
  return ids;
}

const looksRss = (u: string) => /(\.xml|\.rss)(\?|$)|\/rss\b|\/feed\b|podcast\/rss|feeds\.|anchor\.fm\/s\//i.test(u);

async function addLocal(ctx: Ctx, file: string): Promise<string> {
  if (!fs.existsSync(file)) throw new Error('Fichier introuvable : ' + file);
  if (!MEDIA_EXT.test(file)) throw new Error('Format non pris en charge (vidéo mp4/webm/mkv ou audio mp3/m4a/wav/ogg…).');
  const id = 'local-' + shortHash(path.resolve(file));
  let duration = 0;
  try {
    duration = (await probe(ctx.paths.bin, file)).duration;
  } catch {
    /* ffmpeg absent: duration read later by the player */
  }
  insertVideo(ctx, { id, url: 'file://' + path.resolve(file), title: path.basename(file).replace(/\.[^.]+$/, ''), duration, path: path.resolve(file), status: 'ready' });
  setVideo(ctx, id, { path: path.resolve(file), status: 'ready' });
  const sub = sidecarSubs(file);
  if (sub) {
    try {
      ingestSubtitles(ctx, id, fs.readFileSync(sub, 'utf8'), { variant: 't', source: 'cc' });
    } catch (e) {
      setVideo(ctx, id, { error: 'Sous-titres ignorés : ' + (e as Error).message });
    }
  }
  return id;
}

// ------------------------------------------------------------------ subtitles / download / transcription
async function fetchSubsFor(ctx: Ctx, id: string, rep: ReturnType<typeof reporter>): Promise<{ found: boolean; source?: string; lines?: number }> {
  const v = rawVideo(ctx, id);
  const kind = kindOf(v);
  if (kind === 'local') {
    const sub = v.path ? sidecarSubs(v.path) : null;
    if (!sub) return { found: false };
    return { found: true, source: 'cc', lines: ingestSubtitles(ctx, id, fs.readFileSync(sub, 'utf8'), { variant: 't', source: 'cc' }) };
  }
  if (kind === 'rss') return { found: false };
  rep('subs', -1, 'Recherche des sous-titres chinois…');
  let meta = readMeta<{ subs?: { subtitles: string[]; auto: string[]; language?: string | null } }>(ctx, id);
  if (!meta?.subs) {
    const m = await yt.fetchMeta(v.url, ytOpts(ctx, id));
    writeMeta(ctx, id, { subs: m.subs, channel: m.channel, language: m.language });
    setVideo(ctx, id, { title: m.title, duration: m.duration || v.duration, thumbnail: v.thumbnail ?? m.thumbnail });
    meta = { subs: m.subs };
  }
  const track = chooseSubTrack(meta.subs!);
  if (!track) {
    setVideo(ctx, id, { error: 'Pas de sous-titres chinois (CC ou automatiques) : utilise la transcription Whisper.' });
    return { found: false };
  }
  const r = await yt.fetchSubs(v.url, base(ctx, id), { ...ytOpts(ctx, id), lang: track.lang, auto: track.source === 'auto' });
  if (!r) {
    setVideo(ctx, id, { error: 'Sous-titres annoncés mais non téléchargés : réessaie plus tard ou utilise Whisper.' });
    return { found: false };
  }
  const n = ingestSubtitles(ctx, id, fs.readFileSync(r.file, 'utf8'), { variant: isTraditionalTag(r.lang) ?? null, source: track.source });
  return { found: true, source: track.source, lines: n };
}

async function downloadFor(ctx: Ctx, id: string, rep: ReturnType<typeof reporter>): Promise<string> {
  const v = rawVideo(ctx, id);
  if (v.path && fs.existsSync(v.path)) return v.path;
  const kind = kindOf(v);
  if (kind === 'local') throw new Error('Fichier local introuvable : ' + v.path);
  const prev = v.status;
  setVideo(ctx, id, { status: 'downloading', error: null });
  try {
    let file: string;
    if (kind === 'rss') {
      const ext = (v.url.split('?')[0].match(/\.(mp3|m4a|aac|ogg|opus|wav)$/i)?.[0] ?? '.mp3').toLowerCase();
      file = base(ctx, id) + ext;
      await downloadFile(v.url, file, (pct) => rep('download', pct, 'Téléchargement de l\'épisode…'), id);
    } else {
      rep('download', 0, 'Téléchargement de la vidéo (≤ 480p)…');
      file = await yt.download(v.url, base(ctx, id), { ...ytOpts(ctx, id), onProgress: (p) => rep('download', p, 'Téléchargement de la vidéo (≤ 480p)…') });
    }
    let duration = v.duration;
    if (!duration) duration = await probe(ctx.paths.bin, file).then((p) => p.duration).catch(() => 0);
    setVideo(ctx, id, { path: file, status: 'ready', duration, error: null });
    return file;
  } catch (e) {
    setVideo(ctx, id, { status: prev === 'downloading' ? 'listed' : prev, error: (e as Error).message });
    throw e;
  }
}

/** Video job id → model download it is waiting for (so « Annuler » on the video also stops the model download). */
const modelWaits = new Map<string, WhisperSize>();

async function ensureWhisperModel(ctx: Ctx, size: WhisperSize, rep?: ReturnType<typeof reporter>, jobId?: string) {
  const mrep = reporter(ctx, 'model:' + size);
  if (jobId) modelWaits.set(jobId, size);
  try {
    const p = await ensureModel(ctx.paths.models, size, (pct) => {
      mrep('model', pct, `Téléchargement du modèle Whisper « ${size} »…`);
      rep?.('model', pct, `Téléchargement du modèle Whisper « ${size} »…`);
    });
    emit(ctx, { id: 'model:' + size, stage: 'done', pct: 100 });
    return p;
  } catch (e) {
    emit(ctx, { id: 'model:' + size, stage: 'error', pct: 0, message: (e as Error).message });
    throw e;
  } finally {
    if (jobId) modelWaits.delete(jobId);
  }
}

async function transcribeFor(ctx: Ctx, id: string, size: WhisperSize, rep: ReturnType<typeof reporter>): Promise<number> {
  const file = await downloadFor(ctx, id, rep);
  const v = rawVideo(ctx, id);
  const model = await ensureWhisperModel(ctx, size, rep, id);
  const prev = v.status;
  setVideo(ctx, id, { status: 'transcribing', error: null });
  const wav = base(ctx, id) + '.16k.wav';
  try {
    const duration = v.duration || (await probe(ctx.paths.bin, file)).duration;
    rep('convert', 0, 'Extraction de l\'audio (16 kHz)…');
    await toWav16k(ctx.paths.bin, file, wav, duration, (p) => rep('convert', p, 'Extraction de l\'audio (16 kHz)…'), id);
    rep('transcribe', 0, `Transcription Whisper (${size})…`);
    const srt = await whisperTranscribe(ctx.paths.bin, model, wav, base(ctx, id) + '.whisper', (p) => rep('transcribe', p, `Transcription Whisper (${size})…`), id);
    const n = ingestSubtitles(ctx, id, fs.readFileSync(srt, 'utf8'), { variant: 't', source: 'whisper' });
    setVideo(ctx, id, { status: 'ready' });
    return n;
  } catch (e) {
    setVideo(ctx, id, { status: prev === 'transcribing' ? 'ready' : prev, error: (e as Error).message });
    throw e;
  } finally {
    fs.rmSync(wav, { force: true });
  }
}

// ------------------------------------------------------------------ missions
function parseMission(m: DbMission): Mission {
  let pre: PreteachWord[] = [];
  try {
    pre = JSON.parse(m.preteach);
  } catch {
    /* empty */
  }
  return { ...m, preteach: pre };
}

/** Shared rule (Curriculum.missionRemaining) — also used by the planner and study:newBatch/introduce. */
function remainingWords(ctx: Ctx, pre: PreteachWord[]): string[] {
  return ctx.cur.missionRemaining(pre);
}

/** Keep the status consistent with what has been learnt (planned → briefing → ready). */
function refreshMissionStatus(ctx: Ctx, m: Mission): Mission {
  if (m.status === 'done') return m;
  const left = remainingWords(ctx, m.preteach).length;
  const newCount = m.preteach.filter((p) => p.status === 'new').length;
  const status: Mission['status'] = left === 0 ? 'ready' : left < newCount ? 'briefing' : m.status === 'ready' ? 'briefing' : m.status;
  if (status !== m.status) ctx.db.run('UPDATE missions SET status=? WHERE id=?', [status, m.id]);
  return { ...m, status };
}

function missionDetail(ctx: Ctx, id: string): MissionDetail {
  const raw = ctx.db.get<DbMission>('SELECT * FROM missions WHERE id=?', [id]);
  if (!raw) throw new Error('Mission introuvable');
  const m = refreshMissionStatus(ctx, parseMission(raw));
  const intro = ctx.cur.introducedWords();
  const st = ctx.cur.wordStatus();
  const a = analysisCtx(ctx);
  const video = toInfo(ctx, rawVideo(ctx, m.video_id), a);
  return {
    mission: m,
    video,
    words: m.preteach.map((p) => ({ ...p, introduced: intro.has(p.w) || st.has(p.w), current: (st.get(p.w) ?? 'new') as 'known' | 'learning' | 'new' | 'ignored' })),
    remaining: remainingWords(ctx, m.preteach).length,
    coverageNow: video.coverage,
  };
}

function buildPreteach(ctx: Ctx, rep: CoverageReport, l: Token[][], a: Analysis): PreteachWord[] {
  const pre: PreteachWord[] = rep.preteach.map((p) => ({ ...p, fr: p.fr.slice(0, 3), status: 'new' as const }));
  // Words already in SRS but not yet solid: reinforced during the « révision express ».
  const learning = new Map<string, number>();
  for (const line of l) for (const t of line) if (t.han && a.status(t.t) === 'learning') learning.set(t.t, (learning.get(t.t) ?? 0) + 1);
  const extra = [...learning.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10);
  for (const [w, count] of extra) {
    const g = ctx.content.gloss(w);
    pre.push({ w, count, fr: (g.fr.length ? g.fr : g.en).slice(0, 3), py: g.py, status: 'learning' });
  }
  return pre;
}

function planMission(ctx: Ctx, videoId: string, plannedDate?: string): Mission {
  const a = analysisCtx(ctx);
  const l = lines(ctx, videoId);
  if (!l.length) throw new Error('Pas encore de sous-titres pour cette vidéo : récupère-les ou lance la transcription Whisper.');
  const cov = analyse(ctx, a, videoId)!;
  storeCoverage(ctx, videoId, cov);
  const pre = buildPreteach(ctx, cov, l, a);
  const nNew = pre.filter((p) => p.status === 'new').length;
  const today = dayKey();
  const date = plannedDate ?? addDays(today, nNew ? briefingDays(nNew, a.perDay) : 0);
  const existing = activeMission(ctx, videoId);
  const id = existing?.id ?? 'm-' + shortHash(videoId + ':' + Date.now());
  const status: Mission['status'] = nNew === 0 ? 'ready' : 'planned';
  if (existing) ctx.db.run('UPDATE missions SET planned_date=?, preteach=?, status=? WHERE id=?', [date, JSON.stringify(pre), status, id]);
  else
    ctx.db.run('INSERT INTO missions(id,video_id,planned_date,status,preteach,created,completed_at,comprehension) VALUES(?,?,?,?,?,?,NULL,NULL)', [
      id,
      videoId,
      date,
      status,
      JSON.stringify(pre),
      Date.now(),
    ]);
  return refreshMissionStatus(ctx, parseMission(ctx.db.get<DbMission>('SELECT * FROM missions WHERE id=?', [id])!));
}

function logMinutes(ctx: Ctx, type: string, minutes: number, detail?: unknown) {
  if (!(minutes > 0)) return;
  ctx.db.run('INSERT INTO activity(date,ts,type,minutes,detail) VALUES(?,?,?,?,?)', [dayKey(), Date.now(), type, Math.round(minutes * 10) / 10, detail ? JSON.stringify(detail) : null]);
}

// ------------------------------------------------------------------ deterministic quiz
function shortGloss(ctx: Ctx, w: string): string {
  const g = ctx.content.gloss(w);
  const s = (g.fr[0] ?? g.en[0] ?? '').replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  return s.length > 40 ? s.slice(0, 38) + '…' : s;
}

function deterministicQuiz(ctx: Ctx, videoId: string, n = 6): QuizQuestion[] {
  const v = rawVideo(ctx, videoId);
  const segs = ctx.db.all<{ idx: number; start: number; end: number; text: string; tokens: string }>('SELECT * FROM segments WHERE video_id=? ORDER BY idx', [videoId]);
  const m = activeMission(ctx, videoId) ?? ctx.db.get<DbMission>('SELECT * FROM missions WHERE video_id=? ORDER BY created DESC LIMIT 1', [videoId]);
  let targets: string[] = m ? parseMission(m).preteach.map((p) => p.w) : [];
  if (!targets.length) {
    const a = analysisCtx(ctx);
    const c = analyse(ctx, a, videoId);
    targets = c ? c.preteach.map((p) => p.w) : [];
    // fall back on frequent content words of the transcript
    if (targets.length < n) {
      const counts = tokenCounts(lines(ctx, videoId));
      targets.push(...[...counts.entries()].filter(([w]) => w.length > 1 && ctx.content.dict[w]).sort((x, y) => y[1] - x[1]).map(([w]) => w));
    }
  }
  targets = [...new Set(targets)].filter((w) => shortGloss(ctx, w));
  const pool = [...new Set([...targets, ...ctx.content.words.slice(0, 600).map((w) => w.w)])].filter((w) => shortGloss(ctx, w));
  const hasAudio = !!v.path && fs.existsSync(v.path);
  const out: QuizQuestion[] = [];
  const used = new Set<number>();
  const rnd = (k: number) => Math.floor(Math.random() * k);
  for (const w of targets.sort(() => Math.random() - 0.5)) {
    if (out.length >= n) break;
    const has = (s: (typeof segs)[number]) => (JSON.parse(s.tokens) as Token[]).some((t) => t.t === w);
    // prefer short, not yet used lines; fall back on any line containing the word
    const seg = segs.find((s) => !used.has(s.idx) && s.end - s.start <= 15 && has(s)) ?? segs.find((s) => !used.has(s.idx) && has(s)) ?? segs.find(has);
    if (!seg) continue;
    used.add(seg.idx);
    const right = shortGloss(ctx, w);
    const distract = new Set<string>();
    for (let k = 0; k < 60 && distract.size < 3; k++) {
      const d = shortGloss(ctx, pool[rnd(pool.length)]);
      if (d && d !== right) distract.add(d);
    }
    const options = [...distract, right].sort(() => Math.random() - 0.5);
    const py = ctx.content.gloss(w).py || pinyin(w);
    out.push({
      question: hasAudio ? `Écoute l'extrait. Que signifie « ${w} » dans cette phrase ?` : `Que signifie « ${w} » dans cette phrase ?`,
      zh: hasAudio ? w : seg.text,
      options,
      answer: options.indexOf(right),
      explanation: `${seg.text} — ${w} (${py}) : ${ctx.content.gloss(w).fr.slice(0, 3).join(', ') || ctx.content.gloss(w).en.slice(0, 2).join(', ')}`,
      audio: hasAudio ? { path: v.path!, start: Math.max(0, seg.start - 0.2), end: seg.end + 0.3 } : undefined,
    });
  }
  return out;
}

// ------------------------------------------------------------------ recommendations
function recommend(ctx: Ctx): RecItem[] {
  const s = ctx.settings();
  const a = analysisCtx(ctx);
  const phase = ctx.cur.phase();
  const sources = new Map(ctx.content.catalog.sources.map((x) => [x.id, x]));
  const items: RecItem[] = [];
  const seen = new Set<string>();
  for (const raw of ctx.db.all<DbVideo>('SELECT * FROM videos')) {
    const v = toInfo(ctx, raw, a);
    seen.add(v.id);
    const src = v.source_id ? sources.get(v.source_id) : undefined;
    const st = starterFor(ctx, v.url);
    const themes = [...new Set([...v.themes, ...(st?.themes ?? []), ...(src?.themes ?? [])])];
    const r = recommendationScore({
      projected3: v.segCount ? v.projected3 : null,
      durationSec: v.duration || null,
      phase,
      sourcePhases: src?.phases ?? (st ? [st.phase] : []),
      themes,
      interests: s.interests,
      watched: v.watched,
      hasMission: !!v.mission,
    });
    items.push({
      key: v.id,
      video: v,
      url: v.url,
      title: v.title,
      sourceId: v.source_id,
      sourceName: src?.name ?? null,
      durationSec: v.duration || null,
      thumbnail: v.thumbnail,
      themes,
      coverage: v.segCount ? v.coverage : null,
      projected3: v.segCount ? v.projected3 : null,
      readyInDays: v.readyInDays,
      preteachCount: v.preteachCount,
      score: r.score,
      reasons: r.reasons,
    });
  }
  for (const st of ctx.content.catalog.starterVideos) {
    const yid = youtubeId(st.url);
    if (yid && seen.has('yt-' + yid)) continue;
    const src = sources.get(st.sourceId);
    const themes = [...new Set([...(st.themes ?? []), ...(src?.themes ?? [])])];
    const r = recommendationScore({ projected3: null, durationSec: st.durationSec ?? null, phase, sourcePhases: src?.phases ?? [st.phase], themes, interests: s.interests });
    items.push({
      key: st.url,
      video: null,
      url: st.url,
      title: st.title,
      sourceId: st.sourceId,
      sourceName: src?.name ?? null,
      durationSec: st.durationSec ?? null,
      thumbnail: yid ? `https://i.ytimg.com/vi/${yid}/hqdefault.jpg` : null,
      themes,
      coverage: null,
      projected3: null,
      readyInDays: null,
      preteachCount: null,
      score: r.score,
      reasons: r.reasons,
    });
  }
  items.sort((x, y) => y.score - x.score);
  return items.slice(0, 40);
}

// ------------------------------------------------------------------ misc
function exportDir(ctx: Ctx): string {
  const tries: string[] = [];
  try {
    tries.push(path.join(app.getPath('music'), 'Operation Mandarin'));
  } catch {
    /* no music dir */
  }
  tries.push(path.join(ctx.paths.media, 'export'));
  for (const d of tries) {
    try {
      fs.mkdirSync(d, { recursive: true });
      fs.accessSync(d, fs.constants.W_OK);
      return d;
    } catch {
      /* next */
    }
  }
  throw new Error('Aucun dossier d\'export accessible en écriture.');
}

const safeName = (s: string) =>
  s
    .replace(/[/\\?%*:|"<>\n\r]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90) || 'audio';

function exportedPath(ctx: Ctx, v: DbVideo): string | null {
  const m = readMeta<{ exported?: string }>(ctx, v.id);
  return m?.exported && fs.existsSync(m.exported) ? m.exported : null;
}

// ------------------------------------------------------------------ registration
export function register(ctx: Ctx): void {
  app.on('before-quit', () => {
    for (const id of busy) {
      cancelJob(id);
      cancelDownload(id);
    }
    for (const size of new Set(modelWaits.values())) cancelDownload(modelJob(size));
  });

  handle('media:prefs', () => prefs(ctx));
  handle('media:setPrefs', (p: Partial<MediaPrefs>) => {
    const next = { ...prefs(ctx), ...p };
    ctx.db.setSetting('mediaPrefs', next);
    return next;
  });

  handle('media:binStatus', async (): Promise<BinStatus> => ({
    ytdlp: await yt.version(ctx.paths.bin),
    ffmpeg: !!findBin(ctx.paths.bin, 'ffmpeg'),
    whisper: await whisperRuns(ctx.paths.bin),
    models: { base: hasModel(ctx.paths.models, 'base'), small: hasModel(ctx.paths.models, 'small') },
  }));

  handle('media:jobs', () => [...jobs.values()]);
  handle('media:cancel', (id: string) => {
    if (cancelJob(id) || cancelDownload(id)) return true;
    const size = modelWaits.get(id);
    return size ? cancelDownload(modelJob(size)) : false;
  });

  handle('media:list', (): VideoInfo[] => {
    const a = analysisCtx(ctx);
    return ctx.db.all<DbVideo>('SELECT * FROM videos ORDER BY added_at DESC').map((v) => toInfo(ctx, v, a));
  });
  handle('media:get', (id: string) => info(ctx, id));

  // --- ingestion
  handle('media:add', async (url: string, opts?: { sourceId?: string; n?: number }): Promise<VideoInfo[]> => {
    url = (url ?? '').trim();
    if (!/^https?:\/\//.test(url)) throw new Error('Adresse invalide : colle une URL commençant par https://');
    let ids: string[];
    const src = opts?.sourceId ? ctx.content.catalog.sources.find((s) => s.id === opts.sourceId) : sourceForUrl(ctx, url);
    if (looksRss(url) || src?.kind === 'podcast_rss') ids = await addRss(ctx, url, opts?.n ?? 15, src?.id ?? null);
    else if (isYoutubeCollection(url)) ids = await addFlat(ctx, url, opts?.n ?? 15, src?.id ?? null);
    else ids = [await addYoutube(ctx, url, src?.id ?? null)];
    const a = analysisCtx(ctx);
    return ids.map((id) => toInfo(ctx, rawVideo(ctx, id), a));
  });

  handle('media:addRss', async (url: string, n: number = 15): Promise<VideoInfo[]> => {
    const ids = await addRss(ctx, url.trim(), n, sourceForUrl(ctx, url.trim())?.id ?? null);
    const a = analysisCtx(ctx);
    return ids.map((id) => toInfo(ctx, rawVideo(ctx, id), a));
  });

  handle('media:rssEpisodes', async (url: string): Promise<{ title: string; image: string | null; episodes: RssEpisode[] }> => parseRss(await fetchText(url)));

  handle('media:addLocal', async (file?: string): Promise<VideoInfo[]> => {
    let files = file ? [file] : [];
    if (!files.length) {
      const win = ctx.win();
      const opts: OpenDialogOptions = {
        title: 'Importer une vidéo ou un audio',
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'Vidéo / audio', extensions: ['mp4', 'm4v', 'webm', 'mkv', 'mov', 'mp3', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'flac'] },
          { name: 'Tous les fichiers', extensions: ['*'] },
        ],
      };
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      if (r.canceled) return [];
      files = r.filePaths;
    }
    const ids: string[] = [];
    for (const f of files) ids.push(await addLocal(ctx, f));
    const a = analysisCtx(ctx);
    return ids.map((id) => toInfo(ctx, rawVideo(ctx, id), a));
  });

  handle('media:importSubs', async (id: string, file?: string): Promise<VideoInfo | null> => {
    if (!file) {
      const r = await dialog.showOpenDialog({ title: 'Choisir un fichier de sous-titres chinois', properties: ['openFile'], filters: [{ name: 'Sous-titres', extensions: ['srt', 'vtt'] }] });
      if (r.canceled || !r.filePaths[0]) return null;
      file = r.filePaths[0];
    }
    ingestSubtitles(ctx, id, fs.readFileSync(file, 'utf8'), { variant: 't', source: 'cc' });
    return info(ctx, id);
  });

  handle('media:fetchSubs', (id: string) =>
    exclusive(ctx, id, async () => {
      const r = await fetchSubsFor(ctx, id, reporter(ctx, id)).catch((e: Error) => {
        setVideo(ctx, id, { error: e.message });
        throw e;
      });
      return { ...r, video: info(ctx, id) };
    }),
  );

  handle('media:download', (id: string) =>
    exclusive(ctx, id, async () => {
      await downloadFor(ctx, id, reporter(ctx, id));
      return info(ctx, id);
    }),
  );

  handle('media:transcribe', (id: string, size?: WhisperSize) =>
    exclusive(ctx, id, async () => {
      await transcribeFor(ctx, id, size ?? prefs(ctx).whisperModel, reporter(ctx, id));
      return info(ctx, id);
    }),
  );

  /** One-click preparation: subtitles (CC/auto) → download → Whisper if no subtitles. */
  handle('media:prepare', (id: string) =>
    exclusive(ctx, id, async () => {
      const rep = reporter(ctx, id);
      const p = prefs(ctx);
      let v = info(ctx, id);
      let subsError: string | null = null;
      if (!v.segCount && (v.kind === 'youtube' || v.kind === 'other' || v.kind === 'local')) {
        try {
          await fetchSubsFor(ctx, id, rep);
        } catch (e) {
          subsError = (e as Error).message;
        }
        v = info(ctx, id);
      }
      if (!v.hasFile && (p.autoDownload || !v.segCount)) {
        await downloadFor(ctx, id, rep);
        v = info(ctx, id);
      }
      if (!v.segCount) {
        if (subsError && /YouTube bloque/.test(subsError) && !v.hasFile) throw new Error(subsError);
        await transcribeFor(ctx, id, p.whisperModel, rep);
      }
      return info(ctx, id);
    }),
  );

  handle('media:downloadModel', async (size: WhisperSize) => {
    await ensureWhisperModel(ctx, size);
    return true;
  });

  handle('media:remove', (id: string) => {
    const v = rawVideo(ctx, id);
    cancelJob(id);
    cancelDownload(id);
    ctx.db.tx(() => {
      ctx.db.run('DELETE FROM segments WHERE video_id=?', [id]);
      ctx.db.run("DELETE FROM missions WHERE video_id=? AND status!='done'", [id]);
      ctx.db.run('DELETE FROM videos WHERE id=?', [id]);
    });
    tokenCache.delete(id);
    // only delete files we created (never the user's local file)
    for (const f of fs.readdirSync(ctx.paths.media)) if (f.startsWith(id + '.')) fs.rmSync(path.join(ctx.paths.media, f), { force: true });
    if (kindOf(v) !== 'local' && v.path && v.path.startsWith(ctx.paths.media)) fs.rmSync(v.path, { force: true });
    return true;
  });

  // --- transcript & coverage
  handle('media:segments', (id: string): PlayerSegment[] => {
    const st = ctx.cur.wordStatus();
    const a = analysisCtx(ctx);
    return ctx.db
      .all<{ idx: number; start: number; end: number; text: string; tokens: string; fr: string | null }>('SELECT * FROM segments WHERE video_id=? ORDER BY idx', [id])
      .map((s) => ({
        idx: s.idx,
        start: s.start,
        end: s.end,
        text: s.text,
        fr: s.fr,
        tokens: (JSON.parse(s.tokens) as Token[]).map((t) => {
          if (!t.han) return t;
          const status = (st.get(t.t) ?? (a.isProper(t.t) ? 'known' : 'new')) as Token['status'];
          return status === 'known' || status === 'ignored' ? { ...t, status } : { ...t, status, py: ctx.content.gloss(t.t).py || pinyin(t.t) };
        }),
      }));
  });

  handle('media:coverage', (id: string): CoverageInfo => {
    const c = analyse(ctx, analysisCtx(ctx), id);
    if (!c) throw new Error('Pas de sous-titres pour cette vidéo.');
    storeCoverage(ctx, id, c);
    return c;
  });

  /** Projected coverage at a given date (current status + next curriculum words as 'learning'). */
  handle('media:projectedCoverage', (id: string, date: string) => {
    const a = analysisCtx(ctx);
    const l = lines(ctx, id);
    if (!l.length) return null;
    const d = Math.max(0, daysBetween(dayKey(), date));
    const s = projectStatus(a.status, a.upcoming.slice(0, Math.round(a.perDay * d)));
    const counts = tokenCounts(l);
    let total = 0;
    let ok = 0;
    for (const [w, n] of counts) {
      total += n;
      if (s(w) || a.isProper(w)) ok += n;
    }
    return total ? ok / total : 1;
  });

  // --- missions
  handle('media:planMission', (videoId: string, plannedDate?: string) => planMission(ctx, videoId, plannedDate));

  handle('media:missions', () => {
    const rows = ctx.db.all<DbMission & { title: string; thumbnail: string | null }>(
      "SELECT m.*, v.title, v.thumbnail FROM missions m JOIN videos v ON v.id=m.video_id ORDER BY CASE WHEN m.status='done' THEN 1 ELSE 0 END, m.planned_date",
    );
    return rows.map((r) => {
      const m = refreshMissionStatus(ctx, parseMission(r));
      return { ...m, title: r.title, thumbnail: r.thumbnail, remaining: remainingWords(ctx, m.preteach).length };
    });
  });

  handle('media:mission', (id: string): MissionDetail => missionDetail(ctx, id));

  /** Next mission of the daily plan (same order as the planner): used when the screen is opened without parameters. */
  handle('media:nextMission', (): MissionDetail | null => {
    const m = ctx.db.get<{ id: string }>("SELECT id FROM missions WHERE status IN ('planned','briefing','ready') ORDER BY planned_date LIMIT 1");
    return m ? missionDetail(ctx, m.id) : null;
  });

  handle('media:missionForVideo', (videoId: string): MissionDetail | null => {
    const m = activeMission(ctx, videoId);
    return m ? missionDetail(ctx, m.id) : null;
  });

  handle('media:setPreteach', (missionId: string, words: PreteachWord[]) => {
    if (!Array.isArray(words)) throw new Error('Liste de mots invalide');
    const clean = words
      .filter((w) => w && typeof w.w === 'string' && w.w.trim())
      .map((w) => {
        const g = ctx.content.gloss(w.w);
        return {
          w: w.w.trim(),
          count: +w.count || 1,
          fr: Array.isArray(w.fr) && w.fr.length ? w.fr.map(String) : (g.fr.length ? g.fr : g.en).slice(0, 3),
          py: w.py || g.py,
          status: w.status === 'learning' ? 'learning' : 'new',
          contextFr: w.contextFr,
          key: w.key,
        } as PreteachWord;
      });
    ctx.db.run('UPDATE missions SET preteach=? WHERE id=?', [JSON.stringify(clean), missionId]);
    return missionDetail(ctx, missionId);
  });

  handle('media:setMissionDate', (id: string, date: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Date invalide');
    ctx.db.run('UPDATE missions SET planned_date=? WHERE id=?', [date, id]);
    return true;
  });

  handle('media:cancelMission', (id: string) => {
    ctx.db.run("DELETE FROM missions WHERE id=? AND status!='done'", [id]);
    return true;
  });

  handle('media:completeMission', (id: string, comprehension: number, minutes?: number) => {
    const m = ctx.db.get<DbMission>('SELECT * FROM missions WHERE id=?', [id]);
    if (!m) throw new Error('Mission introuvable');
    const c = Math.max(0, Math.min(1, +comprehension || 0));
    ctx.db.run("UPDATE missions SET status='done', completed_at=?, comprehension=? WHERE id=?", [Date.now(), c, id]);
    ctx.db.run('UPDATE videos SET watched=watched+1 WHERE id=?', [m.video_id]);
    logMinutes(ctx, 'mission', minutes ?? 0, { missionId: id, videoId: m.video_id, comprehension: c });
    return true;
  });

  /** Free viewing without mission. */
  handle('media:markWatched', (videoId: string, comprehension?: number, minutes?: number) => {
    ctx.db.run('UPDATE videos SET watched=watched+1 WHERE id=?', [videoId]);
    logMinutes(ctx, 'mission', minutes ?? 0, { videoId, comprehension });
    return true;
  });

  handle('media:quiz', (videoId: string, n?: number) => deterministicQuiz(ctx, videoId, n ?? 6));

  // --- recommendations & catalogue
  handle('media:recommend', () => recommend(ctx));

  handle('media:sources', () => {
    const counts = new Map(ctx.db.all<{ source_id: string; n: number }>('SELECT source_id, COUNT(*) n FROM videos WHERE source_id IS NOT NULL GROUP BY source_id').map((r) => [r.source_id, r.n]));
    return {
      phase: ctx.cur.phase(),
      phaseName: ctx.cur.phaseName(),
      interests: ctx.settings().interests,
      sources: ctx.content.catalog.sources.map((s) => ({ ...s, scanned: counts.get(s.id) ?? 0 })),
    };
  });

  /** List the last N videos of a catalogue source and fetch only their subtitles to compute coverage. */
  handle('media:scanSource', (sourceId: string, n: number = 8) =>
    exclusive(ctx, 'scan:' + sourceId, async () => {
      const src = ctx.content.catalog.sources.find((s) => s.id === sourceId);
      if (!src) throw new Error('Source inconnue');
      const rep = reporter(ctx, 'scan:' + sourceId);
      rep('scan', -1, 'Liste des dernières vidéos…');
      if (src.kind === 'podcast_rss') {
        const ids = await addRss(ctx, src.url, n, src.id);
        return { added: ids.length, withSubs: 0, errors: [] as string[], note: 'Épisodes ajoutés : télécharge-les puis lance la transcription Whisper pour calculer la couverture.' };
      }
      const ids = await addFlat(ctx, src.url, n, src.id);
      let withSubs = 0;
      const errors: string[] = [];
      for (let i = 0; i < ids.length; i++) {
        rep('scan', (i / ids.length) * 100, `Sous-titres ${i + 1}/${ids.length}…`);
        if ((ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM segments WHERE video_id=?', [ids[i]])?.n ?? 0) > 0) {
          withSubs++;
          continue;
        }
        try {
          const r = await fetchSubsFor(ctx, ids[i], () => {});
          if (r.found) withSubs++;
        } catch (e) {
          errors.push((e as Error).message);
          setVideo(ctx, ids[i], { error: (e as Error).message });
          if (/YouTube bloque/.test((e as Error).message)) break; // inutile d'insister
        }
      }
      return { added: ids.length, withSubs, errors: [...new Set(errors)], note: '' };
    }),
  );

  // --- extensive listening
  handle('media:exportAudio', (id: string) =>
    exclusive(ctx, id, async () => {
      const v = rawVideo(ctx, id);
      const file = await downloadFor(ctx, id, reporter(ctx, id));
      const out = path.join(exportDir(ctx), safeName(v.title) + '.mp3');
      const rep = reporter(ctx, id);
      await toMp3(ctx.paths.bin, file, out, v.duration, (p) => rep('export', p, 'Export MP3…'), id);
      writeMeta(ctx, id, { exported: out });
      return { path: out };
    }),
  );

  handle('media:showInFolder', (p: string) => {
    shell.showItemInFolder(p);
    return true;
  });

  handle('media:listeningQueue', () => {
    const a = analysisCtx(ctx);
    const rows = ctx.db.all<DbVideo & { last_done: number | null }>(
      `SELECT v.*, (SELECT MAX(completed_at) FROM missions m WHERE m.video_id=v.id AND m.status='done') last_done FROM videos v
       WHERE v.path IS NOT NULL AND (v.watched > 0 OR EXISTS (SELECT 1 FROM missions m WHERE m.video_id=v.id AND m.status='done'))
       ORDER BY COALESCE(last_done, v.added_at) DESC`,
    );
    return rows.filter((v) => v.path && fs.existsSync(v.path)).map((v) => ({ ...toInfo(ctx, v, a), exported: exportedPath(ctx, v) }));
  });
}
