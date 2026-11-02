#!/usr/bin/env node
// Fusionne content/chars/parts/batch_*.json → resources/data/char-stories.json (fiche caractère illustrée).
// Sortie : { "<car>": { t: type, o: origine_fr, k: [[composant, rôle, fr]], m: mnémotechnique_fr, s: scène_fr, a: svg },
//           "_ancient": { "<car>": "<graphies à chercher sur Commons, dans l'ordre>" } }
// Chaque SVG est validé par une liste blanche stricte (éléments, attributs, valeurs) : toute violation fait échouer le build.
// « _ancient » (formes anciennes, cf. src/main/services/ancient.ts) vient d'OpenCC STCharacters.txt (1.1.9, liste
// complète simplifié → traditionnels, y compris le caractère lui-même quand il est AUSSI traditionnel : 干 → 幹 乾 干).
// Absent de la table = le caractère seul. Règles (cf. scripts/fetch-ancient.mjs) :
//   - simplifié qui n'est pas traditionnel (马 → 馬) : traditionnels seulement (sauf SELF_OK, graphie archaïque) ;
//   - simplifié qui est la forme standard taïwanaise/hongkongaise du traditionnel (群/羣, 床/牀, 秘/祕 : variantes
//     OpenCC TWVariants/HKVariants) : traditionnel puis le caractère lui-même (même mot, même lignée) ;
//   - caractère fusionné (干, 里, 后, 台…) : sa propre graphie D'ABORD, car la fiche raconte l'origine de ce glyphe —
//     sauf si la fiche décrit explicitement le traditionnel (« Forme simplifiée de 確… », « Le traditionnel 價… »).
// Usage : node scripts/build-chars.mjs [--check] [--st STCharacters.txt]   (--check : valide sans écrire)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PARTS = path.join(ROOT, 'content/chars/parts');
const OUT = path.join(ROOT, 'resources/data/char-stories.json');
const MAX_SVG = 2800;

const TYPES = new Set(['pictogramme', 'idéogramme', 'idéogramme composé', 'idéo-phonétique', 'emprunt phonétique', 'forme altérée', 'incertain']);
const ROLES = new Set(['sens', 'son', 'forme']);

// ---------- SVG allowlist validator ----------
const ELEMENTS = new Set(['svg', 'g', 'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'rect']);
const NUM = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const NUMS = /^[-+0-9.eE\s,]*$/;
const PATH_D = /^[-+0-9.eE\s,MmLlHhVvCcSsQqTtAaZz]*$/;
const TRANSFORM = /^\s*((matrix|translate|scale|rotate|skewX|skewY)\s*\([-+0-9.eE\s,]*\)\s*,?\s*)*$/;
const PAINT = /^(currentColor|none)$/;
const ATTRS = {
  d: (v) => PATH_D.test(v),
  points: (v) => NUMS.test(v),
  transform: (v) => TRANSFORM.test(v),
  fill: (v) => PAINT.test(v),
  stroke: (v) => PAINT.test(v),
  'stroke-linecap': (v) => /^(round|butt|square)$/.test(v),
  'stroke-linejoin': (v) => /^(round|miter|bevel)$/.test(v),
  'stroke-dasharray': (v) => v === 'none' || NUMS.test(v),
  'fill-rule': (v) => /^(evenodd|nonzero)$/.test(v),
  viewBox: (v) => /^0 0 200 200$/.test(v.trim()),
  xmlns: (v) => v === 'http://www.w3.org/2000/svg',
};
for (const k of ['cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'width', 'height', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-opacity'])
  ATTRS[k] = (v) => NUM.test(v.trim());

/** Returns a list of violations (empty = valid). */
export function validateSvg(svg) {
  const errs = [];
  if (typeof svg !== 'string' || !svg) return ['svg vide'];
  if (svg.length > MAX_SVG) errs.push(`trop gros (${svg.length} o > ${MAX_SVG})`);
  if (/<!--|<!\[CDATA\[|<\?|<!DOCTYPE|&/i.test(svg)) errs.push('commentaire/CDATA/PI/entité interdits');
  const tagRe = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[^\s=<>\/"']+\s*=\s*"[^"<>]*")*)\s*(\/?)>/g;
  const stack = [];
  let last = 0, m, roots = 0;
  while ((m = tagRe.exec(svg))) {
    const between = svg.slice(last, m.index);
    if (between.trim()) errs.push(`texte hors balise : ${JSON.stringify(between.trim().slice(0, 30))}`);
    last = tagRe.lastIndex;
    const [, close, name, attrs, selfClose] = m;
    if (!ELEMENTS.has(name)) errs.push(`élément interdit <${name}>`);
    if (close) {
      if (stack.pop() !== name) errs.push(`balise fermante inattendue </${name}>`);
      continue;
    }
    if (stack.length === 0) {
      roots++;
      if (name !== 'svg') errs.push('la racine doit être <svg>');
    } else if (name === 'svg') errs.push('<svg> imbriqué interdit');
    const seen = new Set();
    for (const a of attrs.matchAll(/([^\s=]+)\s*=\s*"([^"]*)"/g)) {
      const [, k, v] = a;
      if (seen.has(k)) errs.push(`attribut dupliqué ${k}`);
      seen.add(k);
      if (/^on/i.test(k)) errs.push(`attribut d'événement interdit ${k}`);
      else if (!(k in ATTRS)) errs.push(`attribut interdit ${k} sur <${name}>`);
      else if ((k === 'viewBox' || k === 'xmlns') && name !== 'svg') errs.push(`${k} hors de <svg>`);
      else if (!ATTRS[k](v)) errs.push(`valeur interdite ${k}="${v.slice(0, 40)}"`);
    }
    if (name === 'svg' && !seen.has('viewBox')) errs.push('viewBox manquant');
    if (!selfClose) stack.push(name);
  }
  const tail = svg.slice(last);
  if (tail.trim()) errs.push(`contenu non analysable : ${JSON.stringify(tail.trim().slice(0, 40))}`);
  // Anything that looks like a tag but was not matched by the strict tokenizer (single quotes, odd syntax…)
  const nTags = (svg.match(/</g) || []).length;
  const nMatched = (svg.match(tagRe) || []).length;
  if (nTags !== nMatched) errs.push('balise non conforme (guillemets simples, syntaxe inattendue…)');
  if (stack.length) errs.push(`balises non fermées : ${stack.join(',')}`);
  if (roots !== 1) errs.push(`${roots} racines`);
  return errs;
}

/** Light minification: collapse whitespace between tags and inside attribute separators. */
function minify(svg) {
  return svg.replace(/>\s+</g, '><').replace(/\s{2,}/g, ' ').trim();
}

/** Malformed but harmless: a duplicated attribute. Keep the first one (what the HTML parser renders). */
export function dedupeAttrs(svg, onFix = () => {}) {
  return svg.replace(/<([A-Za-z][\w:.-]*)((?:\s+[^\s=<>\/"']+\s*=\s*"[^"<>]*")*)(\s*\/?)>/g, (all, name, attrs, end) => {
    const seen = new Set();
    let fixed = false;
    const kept = attrs.replace(/\s+([^\s=]+)\s*=\s*"([^"]*)"/g, (a, k) => {
      if (seen.has(k)) return (fixed = true), '';
      seen.add(k);
      return a;
    });
    if (fixed) onFix(name);
    return `<${name}${kept}${end}>`;
  });
}

// ---------- candidats « formes anciennes » ----------
const STCHARS_URL = 'https://raw.githubusercontent.com/BYVoid/OpenCC/ver.1.1.9/data/dictionary/STCharacters.txt';
const ST_CACHE = path.join(os.homedir(), '.cache', 'operation-mandarin', 'ancient', 'STCharacters.txt'); // = fetch-ancient.mjs
/** Glyphes simplifiés qui sont eux-mêmes la graphie archaïque (古字) du traditionnel (cf. fetch-ancient.mjs). */
export const SELF_OK = new Set([...'云从众网采气']);
const MAX_CANDIDATES = 4;
/** Décisions manuelles pour les caractères fusionnés : 'self' | 'trad' (prioritaires sur la détection automatique). */
const ORDER_OVERRIDE = {};
/** La fiche commence par décrire le traditionnel X : « Forme simplifiée de X », « X est la forme simplifiée de… »… */
export function storyDescribesTrad(c, origin, trads) {
  const head = (origin || '').split(/[.:;]/)[0];
  return trads.some((t) =>
    new RegExp(
      `^(?:(?:la |une )?forme (?:simplifiée|traditionnelle|vulgaire|populaire)(?: de)? ${t}` +
        `|le (?:caractère )?traditionnel(?: est)? ${t}` +
        `|${c} (?:est|était) (?:la |une )?forme (?:simplifiée|vulgaire|populaire) de ${t}` +
        `|${c} sert de forme simplifiée à ${t})`,
      'iu',
    ).test(head.trim()),
  );
}

/** STCharacters.txt → Map(simplifié → [traditionnels…]). */
export function parseST(txt) {
  const m = new Map();
  for (const line of txt.split('\n')) {
    const [s, t] = line.split('\t');
    if (s && t && [...s].length === 1) m.set(s, t.trim().split(/\s+/).filter((x) => [...x].length === 1));
  }
  return m;
}

/** Dictionnaire OpenCC « a b c|… » (opencc-js) → Map(a → [b, c]). */
export function parseOpenccDict(txt) {
  const m = new Map();
  for (const e of txt.split('|')) {
    const [a, ...b] = e.split(' ');
    if (a && b.length) m.set(a, b);
  }
  return m;
}

/**
 * Ordre des graphies à chercher pour c (null = le caractère seul, rien à stocker).
 * `regional` : Map(traditionnel → formes standard TW/HK) ; une variante régionale égale à c rend c acceptable.
 */
export function ancientOrder(c, st, story, regional = new Map()) {
  const list = st.get(c);
  if (!list || !list.length) return null;
  const trads = list.filter((t) => t !== c);
  let order;
  if (list.includes(c)) {
    // caractère fusionné : la fiche raconte en général le glyphe c lui-même
    const how = ORDER_OVERRIDE[c] ?? (story && storyDescribesTrad(c, story.o, trads) ? 'trad' : 'self');
    order = how === 'trad' ? [...trads, c] : [c, ...trads];
  } else if (SELF_OK.has(c) || trads.some((t) => (regional.get(t) || []).includes(c))) order = [...trads, c];
  else order = trads;
  order = [...new Set(order)].slice(0, MAX_CANDIDATES);
  return order.length === 1 && order[0] === c ? null : order.join('');
}

async function loadST(argPath, previous) {
  const tryRead = (f) => {
    try {
      return f && fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
    } catch {
      return null;
    }
  };
  let txt = tryRead(argPath) ?? tryRead(ST_CACHE);
  if (!txt && !argPath) {
    try {
      const res = await fetch(STCHARS_URL);
      if (res.ok) {
        txt = await res.text();
        fs.mkdirSync(path.dirname(ST_CACHE), { recursive: true });
        fs.writeFileSync(ST_CACHE, txt);
      }
    } catch (e) {
      console.warn(`⚠ STCharacters.txt indisponible (${e.message || e})`);
    }
  }
  if (txt) {
    const st = parseST(txt);
    if (st.size < 3000) throw new Error(`STCharacters.txt suspect (${st.size} entrées)`);
    return st;
  }
  if (previous && Object.keys(previous).length) {
    console.warn('⚠ STCharacters.txt introuvable (hors ligne ?) : table « _ancient » précédente conservée telle quelle');
    return null;
  }
  throw new Error(`STCharacters.txt introuvable : --st FICHIER, ou ${ST_CACHE}, ou accès à ${STCHARS_URL}`);
}

// ---------- main ----------
async function main() {
  const check = process.argv.includes('--check');
  const files = fs.readdirSync(PARTS).filter((f) => /^batch_\d+\.json$/.test(f)).sort();
  if (!files.length) throw new Error('aucun fichier dans ' + PARTS);
  const chars = JSON.parse(fs.readFileSync(path.join(ROOT, 'resources/data/chars.json'), 'utf8')).chars;
  const out = {};
  const problems = [];
  const warnings = [];
  const stats = { types: {}, svgBytes: 0, noSvg: 0, dup: 0 };
  for (const f of files) {
    const data = JSON.parse(fs.readFileSync(path.join(PARTS, f), 'utf8'));
    for (const [c, v] of Object.entries(data)) {
      const where = `${f} ${c}`;
      if ([...c].length !== 1) problems.push(`${where}: clé non mono-caractère`);
      if (out[c]) stats.dup++;
      if (!TYPES.has(v.type)) problems.push(`${where}: type inconnu « ${v.type} »`);
      if (!v.origin_fr || typeof v.origin_fr !== 'string') problems.push(`${where}: origin_fr manquant`);
      const comps = Array.isArray(v.components) ? v.components : [];
      for (const k of comps) {
        if (!k || typeof k.c !== 'string' || !k.c) problems.push(`${where}: composant invalide`);
        else if (!ROLES.has(k.role)) problems.push(`${where}: rôle inconnu « ${k.role} » pour ${k.c}`);
      }
      let svg = '';
      if (v.svg) {
        svg = dedupeAttrs(minify(v.svg), (el) => warnings.push(`${where}: attribut dupliqué sur <${el}> (premier conservé)`));
        const errs = validateSvg(svg);
        if (errs.length) problems.push(`${where}: SVG — ${errs.slice(0, 4).join(' ; ')}`);
      } else stats.noSvg++;
      stats.types[v.type] = (stats.types[v.type] || 0) + 1;
      stats.svgBytes += svg.length;
      const e = { t: v.type, o: v.origin_fr.trim(), k: comps.map((k) => [k.c, k.role, (k.fr || '').trim()]) };
      if (v.mnemonic_fr) e.m = v.mnemonic_fr.trim();
      if (v.scene_fr) e.s = v.scene_fr.trim();
      if (svg) e.a = svg;
      out[c] = e;
    }
  }
  const missing = Object.keys(chars).filter((c) => !out[c]);
  // candidats « formes anciennes » pour tout caractère de la table OpenCC (fiche ou non : composants, dictionnaire…)
  let previous = null;
  try {
    previous = JSON.parse(fs.readFileSync(OUT, 'utf8'))._ancient ?? null;
  } catch {
    /* premier build */
  }
  const stIdx = process.argv.indexOf('--st');
  const st = await loadST(stIdx > 0 ? path.resolve(process.argv[stIdx + 1]) : null, previous);
  let ancient = previous ?? {};
  const tradFirst = [];
  if (st) {
    const regional = new Map();
    for (const name of ['TWVariants', 'HKVariants'])
      for (const [t, v] of parseOpenccDict((await import(`opencc-js/dict/${name}`)).default))
        regional.set(t, [...new Set([...(regional.get(t) || []), ...v])]);
    ancient = {};
    for (const c of [...st.keys()].sort()) {
      const o = ancientOrder(c, st, out[c], regional);
      if (o) ancient[c] = o;
      if (o && st.get(c).includes(c) && o[0] !== c && out[c]) tradFirst.push(c);
    }
  }
  if (problems.length) {
    console.error(`✗ ${problems.length} problème(s) :`);
    for (const p of problems.slice(0, 80)) console.error('  - ' + p);
    process.exit(1);
  }
  for (const w of warnings) console.warn('⚠ ' + w);
  for (const c of Object.keys(ORDER_OVERRIDE)) if (!st?.get(c)?.includes(c)) problems.push(`ORDER_OVERRIDE ${c} : pas un caractère fusionné`);
  if (problems.length) {
    for (const p of problems) console.error('  - ' + p);
    process.exit(1);
  }
  const json = JSON.stringify({ ...out, _ancient: ancient });
  if (!check) fs.writeFileSync(OUT, json);
  console.log(
    `${check ? '(check) ' : ''}${Object.keys(out).length} caractères${stats.dup ? `, ${stats.dup} doublon(s) écrasé(s)` : ''} ; ` +
      `curriculum non couvert : ${missing.length}${missing.length ? ' (' + missing.slice(0, 20).join('') + ')' : ''} ; sans SVG : ${stats.noSvg}`,
  );
  console.log('types :', JSON.stringify(stats.types));
  console.log(`formes anciennes : ${Object.keys(ancient).length} caractères avec graphies candidates ; fiches fusionnées décrivant le traditionnel (trad. d'abord) : ${tradFirst.join('') || '—'}`);
  console.log(`SVG : ${(stats.svgBytes / 1024).toFixed(0)} Ko ; fichier ${path.relative(ROOT, OUT)} : ${(Buffer.byteLength(json) / 1024).toFixed(0)} Ko`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((e) => {
    console.error('✗ ' + (e.message || e));
    process.exit(1);
  });
