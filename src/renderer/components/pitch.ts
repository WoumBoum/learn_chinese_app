// Analyse de hauteur (F0) en TypeScript pur — aucune dépendance DOM/Electron (testable avec vitest).
//  - pitchTrack : YIN (de Cheveigné & Kawahara 2002) avec interpolation parabolique, hop 10 ms
//  - post-traitement : correction d'octave, suppression des îlots trop courts, lissage médian
//  - toSemitones : demi-tons relatifs à la médiane du locuteur (neutralise voix grave/aiguë)
//  - contour : concaténation des zones voisées, durée normalisée (rééchantillonnage)
//  - similarity : DTW contraint sur contours centrés → score 0-100

export interface PitchPoint {
  t: number; // secondes
  f0: number | null; // Hz, null = non voisé
}

export interface PitchOptions {
  hop?: number; // s (défaut 0.01)
  window?: number; // s (défaut 0.04)
  fmin?: number; // Hz (défaut 70)
  fmax?: number; // Hz (défaut 500)
  threshold?: number; // seuil YIN sur la différence normalisée cumulée (défaut 0.15)
  maxAperiodicity?: number; // au-delà, trame non voisée (défaut 0.35)
  silenceDb?: number; // trames sous (max RMS + silenceDb) dB ignorées (défaut -32)
  targetRate?: number; // rééchantillonnage interne (défaut 16000)
}

/** Rééchantillonne (filtre passe-bas moyenneur + interpolation linéaire). */
export function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  let src = x;
  if (to < from) {
    // passe-bas simple : moyenne glissante sur ~ from/to échantillons
    const k = Math.max(1, Math.round(from / to));
    if (k > 1) {
      src = new Float32Array(x.length);
      let acc = 0;
      const half = Math.floor(k / 2);
      for (let i = 0; i < x.length + half; i++) {
        if (i < x.length) acc += x[i];
        if (i - k >= 0) acc -= x[i - k];
        const j = i - half;
        if (j >= 0 && j < x.length) src[j] = acc / k;
      }
    }
  }
  const n = Math.floor((src.length * to) / from);
  const out = new Float32Array(n);
  const ratio = from / to;
  for (let i = 0; i < n; i++) {
    const p = i * ratio;
    const i0 = Math.floor(p);
    const f = p - i0;
    const a = src[i0] ?? 0;
    const b = src[i0 + 1] ?? a;
    out[i] = a + (b - a) * f;
  }
  return out;
}

/** YIN sur une trame. Renvoie f0 (Hz) et apériodicité (0 = parfaitement périodique). */
export function yinFrame(frame: Float32Array, sr: number, fmin: number, fmax: number, threshold: number, buf?: Float32Array): { f0: number; ap: number } | null {
  const tauMin = Math.max(2, Math.floor(sr / fmax));
  const tauMax = Math.min(Math.floor(sr / fmin), Math.floor(frame.length / 2));
  if (tauMax <= tauMin + 2) return null;
  const W = frame.length - tauMax;
  const d = buf && buf.length >= tauMax + 1 ? buf : new Float32Array(tauMax + 1);
  // fonction de différence
  for (let tau = 1; tau <= tauMax; tau++) {
    let s = 0;
    for (let j = 0; j < W; j++) {
      const v = frame[j] - frame[j + tau];
      s += v * v;
    }
    d[tau] = s;
  }
  // différence normalisée cumulée
  d[0] = 1;
  let run = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    run += d[tau];
    d[tau] = run > 0 ? (d[tau] * tau) / run : 1;
  }
  // premier minimum sous le seuil, sinon minimum global
  let best = -1;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (d[tau] < threshold) {
      while (tau + 1 <= tauMax && d[tau + 1] < d[tau]) tau++;
      best = tau;
      break;
    }
  }
  if (best < 0) {
    let m = Infinity;
    for (let tau = tauMin; tau <= tauMax; tau++)
      if (d[tau] < m) {
        m = d[tau];
        best = tau;
      }
  }
  if (best <= 0) return null;
  // interpolation parabolique
  let tauF = best;
  if (best > 1 && best < tauMax) {
    const a = d[best - 1];
    const b = d[best];
    const c = d[best + 1];
    const den = a + c - 2 * b;
    if (Math.abs(den) > 1e-12) tauF = best + (a - c) / (2 * den);
  }
  return { f0: sr / tauF, ap: d[best] };
}

/** Courbe F0 brute + post-traitée. */
export function pitchTrack(samples: Float32Array, sampleRate: number, opts: PitchOptions = {}): PitchPoint[] {
  const hop = opts.hop ?? 0.01;
  const winS = opts.window ?? 0.04;
  const fmin = opts.fmin ?? 70;
  const fmax = opts.fmax ?? 500;
  const thr = opts.threshold ?? 0.15;
  const maxAp = opts.maxAperiodicity ?? 0.35;
  const silenceDb = opts.silenceDb ?? -32;
  const sr = Math.min(sampleRate, opts.targetRate ?? 16000);
  const x = resample(samples, sampleRate, sr);
  const win = Math.round(winS * sr);
  const hopN = Math.max(1, Math.round(hop * sr));
  const nFrames = x.length >= win ? Math.floor((x.length - win) / hopN) + 1 : 0;
  if (!nFrames) return [];
  // énergie
  const rms = new Float32Array(nFrames);
  let maxRms = 0;
  for (let i = 0; i < nFrames; i++) {
    let s = 0;
    const o = i * hopN;
    for (let j = 0; j < win; j++) s += x[o + j] * x[o + j];
    rms[i] = Math.sqrt(s / win);
    if (rms[i] > maxRms) maxRms = rms[i];
  }
  const gate = Math.max(1e-4, maxRms * Math.pow(10, silenceDb / 20));
  const buf = new Float32Array(Math.floor(sr / fmin) + 2);
  const frame = new Float32Array(win);
  const raw: (number | null)[] = new Array(nFrames).fill(null);
  for (let i = 0; i < nFrames; i++) {
    if (rms[i] < gate) continue;
    const o = i * hopN;
    // retrait de la composante continue
    let mean = 0;
    for (let j = 0; j < win; j++) mean += x[o + j];
    mean /= win;
    for (let j = 0; j < win; j++) frame[j] = x[o + j] - mean;
    const r = yinFrame(frame, sr, fmin, fmax, thr, buf);
    if (r && r.ap <= maxAp && r.f0 >= fmin && r.f0 <= fmax) raw[i] = r.f0;
  }
  const cleaned = smoothF0(removeShortIslands(fixJumps(fixOctaves(removeShortIslands(raw, 4))), 3), 5);
  const t0 = winS / 2;
  return cleaned.map((f0, i) => ({ t: t0 + i * hop, f0 }));
}

/** Supprime les zones voisées plus courtes que `minLen` trames (bruits, clics). */
export function removeShortIslands(f: (number | null)[], minLen: number): (number | null)[] {
  const out = [...f];
  let i = 0;
  while (i < out.length) {
    if (out[i] == null) {
      i++;
      continue;
    }
    let j = i;
    while (j < out.length && out[j] != null) j++;
    if (j - i < minLen) for (let k = i; k < j; k++) out[k] = null;
    i = j;
  }
  return out;
}

export function median(v: number[]): number {
  if (!v.length) return NaN;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Corrige les erreurs d'octave (doublement/division) par rapport à la médiane. */
export function fixOctaves(f: (number | null)[]): (number | null)[] {
  const voiced = f.filter((v): v is number => v != null);
  if (voiced.length < 3) return f;
  const med = median(voiced);
  return f.map((v) => {
    if (v == null) return v;
    let x = v;
    if (x > med * 1.85) x /= 2;
    else if (x < med * 0.54) x *= 2;
    // valeurs aberrantes restantes : hors ±1 octave de la médiane
    if (x > med * 2.2 || x < med * 0.45) return null;
    return x;
  });
}

/** Continuité : dans chaque zone voisée, en partant de la trame la plus « typique », corrige les sauts
 *  d'octave (×2, ÷2) et supprime les sauts physiquement impossibles (> 6 demi-tons en 10 ms). */
export function fixJumps(f: (number | null)[]): (number | null)[] {
  const out = [...f];
  for (const [a, b] of voicedSegments(out.map((v) => ({ f0: v })))) {
    const seg = out.slice(a, b) as number[];
    const med = median(seg);
    let anchor = a;
    for (let i = a; i < b; i++) if (Math.abs(Math.log2(out[i]! / med)) < Math.abs(Math.log2(out[anchor]! / med))) anchor = i;
    for (const dir of [1, -1]) {
      let ref = out[anchor]!;
      for (let i = anchor + dir; i >= a && i < b; i += dir) {
        let v = out[i]!;
        const r = v / ref;
        if (r > 1.75 && r < 2.3) v /= 2;
        else if (r > 0.43 && r < 0.57) v *= 2;
        const r2 = v / ref;
        if (r2 > 1.42 || r2 < 0.7) {
          out[i] = null;
          continue;
        }
        out[i] = v;
        ref = v;
      }
    }
  }
  return out;
}

/** Lissage médian (fenêtre impaire) appliqué uniquement à l'intérieur des zones voisées. */
export function smoothF0(f: (number | null)[], k = 5): (number | null)[] {
  const h = k >> 1;
  return f.map((v, i) => {
    if (v == null) return null;
    const w: number[] = [];
    for (let j = i - h; j <= i + h; j++) {
      const x = f[j];
      if (x != null) w.push(x);
    }
    return median(w);
  });
}

/** Médiane F0 (Hz) des trames voisées. */
export function speakerMedian(track: PitchPoint[]): number | null {
  const v = track.map((p) => p.f0).filter((x): x is number => x != null);
  return v.length ? median(v) : null;
}

/** Convertit en demi-tons relatifs à la médiane du locuteur (ou à `ref` Hz). */
export function toSemitones(track: PitchPoint[], ref?: number): { t: number; st: number | null }[] {
  const m = ref ?? speakerMedian(track);
  return track.map((p) => ({ t: p.t, st: p.f0 != null && m ? 12 * Math.log2(p.f0 / m) : null }));
}

/** Zones voisées : indices [début, fin) dans la piste. */
export function voicedSegments(track: { f0?: number | null; st?: number | null }[]): [number, number][] {
  const segs: [number, number][] = [];
  let s = -1;
  track.forEach((p, i) => {
    const v = (p.f0 ?? p.st) != null;
    if (v && s < 0) s = i;
    if (!v && s >= 0) {
      segs.push([s, i]);
      s = -1;
    }
  });
  if (s >= 0) segs.push([s, track.length]);
  return segs;
}

/** Interpolation linéaire d'une suite vers `n` points. */
export function resampleSeq(v: number[], n: number): number[] {
  if (!v.length) return [];
  if (v.length === 1) return new Array(n).fill(v[0]);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = (i * (v.length - 1)) / (n - 1);
    const i0 = Math.floor(p);
    const f = p - i0;
    out.push(v[i0] + ((v[Math.min(i0 + 1, v.length - 1)] ?? v[i0]) - v[i0]) * f);
  }
  return out;
}

/** Contour normalisé : demi-tons des zones voisées concaténées, durée ramenée à `n` points. */
export function contour(track: PitchPoint[], n = 60): number[] {
  const st = toSemitones(track)
    .map((p) => p.st)
    .filter((x): x is number => x != null);
  return st.length >= 3 ? resampleSeq(st, n) : [];
}

/** DTW à bande Sakoe-Chiba ; coût |a-b| ; renvoie le coût moyen par pas sur le chemin optimal. */
export function dtw(a: number[], b: number[], band = 0.2): number {
  const n = a.length;
  const m = b.length;
  if (!n || !m) return Infinity;
  const w = Math.max(Math.ceil(Math.max(n, m) * band), Math.abs(n - m) + 1);
  const INF = Infinity;
  let prev = new Float64Array(m + 1).fill(INF);
  let prevLen = new Float64Array(m + 1).fill(0);
  prev[0] = 0;
  for (let i = 1; i <= n; i++) {
    const cur = new Float64Array(m + 1).fill(INF);
    const curLen = new Float64Array(m + 1).fill(0);
    const jc = Math.round((i * m) / n);
    const lo = Math.max(1, jc - w);
    const hi = Math.min(m, jc + w);
    for (let j = lo; j <= hi; j++) {
      const c = Math.abs(a[i - 1] - b[j - 1]);
      // diagonale, verticale, horizontale
      let best = prev[j - 1];
      let len = prevLen[j - 1];
      if (prev[j] < best) {
        best = prev[j];
        len = prevLen[j];
      }
      if (cur[j - 1] < best) {
        best = cur[j - 1];
        len = curLen[j - 1];
      }
      cur[j] = best + c;
      curLen[j] = len + 1;
    }
    prev = cur;
    prevLen = curLen;
  }
  return prevLen[m] ? prev[m] / prevLen[m] : Infinity;
}

const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / (v.length || 1);

/** Écart moyen (demi-tons) et score de similarité 0-100 entre deux contours (ou pistes). */
export function compareContours(a: number[], b: number[], band = 0.08): { distance: number; score: number } {
  if (a.length < 3 || b.length < 3) return { distance: Infinity, score: 0 };
  const ma = mean(a);
  const mb = mean(b);
  const ca = a.map((x) => x - ma);
  const cb = b.map((x) => x - mb);
  // bande étroite : on tolère les écarts de débit, pas une réorganisation de la mélodie
  const d = dtw(ca, cb, band);
  // calibré sur de la parole réelle (Piper) : même phrase ≈ 0,2-0,6 demi-ton ; phrases différentes ≥ 1-1,5 ;
  // d = 0,3 → 94 ; 0,6 → 78 ; 0,9 → 57 ; 1,2 → 37 ; 1,8 → 11
  const score = Math.round(100 * Math.exp(-Math.pow(d / 1.2, 2)));
  return { distance: d, score: Math.max(0, Math.min(100, score)) };
}

/** Zones voisées « utiles » (micro-coupures ≤ 3 trames fusionnées, zones < 4 trames ignorées), en demi-tons. */
export function voicedRuns(track: PitchPoint[]): number[][] {
  const st = toSemitones(track);
  const segs: [number, number][] = [];
  for (const [a, b] of voicedSegments(st)) {
    const last = segs[segs.length - 1];
    if (last && a - last[1] <= 3) last[1] = b;
    else segs.push([a, b]);
  }
  return segs.filter(([a, b]) => b - a >= 4).map(([a, b]) => st.slice(a, b).map((p) => p.st).filter((x): x is number => x != null));
}

/** Compare deux pistes. Si elles ont le même nombre de zones voisées (≈ mêmes syllabes ou groupes),
 *  chaque zone est normalisée en durée séparément (insensible aux différences de débit syllabe par syllabe) ;
 *  sinon, contours globaux alignés par DTW. */
export function compareTracks(a: PitchPoint[], b: PitchPoint[]): { distance: number; score: number; method: 'segments' | 'dtw' } {
  const ra = voicedRuns(a);
  const rb = voicedRuns(b);
  if (ra.length >= 2 && ra.length === rb.length) {
    const per = Math.max(8, Math.round(72 / ra.length));
    const ca = ra.flatMap((r) => resampleSeq(r, per));
    const cb = rb.flatMap((r) => resampleSeq(r, per));
    return { ...compareContours(ca, cb, 0.04), method: 'segments' };
  }
  return { ...compareContours(contour(a), contour(b), ra.length <= 1 && rb.length <= 1 ? 0.08 : 0.12), method: 'dtw' };
}

/** Similarité 0-100 entre deux pistes de hauteur. */
export function similarity(a: PitchPoint[], b: PitchPoint[]): number {
  return compareTracks(a, b).score;
}

export type ToneGuess = 1 | 2 | 3 | 4;

/** Devine le ton d'une syllabe isolée à partir de son contour (demi-tons, durée normalisée).
 *  Heuristique : pente début→fin, position et profondeur du minimum. */
export function guessTone(c: number[]): ToneGuess | null {
  if (c.length < 5) return null;
  const n = c.length;
  const q = Math.max(1, Math.floor(n / 5));
  const start = mean(c.slice(0, q));
  const end = mean(c.slice(n - q));
  let minI = 0;
  for (let i = 1; i < n; i++) if (c[i] < c[minI]) minI = i;
  const minV = c[minI];
  const range = Math.max(...c) - minV;
  const rel = minI / (n - 1);
  if (range < 1.8) return 1;
  if (rel > 0.2 && rel < 0.8 && start - minV > 1 && end - minV > 1) return 3;
  if (end - start > 1.5) return 2;
  if (start - end > 1.5) return 4;
  return 1;
}

/** Description française de la forme d'un contour (pour les retours à l'utilisateur). */
export function describeShape(c: number[]): string {
  const t = guessTone(c);
  switch (t) {
    case 1:
      return 'plate';
    case 2:
      return 'montante';
    case 3:
      return 'descendante puis montante (creux)';
    case 4:
      return 'descendante';
    default:
      return 'indéterminée';
  }
}
