// Evaluation helper (word-videos): replays cached yt-dlp search JSON (from fetch-word-video-search.sh) through the
// pure scorer (scripts/lib/word-video-score.mjs) and prints the top candidates per word and slot.
//   node scripts/eval-word-video-ranking.mjs SEARCH_DIR[,SEARCH_DIR2…] [--channels content/catalog/word-video-channels.json] [--json out.json] [--top 3]
import fs from 'node:fs';
import path from 'node:path';
import { rankCandidates, hanChars } from './lib/word-video-score.mjs';

const args = process.argv.slice(2);
const dir = args[0];
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const chanFile = opt('--channels', path.join(root, 'content/catalog/word-video-channels.json'));
const top = Number(opt('--top', 3));
const words = JSON.parse(fs.readFileSync(path.join(root, 'resources/data/words.json'), 'utf8'));
const chars = JSON.parse(fs.readFileSync(path.join(root, 'resources/data/chars.json'), 'utf8')).chars;
const wmap = new Map(words.map((x) => [x.w, x]));
const pyOf = (w) => wmap.get(w)?.py ?? (chars[w]?.py ?? [])[0] ?? '';
// Traditional spellings from CEDICT (data-raw/cedict.txt.gz): simplified → [traditional ≠ simplified].
import zlib from 'node:zlib';
const trad = new Map();
const ced = path.join(root, 'data-raw/cedict.txt.gz');
if (fs.existsSync(ced)) for (const line of zlib.gunzipSync(fs.readFileSync(ced)).toString('utf8').split('\n')) {
  const m = /^(\S+) (\S+) \[/.exec(line);
  if (m && m[1] !== m[2]) { const a = trad.get(m[2]) ?? []; if (!a.includes(m[1])) a.push(m[1]); trad.set(m[2], a); }
}
const channels = {};
if (fs.existsSync(chanFile)) for (const c of JSON.parse(fs.readFileSync(chanFile, 'utf8'))) if (c.channelId) channels[c.channelId] = c;

const files = dir.split(',').flatMap((dd) => fs.readdirSync(dd).filter((f) => f.endsWith('.json')).map((f) => path.join(dd, f)));
const byWord = new Map();
for (const f of files) {
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!d._word) continue;
  if (!byWord.has(d._word)) byWord.set(d._word, []);
  for (const e of d.entries ?? []) byWord.get(d._word).push({ ...e, _template: d._template });
}
const out = [];
for (const [w, pool] of [...byWord.entries()].sort((a, b) => (wmap.get(a[0])?.rank ?? 1e9) - (wmap.get(b[0])?.rank ?? 1e9))) {
  const res = { w, py: pyOf(w), poolSize: pool.length, uniqueIds: new Set(pool.map((e) => e.id)).size, slots: {} };
  const targets = [{ slot: 'usage', w, py: pyOf(w), alt: trad.get(w) }, ...hanChars(w).map((c) => ({ slot: 'etymology', w: c, py: pyOf(c), alt: trad.get(c) }))];
  for (const t of targets) {
    const r = rankCandidates(t, pool, channels);
    res.slots[`${t.slot}:${t.w}`] = r.slice(0, top).map((x) => ({
      score: x.score, id: x.entry.id, title: x.entry.title, channel: x.entry.channel, duration: x.entry.duration,
      views: x.entry.view_count, from: x.entry._template, f: x.f, offSlot: x.offSlot,
    }));
    res.slots[`${t.slot}:${t.w}`].nAccepted = r.length;
  }
  out.push(res);
  console.log(`\n### ${w} (${res.py}) pool=${res.poolSize} unique=${res.uniqueIds}`);
  for (const [k, list] of Object.entries(res.slots)) {
    console.log(`  [${k}] accepted=${list.nAccepted}`);
    for (const x of list) console.log(`    ${x.offSlot ? '~' : ' '}${x.score.toFixed(3)} ${String(x.duration).padStart(5)}s ${x.id} | ${(x.channel ?? '').slice(0, 24).padEnd(24)} | ${x.title.slice(0, 80)}`);
  }
}
if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify(out, null, 1));
