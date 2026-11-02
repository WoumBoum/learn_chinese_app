import path from 'node:path';
import fs from 'node:fs';
import { app, BrowserWindow, dialog, session, shell } from 'electron';
import { createCtx, type Ctx } from './ctx';
import { registerIpcModules } from './ipc';

let win: BrowserWindow | null = null;
let ctx: Ctx | null = null;

// Allow a separate profile (tests, screenshots): OM_USER_DATA=/tmp/x
if (process.env.OM_USER_DATA) app.setPath('userData', process.env.OM_USER_DATA);

// Running as root (e.g. in containers) requires disabling the Chromium sandbox.
if (process.getuid && process.getuid() === 0) app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

async function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1000,
    minHeight: 680,
    backgroundColor: '#0f1419',
    title: 'Opération Mandarin',
    icon: app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : path.join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Local media (downloaded videos, TTS audio) is loaded with file:// URLs.
      webSecurity: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Never let a dropped file (or any link) replace the app page.
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) e.preventDefault();
  });
  const devUrl = process.env.OM_DEV_URL;
  if (devUrl) await win.loadURL(devUrl);
  else await win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.on('closed', () => (win = null));
}

// One instance per profile: two processes would overwrite each other's user.db.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(async () => {
    try {
      session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
        cb(['media', 'microphone', 'audioCapture'].includes(permission) || permission === 'clipboard-sanitized-write');
      });
      session.defaultSession.setPermissionCheckHandler(() => true);
      // Lecteur YouTube intégré : la page file:// n'envoie aucun Referer → erreur 153. On identifie l'app (identifiant
      // d'application, règles YouTube) sur la seule requête du document /embed/* ; Origin et les autres requêtes intactes.
      session.defaultSession.webRequest.onBeforeSendHeaders(
        { urls: ['https://www.youtube-nocookie.com/embed/*', 'https://www.youtube.com/embed/*'] },
        (d, cb) => {
          const h = d.requestHeaders;
          if (d.resourceType === 'subFrame' && !h['Referer'] && !h['referer']) h['Referer'] = 'https://app.operation-mandarin/';
          cb({ requestHeaders: h });
        },
      );
      ctx = await createCtx(() => win);
      registerIpcModules(ctx);
      await createWindow();
      if (process.env.OM_SCREENSHOT_DIR) fs.mkdirSync(process.env.OM_SCREENSHOT_DIR, { recursive: true });
    } catch (e) {
      console.error(e);
      dialog.showErrorBox(
        'Opération Mandarin — erreur au démarrage',
        `${e instanceof Error ? e.stack ?? e.message : String(e)}\n\nTes données sont dans ${app.getPath('userData')}.`,
      );
      app.exit(1);
    }
  });
}

app.on('before-quit', () => ctx?.db.saveNow());
app.on('window-all-closed', () => {
  ctx?.db.saveNow();
  app.quit();
});
