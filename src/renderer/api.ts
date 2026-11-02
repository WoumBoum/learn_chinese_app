// Bridge to the main process. Every call goes through `window.om.invoke(channel, ...args)`.
interface OmBridge {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, cb: (payload: unknown) => void) => () => void;
}
const bridge = (window as unknown as { om: OmBridge }).om;

export function call<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  return bridge.invoke(channel, ...args) as Promise<T>;
}

export function listen<T = unknown>(channel: string, cb: (payload: T) => void): () => void {
  return bridge.on(channel, cb as (p: unknown) => void);
}

/** Convert an absolute local path into a URL usable in <audio>/<video>/<img>. */
export function fileUrl(p: string): string {
  if (!p) return '';
  if (/^(https?|file|data|blob):/.test(p)) return p;
  return 'file://' + p.split('/').map(encodeURIComponent).join('/');
}
