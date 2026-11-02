// Pré-calcule l'index « une vidéo YouTube par mot / caractère » à partir des listes de vidéos des chaînes du
// catalogue (yt-dlp --flat-playlist -J, data-raw/yt-channels puis data-raw/yt-channels-full qui les remplace).
//   node scripts/build-word-videos.mjs [--min 0.5] [--top 5] [--out resources/data/word-videos.json]
// Cibles : chaque mot de words.json → « u:<mot> » (usage) ; chaque caractère distinct → « e:<car> » (etymology).
// Sortie compacte et déterministe : { v:1, generated, channels:[noms], t: { "u:好": [[id, titre, durée, iChaîne, score×1000, offSlot?], …] },
//   alt: { "马": ["馬"] } } (graphies traditionnelles des caractères, pour la recherche de repli).
// Score : scripts/lib/word-video-score.mjs (identique à src/core/wordVideos.ts, test de parité vitest).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { rankCandidates, hanChars } from './lib/word-video-score.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const MIN = Number(opt('--min', 0.5));
const TOP = Number(opt('--top', 5));
const OUT = path.resolve(root, opt('--out', 'resources/data/word-videos.json'));
const DIRS = ['data-raw/yt-channels', 'data-raw/yt-channels-full'].map((d) => path.join(root, d)).filter((d) => fs.existsSync(d));

if (!DIRS.length) {
  // Données brutes absentes (clone sans data-raw) : garder l'index existant plutôt que l'écraser par un vide.
  console.warn('build-word-videos : data-raw/yt-channels absent, index inchangé.');
  process.exit(0);
}

const words = JSON.parse(fs.readFileSync(path.join(root, 'resources/data/words.json'), 'utf8')).sort((a, b) => a.rank - b.rank);
const chars = JSON.parse(fs.readFileSync(path.join(root, 'resources/data/chars.json'), 'utf8')).chars;
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'content/catalog/word-video-channels.json'), 'utf8'));
const channels = Object.fromEntries(catalog.filter((c) => c.channelId).map((c) => [c.channelId, c]));

// Graphies traditionnelles (CEDICT). Écartées : noms propres (pinyin en majuscule) et entrées qui ne sont que des
// variantes / formes anciennes / « used in » (和 → 龢/咊, 是 → 昰, 板 → 闆…), sinon leurs vidéos (histoire d'un autre
// caractère) passent devant celles du caractère lui-même.
const NON_MAIN_GLOSS = /variant of|^used in\b|^see \S|^\((?:old|archaic|obsolete)\)|^(?:old|archaic|obsolete) (?:form|name)\b/i;
const toneKey = (py) => String(py).toLowerCase().replace(/\s+/g, ' ').trim();
const cedictLines = [];
const cedict = path.join(root, 'data-raw/cedict.txt.gz');
if (fs.existsSync(cedict))
  for (const line of zlib.gunzipSync(fs.readFileSync(cedict)).toString('utf8').split('\n')) {
    const m = /^(\S+) (\S+) \[([^\]]*)\] \/(.*)\/\s*$/.exec(line);
    if (!m || /^[A-Z]/.test(m[3])) continue;
    const glosses = m[4].split('/').filter(Boolean);
    if (!glosses.length || glosses.every((g) => NON_MAIN_GLOSS.test(g.trim()))) continue;
    cedictLines.push({ trad: m[1], simp: m[2], py: toneKey(m[3]) });
  }
const bySimp = new Map();
for (const l of cedictLines) bySimp.set(l.simp, [...(bySimp.get(l.simp) ?? []), l]);
// Mot : toutes ses graphies traditionnelles (hors variantes).
const wordTrad = (w) => [...new Set((bySimp.get(w) ?? []).map((l) => l.trad).filter((t) => t !== w))];
// Caractère : UNE forme principale (发 → 發, pas 髮 ; 须 → 須, pas 鬚 ; 只 → 只). Choix : lecture principale du
// programme, puis fréquence dans les mots du programme, puis dans tout CEDICT ; à égalité la forme simplifiée.
const numPy = (py) => {
  const marks = { ā: 'a1', á: 'a2', ǎ: 'a3', à: 'a4', ē: 'e1', é: 'e2', ě: 'e3', è: 'e4', ī: 'i1', í: 'i2', ǐ: 'i3', ì: 'i4', ō: 'o1', ó: 'o2', ǒ: 'o3', ò: 'o4', ū: 'u1', ú: 'u2', ǔ: 'u3', ù: 'u4', ǖ: 'v1', ǘ: 'v2', ǚ: 'v3', ǜ: 'v4' };
  let tone = '5';
  const base = [...String(py).toLowerCase()].map((ch) => (marks[ch] ? ((tone = marks[ch][1]), marks[ch][0]) : ch === 'ü' ? 'v' : ch)).join('');
  return `${base.replace(/u:/g, 'v')}${tone}`;
};
const countTrad = (lines) => {
  const n = new Map(); // simplifié → (traditionnel → nombre)
  for (const l of lines) {
    const s = [...l.simp];
    const t = [...l.trad];
    if (s.length < 2 || s.length !== t.length) continue;
    s.forEach((c, i) => {
      const m = n.get(c) ?? new Map();
      m.set(t[i], (m.get(t[i]) ?? 0) + 1);
      n.set(c, m);
    });
  }
  return n;
};
const ALL_COUNTS = countTrad(cedictLines);
let CURR_COUNTS = new Map();
function mainTrad(c, py) {
  const lines = bySimp.get(c) ?? [];
  const forms = [...new Set(lines.map((l) => l.trad))];
  if (!forms.length || (forms.length === 1 && forms[0] === c)) return [];
  const reading = py ? numPy(py).replace(/u:/g, 'v') : '';
  const byReading = reading ? [...new Set(lines.filter((l) => l.py.replace(/u:/g, 'v') === reading).map((l) => l.trad))] : [];
  const cands = byReading.length ? byReading : forms;
  const score = (f) => [CURR_COUNTS.get(c)?.get(f) ?? 0, ALL_COUNTS.get(c)?.get(f) ?? 0, f === c ? 1 : 0];
  const best = [...cands].sort((a, b) => {
    const [x, y] = [score(a), score(b)];
    return y[0] - x[0] || y[1] - x[1] || y[2] - x[2] || forms.indexOf(a) - forms.indexOf(b);
  })[0];
  return best && best !== c ? [best] : [];
}

// Listes des chaînes (les dossiers suivants remplacent les précédents pour une même chaîne).
const byChan = new Map();
let epoch = 0;
for (const dir of DIRS)
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const cid = d.channel_id || d.id;
    if (!channels[cid]) continue;
    epoch = Math.max(epoch, Number(d.epoch) || 0);
    byChan.set(cid, (d.entries ?? []).filter((e) => e && e.id && e.title).map((e) => ({ ...e, channel_id: cid, channel: String(channels[cid].name).trim() })));
  }
const pool = [...byChan.values()].flat();

// Index caractère → entrées (accélère la recherche des titres contenant la cible).
const byChar = new Map();
for (const e of pool)
  for (const c of hanChars(e.title)) {
    const a = byChar.get(c) ?? [];
    a.push(e);
    byChar.set(c, a);
  }
const candidatesFor = (forms) => {
  const out = new Set();
  for (const f of forms) for (const e of byChar.get([...f][0]) ?? []) if (e.title.includes(f)) out.add(e);
  return [...out];
};

const pyOf = (w) => words.find((x) => x.w === w)?.py ?? chars[w]?.py?.[0] ?? '';
CURR_COUNTS = countTrad(words.flatMap((x) => bySimp.get(x.w) ?? []));
const targets = new Map();
for (const x of words) {
  const single = [...x.w].length === 1;
  targets.set(`u:${x.w}`, { slot: 'usage', w: x.w, py: x.py, alt: single ? mainTrad(x.w, x.py) : wordTrad(x.w) });
  for (const c of hanChars(x.w)) if (!targets.has(`e:${c}`)) targets.set(`e:${c}`, { slot: 'etymology', w: c, py: pyOf(c), alt: mainTrad(c, pyOf(c)) });
}

const chanNames = [];
const chanIdx = new Map();
const ci = (cid) => {
  if (!chanIdx.has(cid)) {
    chanIdx.set(cid, chanNames.length);
    chanNames.push(String(channels[cid].name).trim());
  }
  return chanIdx.get(cid);
};

// Ordre identique à orderForSlot() de src/core/wordVideos.ts : sur l'emplacement d'abord, puis replis offSlot.
const order = (r) => [...r].sort((a, b) => Number(!!a.offSlot) - Number(!!b.offSlot) || b.score - a.score || a.entry.id.localeCompare(b.entry.id));
// Variété : identique à diversify() de src/core/wordVideos.ts (doublons d'une chaîne retirés — même titre normalisé,
// ou même durée à ±2 s : Chou Meizai publie chaque animation deux fois, titre anglais et titre chinois —, ≤ 2 par chaîne).
const titleKey = (s) => s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
const DUP_DURATION_S = 2;
function diversify(xs, max, perChannel = 2) {
  const kept = [];
  const uniq = xs.filter((x) => {
    const tk = titleKey(x.title);
    const d = Number(x.duration) || 0;
    const dup = kept.some((y) => y.channel === x.channel && (titleKey(y.title) === tk || (d > 0 && (Number(y.duration) || 0) > 0 && Math.abs((Number(y.duration) || 0) - d) <= DUP_DURATION_S)));
    if (!dup) kept.push(x);
    return !dup;
  });
  const n = new Map();
  const first = [];
  const rest = [];
  for (const x of uniq) {
    const c = n.get(x.channel) ?? 0;
    if (c < perChannel && first.length < max) {
      first.push(x);
      n.set(x.channel, c + 1);
    } else rest.push(x);
  }
  const keep = new Set([...first, ...rest.slice(0, Math.max(0, max - first.length))]);
  return uniq.filter((x) => keep.has(x));
}
// Identique à refineOffSlot() de src/core/wordVideos.ts : sur l'emplacement « origine », une vidéo dont le caractère
// n'apparaît qu'à l'intérieur d'un mot (機器人, 故事, 起源, 为什么…) parle d'autre chose que de ce caractère : c'est un
// repli (offSlot, ×0,7), pas « l'origine du caractère ». Ses propres graphies (吗嗎) ne comptent pas comme voisines.
const isHanCh = (ch) => /[\u3400-\u9fff\uf900-\ufaff]/.test(ch);
function isolatedIn(w, title, own = []) {
  const near = (ch) => isHanCh(ch) && !own.includes(ch);
  for (let i = title.indexOf(w); i >= 0; i = title.indexOf(w, i + 1)) {
    const before = i === 0 ? ' ' : title[i - 1];
    const after = i + w.length >= title.length ? ' ' : title[i + w.length];
    if (!near(before) && !near(after)) return true;
  }
  return false;
}
function refineOffSlot(t, ranked, min) {
  if (t.slot !== 'etymology') return ranked;
  const forms = [t.w, ...(t.alt ?? [])].filter(Boolean);
  return ranked
    .map((r) => {
      if (r.offSlot) return r;
      const title = String(r.entry.title ?? '');
      if (forms.some((x) => isolatedIn(x, title, forms))) return r;
      return { ...r, offSlot: true, score: Math.round(r.score * 700) / 1000 };
    })
    .filter((r) => r.score >= min)
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
}
const ranked = new Map();
for (const [k, t] of targets) {
  const all = order(refineOffSlot(t, rankCandidates(t, candidatesFor([t.w, ...(t.alt ?? [])]), channels, MIN), MIN)).map((x) => ({
    ...x,
    channel: x.entry.channel,
    title: x.entry.title,
    duration: x.entry.duration,
  }));
  const r = diversify(all, TOP);
  if (r.length) ranked.set(k, r);
}
// §4.4 : mot d'un caractère → pas la même vidéo en tête pour « usage » et « origine ».
for (const [k, r] of ranked) {
  if (!k.startsWith('u:') || [...k.slice(2)].length !== 1) continue;
  const e = ranked.get(`e:${k.slice(2)}`);
  if (e && r.length >= 2 && r[0].entry.id === e[0].entry.id) [r[0], r[1]] = [r[1], r[0]];
}

const t = {};
const stat = { usage: [0, 0, 0], etymology: [0, 0, 0] }; // [cibles, servies sur l'emplacement, replis seulement]
for (const [k, tg] of targets) {
  stat[tg.slot][0]++;
  const r = ranked.get(k);
  if (!r) continue;
  if (r.some((x) => !x.offSlot)) stat[tg.slot][1]++;
  else stat[tg.slot][2]++;
  t[k] = r.map((x) => {
    const row = [x.entry.id, String(x.entry.title).slice(0, 140), Math.round(+x.entry.duration || 0), ci(x.entry.channel_id), Math.round(x.score * 1000)];
    if (x.offSlot) row.push(1);
    return row;
  });
}

const generated = epoch ? new Date(epoch * 1000).toISOString().slice(0, 10) : 'inconnu';
// Graphies traditionnelles des caractères du programme (recherche de repli à l'exécution : CEDICT n'est pas embarqué).
const alt = {};
for (const [k, tg] of targets) if (tg.slot === 'etymology' && tg.alt?.length) alt[k.slice(2)] = tg.alt;
const json = JSON.stringify({ v: 1, generated, channels: chanNames, t, alt });
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, json);
const gz = zlib.gzipSync(json).length;
console.log(`pool : ${pool.length} vidéos de ${byChan.size} chaînes ; ${targets.size} cibles ; seuil ${MIN} ; top ${TOP}`);
for (const s of ['usage', 'etymology']) {
  const [n, ok, off] = stat[s];
  console.log(`${s} : ${ok}/${n} = ${((100 * ok) / n).toFixed(1)} % sur l'emplacement, +${off} replis seulement, ${n - ok - off} sans vidéo`);
}
console.log(`→ ${path.relative(root, OUT)} : ${(json.length / 1024).toFixed(0)} Ko (${(Buffer.byteLength(json) / 1024).toFixed(0)} Ko UTF-8, ${(gz / 1024).toFixed(0)} Ko gzip), généré le ${generated}`);
