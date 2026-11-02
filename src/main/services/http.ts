// HTTP helpers for the main process (Electron net.fetch honours system proxy settings; falls back to Node fetch).
import fs from 'node:fs';

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

function getFetch(): FetchFn {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { net } = require('electron') as typeof import('electron');
    if (net?.fetch) return (u, i) => net.fetch(u, i as never) as unknown as Promise<Response>;
  } catch {
    /* not in Electron (tests) */
  }
  return (u, i) => fetch(u, i);
}

export async function fetchText(url: string, timeoutMs = 30_000): Promise<string> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await getFetch()(url, { signal: ac.signal, headers: { 'User-Agent': 'OperationMandarin/0.1 (+podcast)' } });
    if (!r.ok) throw new Error(`HTTP ${r.status} pour ${url}`);
    return await r.text();
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error('Délai dépassé pour ' + url);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

const aborts = new Map<string, AbortController>();

export function cancelDownload(job: string): boolean {
  const a = aborts.get(job);
  if (!a) return false;
  a.abort();
  return true;
}

/** Stream a URL to a file (via a .part file) with progress callback (pct 0-100, -1 when size unknown). */
export async function downloadFile(url: string, dest: string, onProgress?: (pct: number, received: number) => void, job?: string): Promise<void> {
  const ac = new AbortController();
  if (job) aborts.set(job, ac);
  const tmp = dest + '.part';
  try {
    const r = await getFetch()(url, { signal: ac.signal, headers: { 'User-Agent': 'OperationMandarin/0.1' } });
    if (!r.ok || !r.body) throw new Error(`HTTP ${r.status} pour ${url}`);
    const total = +(r.headers.get('content-length') ?? 0);
    const out = fs.createWriteStream(tmp);
    const reader = r.body.getReader();
    let received = 0;
    let lastPct = -2;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (!out.write(Buffer.from(value))) await new Promise<void>((res) => out.once('drain', () => res()));
        const pct = total ? Math.floor((received / total) * 100) : -1;
        if (pct !== lastPct) {
          lastPct = pct;
          onProgress?.(pct, received);
        }
      }
    } finally {
      await new Promise<void>((res) => out.end(() => res()));
    }
    if (total && received < total) throw new Error('Téléchargement incomplet');
    fs.renameSync(tmp, dest);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    if ((e as Error).name === 'AbortError') throw new Error('Opération annulée');
    throw e;
  } finally {
    if (job) aborts.delete(job);
  }
}
