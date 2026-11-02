// ffmpeg helpers: probe duration, 16 kHz mono WAV for Whisper, MP3 export for extensive listening.
import { findBin, run, runOk } from './proc';
import { parseFfmpegDuration, parseFfmpegTime } from '../../core/media';

export function ffmpegBin(binDir: string): string {
  const b = findBin(binDir, 'ffmpeg');
  if (!b) throw new Error('ffmpeg introuvable : lance « bash scripts/fetch-binaries.sh » ou installe ffmpeg.');
  return b;
}

/** Duration (s) and whether the file has a video stream. */
export async function probe(binDir: string, file: string): Promise<{ duration: number; hasVideo: boolean }> {
  const r = await run(ffmpegBin(binDir), ['-hide_banner', '-i', file], { timeoutMs: 30_000 });
  const hasVideo = /Stream #\d+:\d+.*: Video: (?!mjpeg|png)/.test(r.stderr);
  return { duration: parseFfmpegDuration(r.stderr), hasVideo };
}

async function convert(binDir: string, args: string[], duration: number, onProgress?: (pct: number) => void, job?: string) {
  await runOk(ffmpegBin(binDir), ['-hide_banner', '-y', ...args], {
    job,
    onLine: (l) => {
      const t = parseFfmpegTime(l);
      if (t != null && duration > 0) onProgress?.(Math.min(100, (t / duration) * 100));
    },
  });
}

export async function toWav16k(binDir: string, input: string, output: string, duration: number, onProgress?: (pct: number) => void, job?: string) {
  await convert(binDir, ['-i', input, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', output], duration, onProgress, job);
}

export async function toMp3(binDir: string, input: string, output: string, duration: number, onProgress?: (pct: number) => void, job?: string) {
  await convert(binDir, ['-i', input, '-vn', '-c:a', 'libmp3lame', '-q:a', '5', output], duration, onProgress, job);
}
