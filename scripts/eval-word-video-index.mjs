// Evaluation helper (word-videos): "channel index first" strategy — how many curriculum targets can be served by the
// uploads of catalogued channels alone (no per-word search)?  Uses the same pure scorer.
//   node scripts/eval-word-video-index.mjs LISTING_DIR[,LISTING_DIR2…] [--n 300] [--min 0.5] [--json out.json]
// LISTING_DIR = output of verify-word-video-channels.sh (later dirs override earlier ones for the same channel).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { rankCandidates, hanChars } from './lib/word-video-score.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const N = Number(opt('--n', 300));
const MIN = Number(opt('--min', 0.5));
const words = JSON.parse(fs.readFileSync(path.join(root, 'resources/data/words.json'), 'utf8')).sort((a, b) => a.rank - b.rank);
const chars = JSON.parse(fs.readFileSync(path.join(root, 'resources/data/chars.json'), 'utf8')).chars;
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'content/catalog/word-video-channels.json'), 'utf8'));
const channels = Object.fromEntries(catalog.filter((c) => c.channelId).map((c) => [c.channelId, c]));
const trad = new Map();
for (const line of zlib.gunzipSync(fs.readFileSync(path.join(root, 'data-raw/cedict.txt.gz'))).toString('utf8').split('\n')) {
  const m = /^(\S+) (\S+) \[/.exec(line);
  if (m && m[1] !== m[2]) { const a = trad.get(m[2]) ?? []; if (!a.includes(m[1])) a.push(m[1]); trad.set(m[2], a); }
}
// Load listings; entries of a channel listing lack channel_id → take it from the playlist.
const byChan = new Map();
for (const dir of args[0].split(',')) for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
  const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const cid = d.channel_id || d.id;
  if (!channels[cid]) continue;
  byChan.set(cid, (d.entries ?? []).filter(Boolean).map((e) => ({ ...e, channel_id: cid, channel: d.channel })));
}
const pool = [...byChan.values()].flat();
const pyOf = (w) => words.find((x) => x.w === w)?.py ?? chars[w]?.py?.[0] ?? '';
const top = words.slice(0, N);
const targets = new Map();
for (const x of top) {
  targets.set(`usage:${x.w}`, { slot: 'usage', w: x.w, py: x.py, alt: trad.get(x.w) });
  for (const c of hanChars(x.w)) targets.set(`etymology:${c}`, { slot: 'etymology', w: c, py: pyOf(c), alt: trad.get(c) });
}
const res = {};
const stat = { usage: [0, 0, 0], etymology: [0, 0, 0] }; // [targets, served (≥MIN, on-slot), offSlot-only]
const winners = { usage: {}, etymology: {} };
for (const [k, t] of targets) {
  const cand = pool.filter((e) => [t.w, ...(t.alt ?? [])].some((f) => (e.title ?? '').includes(f)));
  const r = rankCandidates(t, cand, channels, MIN);
  const on = r.filter((x) => !x.offSlot);
  stat[t.slot][0]++;
  if (on.length) { stat[t.slot][1]++; const ch = on[0].entry.channel; winners[t.slot][ch] = (winners[t.slot][ch] ?? 0) + 1; }
  else if (r.length) stat[t.slot][2]++;
  res[k] = on[0] ? { id: on[0].entry.id, title: on[0].entry.title, channel: on[0].entry.channel, score: on[0].score } : r[0] ? { offSlot: true, id: r[0].entry.id, title: r[0].entry.title } : null;
}
console.log(`pool: ${pool.length} uploads from ${byChan.size} catalogued channels; top ${N} words; min score ${MIN}`);
for (const s of ['usage', 'etymology']) {
  const [n, ok, off] = stat[s];
  console.log(`${s}: ${ok}/${n} = ${((100 * ok) / n).toFixed(1)} % served on-slot, +${off} off-slot fallback only, ${n - ok - off} none`);
  console.log('   top-1 by channel:', Object.entries(winners[s]).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c, v]) => `${c} ${v}`).join(' · '));
}
const missing = Object.entries(res).filter(([, v]) => !v).map(([k]) => k);
console.log('none (first 40):', missing.slice(0, 40).join(' '));
if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify({ stat, winners, res }, null, 1));
