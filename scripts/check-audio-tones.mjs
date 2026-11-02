#!/usr/bin/env node
// Vérification « à l'oreille » automatisée des tons d'enregistrements natifs d'UNE syllabe.
// Réutilise la logique de l'app (src/renderer/components/pitch.ts : YIN + guessTone, et
// src/main/services/tonefix.ts : gabarits de Chao) en la bundlant à la volée avec esbuild.
//
// Usage : node scripts/check-audio-tones.mjs <liste.tsv> [--ffmpeg <bin>] > resultats.json
//   liste.tsv : une ligne par fichier « chemin<TAB>ton attendu (1-4)<TAB>étiquette optionnelle »
// Sortie (JSON) : { items: [{file, label, expected, guess, template, distances, voicedMs, f0med}], summary }
//   guess    = pitch.ts:guessTone (heuristique utilisée par l'écran Tons)
//   template = gabarit de Chao le plus proche (contour centré, distance L1 moyenne en demi-tons)
//   absolute = gabarit de Chao le plus proche en hauteur absolue (réf. = médiane du locuteur sur la liste, ou --ref-hz)
//   vote     = majorité des trois (sinon « absolute ») — n'a de sens que si toute la liste vient d'un même locuteur
import { buildSync } from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const listFile = args.find((a) => !a.startsWith('--'));
const ffIdx = args.indexOf('--ffmpeg');
const FFMPEG = ffIdx >= 0 ? args[ffIdx + 1] : path.join(ROOT, 'resources/bin/ffmpeg');
if (!listFile) {
  console.error('usage: node scripts/check-audio-tones.mjs <liste.tsv> [--ffmpeg bin]');
  process.exit(2);
}

// Bundle des modules TS de l'app (lecture seule) vers un fichier temporaire.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'om-tones-'));
const entry = `export * from ${JSON.stringify(path.join(ROOT, 'src/renderer/components/pitch.ts'))};
export { chaoTemplate, sampleTemplate, CHAO_STEP_ST } from ${JSON.stringify(path.join(ROOT, 'src/main/services/tonefix.ts'))};`;
buildSync({ stdin: { contents: entry, resolveDir: ROOT, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: path.join(tmp, 'lib.mjs'), logLevel: 'error' });
const P = await import(pathToFileURL(path.join(tmp, 'lib.mjs')).href);
fs.rmSync(tmp, { recursive: true, force: true });

const SR = 16000;
function decode(file) {
  const buf = execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

const N = 40;
const templates = [1, 2, 3, 4].map((t) => {
  const v = P.sampleTemplate(P.chaoTemplate(t, true), N).map((c) => c * P.CHAO_STEP_ST);
  const m = v.reduce((s, x) => s + x, 0) / N;
  return v.map((x) => x - m);
});

function classify(file) {
  const x = decode(file);
  const track = P.pitchTrack(x, SR);
  // plus longue zone voisée (micro-coupures fusionnées) = la syllabe
  const runs = P.voicedRuns(track);
  if (!runs.length) return { guess: null, template: null, distances: null, voicedMs: 0, f0med: null };
  const run = runs.reduce((a, b) => (b.length > a.length ? b : a));
  const c = P.resampleSeq(run, N);
  const guess = P.guessTone(c);
  const m = c.reduce((s, v) => s + v, 0) / N;
  const cc = c.map((v) => v - m);
  const distances = templates.map((t) => +(t.reduce((s, v, i) => s + Math.abs(v - cc[i]), 0) / N).toFixed(2));
  const template = distances.indexOf(Math.min(...distances)) + 1;
  // contour en Hz (pour le classifieur « niveau absolu », calculé une fois la référence du locuteur connue)
  const med = P.speakerMedian(track) ?? 0;
  const hz = c.map((st) => med * Math.pow(2, st / 12));
  return { guess, template, distances, voicedMs: run.length * 10, f0med: Math.round(med), hz, contour: c.filter((_, i) => i % 4 === 0).map((v) => +v.toFixed(1)) };
}

const items = [];
for (const line of fs.readFileSync(listFile, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const [file, exp, label] = line.split('\t');
  const r = classify(file);
  items.push({ file: path.basename(file), label: label ?? '', expected: +exp, ...r });
}
// Classifieur 3 « niveau absolu » : même locuteur pour toute la liste → la hauteur absolue distingue
// le 3e ton (bas, souvent réalisé 21 sans remontée en isolé) du 4e ton (départ haut).
// Référence = médiane des F0 médianes de la liste ≈ niveau 3 de Chao ; contour comparé aux gabarits NON centrés.
const refIdx = args.indexOf('--ref-hz');
const fm = items.map((i) => i.f0med).filter((v) => v > 0).sort((a, b) => a - b);
const REF = refIdx >= 0 ? +args[refIdx + 1] : fm[fm.length >> 1] ?? 200;
const absT = [1, 2, 3, 4].map((t) => P.sampleTemplate(P.chaoTemplate(t, true), N).map((c) => (c - 3) * P.CHAO_STEP_ST));
for (const i of items) {
  if (!i.hz) { i.absolute = null; continue; }
  const st = i.hz.map((h) => 12 * Math.log2(h / REF));
  const d = absT.map((t) => t.reduce((s, v, k) => s + Math.abs(v - st[k]), 0) / N);
  i.absolute = d.indexOf(Math.min(...d)) + 1;
  i.startSt = +st.slice(0, 4).reduce((a, b) => a + b / 4, 0).toFixed(1);
  delete i.hz;
}
const acc = (k) => {
  const ok = items.filter((i) => i[k] === i.expected).length;
  const conf = {};
  for (const i of items) conf[`${i.expected}->${i[k]}`] = (conf[`${i.expected}->${i[k]}`] ?? 0) + 1;
  return { correct: ok, total: items.length, pct: +((100 * ok) / (items.length || 1)).toFixed(1), confusion: conf };
};
const vote = (i) => {
  const v = [i.guess, i.template, i.absolute].filter((x) => x != null);
  for (const t of v) if (v.filter((y) => y === t).length >= 2) return t;
  return i.absolute;
};
for (const i of items) i.vote = vote(i);
const either = items.filter((i) => i.guess === i.expected || i.template === i.expected || i.absolute === i.expected).length;
const both = items.filter((i) => i.vote !== i.expected);
console.log(JSON.stringify({ items, summary: { refHz: REF, guessTone: acc('guess'), template: acc('template'), absolute: acc('absolute'), vote: acc('vote'), anyCorrect: either, voteWrong: both.map((i) => `${i.label || i.file}:${i.expected}->g${i.guess}/t${i.template}/a${i.absolute}`) } }, null, 1));
