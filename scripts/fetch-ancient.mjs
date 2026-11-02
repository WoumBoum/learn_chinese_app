#!/usr/bin/env node
// Fetches historical character forms (oracle bone 甲骨文, bronze 金文, large seal 大篆, small seal 小篆)
// for the curriculum characters (keys of resources/data/chars.json) from the Wikimedia Commons
// "Ancient Chinese characters project" (files named `File:<char>-<form>.svg`), sanitizes the SVGs
// (paths only, transforms baked in, numbers minified) and writes resources/data/ancient.json.
//
// Usage:
//   node scripts/fetch-ancient.mjs [--cache DIR] [--out FILE] [--report FILE] [--limit N]
//                                  [--no-download] [--forms oracle,bronze,bigseal,seal] [--precision 1]
//
// - Simplified → traditional candidates come from OpenCC STCharacters.txt (downloaded into the cache):
//   most ACC files are named with the TRADITIONAL character (馬-oracle.svg, not 马-oracle.svg).
// - Every HTTP response is cached under --cache (default ~/.cache/operation-mandarin/ancient), so a
//   re-run is offline and deterministic. Commons API: 50 titles/request, ≥1.5 s between requests,
//   Retry-After / exponential back-off on 429 & 5xx (the API rate-limits anonymous shared IPs hard).
// - Behind an HTTPS proxy, Node's fetch needs NODE_USE_ENV_PROXY=1 (Node ≥ 22.21): the script
//   re-executes itself with it when HTTPS_PROXY is set.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sanitize } from './lib/ancient-svg.mjs';

if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY) {
  const r = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1' } });
  process.exit(r.status ?? 1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : def; };
const flag = (name) => argv.includes('--' + name);

const CACHE = path.resolve(opt('cache', path.join(os.homedir(), '.cache', 'operation-mandarin', 'ancient')));
const OUT = path.resolve(opt('out', path.join(ROOT, 'resources/data/ancient.json')));
const REPORT = opt('report', null);
const LIMIT = Number(opt('limit', 0)) || Infinity;
const PRECISION = Number(opt('precision', 1));
// Forms probed on Commons (coverage stats) vs forms bundled in ancient.json.
const PROBE_FORMS = ['oracle', 'bronze', 'bigseal', 'seal', 'silk', 'slip'];
const BUNDLE_FORMS = opt('forms', 'oracle,bronze,bigseal,seal').split(',');
// Wikimedia User-Agent policy: identify the tool and give a contact (override with ANCIENT_UA).
const UA = process.env.ANCIENT_UA || 'OperationMandarin/0.1 (https://github.com/WoumBoum/learn_chinese_app; build-time fetch of Ancient Chinese characters project SVGs) node';
const API = 'https://commons.wikimedia.org/w/api.php';
const STCHARS_URL = 'https://raw.githubusercontent.com/BYVoid/OpenCC/ver.1.1.9/data/dictionary/STCharacters.txt';
// Simplified glyphs that are themselves the historical original (古字) of the traditional form, so their
// own ancient forms may be used when the traditional character has none. Any other simplified-only hit
// is NOT used (厂 hǎn "cliff" ≠ 廠, 广 yǎn ≠ 廣, 叶 xié ≠ 葉 …) and is only listed in the report.
const SELF_OK = new Set([...'云从众网采气']);

fs.mkdirSync(CACHE, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastApi = 0;

async function http(url, { api = false, tries = 8 } = {}) {
  if (flag('offline')) throw new Error(`--offline: refusing to fetch ${url} (not in cache)`);
  for (let t = 0; t < tries; t++) {
    if (api) { const wait = lastApi + 1500 - Date.now(); if (wait > 0) await sleep(wait); lastApi = Date.now(); }
    let res;
    try { res = await fetch(url, { headers: { 'User-Agent': UA, 'Api-User-Agent': UA } }); }
    catch (e) { await sleep(2000 * 2 ** t); continue; }
    if (res.ok) return res;
    if (res.status === 404) return res;
    if (res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers.get('retry-after')) || 0;
      const ms = Math.max(ra * 1000, Math.min(120000, 3000 * 2 ** t)) + Math.random() * 1000;
      process.stderr.write(`  HTTP ${res.status} → retry in ${(ms / 1000).toFixed(0)} s\n`);
      await sleep(ms);
      continue;
    }
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  throw new Error(`giving up on ${url}`);
}

// ---------- characters & candidates ----------
const charsJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'resources/data/chars.json'), 'utf8'));
const chars = Object.values(charsJson.chars).sort((a, b) => a.i - b.i).map((x) => x.c).slice(0, LIMIT);

async function loadST() {
  const f = path.join(CACHE, 'STCharacters.txt');
  if (!fs.existsSync(f)) fs.writeFileSync(f, await (await http(STCHARS_URL)).text());
  const m = new Map();
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const [s, t] = line.split('\t');
    if (s && t) m.set(s, t.trim().split(/\s+/));
  }
  return m;
}
const ST = await loadST();
/** Ordered candidates: traditional forms (OpenCC order = most frequent first), then the char itself. */
const candidates = (c) => { const l = [...(ST.get(c) || [])]; if (!l.includes(c)) l.push(c); return l; };

// ---------- Commons metadata ----------
const strip = (h) => (h || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/\s+/g, ' ').trim();
const metaFile = path.join(CACHE, 'meta.json');
const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {};
const titleOf = (cand, form) => `File:${cand}-${form}.svg`;
const wanted = [...new Set(chars.flatMap((c) => candidates(c).flatMap((k) => PROBE_FORMS.map((f) => titleOf(k, f)))))];
const todo = wanted.filter((t) => !(t in meta));
console.log(`${chars.length} chars, ${wanted.length} candidate titles, ${todo.length} not cached`);
for (let i = 0; i < todo.length; i += 50) {
  const batch = todo.slice(i, i + 50);
  const url = `${API}?action=query&format=json&formatversion=2&maxlag=5&prop=imageinfo&iiprop=url%7Csize%7Cextmetadata%7Csha1&iiextmetadatafilter=LicenseShortName%7CLicense%7CLicenseUrl%7CCopyrighted%7CAttributionRequired%7CUsageTerms%7CArtist%7CCredit%7CImageDescription&titles=${encodeURIComponent(batch.join('|'))}`;
  const j = await (await http(url, { api: true })).json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  const norm = new Map((j.query.normalized || []).map((n) => [n.to, n.from]));
  for (const p of j.query.pages) {
    const t = norm.get(p.title) || p.title;
    if (p.missing || !p.imageinfo) { meta[t] = null; continue; }
    const ii = p.imageinfo[0], em = ii.extmetadata || {};
    const v = (k) => em[k]?.value;
    meta[t] = {
      url: ii.url.split('?')[0], desc: ii.descriptionurl, size: ii.size, w: ii.width, h: ii.height, sha1: ii.sha1,
      license: v('LicenseShortName') || null, licenseCode: v('License') || null, licenseUrl: v('LicenseUrl') || null,
      copyrighted: v('Copyrighted') ?? null, attribution: v('AttributionRequired') ?? null,
      artist: strip(v('Artist')) || null, credit: strip(v('Credit')).slice(0, 300) || null,
      description: strip(v('ImageDescription')).slice(0, 300) || null,
    };
  }
  for (const t of batch) if (!(t in meta)) meta[t] = null;
  fs.writeFileSync(metaFile, JSON.stringify(meta));
  process.stdout.write(`  meta ${Math.min(i + 50, todo.length)}/${todo.length}\r`);
}
console.log('');

// ---------- selection ----------
// For each char and form: first candidate (traditional first) that has the file; the simplified
// glyph itself only if it is the traditional glyph too, or whitelisted in SELF_OK.
const sel = {}; // char -> form -> {title, src}
const selfOnly = []; // [char, form, title] hits rejected because only the simplified glyph has them
// Licenses acceptable for a publicly distributed app (attribution kept in ancient.json either way).
const LICENSE_OK = /^(public domain|pd\b|cc0|cc[ -]by(-sa)?[ -]?[0-9.]*( \w+)?$)/i;
const badLicense = []; // [title, license] files that exist but are skipped for licensing reasons
for (const c of chars) {
  sel[c] = {};
  const cands = candidates(c);
  const isTradToo = !ST.has(c) || ST.get(c).includes(c);
  for (const f of PROBE_FORMS) {
    for (const k of cands) {
      const m = meta[titleOf(k, f)];
      if (!m) continue;
      if (!LICENSE_OK.test(m.license || '')) { badLicense.push([titleOf(k, f), m.license]); continue; }
      if (k === c && !isTradToo && cands.length > 1 && !SELF_OK.has(c)) { selfOnly.push([c, f, titleOf(k, f)]); break; }
      sel[c][f] = { title: titleOf(k, f), src: k };
      break;
    }
  }
}

// ---------- SVG sanitizer: scripts/lib/ancient-svg.mjs ----------
// ---------- download + build ----------
const dlDir = path.join(CACHE, 'svg');
fs.mkdirSync(dlDir, { recursive: true });
const jobs = [];
for (const c of chars) for (const f of BUNDLE_FORMS) if (sel[c][f]) jobs.push([c, f, sel[c][f]]);
const stats = { dropped: {}, white: 0, stroked: 0, rawBytes: 0, outBytes: 0, failed: [], vbNon300: 0, licenses: {} };
if (!flag('no-download')) {
  let done = 0;
  const queue = jobs.filter(([, , s]) => !fs.existsSync(path.join(dlDir, Buffer.from(s.title).toString('hex') + '.svg')));
  console.log(`${jobs.length} SVGs selected, ${queue.length} to download`);
  const worker = async () => {
    while (queue.length) {
      const [, , s] = queue.shift();
      const m = meta[s.title];
      try {
        const res = await http(m.url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        fs.writeFileSync(path.join(dlDir, Buffer.from(s.title).toString('hex') + '.svg'), await res.text());
      } catch (e) { stats.failed.push([s.title, String(e.message || e)]); }
      await sleep(150);
      process.stdout.write(`  svg ${++done}\r`);
    }
  };
  await Promise.all([worker(), worker()]);
  console.log('');
}
const out = {};
const creditMeta = {};
for (const [c, f, s] of jobs) {
  const file = path.join(dlDir, Buffer.from(s.title).toString('hex') + '.svg');
  if (!fs.existsSync(file)) continue;
  const raw = fs.readFileSync(file, 'utf8');
  let r;
  try { r = sanitize(raw, { precision: PRECISION }); } catch (e) { stats.failed.push([s.title, 'sanitize: ' + e.message]); continue; }
  stats.white += r.stats.white; stats.stroked += r.stats.stroked;
  for (const [k, v] of Object.entries(r.stats.dropped)) stats.dropped[k] = (stats.dropped[k] || 0) + v;
  if (!r.nPaths) { stats.failed.push([s.title, 'no paths']); continue; }
  if (r.vb[2] !== 300 || r.vb[3] !== 300) stats.vbNon300++;
  stats.rawBytes += raw.length; stats.outBytes += r.svg.length;
  const m = meta[s.title];
  stats.licenses[m.license] = (stats.licenses[m.license] || 0) + 1;
  (out[c] ||= {})[f] = r.svg;
  if (s.src !== c) (out[c].src ||= {})[f] = s.src;
  // Compact credit: file name + author + license (all ACC files are by the same group; see _meta).
  (out[c].credit ||= {})[f] = { file: s.title.slice(5), author: m.artist, license: m.license };
  creditMeta[m.license] = m.licenseUrl;
}
const result = {
  _meta: {
    source: 'Wikimedia Commons — Ancient Chinese characters project (https://commons.wikimedia.org/wiki/Commons:Ancient_Chinese_characters_project)',
    fileUrl: 'https://commons.wikimedia.org/wiki/File:<file>',
    licenses: creditMeta,
    forms: { oracle: '甲骨文 (Shang, ~1250–1050 av. J.-C.)', bronze: '金文 (Shang–Zhou)', bigseal: '大篆 / 籀文', seal: '小篆 (Qin, Shuowen)' },
    note: 'SVG sanitized (paths only, transforms baked in, fill=currentColor). `src` = character whose file was used when it differs from the key (traditional form, e.g. 马 → 馬).',
    generated: new Date().toISOString().slice(0, 10),
  },
  ...out,
};
fs.writeFileSync(OUT, JSON.stringify(result));
const outSize = fs.statSync(OUT).size;

// ---------- coverage report ----------
const buckets = [300, 600, chars.length];
const cov = {};
for (const N of buckets) {
  const sub = chars.slice(0, N);
  const row = { n: sub.length };
  for (const f of PROBE_FORMS) row[f] = sub.filter((c) => sel[c][f]).length;
  row.anyAncient = sub.filter((c) => ['oracle', 'bronze', 'bigseal', 'seal'].some((f) => sel[c][f])).length;
  row.anyPreQin = sub.filter((c) => ['oracle', 'bronze'].some((f) => sel[c][f])).length;
  row.bundled = sub.filter((c) => out[c] && BUNDLE_FORMS.some((f) => out[c][f])).length;
  row.viaTraditional = sub.filter((c) => out[c]?.src).length;
  row.selectedViaTraditional = sub.filter((c) => Object.values(sel[c]).some((x) => x.src !== c)).length;
  cov[N] = row;
}
const licenseCount = {};
for (const t of wanted) if (meta[t]) { const k = `${meta[t].license} | copyrighted=${meta[t].copyrighted} | attribution=${meta[t].attribution}`; licenseCount[k] = (licenseCount[k] || 0) + 1; }
const artists = {};
for (const t of wanted) if (meta[t]) artists[meta[t].artist] = (artists[meta[t].artist] || 0) + 1;
const sizes = wanted.filter((t) => meta[t]).map((t) => meta[t].size).sort((a, b) => a - b);
const report = {
  chars: chars.length, titlesProbed: wanted.length, titlesFound: sizes.length,
  coverage: cov, licenses: licenseCount, artists: Object.fromEntries(Object.entries(artists).sort((a, b) => b[1] - a[1]).slice(0, 15)),
  rawFileSize: { min: sizes[0], median: sizes[sizes.length >> 1], p95: sizes[Math.floor(sizes.length * 0.95)], max: sizes[sizes.length - 1] },
  bundle: { file: path.relative(ROOT, OUT), bytes: outSize, svgs: Object.values(out).reduce((n, o) => n + BUNDLE_FORMS.filter((f) => o[f]).length, 0), rawBytes: stats.rawBytes, svgBytes: stats.outBytes, whiteKnockouts: stats.white, strokedPaths: stats.stroked, dropped: stats.dropped, viewBoxNot300: stats.vbNon300, failed: stats.failed, licenses: stats.licenses },
  rejectedSimplifiedOnly: selfOnly,
  rejectedLicense: badLicense,
  missingAll: chars.filter((c) => !['oracle', 'bronze', 'bigseal', 'seal'].some((f) => sel[c][f])),
  missingTop300: chars.slice(0, 300).filter((c) => !['oracle', 'bronze', 'bigseal', 'seal'].some((f) => sel[c][f])),
};
console.log(JSON.stringify({ coverage: cov, bundle: { bytes: outSize, svgs: report.bundle.svgs, failed: stats.failed.length }, licenses: licenseCount }, null, 1));
if (REPORT) fs.writeFileSync(path.resolve(REPORT), JSON.stringify(report, null, 1));
