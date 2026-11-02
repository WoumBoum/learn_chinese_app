// whisper.cpp transcription (local, offline once the ggml model is downloaded).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findBin, run, runOk } from './proc';
import { downloadFile } from './http';
import { parseWhisperProgress } from '../../core/media';

export type WhisperSize = 'base' | 'small';
export const MODEL_SIZES: Record<WhisperSize, string> = { base: '142 Mo', small: '466 Mo' };

export function modelPath(modelsDir: string, size: WhisperSize): string {
  return path.join(modelsDir, `ggml-${size}.bin`);
}

export function hasModel(modelsDir: string, size: WhisperSize): boolean {
  const p = modelPath(modelsDir, size);
  return fs.existsSync(p) && fs.statSync(p).size > 50_000_000;
}

const inflight = new Map<string, { promise: Promise<string>; listeners: Set<(pct: number) => void> }>();

/** Model download key, used by `cancelDownload()`. */
export const modelJob = (size: WhisperSize) => `model:${size}`;

/**
 * Download the ggml model once. Concurrent callers (two videos being transcribed, or the settings button)
 * share the same download instead of writing the same `.part` file in parallel.
 */
export function ensureModel(modelsDir: string, size: WhisperSize, onProgress?: (pct: number) => void, url?: string): Promise<string> {
  const p = modelPath(modelsDir, size);
  if (hasModel(modelsDir, size)) return Promise.resolve(p);
  let job = inflight.get(p);
  if (!job) {
    const listeners = new Set<(pct: number) => void>();
    const promise = (async () => {
      fs.mkdirSync(modelsDir, { recursive: true });
      await downloadFile(url ?? `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${size}.bin`, p, (pct) => listeners.forEach((l) => l(pct)), modelJob(size));
      return p;
    })().finally(() => inflight.delete(p));
    job = { promise, listeners };
    inflight.set(p, job);
  }
  if (onProgress) {
    const j = job;
    j.listeners.add(onProgress);
    j.promise.catch(() => undefined).finally(() => j.listeners.delete(onProgress));
  }
  return job.promise;
}

export function whisperBin(binDir: string): string {
  const b = findBin(binDir, 'whisper-cli') ?? findBin(binDir, 'whisper-cpp');
  if (!b) throw new Error('whisper-cli introuvable : lance « bash scripts/fetch-binaries.sh » (compile whisper.cpp).');
  return b;
}

let runsCache: { bin: string; ok: boolean } | null = null;

/**
 * True when whisper-cli is present AND can actually start on this system (a binary linked against a newer glibc
 * than the user's fails with « version `GLIBC_2.xx' not found » / exit 127).
 */
export async function whisperRuns(binDir: string): Promise<boolean> {
  const b = findBin(binDir, 'whisper-cli') ?? findBin(binDir, 'whisper-cpp');
  if (!b) return false;
  if (runsCache?.bin === b) return runsCache.ok;
  let ok = false;
  try {
    const r = await run(b, ['--help'], { timeoutMs: 15_000 });
    ok = r.code !== 127 && !/GLIBC_|GLIBCXX_|error while loading shared libraries/.test(r.stderr);
  } catch {
    ok = false;
  }
  runsCache = { bin: b, ok };
  return ok;
}

/** Transcribe a 16 kHz mono WAV in Mandarin. Returns the produced .srt path. */
export async function transcribe(binDir: string, model: string, wav: string, outBase: string, onProgress?: (pct: number) => void, job?: string): Promise<string> {
  const threads = Math.max(1, Math.min(8, os.cpus().length - 1));
  try {
    await runOk(
      whisperBin(binDir),
      // A simplified-Chinese prompt nudges Whisper towards simplified characters and punctuation.
      ['-m', model, '-l', 'zh', '-t', String(threads), '-osrt', '-of', outBase, '-pp', '--prompt', '以下是普通话的句子，使用简体中文。', '-f', wav],
      {
        job,
        onLine: (l) => {
          const p = parseWhisperProgress(l);
          if (p != null) onProgress?.(p);
        },
      },
    );
  } catch (e) {
    if (/GLIBC_|GLIBCXX_|error while loading shared libraries/.test((e as Error).message))
      throw new Error('whisper-cli ne peut pas démarrer sur ce système (glibc trop ancienne pour ce binaire) : mets à jour l\'application, ou recompile-le avec « bash scripts/fetch-binaries.sh --force whisper-cli ».');
    throw e;
  }
  const srt = outBase + '.srt';
  if (!fs.existsSync(srt)) throw new Error('Whisper n\'a produit aucun sous-titre.');
  return srt;
}
