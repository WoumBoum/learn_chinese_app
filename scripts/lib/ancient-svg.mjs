// SVG sanitizer for the Ancient Chinese characters project files (used by scripts/fetch-ancient.mjs).
// sanitize(svgText, {precision}) → {svg, nPaths, vb, stats}
// Keeps only geometry: every shape becomes a <path>, group/element transforms are baked into the
// coordinates (arcs → cubics), metadata / scripts / <use> / <image> / external refs / ids / styles are
// dropped, numbers are rounded with error compensation (relative commands never drift), fill=currentColor.
function parseXml(s) {
  // Minimal well-formed-XML tokenizer → element tree (no text nodes needed).
  s = s.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '').replace(/<!DOCTYPE[\s\S]*?(\[[\s\S]*?\])?\s*>/i, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const root = { name: '#root', attrs: {}, children: [] }, stack = [root];
  const re = /<\/?([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[0][1] === '/') { if (stack.length > 1) stack.pop(); continue; }
    const attrs = {};
    for (const a of m[2].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = a[2] ?? a[3];
    const el = { name: m[1], attrs, children: [] };
    stack[stack.length - 1].children.push(el);
    if (!m[3]) stack.push(el);
  }
  return root;
}
const IDENT = [1, 0, 0, 1, 0, 0];
const mul = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
function parseTransform(t) {
  let M = IDENT;
  for (const m of (t || '').matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g)) {
    const n = m[2].split(/[\s,]+/).filter(Boolean).map(Number);
    let T;
    switch (m[1]) {
      case 'matrix': T = n; break;
      case 'translate': T = [1, 0, 0, 1, n[0], n[1] || 0]; break;
      case 'scale': T = [n[0], 0, 0, n[1] ?? n[0], 0, 0]; break;
      case 'rotate': { const a = (n[0] * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a); T = [c, s, -s, c, 0, 0]; if (n.length === 3) T = mul(mul([1, 0, 0, 1, n[1], n[2]], T), [1, 0, 0, 1, -n[1], -n[2]]); break; }
      case 'skewX': T = [1, 0, Math.tan((n[0] * Math.PI) / 180), 1, 0, 0]; break;
      case 'skewY': T = [1, Math.tan((n[0] * Math.PI) / 180), 0, 1, 0, 0]; break;
    }
    M = mul(M, T);
  }
  return M;
}
const ap = (M, x, y) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];

/** Parse path data into absolute segments: M/L/C/Z only (H,V→L; S,Q,T→C; A→C). */
export function pathToAbs(d) {
  const toks = d.match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || [];
  const out = [];
  let i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0, lcx = 0, lcy = 0, lqx = 0, lqy = 0, prev = '';
  const num = () => Number(toks[i++]);
  const isNum = () => i < toks.length && !/[A-Za-z]/.test(toks[i]);
  while (i < toks.length) {
    if (/[A-Za-z]/.test(toks[i])) cmd = toks[i++];
    else if (!cmd) { i++; continue; }
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    if (C === 'Z') { out.push(['Z']); x = sx; y = sy; prev = 'Z'; if (!isNum()) continue; else { cmd = rel ? 'l' : 'L'; continue; } }
    if (!isNum()) { cmd = ''; continue; }
    switch (C) {
      case 'M': x = ox + num(); y = oy + num(); sx = x; sy = y; out.push(['M', x, y]); cmd = rel ? 'l' : 'L'; break;
      case 'L': x = ox + num(); y = oy + num(); out.push(['L', x, y]); break;
      case 'H': x = ox + num(); out.push(['L', x, y]); break;
      case 'V': y = (rel ? y : 0) + num(); out.push(['L', x, y]); break;
      case 'C': { const a = [ox + num(), oy + num(), ox + num(), oy + num(), ox + num(), oy + num()]; out.push(['C', ...a]); [lcx, lcy, x, y] = [a[2], a[3], a[4], a[5]]; break; }
      case 'S': { const r1 = /[CS]/.test(prev) ? [2 * x - lcx, 2 * y - lcy] : [x, y]; const a = [ox + num(), oy + num(), ox + num(), oy + num()]; out.push(['C', r1[0], r1[1], ...a]); [lcx, lcy, x, y] = a; break; }
      case 'Q': { const q = [ox + num(), oy + num()], e = [ox + num(), oy + num()]; out.push(['C', x + (2 / 3) * (q[0] - x), y + (2 / 3) * (q[1] - y), e[0] + (2 / 3) * (q[0] - e[0]), e[1] + (2 / 3) * (q[1] - e[1]), e[0], e[1]]); [lqx, lqy, x, y] = [q[0], q[1], e[0], e[1]]; break; }
      case 'T': { const q = /[QT]/.test(prev) ? [2 * x - lqx, 2 * y - lqy] : [x, y]; const e = [ox + num(), oy + num()]; out.push(['C', x + (2 / 3) * (q[0] - x), y + (2 / 3) * (q[1] - y), e[0] + (2 / 3) * (q[0] - e[0]), e[1] + (2 / 3) * (q[1] - e[1]), e[0], e[1]]); [lqx, lqy, x, y] = [q[0], q[1], e[0], e[1]]; break; }
      case 'A': { const rx = num(), ry = num(), rot = num(), la = num(), sw = num(), ex = ox + num(), ey = oy + num(); for (const c of arcToCubics(x, y, rx, ry, rot, la, sw, ex, ey)) out.push(['C', ...c]); x = ex; y = ey; break; }
    }
    prev = C;
  }
  return out;
}
function arcToCubics(x1, y1, rx, ry, phiDeg, fa, fs, x2, y2) {
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) return [[x1, y1, x2, y2, x2, y2]];
  const phi = (phiDeg * Math.PI) / 180, cp = Math.cos(phi), sp = Math.sin(phi);
  rx = Math.abs(rx); ry = Math.abs(ry);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2, x1p = cp * dx + sp * dy, y1p = -sp * dx + cp * dy;
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p, den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let co = Math.sqrt(Math.max(0, num / den)); if (fa === fs) co = -co;
  const cxp = (co * rx * y1p) / ry, cyp = (-co * ry * x1p) / rx;
  const cx = cp * cxp - sp * cyp + (x1 + x2) / 2, cy = sp * cxp + cp * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => { const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy); return a; };
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!fs && dt > 0) dt -= 2 * Math.PI; else if (fs && dt < 0) dt += 2 * Math.PI;
  const n = Math.ceil(Math.abs(dt) / (Math.PI / 2)), seg = dt / n, k = (4 / 3) * Math.tan(seg / 4), res = [];
  const pt = (t) => [cx + rx * Math.cos(t) * cp - ry * Math.sin(t) * sp, cy + rx * Math.cos(t) * sp + ry * Math.sin(t) * cp];
  const dpt = (t) => [-rx * Math.sin(t) * cp - ry * Math.cos(t) * sp, -rx * Math.sin(t) * sp + ry * Math.cos(t) * cp];
  for (let j = 0, t = t1; j < n; j++, t += seg) {
    const p0 = pt(t), p3 = pt(t + seg), d0 = dpt(t), d3 = dpt(t + seg);
    res.push([p0[0] + k * d0[0], p0[1] + k * d0[1], p3[0] - k * d3[0], p3[1] - k * d3[1], p3[0], p3[1]]);
  }
  return res;
}
function shapeToD(el) {
  const a = el.attrs, n = (k) => Number(a[k] || 0);
  switch (el.name) {
    case 'path': return a.d || '';
    case 'polygon': case 'polyline': { const p = (a.points || '').trim().split(/[\s,]+/); return p.length >= 2 ? 'M' + p.join(' ') + (el.name === 'polygon' ? 'Z' : '') : ''; }
    case 'line': return `M${n('x1')} ${n('y1')}L${n('x2')} ${n('y2')}`;
    case 'rect': { const x = n('x'), y = n('y'), w = n('width'), h = n('height'); return w && h ? `M${x} ${y}H${x + w}V${y + h}H${x}Z` : ''; }
    case 'circle': case 'ellipse': { const cx = n('cx'), cy = n('cy'), rx = el.name === 'circle' ? n('r') : n('rx'), ry = el.name === 'circle' ? n('r') : n('ry'); return rx && ry ? `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z` : ''; }
  }
  return '';
}
/** Serialize absolute segments as relative commands, rounding with error compensation. */
function serialize(segs, M, prec) {
  const f = 10 ** prec, r = (v) => Math.round(v * f) / f;
  const fmt = (v) => { let s = String(v); if (s.startsWith('0.')) s = s.slice(1); else if (s.startsWith('-0.')) s = '-' + s.slice(2); return s; };
  let out = '', last = '', qx = 0, qy = 0, sqx = 0, sqy = 0; // q = rounded current point actually emitted
  const nums = (arr) => { let s = ''; for (const v of arr) { const t = fmt(v); s += (s === '' || t[0] === '-' || (t[0] === '.' && /\.\d*$/.test(s))) ? t : ' ' + t; } return s; };
  const emit = (c, arr) => { const body = nums(arr); if (c === last && c !== 'm') { out += (body[0] === '-' || (body[0] === '.' && /\.\d*$/.test(out)) ? '' : ' ') + body; } else { out += c + body; } last = c === 'm' ? 'l' : c; };
  for (const s of segs) {
    if (s[0] === 'Z') { out += 'z'; last = 'z'; qx = sqx; qy = sqy; continue; }
    const pts = [];
    for (let j = 1; j < s.length; j += 2) pts.push(ap(M, s[j], s[j + 1]));
    const rel = pts.map(([X, Y]) => [r(X - qx), r(Y - qy)]);
    const end = rel[rel.length - 1];
    if (s[0] === 'M') { emit('m', end); last = 'l'; }
    else if (s[0] === 'L') {
      if (end[0] === 0 && end[1] === 0) continue;
      if (end[1] === 0) emit('h', [end[0]]); else if (end[0] === 0) emit('v', [end[1]]); else emit('l', end);
    } else emit('c', rel.flat());
    qx = r(qx + end[0]); qy = r(qy + end[1]);
    if (s[0] === 'M') { sqx = qx; sqy = qy; }
  }
  return out;
}
const WHITE = /^(#fff(fff)?|white|rgb\(255,\s*255,\s*255\))$/i;
const PROPS = ['fill', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'display', 'opacity', 'fill-opacity', 'visibility'];
const decls = (txt) => { const st = {}; for (const kv of (txt || '').split(';')) { const i = kv.indexOf(':'); if (i < 0) continue; const k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim(); if (PROPS.includes(k) && v) st[k] = v.replace(/\s*!important$/, ''); } return st; };
function cssClasses(svgText) {
  // Only simple `.a, .b { … }` rules are understood; anything else is ignored.
  const map = {};
  for (const m of svgText.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    const css = m[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const r of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) for (const sel of r[1].split(',')) { const c = sel.trim().match(/^\.([\w-]+)$/); if (c) map[c[1]] = { ...map[c[1]], ...decls(r[2]) }; }
  }
  return map;
}

export function sanitize(svgText, { precision = 1 } = {}) {
  const stats = { dropped: {}, white: 0, stroked: 0 };
  const classes = cssClasses(svgText);
  const root = parseXml(svgText);
  const svg = root.children.find((e) => e.name === 'svg' || e.name.endsWith(':svg'));
  if (!svg) throw new Error('no <svg>');
  let vb = (svg.attrs.viewBox || '').trim().split(/[\s,]+/).map(Number);
  if (vb.length !== 4 || vb.some(isNaN)) vb = [0, 0, parseFloat(svg.attrs.width) || 300, parseFloat(svg.attrs.height) || 300];
  // Rounding step ≤ 1/2000 of the canvas whatever its units (300-unit ACC canvas → 1 decimal).
  const prec = Math.max(precision, Math.ceil(Math.log10(2000 / Math.max(vb[2], vb[3], 1e-9))));
  const paths = [];
  const styleOf = (a) => { const st = {}; for (const k of PROPS) if (a[k] != null) st[k] = a[k]; for (const c of (a.class || '').split(/\s+/)) if (classes[c]) Object.assign(st, classes[c]); return Object.assign(st, decls(a.style)); };
  const SKIP = new Set(['metadata', 'defs', 'title', 'desc', 'script', 'style', 'foreignObject', 'image', 'use', 'text', 'clipPath', 'mask', 'pattern', 'linearGradient', 'radialGradient', 'symbol', 'marker', 'filter']);
  const ids = new Map();
  (function index(e) { if (e.attrs.id) ids.set(e.attrs.id, e); e.children.forEach(index); })(svg);
  const walk = (el, M, inh, depth = 0) => {
    const local = el.name.includes(':') ? el.name.split(':')[1] : el.name;
    if (local === 'use') {
      const href = el.attrs.href || el.attrs['xlink:href'] || '';
      const ref = href.startsWith('#') ? ids.get(href.slice(1)) : null;
      if (!ref || depth > 8) { stats.dropped.use = (stats.dropped.use || 0) + 1; return; }
      const T = mul(el.attrs.transform ? mul(M, parseTransform(el.attrs.transform)) : M, [1, 0, 0, 1, Number(el.attrs.x || 0), Number(el.attrs.y || 0)]);
      const st0 = { ...inh, ...styleOf(el.attrs) };
      if (ref.name === 'symbol') for (const ch of ref.children) walk(ch, T, st0, depth + 1);
      else walk(ref, T, st0, depth + 1);
      return;
    }
    if (SKIP.has(local) || el.name.startsWith('sodipodi:') || el.name.startsWith('inkscape:') || el.name.startsWith('rdf:')) { if (local === 'use' || local === 'image' || local === 'text') stats.dropped[local] = (stats.dropped[local] || 0) + 1; return; }
    const st = { ...inh, ...styleOf(el.attrs) };
    if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return;
    const M2 = el.attrs.transform ? mul(M, parseTransform(el.attrs.transform)) : M;
    if (local === 'g' || local === 'svg' || local === 'switch' || local === 'a') { for (const ch of el.children) walk(ch, M2, st, depth); return; }
    const d = shapeToD({ ...el, name: local });
    if (!d) return;
    const fill = st.fill ?? '#000', stroke = st.stroke && st.stroke !== 'none' ? st.stroke : null;
    if (fill === 'none' && !stroke) return;
    const scale = Math.sqrt(Math.abs(M2[0] * M2[3] - M2[1] * M2[2])) || 1;
    const out = { d: serialize(pathToAbs(d), M2, prec), white: fill !== 'none' && WHITE.test(fill) };
    if (st['fill-rule'] === 'evenodd') out.evenodd = true;
    if (fill === 'none') out.nofill = true;
    if (stroke) {
      out.sw = Math.round(parseFloat(st['stroke-width'] || '1') * scale * 10 ** (prec + 1)) / 10 ** (prec + 1); stats.stroked++;
      for (const k of ['stroke-linecap', 'stroke-linejoin']) if (/^(round|square|bevel|miter)$/.test(st[k] || '')) out[k] = st[k];
      if (st['stroke-miterlimit'] && !isNaN(+st['stroke-miterlimit'])) out['stroke-miterlimit'] = +st['stroke-miterlimit'];
    }
    if (out.white) stats.white++;
    if (out.d.length > 2) paths.push(out);
  };
  walk(svg, IDENT, {});
  const vbs = vb.map((v) => Math.round(v * 100) / 100).join(' ');
  const body = paths.map((p) => {
    let a = `<path d="${p.d}"`;
    if (p.evenodd) a += ' fill-rule="evenodd"';
    if (p.white) a += ' style="fill:var(--bg,#fff)"'; // knock-out shapes: follow the page background when inlined
    if (p.nofill) a += ' fill="none"';
    if (p.sw) a += ` stroke="currentColor" stroke-width="${p.sw}"`;
    for (const k of ['stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit']) if (p[k] != null) a += ` ${k}="${p[k]}"`;
    return a + '/>';
  }).join('');
  return { stats, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vbs}" fill="currentColor">${body}</svg>`, nPaths: paths.length, vb };
}

