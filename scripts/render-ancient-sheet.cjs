// Renders ancient-form SVGs with Electron's Chromium (the app's renderer) to a PNG contact sheet and,
// in --pairs mode, measures how faithful the sanitizer is (ink IoU original vs sanitized, 256 px).
//
//   xvfb-run -a npx electron scripts/render-ancient-sheet.cjs --no-sandbox --json resources/data/ancient.json --chars 人马日月 --out sheet.png
//   xvfb-run -a npx electron scripts/render-ancient-sheet.cjs --no-sandbox --pairs DIR_OF_SVGS --out pairs.png [--report pairs.json]
//
// --json  : grid, one row per char, one column per form (oracle / bronze / bigseal / seal), light + dark cell.
// --pairs : every *.svg in DIR is sanitized with scripts/lib/ancient-svg.mjs; row = original | sanitized | XOR diff.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const argv = process.argv;
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const OUT = path.resolve(opt('out', 'ancient-sheet.png'));
const FORMS = ['oracle', 'bronze', 'bigseal', 'seal'];
app.disableHardwareAcceleration();

async function buildItems() {
  if (opt('pairs')) {
    const { sanitize } = await import(path.join(__dirname, 'lib/ancient-svg.mjs'));
    const dir = path.resolve(opt('pairs'));
    return fs.readdirSync(dir).filter((f) => f.endsWith('.svg') && !f.endsWith('.clean.svg')).sort().map((f) => {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8');
      const r = sanitize(raw, { precision: Number(opt('precision', 1)) });
      return { label: f.replace(/\.svg$/, ''), cells: [raw, r.svg], rawBytes: Buffer.byteLength(raw), cleanBytes: Buffer.byteLength(r.svg) };
    });
  }
  const data = JSON.parse(fs.readFileSync(path.resolve(opt('json')), 'utf8'));
  const chars = [...(opt('chars') || Object.keys(data).filter((k) => k !== '_meta').slice(0, 12).join(''))];
  return chars.map((c) => ({ label: c + (data[c]?.src ? ' (' + [...new Set(Object.values(data[c].src))].join('') + ')' : ''), cells: FORMS.map((f) => data[c]?.[f] || null) }));
}

app.whenReady().then(async () => {
  const items = await buildItems();
  const pairs = !!opt('pairs');
  const cols = pairs ? ['original', 'sanitized', 'diff (red = lost, blue = added)'] : FORMS;
  // Pages of ROWS rows (window height is capped by the X screen): out.png, out-2.png, …
  const ROWS = Number(opt('rows', 6));
  const W = 170 + cols.length * 150, H = 40 + ROWS * 140;
  const win = new BrowserWindow({ show: false, width: W, height: H, useContentSize: true, webPreferences: { offscreen: true } });
  const result = [], outs = [];
  for (let page = 0; page * ROWS < items.length; page++) {
  const chunk = items.slice(page * ROWS, page * ROWS + ROWS);
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><meta charset="utf-8"><body style="margin:0;background:#fff;font:14px sans-serif;overflow:hidden"></body>`));
  const res = await win.webContents.executeJavaScript(`(async () => {
    const items = ${JSON.stringify(chunk)}, cols = ${JSON.stringify(cols)}, pairs = ${pairs};
    const load = (svg) => new Promise((ok, ko) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ko(new Error('render failed')); i.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); });
    const S = 256;
    const mask = (img) => { const c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d'); g.drawImage(img, 0, 0, S, S); const d = g.getImageData(0, 0, S, S).data; const m = new Uint8Array(S * S); for (let i = 0; i < S * S; i++) m[i] = d[i * 4 + 3] > 127 && d[i * 4] < 128 ? 1 : 0; return m; };
    const head = document.createElement('div'); head.style.cssText = 'display:flex;height:40px;align-items:center;font-weight:bold'; head.innerHTML = '<div style="width:170px;padding-left:8px">char</div>' + cols.map((c) => '<div style="width:150px;text-align:center">' + c + '</div>').join(''); document.body.append(head);
    const stats = [];
    for (const it of items) {
      const row = document.createElement('div'); row.style.cssText = 'display:flex;height:140px;align-items:center;border-top:1px solid #ddd';
      const lab = document.createElement('div'); lab.style.cssText = 'width:170px;padding-left:8px;font-size:' + (pairs ? 13 : 40) + 'px;word-break:break-all'; lab.textContent = it.label; row.append(lab);
      const imgs = [];
      for (const svg of it.cells) {
        const cell = document.createElement('div'); cell.style.cssText = 'width:150px;display:flex;justify-content:center';
        if (svg) {
          const box = document.createElement('div'); box.style.cssText = 'display:flex;gap:2px';
          // light cell (img: currentColor = black) + dark cell (inline svg: currentColor = white), like the app themes
          const a = document.createElement('div'); const sz = pairs ? 128 : 70; a.style.cssText = 'width:' + sz + 'px;height:' + sz + 'px;background:#fffdf7;border:1px solid #ccc';
          const im = document.createElement('img'); im.style.cssText = 'width:100%;height:100%'; a.append(im); box.append(a);
          try { const loaded = await load(svg); im.src = loaded.src; imgs.push(loaded); } catch (e) { a.textContent = 'ERR'; imgs.push(null); }
          if (!pairs) { const b = document.createElement('div'); b.style.cssText = 'width:70px;height:70px;background:#1d1f24;color:#f3efe6;border:1px solid #ccc;--bg:#1d1f24'; b.innerHTML = svg.replace('<svg ', '<svg width="70" height="70" '); box.append(b); }
          cell.append(box);
        } else { cell.textContent = '—'; cell.style.color = '#aaa'; imgs.push(null); }
        row.append(cell);
      }
      if (pairs && imgs[0] && imgs[1]) {
        const m0 = mask(imgs[0]), m1 = mask(imgs[1]);
        let inter = 0, uni = 0, lost = 0, added = 0;
        const c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d'); const id = g.createImageData(S, S);
        for (let i = 0; i < S * S; i++) { inter += m0[i] & m1[i]; uni += m0[i] | m1[i]; const p = i * 4; id.data[p + 3] = 255;
          if (m0[i] && !m1[i]) { lost++; id.data[p] = 230; } else if (!m0[i] && m1[i]) { added++; id.data[p + 2] = 230; } else if (m0[i]) { id.data[p] = id.data[p + 1] = id.data[p + 2] = 200; } else { id.data[p] = id.data[p + 1] = id.data[p + 2] = 255; } }
        g.putImageData(id, 0, 0); c.style.cssText = 'width:128px;height:128px;border:1px solid #ccc';
        const cell = document.createElement('div'); cell.style.cssText = 'width:150px;display:flex;flex-direction:column;align-items:center;font-size:11px'; cell.append(c);
        const iou = uni ? inter / uni : 1; const t = document.createElement('div'); t.textContent = 'IoU ' + iou.toFixed(4) + ' · ' + it.rawBytes + '→' + it.cleanBytes + ' B'; cell.append(t); row.append(cell);
        stats.push({ label: it.label, iou, inkPx: m0.reduce((a, b) => a + b, 0), lost, added, rawBytes: it.rawBytes, cleanBytes: it.cleanBytes });
      }
      document.body.append(row);
    }
    await new Promise((r) => setTimeout(r, 300));
    return stats;
  })()`);
  const img = await win.webContents.capturePage();
  const file = page ? OUT.replace(/\.png$/, `-${page + 1}.png`) : OUT;
  fs.writeFileSync(file, img.toPNG());
  outs.push(file);
  result.push(...res);
  }
  if (pairs) {
    const ious = result.map((r) => r.iou).sort((a, b) => a - b);
    console.log(JSON.stringify({ n: ious.length, minIoU: ious[0], medianIoU: ious[ious.length >> 1], meanIoU: ious.reduce((a, b) => a + b, 0) / ious.length, rawBytes: result.reduce((a, r) => a + r.rawBytes, 0), cleanBytes: result.reduce((a, r) => a + r.cleanBytes, 0) }));
    if (opt('report')) fs.writeFileSync(path.resolve(opt('report')), JSON.stringify(result, null, 1));
  }
  console.log('wrote', outs.join(' '));
  app.quit();
});
