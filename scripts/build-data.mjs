// Builds resources/data/*.json from the open datasets in data-raw/.
// Sources: CFDICT (CC BY-SA, chine.in), CC-CEDICT (CC BY-SA), complete-hsk-vocabulary (MIT),
// Make Me a Hanzi (Arphic PL / LGPL), Tatoeba (CC BY 2.0 FR).
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import * as OpenCC from 'opencc-js';

const RAW = path.resolve('data-raw');
const OUT = path.resolve('resources/data');
fs.mkdirSync(OUT, { recursive: true });

const norm = (p) => p.toLowerCase().replace(/u:/g, 'v').replace(/ü/g, 'v').replace(/[^a-z0-9]/g, '');

// ---------- dictionaries ----------
function parseCedictLike(text) {
  const map = new Map(); // simplified -> [{py, defs}]
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(\S+) (\S+) \[([^\]]*)\] \/(.*)\/\s*$/);
    if (!m) continue;
    const [, trad, simp, py, defs] = m;
    const list = defs.split('/').map((d) => d.trim()).filter(Boolean);
    if (!map.has(simp)) map.set(simp, []);
    map.get(simp).push({ py, defs: list, trad });
  }
  return map;
}
const cfdict = parseCedictLike(fs.readFileSync(path.join(RAW, 'cfdict.u8'), 'utf8'));
const cedict = parseCedictLike(zlib.gunzipSync(fs.readFileSync(path.join(RAW, 'cedict.txt.gz'))).toString('utf8'));
console.log('cfdict', cfdict.size, 'cedict', cedict.size);

const words_ = (s) => new Set(s.toLowerCase().replace(/\(.*?\)/g, ' ').split(/[^a-z]+/).filter((x) => x.length > 2 && !['the', 'and', 'for', 'one', 'used', 'with'].includes(x)));
/** Traditional form of the CC-CEDICT entry whose English matches the HSK meanings. */
function tradFor(word, pyNum, enMeanings) {
  const entries = cedict.get(word);
  if (!entries || !enMeanings?.length) return null;
  const target = words_(enMeanings.join(' '));
  let best = null, bestScore = -1;
  for (const e of entries) {
    const ew = words_(e.defs.join(' '));
    let sc = 0;
    for (const t of target) if (ew.has(t)) sc++;
    if (pyNum && norm(e.py) === norm(pyNum)) sc += 0.5;
    if (sc > bestScore) { bestScore = sc; best = e; }
  }
  return best ? best.trad : null;
}

function pickDefs(map, word, pyNum, trad = null) {
  const entries = map.get(word);
  if (!entries) return null;
  const n = pyNum ? norm(pyNum) : null;
  let exact = n ? entries.filter((e) => norm(e.py) === n) : [];
  if (trad) {
    const t = (exact.length ? exact : entries).filter((e) => e.trad === trad);
    if (t.length) exact = t;
  }
  // prefer entries that are not archaic / variant-only
  const chosen = (exact.length ? exact : entries).slice().sort((a, b) => (/arch\.|archaïque|ancien/.test(a.defs[0]) ? 1 : 0) - (/arch\.|archaïque|ancien/.test(b.defs[0]) ? 1 : 0));
  const defs = [];
  const late = [];
  for (const e of chosen) for (const d of e.defs) {
    if (/^(variante|variant|old variant|see |voir |CL:)/i.test(d)) continue;
    const bucket = /^(surname|nom de famille)/i.test(d) ? late : defs;
    if (!defs.includes(d) && !late.includes(d)) bucket.push(d);
  }
  const all = [...defs, ...late];
  return all.length ? all : null;
}

// Full lookup dictionary (for video subtitles): simplified -> {p: pinyin numeric, f: fr[], e: en[]}
const dict = {};
for (const [w, entries] of cedict) {
  dict[w] = { p: entries[0].py, e: entries.flatMap((x) => x.defs).slice(0, 6) };
}
for (const [w, entries] of cfdict) {
  const d = dict[w] || (dict[w] = { p: entries[0].py });
  d.f = entries.flatMap((x) => x.defs).filter((x) => !/^(variante|CL:)/i.test(x)).slice(0, 6);
  if (!d.p) d.p = entries[0].py;
}
fs.writeFileSync(path.join(OUT, 'dict.json'), JSON.stringify(dict));
console.log('dict entries', Object.keys(dict).length);

// ---------- HSK vocabulary ----------
const CURATED = fs.existsSync('content/fr-curated.json') ? JSON.parse(fs.readFileSync('content/fr-curated.json', 'utf8')) : {};
const SUPP = fs.existsSync('content/fr-supplement.json') ? JSON.parse(fs.readFileSync('content/fr-supplement.json', 'utf8')) : {};
const hsk = JSON.parse(fs.readFileSync(path.join(RAW, 'hsk-complete.json'), 'utf8'));
const words = [];
for (const e of hsk) {
  const newLvl = e.level.filter((l) => /^new-\d$/.test(l)).map((l) => +l.slice(4));
  const oldLvl = e.level.filter((l) => /^old-\d$/.test(l)).map((l) => +l.slice(4));
  const band = newLvl.length ? Math.min(...newLvl) : null;
  const old = oldLvl.length ? Math.min(...oldLvl) : null;
  if (!((band && band <= 4) || (old && old <= 4))) continue;
  // Pick the main reading: most meanings, penalising archaic / surname / loanword / bound-form readings.
  const formScore = (f) => {
    const m = f.meanings.join(' ; ').toLowerCase();
    let sc = f.meanings.length;
    if (/archaic|surname|loanword|bound form|variant|old /.test(m)) sc -= 5;
    if (/^[A-Z]/.test(f.transcriptions.numeric)) sc -= 5;
    return sc;
  };
  const form = e.forms.reduce((best, f) => (formScore(f) > formScore(best) ? f : best), e.forms[0]);
  const pyNum = form.transcriptions.numeric;
  const trad = tradFor(e.simplified, pyNum, form.meanings);
  const fr = SUPP[e.simplified] || pickDefs(cfdict, e.simplified, pyNum, trad) || pickDefs(cfdict, e.simplified.replace(/儿$/, ''), null);
  const cu = CURATED[e.simplified];
  words.push({
    w: e.simplified,
    py: cu?.py || form.transcriptions.pinyin,
    pn: cu?.pn || pyNum,
    fr: cu?.fr?.length ? cu.fr : fr ? fr.slice(0, 4) : [],
    en: form.meanings.slice(0, 3),
    band: band ?? 9,
    old: old ?? 9,
    freq: e.frequency ?? 999999,
    pos: e.pos || [],
    cl: form.classifiers || [],
  });
}
// Learning order: lowest band first (new HSK 3.0), then old HSK level, then frequency.
words.sort((a, b) => Math.min(a.band, a.old + 0.5) - Math.min(b.band, b.old + 0.5) || a.freq - b.freq);
words.forEach((w, i) => (w.rank = i));
const missingFr = words.filter((w) => !w.fr.length);
console.log('words', words.length, 'missing FR', missingFr.length, missingFr.slice(0, 15).map((w) => w.w).join(' '));
fs.writeFileSync(path.join(OUT, 'words.json'), JSON.stringify(words));

// ---------- characters ----------
const charSet = new Set();
for (const w of words) for (const c of w.w) if (/\p{Script=Han}/u.test(c)) charSet.add(c);
const mmahDict = new Map();
for (const line of fs.readFileSync(path.join(RAW, 'mmah-dictionary.txt'), 'utf8').split('\n')) {
  if (!line) continue;
  const o = JSON.parse(line);
  mmahDict.set(o.character, o);
}
// Also include common components (radicals used in decompositions) so we can explain them.
const chars = {};
const strokes = {};
for (const line of fs.readFileSync(path.join(RAW, 'mmah-graphics.txt'), 'utf8').split('\n')) {
  if (!line) continue;
  const o = JSON.parse(line);
  if (charSet.has(o.character)) strokes[o.character] = { strokes: o.strokes, medians: o.medians };
}
// Character order = first appearance in the word learning order.
const charOrder = [];
for (const w of words) for (const c of w.w) if (charSet.has(c) && !charOrder.includes(c)) charOrder.push(c);
charOrder.forEach((c, i) => {
  const m = mmahDict.get(c) || {};
  // A character that is itself a curriculum word uses the word's reviewed French gloss.
  const asWord = words.find((w) => w.w === c);
  const fr = asWord?.fr?.length ? asWord.fr : pickDefs(cfdict, c, null);
  chars[c] = {
    c,
    i,
    py: m.pinyin || [],
    fr: fr ? fr.slice(0, 3) : [],
    en: m.definition || '',
    dec: m.decomposition || '',
    rad: m.radical || '',
    ety: m.etymology || null,
    n: strokes[c] ? strokes[c].strokes.length : 0,
  };
});
// Components appearing in decompositions (for mnemonic explanations)
const comps = {};
for (const c of Object.values(chars)) {
  for (const k of [...(c.dec || '')]) {
    if (/[\u2FF0-\u2FFB？]/.test(k) || chars[k] || comps[k]) continue;
    const m = mmahDict.get(k);
    const fr = pickDefs(cfdict, k, null);
    if (m || fr) comps[k] = { c: k, fr: fr ? fr.slice(0, 2) : [], en: m?.definition || '' };
  }
}
fs.writeFileSync(path.join(OUT, 'chars.json'), JSON.stringify({ chars, comps }));
fs.writeFileSync(path.join(OUT, 'strokes.json'), JSON.stringify(strokes));
console.log('chars', charOrder.length, 'with strokes', Object.keys(strokes).length, 'components', Object.keys(comps).length);

// ---------- Tatoeba sentences (zh -> fr) ----------
const t2s = OpenCC.Converter({ from: 'tw', to: 'cn' });
const readTsv = (f) => fs.readFileSync(path.join(RAW, f), 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t'));
const cmn = new Map(readTsv('cmn_sentences.tsv').map(([id, , text]) => [id, text]));
const fra = new Map(readTsv('fra_sentences.tsv').map(([id, , text]) => [id, text]));
const audio = new Set(readTsv('cmn_sentences_with_audio.tsv').map(([id]) => id));
const pairs = new Map();
for (const [zid, fid] of readTsv('cmn-fra_links.tsv')) {
  if (!cmn.has(zid) || !fra.has(fid)) continue;
  if (!pairs.has(zid)) pairs.set(zid, { id: +zid, zh: t2s(cmn.get(zid)), fr: [], a: audio.has(zid) ? 1 : 0 });
  const p = pairs.get(zid);
  if (p.fr.length < 2) p.fr.push(fra.get(fid));
}
const VULGAR_ZH = /妈的|他妈|操你|屁|婊|傻逼|混蛋|王八|滚蛋|去死|色情|做爱|性交|鸡巴|屌|日你/;
const VULGAR_FR = /\b(putain|merde|con|connard|conne|salope|bordel|foutre|baiser|enculé|chier|nique)\b/i;
const sentences = [...pairs.values()].filter((s) => s.zh.length <= 30 && !VULGAR_ZH.test(s.zh) && !s.fr.some((f) => VULGAR_FR.test(f)));
fs.writeFileSync(path.join(OUT, 'sentences.json'), JSON.stringify(sentences));
console.log('sentences', sentences.length, 'with audio', sentences.filter((s) => s.a).length);
