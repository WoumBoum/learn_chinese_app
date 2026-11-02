// Renders resources/icon.png (512x512) with Electron, using the bundled Noto Sans SC font.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
app.commandLine.appendSwitch('no-sandbox');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const font = path.resolve(__dirname, '../node_modules/@fontsource/noto-sans-sc/files');
  const f = fs.readdirSync(font).filter((x) => x.includes('-700-normal') && x.endsWith('.woff2'));
  const faces = f.map((x) => `@font-face{font-family:N;font-weight:700;src:url('file://${font}/${x}') format('woff2');}`).join('\n');
  const html = `<html><head><style>${faces} body{margin:0;background:transparent}
  .i{width:512px;height:512px;border-radius:112px;background:linear-gradient(145deg,#1a232c,#0f1419);display:grid;place-items:center;position:relative;overflow:hidden;box-sizing:border-box;border:10px solid #e5484d}
  .c{font-family:N;font-weight:700;font-size:300px;color:#e6edf3;line-height:1;margin-top:-20px}
  .s{position:absolute;bottom:40px;font:700 44px sans-serif;letter-spacing:10px;color:#e5484d}
  .stamp{position:absolute;top:36px;right:-60px;transform:rotate(35deg);background:#e5484d;color:#fff;font:700 30px sans-serif;padding:6px 80px;letter-spacing:4px}
  </style></head><body><div class="i"><div class="c">中</div><div class="s">特工</div><div class="stamp">TOP</div></div></body></html>`;
  const win = new BrowserWindow({ width: 512, height: 512, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  const tmp = path.join(require('os').tmpdir(), 'om-icon.html');
  fs.writeFileSync(tmp, html);
  await win.loadFile(tmp);
  await new Promise((r) => setTimeout(r, 1500));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  fs.writeFileSync(path.resolve(__dirname, '../resources/icon.png'), img.resize({ width: 512, height: 512 }).toPNG());
  app.quit();
});
