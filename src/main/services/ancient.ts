// Formes anciennes des caractères (甲骨文 oracle, 金文 bronze, 大篆 bigseal, 小篆 seal), récupérées À L'EXÉCUTION sur
// Wikimedia Commons (« Ancient Chinese characters project », fichiers File:<car>-<forme>.svg) puis mises en cache dans
// userData/ancient/<codepoint>.json. Port de scripts/fetch-ancient.mjs (recherche + licences) et de
// scripts/lib/ancient-svg.mjs (assainisseur : géométrie seule, transformations appliquées, fill=currentColor).
// Voir docs/ancient-forms.md. Politesse : 1 requête API par caractère, ≥ 1,5 s entre requêtes API, Retry-After respecté,
// arrêt pour la session au premier HTTP 429.
// Les graphies candidates (simplifié → traditionnel, ordre choisi pour coller à la fiche) sont PRÉCALCULÉES au build par
// scripts/build-chars.mjs (OpenCC STCharacters.txt, clé « _ancient » de char-stories.json) : aucun convertisseur ici.
import fs from 'node:fs';
import path from 'node:path';

export type AncientFormName = 'oracle' | 'bronze' | 'bigseal' | 'seal';
export interface AncientForm {
  form: AncientFormName;
  svg: string;
  license: string;
  author: string;
  /** page du fichier sur Commons (attribution) */
  url: string;
  /** caractère dont le fichier provient s'il diffère (traditionnel : 马 → 馬) */
  src?: string;
}
export type AncientStatus = 'ok' | 'none' | 'offline' | 'pending';
export interface AncientResult {
  forms: AncientForm[];
  status: AncientStatus;
}

export const FORMS: AncientFormName[] = ['oracle', 'bronze', 'bigseal', 'seal'];
export const UA = 'OperationMandarin/0.1 (https://github.com/WoumBoum/learn_chinese_app; runtime fetch of Ancient Chinese characters project SVGs) electron';
const API = 'https://commons.wikimedia.org/w/api.php';
/** Licences acceptables pour une app distribuée (auteur + licence conservés). NC/ND/GFDL seule : exclues. */
export const LICENSE_OK = /^(public domain|pd\b|cc0|cc[ -]by(-sa)?[ -]?[0-9.]*( \w+)?$)/i;
const NONE_RECHECK_MS = 30 * 24 * 3600 * 1000;
const API_GAP_MS = 1500;
const FILE_GAP_MS = 500;
const MAX_RAW_SVG = 300_000;
const MAX_CANDIDATES = 4; // ≤ 16 titres par requête API (limite : 50)
const CACHE_VERSION = 2; // v2 : sélection « une seule graphie » + candidats précalculés
/** Page de description d'un fichier Commons : seule URL d'attribution acceptée (ouverte via shell.openExternal). */
const COMMONS_PAGE = /^https:\/\/commons\.wikimedia\.org\/wiki\/[^\s"'<>\\]+$/;

// =====================================================================================================
// SVG sanitizer (port de scripts/lib/ancient-svg.mjs)
// =====================================================================================================
interface El {
  name: string;
  attrs: Record<string, string>;
  children: El[];
}
type Mat = number[];
type Seg = (string | number)[];

function parseXml(s: string): El {
  s = s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[\s\S]*?(\[[\s\S]*?\])?\s*>/i, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const root: El = { name: '#root', attrs: {}, children: [] };
  const stack = [root];
  const re = /<\/?([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m[0][1] === '/') {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of m[2].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = a[2] ?? a[3];
    const el: El = { name: m[1], attrs, children: [] };
    stack[stack.length - 1].children.push(el);
    if (!m[3]) stack.push(el);
  }
  return root;
}

const IDENT: Mat = [1, 0, 0, 1, 0, 0];
const mul = (a: Mat, b: Mat): Mat => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];

function parseTransform(t: string | undefined): Mat {
  let M = IDENT;
  for (const m of (t || '').matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g)) {
    const n = m[2].split(/[\s,]+/).filter(Boolean).map(Number);
    let T: Mat = IDENT;
    switch (m[1]) {
      case 'matrix':
        T = n.length === 6 ? n : IDENT;
        break;
      case 'translate':
        T = [1, 0, 0, 1, n[0] || 0, n[1] || 0];
        break;
      case 'scale':
        T = [n[0] ?? 1, 0, 0, n[1] ?? n[0] ?? 1, 0, 0];
        break;
      case 'rotate': {
        const a = ((n[0] || 0) * Math.PI) / 180;
        const c = Math.cos(a);
        const s = Math.sin(a);
        T = [c, s, -s, c, 0, 0];
        if (n.length === 3) T = mul(mul([1, 0, 0, 1, n[1], n[2]], T), [1, 0, 0, 1, -n[1], -n[2]]);
        break;
      }
      case 'skewX':
        T = [1, 0, Math.tan(((n[0] || 0) * Math.PI) / 180), 1, 0, 0];
        break;
      case 'skewY':
        T = [1, Math.tan(((n[0] || 0) * Math.PI) / 180), 0, 1, 0, 0];
        break;
    }
    M = mul(M, T);
  }
  return M;
}
const ap = (M: Mat, x: number, y: number): [number, number] => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];

/** Parse path data into absolute segments: M/L/C/Z only (H,V→L; S,Q,T→C; A→C). */
export function pathToAbs(d: string): Seg[] {
  const toks = d.match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || [];
  const out: Seg[] = [];
  let i = 0;
  let cmd = '';
  let x = 0, y = 0, sx = 0, sy = 0, lcx = 0, lcy = 0, lqx = 0, lqy = 0;
  let prev = '';
  const num = () => Number(toks[i++]);
  const isNum = () => i < toks.length && !/[A-Za-z]/.test(toks[i]);
  while (i < toks.length) {
    if (/[A-Za-z]/.test(toks[i])) cmd = toks[i++];
    else if (!cmd) {
      i++;
      continue;
    }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    if (C === 'Z') {
      out.push(['Z']);
      x = sx;
      y = sy;
      prev = 'Z';
      if (isNum()) cmd = rel ? 'l' : 'L';
      continue;
    }
    if (!isNum()) {
      cmd = '';
      continue;
    }
    switch (C) {
      case 'M':
        x = ox + num();
        y = oy + num();
        sx = x;
        sy = y;
        out.push(['M', x, y]);
        cmd = rel ? 'l' : 'L';
        break;
      case 'L':
        x = ox + num();
        y = oy + num();
        out.push(['L', x, y]);
        break;
      case 'H':
        x = ox + num();
        out.push(['L', x, y]);
        break;
      case 'V':
        y = (rel ? y : 0) + num();
        out.push(['L', x, y]);
        break;
      case 'C': {
        const a = [ox + num(), oy + num(), ox + num(), oy + num(), ox + num(), oy + num()];
        out.push(['C', ...a]);
        [lcx, lcy, x, y] = [a[2], a[3], a[4], a[5]];
        break;
      }
      case 'S': {
        const r1 = /[CS]/.test(prev) ? [2 * x - lcx, 2 * y - lcy] : [x, y];
        const a = [ox + num(), oy + num(), ox + num(), oy + num()];
        out.push(['C', r1[0], r1[1], ...a]);
        [lcx, lcy, x, y] = a;
        break;
      }
      case 'Q': {
        const q = [ox + num(), oy + num()];
        const e = [ox + num(), oy + num()];
        out.push(['C', x + (2 / 3) * (q[0] - x), y + (2 / 3) * (q[1] - y), e[0] + (2 / 3) * (q[0] - e[0]), e[1] + (2 / 3) * (q[1] - e[1]), e[0], e[1]]);
        [lqx, lqy, x, y] = [q[0], q[1], e[0], e[1]];
        break;
      }
      case 'T': {
        const q = /[QT]/.test(prev) ? [2 * x - lqx, 2 * y - lqy] : [x, y];
        const e = [ox + num(), oy + num()];
        out.push(['C', x + (2 / 3) * (q[0] - x), y + (2 / 3) * (q[1] - y), e[0] + (2 / 3) * (q[0] - e[0]), e[1] + (2 / 3) * (q[1] - e[1]), e[0], e[1]]);
        [lqx, lqy, x, y] = [q[0], q[1], e[0], e[1]];
        break;
      }
      case 'A': {
        const rx = num(), ry = num(), rot = num(), la = num(), sw = num(), ex = ox + num(), ey = oy + num();
        for (const c of arcToCubics(x, y, rx, ry, rot, la, sw, ex, ey)) out.push(['C', ...c]);
        x = ex;
        y = ey;
        break;
      }
    }
    prev = C;
  }
  return out.filter((s) => s.every((v) => typeof v === 'string' || Number.isFinite(v)));
}

function arcToCubics(x1: number, y1: number, rx: number, ry: number, phiDeg: number, fa: number, fs: number, x2: number, y2: number): number[][] {
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) return [[x1, y1, x2, y2, x2, y2]];
  const phi = (phiDeg * Math.PI) / 180, cp = Math.cos(phi), sp = Math.sin(phi);
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2, x1p = cp * dx + sp * dy, y1p = -sp * dx + cp * dy;
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) {
    rx *= Math.sqrt(lam);
    ry *= Math.sqrt(lam);
  }
  const nu = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p, den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let co = Math.sqrt(Math.max(0, nu / den));
  if (fa === fs) co = -co;
  const cxp = (co * rx * y1p) / ry, cyp = (-co * ry * x1p) / rx;
  const cx = cp * cxp - sp * cyp + (x1 + x2) / 2, cy = sp * cxp + cp * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!fs && dt > 0) dt -= 2 * Math.PI;
  else if (fs && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2))), seg = dt / n, k = (4 / 3) * Math.tan(seg / 4), res: number[][] = [];
  const pt = (t: number) => [cx + rx * Math.cos(t) * cp - ry * Math.sin(t) * sp, cy + rx * Math.cos(t) * sp + ry * Math.sin(t) * cp];
  const dpt = (t: number) => [-rx * Math.sin(t) * cp - ry * Math.cos(t) * sp, -rx * Math.sin(t) * sp + ry * Math.cos(t) * cp];
  for (let j = 0, t = t1; j < n; j++, t += seg) {
    const p0 = pt(t), p3 = pt(t + seg), d0 = dpt(t), d3 = dpt(t + seg);
    res.push([p0[0] + k * d0[0], p0[1] + k * d0[1], p3[0] - k * d3[0], p3[1] - k * d3[1], p3[0], p3[1]]);
  }
  return res;
}

function shapeToD(name: string, a: Record<string, string>): string {
  const n = (k: string) => Number(a[k] || 0);
  switch (name) {
    case 'path':
      return a.d || '';
    case 'polygon':
    case 'polyline': {
      const p = (a.points || '').trim().split(/[\s,]+/);
      return p.length >= 2 ? 'M' + p.join(' ') + (name === 'polygon' ? 'Z' : '') : '';
    }
    case 'line':
      return `M${n('x1')} ${n('y1')}L${n('x2')} ${n('y2')}`;
    case 'rect': {
      const x = n('x'), y = n('y'), w = n('width'), h = n('height');
      return w && h ? `M${x} ${y}H${x + w}V${y + h}H${x}Z` : '';
    }
    case 'circle':
    case 'ellipse': {
      const cx = n('cx'), cy = n('cy');
      const rx = name === 'circle' ? n('r') : n('rx'), ry = name === 'circle' ? n('r') : n('ry');
      return rx && ry ? `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z` : '';
    }
  }
  return '';
}

/** Serialize absolute segments as relative commands, rounding with error compensation. */
function serialize(segs: Seg[], M: Mat, prec: number): string {
  const f = 10 ** prec;
  const r = (v: number) => Math.round(v * f) / f;
  const fmt = (v: number) => {
    let s = String(Object.is(v, -0) ? 0 : v);
    if (s.startsWith('0.')) s = s.slice(1);
    else if (s.startsWith('-0.')) s = '-' + s.slice(2);
    return s;
  };
  let out = '', last = '', qx = 0, qy = 0, sqx = 0, sqy = 0;
  const nums = (arr: number[]) => {
    let s = '';
    for (const v of arr) {
      const t = fmt(v);
      s += s === '' || t[0] === '-' || (t[0] === '.' && /\.\d*$/.test(s)) ? t : ' ' + t;
    }
    return s;
  };
  const emit = (c: string, arr: number[]) => {
    const body = nums(arr);
    if (c === last && c !== 'm') out += (body[0] === '-' || (body[0] === '.' && /\.\d*$/.test(out)) ? '' : ' ') + body;
    else out += c + body;
    last = c === 'm' ? 'l' : c;
  };
  for (const s of segs) {
    if (s[0] === 'Z') {
      out += 'z';
      last = 'z';
      qx = sqx;
      qy = sqy;
      continue;
    }
    const pts: [number, number][] = [];
    for (let j = 1; j < s.length; j += 2) pts.push(ap(M, s[j] as number, s[j + 1] as number));
    const rel = pts.map(([X, Y]) => [r(X - qx), r(Y - qy)]);
    const end = rel[rel.length - 1];
    if (s[0] === 'M') {
      emit('m', end);
      last = 'l';
    } else if (s[0] === 'L') {
      if (end[0] === 0 && end[1] === 0) continue;
      if (end[1] === 0) emit('h', [end[0]]);
      else if (end[0] === 0) emit('v', [end[1]]);
      else emit('l', end);
    } else emit('c', rel.flat());
    qx = r(qx + end[0]);
    qy = r(qy + end[1]);
    if (s[0] === 'M') {
      sqx = qx;
      sqy = qy;
    }
  }
  return out;
}

const WHITE = /^(#fff(fff)?|white|rgb\(255,\s*255,\s*255\))$/i;
const PROPS = ['fill', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'display', 'opacity', 'fill-opacity', 'visibility'];
type Style = Record<string, string>;
const decls = (txt: string | undefined): Style => {
  const st: Style = {};
  for (const kv of (txt || '').split(';')) {
    const i = kv.indexOf(':');
    if (i < 0) continue;
    const k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim();
    if (PROPS.includes(k) && v) st[k] = v.replace(/\s*!important$/, '');
  }
  return st;
};
function cssClasses(svgText: string): Record<string, Style> {
  // Only simple `.a, .b { … }` rules are understood; anything else is ignored.
  const map: Record<string, Style> = {};
  for (const m of svgText.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    const css = m[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const r of css.matchAll(/([^{}]+)\{([^}]*)\}/g))
      for (const sel of r[1].split(',')) {
        const c = sel.trim().match(/^\.([\w-]+)$/);
        if (c) map[c[1]] = { ...map[c[1]], ...decls(r[2]) };
      }
  }
  return map;
}

interface OutPath {
  d: string;
  white: boolean;
  evenodd?: boolean;
  nofill?: boolean;
  sw?: number;
  cap?: string;
  join?: string;
  miter?: number;
}

export interface SanitizeResult {
  svg: string;
  nPaths: number;
  vb: number[];
  stats: { dropped: Record<string, number>; white: number; stroked: number };
}

/** Rebuilds the SVG from its geometry only: every shape → <path>, transforms baked in, fill=currentColor. */
export function sanitizeSvg(svgText: string, { precision = 1 }: { precision?: number } = {}): SanitizeResult {
  const stats = { dropped: {} as Record<string, number>, white: 0, stroked: 0 };
  const classes = cssClasses(svgText);
  const root = parseXml(svgText);
  const svg = root.children.find((e) => e.name === 'svg' || e.name.endsWith(':svg'));
  if (!svg) throw new Error('no <svg>');
  let vb = (svg.attrs.viewBox || '').trim().split(/[\s,]+/).map(Number);
  if (vb.length !== 4 || vb.some((v) => !Number.isFinite(v)) || vb[2] <= 0 || vb[3] <= 0)
    vb = [0, 0, parseFloat(svg.attrs.width) || 300, parseFloat(svg.attrs.height) || 300];
  const prec = Math.max(precision, Math.ceil(Math.log10(2000 / Math.max(vb[2], vb[3], 1e-9))));
  const paths: OutPath[] = [];
  const styleOf = (a: Record<string, string>): Style => {
    const st: Style = {};
    for (const k of PROPS) if (a[k] != null) st[k] = a[k];
    for (const c of (a.class || '').split(/\s+/)) if (classes[c]) Object.assign(st, classes[c]);
    return Object.assign(st, decls(a.style));
  };
  const SKIP = new Set(['metadata', 'defs', 'title', 'desc', 'script', 'style', 'foreignObject', 'image', 'use', 'text', 'clipPath', 'mask', 'pattern', 'linearGradient', 'radialGradient', 'symbol', 'marker', 'filter']);
  const ids = new Map<string, El>();
  (function index(e: El) {
    if (e.attrs.id) ids.set(e.attrs.id, e);
    e.children.forEach(index);
  })(svg);
  const bump = (k: string) => (stats.dropped[k] = (stats.dropped[k] || 0) + 1);
  const walk = (el: El, M: Mat, inh: Style, depth = 0): void => {
    const local = el.name.includes(':') ? el.name.split(':')[1] : el.name;
    if (local === 'use') {
      const href = el.attrs.href || el.attrs['xlink:href'] || '';
      const ref = href.startsWith('#') ? ids.get(href.slice(1)) : null;
      if (!ref || depth > 8) return void bump('use');
      const T = mul(el.attrs.transform ? mul(M, parseTransform(el.attrs.transform)) : M, [1, 0, 0, 1, Number(el.attrs.x || 0), Number(el.attrs.y || 0)]);
      const st0 = { ...inh, ...styleOf(el.attrs) };
      if (ref.name === 'symbol') for (const ch of ref.children) walk(ch, T, st0, depth + 1);
      else walk(ref, T, st0, depth + 1);
      return;
    }
    if (SKIP.has(local) || /^(sodipodi|inkscape|rdf):/.test(el.name)) {
      if (local === 'image' || local === 'text' || local === 'script' || local === 'style') bump(local);
      return;
    }
    const st = { ...inh, ...styleOf(el.attrs) };
    if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return;
    const M2 = el.attrs.transform ? mul(M, parseTransform(el.attrs.transform)) : M;
    if (local === 'g' || local === 'svg' || local === 'switch' || local === 'a') {
      for (const ch of el.children) walk(ch, M2, st, depth);
      return;
    }
    const d = shapeToD(local, el.attrs);
    if (!d) return;
    const fill = st.fill ?? '#000';
    const stroke = st.stroke && st.stroke !== 'none' ? st.stroke : null;
    if (fill === 'none' && !stroke) return;
    const scale = Math.sqrt(Math.abs(M2[0] * M2[3] - M2[1] * M2[2])) || 1;
    const out: OutPath = { d: serialize(pathToAbs(d), M2, prec), white: fill !== 'none' && WHITE.test(fill) };
    if (st['fill-rule'] === 'evenodd') out.evenodd = true;
    if (fill === 'none') out.nofill = true;
    if (stroke) {
      const sw = Math.round(parseFloat(st['stroke-width'] || '1') * scale * 10 ** (prec + 1)) / 10 ** (prec + 1);
      out.sw = Number.isFinite(sw) && sw > 0 ? sw : 1;
      stats.stroked++;
      if (/^(round|square|bevel|miter)$/.test(st['stroke-linecap'] || '')) out.cap = st['stroke-linecap'];
      if (/^(round|square|bevel|miter)$/.test(st['stroke-linejoin'] || '')) out.join = st['stroke-linejoin'];
      const ml = Number(st['stroke-miterlimit']);
      if (st['stroke-miterlimit'] && Number.isFinite(ml)) out.miter = ml;
    }
    if (out.white) stats.white++;
    if (out.d.length > 2) paths.push(out);
  };
  walk(svg, IDENT, {});
  const vbs = vb.map((v) => Math.round(v * 100) / 100).join(' ');
  const body = paths
    .map((p) => {
      let a = `<path d="${p.d}"`;
      if (p.evenodd) a += ' fill-rule="evenodd"';
      if (p.white) a += ' style="fill:var(--bg,#fff)"'; // formes de découpe : suivent le fond de la page
      if (p.nofill) a += ' fill="none"';
      if (p.sw) a += ` stroke="currentColor" stroke-width="${p.sw}"`;
      if (p.cap) a += ` stroke-linecap="${p.cap}"`;
      if (p.join) a += ` stroke-linejoin="${p.join}"`;
      if (p.miter != null) a += ` stroke-miterlimit="${p.miter}"`;
      return a + '/>';
    })
    .join('');
  return { stats, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vbs}" fill="currentColor">${body}</svg>`, nPaths: paths.length, vb };
}

/** Post-condition (also applied to cached files): only the exact shape sanitizeSvg emits is accepted. */
export function isSafeAncientSvg(svg: string): boolean {
  if (typeof svg !== 'string' || svg.length > 400_000) return false;
  const m = svg.match(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="[-0-9. ]+" fill="currentColor">(.*)<\/svg>$/s);
  if (!m) return false;
  const pathRe =
    /<path d="[-+0-9.emlhvcz ]*"(?: fill-rule="evenodd")?(?: style="fill:var\(--bg,#fff\)")?(?: fill="none")?(?: stroke="currentColor" stroke-width="[0-9.e-]+")?(?: stroke-linecap="(?:round|square|bevel|miter)")?(?: stroke-linejoin="(?:round|square|bevel|miter)")?(?: stroke-miterlimit="[0-9.e-]+")?\/>/gy;
  const body = m[1];
  let pos = 0;
  while (pos < body.length) {
    pathRe.lastIndex = pos;
    const p = pathRe.exec(body);
    if (!p) return false;
    pos = pathRe.lastIndex;
  }
  return true;
}

// =====================================================================================================
// Commons lookup
// =====================================================================================================
export interface FileMeta {
  url: string; // fichier SVG (upload.wikimedia.org)
  page: string; // page de description (attribution)
  size: number;
  license: string;
  author: string;
}

const strip = (h: string | undefined) =>
  (h || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

export const titleOf = (cand: string, form: AncientFormName) => `File:${cand}-${form}.svg`;

/** URL de la page Commons d'un fichier (attribution), construite localement. */
export const commonsPageOf = (title: string) => `https://commons.wikimedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
export const isCommonsPage = (u: unknown): u is string => typeof u === 'string' && u.length < 600 && COMMONS_PAGE.test(u);

/**
 * Graphies à interroger sur Commons, dans l'ordre de préférence. `entry` = valeur précalculée par build-chars.mjs
 * (« _ancient » : chaîne de caractères ; absente = le caractère seul). Une graphie simplifiée qui n'est PAS aussi un
 * caractère traditionnel n'y figure pas (厂 hǎn ≠ 廠…), sauf exceptions SELF_OK décidées au build.
 */
export function ancientCandidates(c: string, entry?: unknown): string[] {
  const out: string[] = [];
  for (const k of typeof entry === 'string' && entry ? [...entry] : [c])
    if (/^\p{Script=Han}$/u.test(k) && !out.includes(k)) out.push(k);
  return (out.length ? out : [c]).slice(0, MAX_CANDIDATES);
}

export function buildQueryUrl(titles: string[]): string {
  return (
    `${API}?action=query&format=json&formatversion=2&maxlag=5&origin=*&prop=imageinfo&iiprop=url%7Csize%7Cextmetadata` +
    `&iiextmetadatafilter=LicenseShortName%7CArtist%7CCopyrighted&titles=${encodeURIComponent(titles.join('|'))}`
  );
}

/** Parses an action=query&prop=imageinfo response (formatversion 1 or 2) → title → meta (null = missing). */
export function parseCommonsResponse(json: unknown, asked: string[]): Record<string, FileMeta | null> {
  const j = json as {
    error?: { code?: string; info?: string };
    query?: { normalized?: { from: string; to: string }[]; pages?: unknown };
  };
  if (!j || typeof j !== 'object') throw new Error('réponse Commons invalide');
  if (j.error) throw new Error(`Commons : ${j.error.code ?? ''} ${j.error.info ?? ''}`.trim());
  const out: Record<string, FileMeta | null> = {};
  for (const t of asked) out[t] = null;
  const q = j.query;
  if (!q) return out;
  const norm = new Map((q.normalized || []).map((n) => [n.to, n.from]));
  const pages = (Array.isArray(q.pages) ? q.pages : Object.values(q.pages || {})) as {
    title: string;
    missing?: boolean | string;
    imageinfo?: { url: string; descriptionurl?: string; size?: number; extmetadata?: Record<string, { value?: unknown }> }[];
  }[];
  for (const p of pages) {
    if (!p || typeof p.title !== 'string') continue;
    const t = norm.get(p.title) || p.title;
    const ii = p.imageinfo?.[0];
    if ((p.missing !== undefined && p.missing !== false) || !ii || typeof ii.url !== 'string') {
      out[t] = null;
      continue;
    }
    const em = ii.extmetadata || {};
    const v = (k: string) => {
      const x = em[k]?.value;
      return typeof x === 'string' ? x : x == null ? '' : String(x);
    };
    if (!/^https:\/\/upload\.wikimedia\.org\//.test(ii.url)) {
      out[t] = null;
      continue;
    }
    out[t] = {
      url: ii.url.split('?')[0],
      page: isCommonsPage(ii.descriptionurl) ? ii.descriptionurl : commonsPageOf(p.title),
      size: Number(ii.size) || 0,
      license: (strip(v('LicenseShortName')) || (v('Copyrighted') === 'False' ? 'Public domain' : '')).slice(0, 80),
      author: strip(v('Artist')).slice(0, 200),
    };
  }
  return out;
}

export interface Selected {
  form: AncientFormName;
  title: string;
  src: string;
  meta: FileMeta;
}

/**
 * Une seule graphie par fiche : le premier candidat qui a au moins une forme sous licence acceptable fournit TOUTE la
 * frise (pas de mélange 干-oracle / 幹-sceau : la frise doit montrer l'évolution du glyphe dont parle la fiche).
 */
export function selectForms(cands: string[], meta: Record<string, FileMeta | null>): Selected[] {
  for (const k of cands) {
    const out: Selected[] = [];
    for (const f of FORMS) {
      const m = meta[titleOf(k, f)];
      if (m && LICENSE_OK.test(m.license || '')) out.push({ form: f, title: titleOf(k, f), src: k, meta: m });
    }
    if (!out.length) continue;
    // Grand sceau (Liushutong, tardif) seulement quand il n'y a ni oracle ni bronze (cf. docs/ancient-forms.md §7).
    if (out.some((s) => s.form === 'oracle' || s.form === 'bronze')) return out.filter((s) => s.form !== 'bigseal');
    return out;
  }
  return [];
}

// =====================================================================================================
// Service (cache + throttling)
// =====================================================================================================
interface CacheFile {
  v: typeof CACHE_VERSION;
  c: string;
  checked: number;
  status: 'ok' | 'none';
  forms: AncientForm[];
}

export interface ResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}
export type FetchLike = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<ResponseLike>;

/** Réponse HTTP dont le corps a été lu en entier sous le délai d'expiration. */
interface HttpBody {
  ok: boolean;
  status: number;
  body: string;
}

class HttpError extends Error {
  constructor(public status: number, public retryAfter: number) {
    super(`HTTP ${status}`);
  }
}
class TimeoutError extends Error {
  constructor() {
    super('délai dépassé');
  }
}

export interface AncientOptions {
  cacheDir: string;
  fetch: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** graphies à interroger (cf. ancientCandidates) ; défaut : le caractère seul */
  candidates?: (c: string) => string[];
  /** délai par requête HTTP, en-têtes ET corps compris (défaut 20 s) */
  timeoutMs?: number;
  /** délai global d'une recherche (défaut 90 s) : au-delà, « offline » et la file passe au caractère suivant */
  lookupDeadlineMs?: number;
}

/** Re-validation d'une forme relue depuis le disque (fichier modifiable par n'importe quel processus local). */
function cleanCachedForm(c: string, f: unknown): AncientForm | null {
  if (!f || typeof f !== 'object') return null;
  const x = f as Record<string, unknown>;
  const form = x.form as AncientFormName;
  if (!FORMS.includes(form) || typeof x.svg !== 'string' || !isSafeAncientSvg(x.svg)) return null;
  const license = typeof x.license === 'string' ? x.license.slice(0, 80) : '';
  if (!LICENSE_OK.test(license)) return null;
  const src = typeof x.src === 'string' && /^\p{Script=Han}$/u.test(x.src) && x.src !== c ? x.src : undefined;
  const out: AncientForm = {
    form,
    svg: x.svg,
    license,
    author: typeof x.author === 'string' ? x.author.replace(/[\u0000-\u001f]/g, ' ').slice(0, 200) : '',
    url: isCommonsPage(x.url) ? x.url : commonsPageOf(titleOf(src ?? c, form)),
  };
  if (src) out.src = src;
  return out;
}

export class AncientService {
  private inflight = new Map<string, Promise<AncientResult>>();
  private chain: Promise<unknown> = Promise.resolve();
  private lastApi = 0;
  private lastFile = 0;
  /** 429 reçu : plus aucune requête pendant cette session. */
  blocked = false;
  private notBefore = 0;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  private cands: (c: string) => string[];

  constructor(private o: AncientOptions) {
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.cands = o.candidates ?? ((c) => [c]);
  }

  cacheFile(c: string): string {
    return path.join(this.o.cacheDir, `${c.codePointAt(0)!.toString(16)}.json`);
  }

  readCache(c: string): CacheFile | null {
    try {
      const j = JSON.parse(fs.readFileSync(this.cacheFile(c), 'utf8')) as CacheFile;
      if (!j || j.v !== CACHE_VERSION || j.c !== c || !Array.isArray(j.forms) || (j.status !== 'ok' && j.status !== 'none')) return null;
      if (typeof j.checked !== 'number' || !Number.isFinite(j.checked)) return null;
      j.forms = j.forms.map((f) => cleanCachedForm(c, f)).filter((f): f is AncientForm => !!f);
      return j;
    } catch {
      return null;
    }
  }

  private writeCache(c: string, status: 'ok' | 'none', forms: AncientForm[]) {
    try {
      fs.mkdirSync(this.o.cacheDir, { recursive: true });
      const f: CacheFile = { v: CACHE_VERSION, c, checked: this.now(), status, forms };
      const tmp = this.cacheFile(c) + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(f));
      fs.renameSync(tmp, this.cacheFile(c));
    } catch (e) {
      console.warn('[ancient] cache', e);
    }
  }

  /** Cached result only (no network). */
  cached(c: string): AncientResult | null {
    const j = this.readCache(c);
    if (!j) return null;
    if (j.status === 'ok' && j.forms.length) return { status: 'ok', forms: j.forms };
    if (j.status === 'none' && this.now() - j.checked < NONE_RECHECK_MS) return { status: 'none', forms: [] };
    return null;
  }

  /** Full lookup: cache, else one Commons API request + SVG downloads (deduplicated per character). */
  get(c: string): Promise<AncientResult> {
    c = [...(c || '')][0] ?? '';
    if (!c || !/\p{Script=Han}/u.test(c)) return Promise.resolve({ status: 'none', forms: [] });
    const hit = this.cached(c);
    if (hit) return Promise.resolve(hit);
    if (this.blocked || this.now() < this.notBefore) return Promise.resolve({ status: 'offline', forms: [] });
    let p = this.inflight.get(c);
    if (!p) {
      p = this.run(() => this.lookup(c)).finally(() => this.inflight.delete(c));
      this.inflight.set(c, p);
    }
    return p;
  }

  isPending(c: string): boolean {
    return this.inflight.has([...(c || '')][0] ?? '');
  }

  /** Serialize lookups (one character at a time), each bounded by a global deadline so one stuck lookup cannot block the queue. */
  private run(fn: () => Promise<AncientResult>): Promise<AncientResult> {
    const deadline = this.o.lookupDeadlineMs ?? 90_000;
    const bounded = (): Promise<AncientResult> => {
      let t: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<AncientResult>((r) => {
        t = setTimeout(() => {
          console.warn('[ancient] recherche trop longue, abandonnée');
          r({ status: 'offline', forms: [] });
        }, deadline);
      });
      return Promise.race([fn().catch((): AncientResult => ({ status: 'offline', forms: [] })), late]).finally(() => clearTimeout(t));
    };
    const p = this.chain.then(bounded, bounded);
    this.chain = p.catch(() => undefined);
    return p;
  }

  /** One polite request; headers AND body are read under the same timeout (a stalled body cannot hang the queue). */
  private async http(url: string, kind: 'api' | 'file'): Promise<HttpBody> {
    if (this.blocked) throw new HttpError(429, 0);
    const gap = kind === 'api' ? API_GAP_MS : FILE_GAP_MS;
    const last = kind === 'api' ? this.lastApi : this.lastFile;
    const wait = Math.max(last + gap, this.notBefore) - this.now();
    if (wait > 0) await this.sleep(wait);
    if (kind === 'api') this.lastApi = this.now();
    else this.lastFile = this.now();
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    let t: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      t = setTimeout(() => {
        ac?.abort();
        reject(new TimeoutError());
      }, this.o.timeoutMs ?? 20_000);
    });
    const go = async (): Promise<HttpBody> => {
      const res = await this.o.fetch(url, { headers: { 'User-Agent': UA, 'Api-User-Agent': UA }, signal: ac?.signal });
      if (res.ok) {
        const ct = Number(res.headers.get('content-length')) || 0;
        if (ct > MAX_RAW_SVG * 4) throw new Error('réponse trop volumineuse');
        return { ok: true, status: res.status, body: await res.text() };
      }
      if (res.status === 404) return { ok: false, status: 404, body: '' };
      const ra = Number(res.headers.get('retry-after')) || 0;
      if (res.status === 429) {
        this.blocked = true; // politesse : on arrête pour la session
        console.warn(`[ancient] HTTP 429 (Retry-After ${ra} s) — formes anciennes désactivées pour cette session`);
      } else if (res.status >= 500) this.notBefore = this.now() + Math.max(ra, 60) * 1000;
      throw new HttpError(res.status, ra);
    };
    try {
      return await Promise.race([go(), expired]);
    } finally {
      clearTimeout(t);
    }
  }

  private async lookup(c: string): Promise<AncientResult> {
    const hit = this.cached(c); // a concurrent lookup may have filled it
    if (hit) return hit;
    if (this.blocked || this.now() < this.notBefore) return { status: 'offline', forms: [] };
    const cands = ancientCandidates(c, this.cands(c).join(''));
    const titles = cands.flatMap((k) => FORMS.map((f) => titleOf(k, f)));
    let meta: Record<string, FileMeta | null>;
    try {
      const res = await this.http(buildQueryUrl(titles), 'api');
      if (!res.ok) return { status: 'offline', forms: [] };
      const j = JSON.parse(res.body) as { error?: { code?: string } };
      if (j?.error?.code === 'maxlag') {
        this.notBefore = this.now() + 30_000;
        return { status: 'offline', forms: [] };
      }
      meta = parseCommonsResponse(j, titles);
    } catch (e) {
      if (!(e instanceof HttpError)) this.notBefore = this.now() + 60_000; // hors ligne / délai / réponse illisible : on réessaie dans une minute
      return { status: 'offline', forms: [] };
    }
    const sel = selectForms(cands, meta);
    if (!sel.length) {
      this.writeCache(c, 'none', []);
      return { status: 'none', forms: [] };
    }
    const forms: AncientForm[] = [];
    let failed = false;
    for (const s of sel) {
      if (s.meta.size > MAX_RAW_SVG) continue;
      try {
        const res = await this.http(s.meta.url, 'file');
        if (!res.ok) continue;
        const raw = res.body;
        if (raw.length > MAX_RAW_SVG) continue;
        const r = sanitizeSvg(raw);
        if (!r.nPaths || !isSafeAncientSvg(r.svg)) continue;
        const f: AncientForm = { form: s.form, svg: r.svg, license: s.meta.license, author: s.meta.author || 'Ancient Chinese characters project', url: s.meta.page };
        if (s.src !== c) f.src = s.src;
        forms.push(f);
      } catch {
        failed = true; // réseau, délai, 429… ou page HTML d'un portail captif à la place du SVG : on ne conclut rien
        if (this.blocked) break;
      }
    }
    if (failed) {
      // Résultat partiel (réseau / délai / 429) : non mis en cache, on réessaiera.
      return forms.length ? { status: 'ok', forms } : { status: 'offline', forms: [] };
    }
    this.writeCache(c, forms.length ? 'ok' : 'none', forms);
    return forms.length ? { status: 'ok', forms } : { status: 'none', forms: [] };
  }
}
