import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('om', {
  invoke: async (channel: string, ...args: unknown[]) => {
    const r = await ipcRenderer.invoke(channel, ...args);
    if (r && typeof r === 'object' && 'ok' in r) {
      if (r.ok) return r.data;
      throw new Error(r.error);
    }
    return r;
  },
  on: (channel: string, cb: (payload: unknown) => void) => {
    const fn = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
  },
});
