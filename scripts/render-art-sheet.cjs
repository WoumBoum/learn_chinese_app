// Renders a contact sheet PNG of character illustrations (SVG drawn behind the character, as in the app).
// Usage: xvfb-run -a npx electron --no-sandbox scripts/render-art-sheet.cjs <batch.json> <out.png> [startIndex] [count]
// batch.json = { "<char>": { "svg": "<svg …>", ... }, ... }  (content/chars/parts/batch_XX.json format)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
app.commandLine.appendSwitch('no-sandbox');
app.disableHardwareAcceleration();

const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith('render-art-sheet.cjs')) + 1);
const [batchPath, outPath, start = '0', count = '40'] = args;

app.whenReady().then(async () => {
  const data = JSON.parse(fs.readFileSync(path.resolve(batchPath), 'utf8'));
  const entries = Object.entries(data).slice(+start, +start + +count);
  const fontDir = path.resolve(__dirname, '../node_modules/@fontsource/noto-sans-sc/files');
  const faces = fs
    .readdirSync(fontDir)
    .filter((x) => x.includes('-400-normal') && x.endsWith('.woff2'))
    .map((x) => `@font-face{font-family:N;src:url('file://${fontDir}/${x}') format('woff2');}`)
    .join('\n');
  const cells = entries
    .map(
      ([c, v]) => `<div class="cell"><div class="art">${v.svg || ''}</div><div class="ch">${c}</div><div class="cap">${c} · ${(v.scene_fr || '').slice(0, 60)}</div></div>`,
    )
    .join('');
  const html = `<html><head><meta charset="utf-8"><style>${faces}
  body{margin:0;background:#0f1419;color:#e6edf3;font-family:sans-serif}
  .grid{display:grid;grid-template-columns:repeat(8,180px);gap:8px;padding:8px}
  .cell{position:relative;width:180px;height:210px;background:#1a232c;border:1px solid #2c3a47;border-radius:8px;overflow:hidden}
  .art{position:absolute;left:10px;top:10px;width:160px;height:160px;opacity:.55;color:#e2b340}
  .art svg{width:100%;height:100%}
  .ch{position:absolute;left:0;right:0;top:20px;text-align:center;font-family:N;font-size:110px;color:rgba(230,237,243,.85)}
  .cap{position:absolute;bottom:4px;left:6px;right:6px;font-size:10px;color:#a9b6c2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  </style></head><body><div class="grid">${cells}</div></body></html>`;
  const tmp = path.join(os.tmpdir(), `art-sheet-${process.pid}.html`);
  fs.writeFileSync(tmp, html);
  const rows = Math.ceil(entries.length / 8);
  const win = new BrowserWindow({ width: 8 * 188 + 16, height: rows * 218 + 16, show: false, webPreferences: { offscreen: true } });
  await win.loadFile(tmp);
  await new Promise((r) => setTimeout(r, 1500));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.resolve(outPath), img.toPNG());
  console.log('wrote', outPath, entries.length, 'cells');
  app.quit();
});
