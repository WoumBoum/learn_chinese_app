// Run external binaries (yt-dlp, ffmpeg, whisper-cli) with line-by-line output callbacks and cancellation.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const running = new Map<string, Set<ChildProcess>>();

export interface RunOpts {
  cwd?: string;
  /** Called with every stdout/stderr line (progress parsing). `\r` also splits lines. */
  onLine?: (line: string, stream: 'out' | 'err') => void;
  /** Job key used to cancel (`cancelJob(key)`). */
  job?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class ProcError extends Error {
  constructor(message: string, public result: RunResult) {
    super(message);
  }
}

export function run(bin: string, args: string[], o: RunOpts = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(bin, args, { cwd: o.cwd, env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...o.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      reject(e);
      return;
    }
    if (o.job) {
      if (!running.has(o.job)) running.set(o.job, new Set());
      running.get(o.job)!.add(child);
    }
    const out: string[] = [];
    const err: string[] = [];
    const bufs = { out: '', err: '' };
    const feed = (stream: 'out' | 'err', chunk: Buffer) => {
      const s = chunk.toString('utf8');
      (stream === 'out' ? out : err).push(s);
      if (!o.onLine) return;
      bufs[stream] += s;
      const parts = bufs[stream].split(/\r\n|\n|\r/);
      bufs[stream] = parts.pop() ?? '';
      for (const l of parts) if (l.trim()) o.onLine(l, stream);
    };
    child.stdout?.on('data', (c: Buffer) => feed('out', c));
    child.stderr?.on('data', (c: Buffer) => feed('err', c));
    let timer: NodeJS.Timeout | null = null;
    let timedOut = false;
    if (o.timeoutMs)
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, o.timeoutMs);
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (o.job) running.get(o.job)?.delete(child);
      if (o.onLine) for (const k of ['out', 'err'] as const) if (bufs[k].trim()) o.onLine(bufs[k], k);
      const res = { code: code ?? (signal ? 1 : 0), stdout: out.join(''), stderr: err.join('') };
      if (timedOut) reject(new ProcError(`${path.basename(bin)} : délai dépassé (réseau lent ou bloqué ?)`, res));
      else if (signal === 'SIGTERM' || signal === 'SIGKILL') reject(new ProcError('Opération annulée', res));
      else resolve(res);
    });
  });
}

/** Run and throw a readable error when the exit code is not 0. */
export async function runOk(bin: string, args: string[], o: RunOpts = {}): Promise<RunResult> {
  const r = await run(bin, args, o);
  if (r.code !== 0) {
    const tail = (r.stderr || r.stdout)
      .split('\n')
      .filter((l) => l.trim() && !/^\s*(WARNING|\[debug\])/.test(l))
      .slice(-4)
      .join('\n');
    throw new ProcError(`${path.basename(bin)} a échoué (code ${r.code}) : ${tail || 'aucune sortie'}`, r);
  }
  return r;
}

export function cancelJob(job: string): boolean {
  const set = running.get(job);
  if (!set || !set.size) return false;
  for (const c of set) c.kill('SIGTERM');
  return true;
}

export function cancelAll(): void {
  for (const set of running.values()) for (const c of set) c.kill('SIGTERM');
}

/** Find an executable: bundled binary in `binDir` first, then the PATH. */
export function findBin(binDir: string, name: string): string | null {
  const local = path.join(binDir, name);
  try {
    fs.accessSync(local, fs.constants.X_OK);
    return local;
  } catch {
    /* not bundled */
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* next */
    }
  }
  return null;
}
