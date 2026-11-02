// Application context shared by all IPC handler modules.
import path from 'node:path';
import fs from 'node:fs';
import { app, ipcMain, type BrowserWindow } from 'electron';
import { Db, initSql } from '../core/db';
import { Content } from '../core/content';
import { Srs } from '../core/srs';
import { Curriculum } from '../core/curriculum';
import { initNlp } from '../core/nlp';
import type { Settings } from '../shared/types';
import { dayKey } from '../core/time';

export interface Paths {
  root: string; // app root (dev: project dir)
  data: string; // resources/data
  content: string; // content/
  bin: string; // bundled binaries
  user: string; // userData
  media: string; // downloaded videos & subtitles
  tts: string; // synthesized audio cache
  models: string; // whisper models etc.
  recordings: string;
  ttsModels: string; // sherpa-onnx models (resources/tts)
  audio: string; // native recordings (resources/audio)
}

export interface Ctx {
  paths: Paths;
  db: Db;
  content: Content;
  srs: Srs;
  cur: Curriculum;
  settings(): Settings;
  saveSettings(s: Partial<Settings>): Settings;
  win(): BrowserWindow | null;
  /** Push an event to the renderer (progress of downloads, etc.). */
  emit(channel: string, payload: unknown): void;
}

export const DEFAULT_SETTINGS: Settings = {
  onboarded: false,
  startDate: dayKey(),
  availability: { minutes: [120, 45, 45, 45, 45, 45, 120] },
  newWordsPerDay: 12,
  grammarDays: [3, 6],
  writingDay: 0,
  testDay: 0,
  interests: [],
  apiKey: '',
  aiModel: 'claude-sonnet-5-5',
  desiredRetention: 0.9,
  pinyinOnUnknownInPlayer: false,
  goalWords: 1500,
  goalDate: '',
};

export function resolvePaths(): Paths {
  const packaged = app.isPackaged;
  const root = packaged ? process.resourcesPath : path.resolve(__dirname, '../..');
  const user = app.getPath('userData');
  const p: Paths = {
    root,
    data: packaged ? path.join(root, 'data') : path.join(root, 'resources/data'),
    content: packaged ? path.join(root, 'content') : path.join(root, 'content'),
    bin: packaged ? path.join(root, 'bin') : path.join(root, 'resources/bin'),
    user,
    media: path.join(user, 'media'),
    tts: path.join(user, 'tts'),
    models: path.join(user, 'models'),
    recordings: path.join(user, 'recordings'),
    ttsModels: packaged ? path.join(root, 'tts') : path.join(root, 'resources/tts'),
    audio: packaged ? path.join(root, 'audio') : path.join(root, 'resources/audio'),
  };
  for (const d of [p.media, p.tts, p.models, p.recordings]) fs.mkdirSync(d, { recursive: true });
  return p;
}

export async function createCtx(getWin: () => BrowserWindow | null): Promise<Ctx> {
  const paths = resolvePaths();
  const sqlDir = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked/node_modules/sql.js/dist')
    : path.join(paths.root, 'node_modules/sql.js/dist');
  const SQL = await initSql(fs.existsSync(sqlDir) ? sqlDir : undefined);
  const db = new Db(SQL, path.join(paths.user, 'user.db'));
  const content = new Content(paths.data, paths.content).load();
  initNlp(content.words.map((w) => w.w));
  const settings = (): Settings => ({ ...DEFAULT_SETTINGS, ...db.getSetting<Partial<Settings>>('settings', {}) });
  const srs = new Srs(db, settings().desiredRetention);
  const cur = new Curriculum(db, content, srs);
  const ctx: Ctx = {
    paths,
    db,
    content,
    srs,
    cur,
    settings,
    saveSettings(s) {
      const next = { ...settings(), ...s };
      db.setSetting('settings', next);
      db.setSetting('startDate', next.startDate);
      srs.setRetention(next.desiredRetention);
      return next;
    },
    win: getWin,
    emit(channel, payload) {
      getWin()?.webContents.send(channel, payload);
    },
  };
  return ctx;
}

/** Register an IPC handler that returns either {ok:true,data} or {ok:false,error}. */
export function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>): void {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...(args as A)) };
    } catch (err) {
      console.error(`[ipc ${channel}]`, err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
