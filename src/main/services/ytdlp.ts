// yt-dlp wrapper: metadata, Chinese subtitles, ≤480p download (DASH merged by ffmpeg), flat playlist listing.
import fs from 'node:fs';
import path from 'node:path';
import { findBin, runOk, type RunOpts } from './proc';
import { parseYtdlpProgress, type SubTrackInfo } from '../../core/media';

export interface YtOpts {
  binDir: string;
  cookiesBrowser?: string;
  job?: string;
}

export interface YtMeta {
  id: string;
  title: string;
  duration: number;
  thumbnail: string | null;
  webpage_url: string;
  channel: string | null;
  language: string | null;
  subs: SubTrackInfo;
}

export interface YtFlatEntry {
  id: string;
  title: string;
  url: string;
  duration: number;
  thumbnail: string | null;
}

export const ZH_SUB_LANGS = 'zh-Hans,zh-CN,zh,zh-Hant,zh-TW,zh-HK';

function bin(o: YtOpts): string {
  const b = findBin(o.binDir, 'yt-dlp');
  if (!b) throw new Error('yt-dlp introuvable : lance « bash scripts/fetch-binaries.sh » ou installe yt-dlp.');
  return b;
}

/**
 * JavaScript runtime for YouTube's player challenges (without one, YouTube only serves a few formats and
 * downloads fail). yt-dlp only enables deno by default: we also enable node, using Electron itself run as
 * Node (ELECTRON_RUN_AS_NODE=1), so it works on a desktop without node/deno installed.
 */
export function jsRuntimeArgs(execPath = process.execPath, versions: NodeJS.ProcessVersions = process.versions): string[] {
  const a: string[] = [];
  if (versions.electron && execPath) a.push('--js-runtimes', `node:${execPath}`);
  // Plain Node (tests / CLI): let yt-dlp find node on the PATH.
  else a.push('--js-runtimes', 'node');
  return a;
}

/** Environment for yt-dlp: makes the Electron binary behave as Node when yt-dlp spawns it. */
function ytEnv(): RunOpts['env'] {
  return process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : undefined;
}

function common(o: YtOpts): string[] {
  const a = ['--no-warnings', '--no-color', '--ignore-config', ...jsRuntimeArgs()];
  if (o.cookiesBrowser) a.push('--cookies-from-browser', o.cookiesBrowser);
  const ff = findBin(o.binDir, 'ffmpeg');
  if (ff) a.push('--ffmpeg-location', ff);
  return a;
}

/**
 * Format selector for a ≤480p video. With ffmpeg: H.264 DASH video + AAC audio merged into mp4 (plays everywhere),
 * then any progressive mp4, then any DASH pair. Without ffmpeg only progressive (muxed) formats can be used.
 */
export function videoFormat(hasFfmpeg: boolean): string {
  const progressive = 'b[height<=480][ext=mp4]/b[height<=480]';
  return hasFfmpeg
    ? `bv[height<=480][vcodec^=avc1]+ba[ext=m4a]/${progressive}/bv[height<=480]+ba/b/wv+ba`
    : `${progressive}/b`;
}

/** Translate common yt-dlp failures into French, actionable messages. */
export function explainYtError(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  if (/confirm you.?re not a bot|Sign in to confirm|429|Too Many Requests/i.test(msg))
    return new Error(
      'YouTube bloque la requête (« confirmez que vous n\'êtes pas un robot » / trop de requêtes). Active l\'option « Cookies du navigateur » (Firefox ou Chrome connecté à YouTube) dans l\'onglet Ajouter, puis réessaie.',
    );
  if (/Private video|members-only|This video is unavailable|Video unavailable/i.test(msg)) return new Error('Vidéo indisponible (privée, supprimée ou réservée aux membres).');
  if (/Unable to download webpage|getaddrinfo|Network is unreachable|timed out|délai dépassé/i.test(msg)) return new Error('Connexion impossible ou trop lente : vérifie ta connexion Internet puis réessaie.');
  if (/Requested format is not available|No video formats found/i.test(msg))
    return new Error('YouTube ne propose aucun format téléchargeable pour cette vidéo (essaie de mettre à jour yt-dlp avec « bash scripts/fetch-binaries.sh », ou active les cookies du navigateur).');
  if (/could not find .* cookies|cookies database/i.test(msg)) return new Error('Impossible de lire les cookies du navigateur choisi (navigateur non installé ou profil introuvable).');
  return e instanceof Error ? e : new Error(msg);
}

export async function fetchMeta(url: string, o: YtOpts): Promise<YtMeta> {
  try {
    const r = await runOk(bin(o), [...common(o), '-J', '--no-playlist', '--skip-download', url], { job: o.job, timeoutMs: 120_000, env: ytEnv() });
    const j = JSON.parse(r.stdout);
    return {
      id: j.id,
      title: j.title ?? j.fulltitle ?? url,
      duration: +j.duration || 0,
      thumbnail: j.thumbnail ?? (Array.isArray(j.thumbnails) && j.thumbnails.length ? j.thumbnails[j.thumbnails.length - 1].url : null),
      webpage_url: j.webpage_url ?? url,
      channel: j.channel ?? j.uploader ?? null,
      language: j.language ?? null,
      subs: { subtitles: Object.keys(j.subtitles ?? {}), auto: Object.keys(j.automatic_captions ?? {}), language: j.language ?? null },
    };
  } catch (e) {
    throw explainYtError(e);
  }
}

/** Download subtitles only, returns the path of the .vtt file found (or null). */
export async function fetchSubs(url: string, outBase: string, o: YtOpts & { lang?: string; auto?: boolean }): Promise<{ file: string; lang: string } | null> {
  const dir = path.dirname(outBase);
  const base = path.basename(outBase);
  for (const f of fs.readdirSync(dir)) if (f.startsWith(base + '.') && f.endsWith('.vtt')) fs.rmSync(path.join(dir, f), { force: true });
  const langs = o.lang ?? ZH_SUB_LANGS;
  const args = [...common(o), '--skip-download', '--no-playlist', '--write-subs'];
  if (o.auto !== false) args.push('--write-auto-subs');
  args.push('--sub-langs', langs, '--sub-format', 'vtt', '-o', `${outBase}.%(ext)s`, url);
  try {
    await runOk(bin(o), args, { job: o.job, timeoutMs: 180_000, env: ytEnv() });
  } catch (e) {
    throw explainYtError(e);
  }
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(base + '.') && f.endsWith('.vtt'));
  if (!files.length) return null;
  const order = langs.split(',');
  const langOf = (f: string) => f.slice(base.length + 1, -4);
  files.sort((a, b) => {
    const ia = order.indexOf(langOf(a));
    const ib = order.indexOf(langOf(b));
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return { file: path.join(dir, files[0]), lang: langOf(files[0]) };
}

/** ≤480p download (DASH video+audio merged into mp4 by the bundled ffmpeg). Returns the final file path. */
export async function download(url: string, outBase: string, o: YtOpts & { onProgress?: (pct: number) => void; audioOnly?: boolean }): Promise<string> {
  const hasFf = !!findBin(o.binDir, 'ffmpeg');
  const fmt = o.audioOnly ? 'bestaudio[ext=m4a]/bestaudio/best' : videoFormat(hasFf);
  const args = [...common(o), '--no-playlist', '--newline', '--progress', '--no-mtime', '-f', fmt];
  if (hasFf && !o.audioOnly) args.push('--merge-output-format', 'mp4');
  args.push('-o', `${outBase}.%(ext)s`, '--print', 'after_move:filepath', url);
  let finalPath = '';
  try {
    const r = await runOk(bin(o), args, {
      job: o.job,
      env: ytEnv(),
      onLine: (l) => {
        const p = parseYtdlpProgress(l);
        if (p != null) o.onProgress?.(p);
        else if (l.startsWith('/') && fs.existsSync(l.trim())) finalPath = l.trim();
      },
    });
    if (!finalPath) finalPath = r.stdout.trim().split('\n').pop() ?? '';
  } catch (e) {
    throw explainYtError(e);
  }
  if (!finalPath || !fs.existsSync(finalPath)) {
    const dir = path.dirname(outBase);
    const f = fs.readdirSync(dir).find((x) => x.startsWith(path.basename(outBase) + '.') && /\.(mp4|webm|mkv|m4a|mp3|opus|ogg)$/.test(x));
    if (!f) throw new Error('Téléchargement terminé mais fichier introuvable.');
    finalPath = path.join(dir, f);
  }
  return finalPath;
}

/** List the last `n` videos of a channel / playlist without downloading anything. */
export async function listFlat(url: string, n: number, o: YtOpts): Promise<{ title: string; entries: YtFlatEntry[] }> {
  try {
    const r = await runOk(bin(o), [...common(o), '--flat-playlist', '-J', '--playlist-end', String(n), url], { job: o.job, timeoutMs: 180_000, env: ytEnv() });
    const j = JSON.parse(r.stdout);
    let entries: Record<string, unknown>[] = j.entries ?? [];
    // A channel URL without /videos returns tabs (Videos, Shorts…) as nested playlists.
    if (entries.length && entries.every((e) => e._type === 'playlist' || (e as { entries?: unknown }).entries)) {
      const vids = entries.find((e) => /videos/i.test(String(e.title ?? ''))) ?? entries[0];
      entries = ((vids as { entries?: Record<string, unknown>[] }).entries ?? []).slice(0, n);
    }
    return {
      title: j.title ?? url,
      entries: entries
        .filter((e) => e.id && e.ie_key !== 'YoutubeTab')
        .slice(0, n)
        .map((e) => ({
          id: String(e.id),
          title: String(e.title ?? e.id),
          url: String(e.url && String(e.url).startsWith('http') ? e.url : `https://www.youtube.com/watch?v=${e.id}`),
          duration: +(e.duration as number) || 0,
          thumbnail: Array.isArray(e.thumbnails) && e.thumbnails.length ? String((e.thumbnails[e.thumbnails.length - 1] as { url: string }).url) : null,
        })),
    };
  } catch (e) {
    throw explainYtError(e);
  }
}

export async function version(binDir: string): Promise<string | null> {
  const b = findBin(binDir, 'yt-dlp');
  if (!b) return null;
  try {
    return (await runOk(b, ['--version'], { timeoutMs: 20_000 })).stdout.trim();
  } catch {
    return null;
  }
}
