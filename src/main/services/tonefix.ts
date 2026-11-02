// Correction des tons des mots courts synthétisés par Piper (pur Node, sans Electron → testable).
//
// Constat (mesuré, voir rapport du module) : la voix zh_CN-huayan-medium prononce correctement les phrases,
// mais dans un énoncé d'1-2 syllabes elle aplatit souvent la syllabe finale (ton 4 isolé ≈ plat : 是, 四, 骂…).
// Pour un outil d'apprentissage des tons, c'est rédhibitoire. Stratégie :
//   1. on connaît les tons attendus (pinyin du dictionnaire + sandhi du 3e ton, de 不 et de 一) ;
//   2. on mesure la courbe F0 de la sortie Piper (YIN), on la découpe en syllabes ;
//   3. pour chaque syllabe dont la forme s'écarte du gabarit de Chao, on impose le gabarit
//      par TD-PSOLA (durées et timbre conservés). Les syllabes déjà correctes sont laissées telles quelles.
import { pitchTrack, compareContours, voicedSegments, median, type PitchPoint } from '../../renderer/components/pitch';

export type Tone = 1 | 2 | 3 | 4 | 5;

/** "ni3 hao3" → [3,3] ; null si une syllabe n'a pas de ton numérique. */
export function parseTones(pn: string): Tone[] | null {
  const syl = pn.trim().split(/\s+/).filter(Boolean);
  if (!syl.length) return null;
  const out: Tone[] = [];
  for (const s of syl) {
    const m = s.match(/([1-5])$/);
    if (!m) return null;
    out.push(+m[1] as Tone);
  }
  return out;
}

/** Tons réalisés lus dans la sortie `espeak-ng -v cmn -x` (chiffres de Chao par syllabe, sandhi déjà appliqués) :
 *  "ni35X'Au214_|" → [2,3] ; 55→1, 35→2, 214/21→3, 51/53→4, autres (11, 22, 33, 44) → neutre. */
export function tonesFromEspeak(phonemes: string): Tone[] {
  const out: Tone[] = [];
  for (const m of phonemes.matchAll(/\d+/g)) {
    const d = m[0];
    if (d === '55') out.push(1);
    else if (d === '35') out.push(2);
    else if (d === '214' || d === '21' || d === '213') out.push(3);
    else if (d === '51' || d === '53' || d === '52') out.push(4);
    else out.push(5);
  }
  return out;
}

/** Tons réalisés : sandhi 3-3 → 2-3, 不 + 4 → bú, 一 + 4 → yí, 一 + 1/2/3 → yì (一 final ou seul : yī). */
export function applySandhi(chars: string[], tones: Tone[]): Tone[] {
  const t = [...tones];
  for (let i = 0; i < t.length - 1; i++) {
    const next = t[i + 1];
    if (chars[i] === '不' && tones[i] === 4 && next === 4) t[i] = 2;
    // 一个 : 个 est ge4 sous-jacent (neutralisé en ge) → yí ge
    else if (chars[i] === '一' && tones[i] === 1 && (next !== 5 || chars[i + 1] === '个')) t[i] = next === 4 || chars[i + 1] === '个' ? 2 : 4;
  }
  // 3e ton : de droite à gauche, un 3 suivi d'un 3 devient 2
  for (let i = t.length - 2; i >= 0; i--) if (t[i] === 3 && tones[i + 1] === 3) t[i] = 2;
  return t;
}

// Échelle de Chao (1 = grave … 5 = aigu) → Hz pour la voix huayan (mesuré : ton 1 ≈ 270-300 Hz, bas ≈ 165 Hz)
export const VOICE_REF_HZ = 228;
export const CHAO_STEP_ST = 2.6;
export const chaoToHz = (c: number, ref = VOICE_REF_HZ) => ref * Math.pow(2, ((c - 3) * CHAO_STEP_ST) / 12);
export const hzToChao = (f: number, ref = VOICE_REF_HZ) => 3 + (12 * Math.log2(f / ref)) / CHAO_STEP_ST;

/** Points (temps normalisé 0-1, niveau Chao) du gabarit d'un ton selon sa position. */
export function chaoTemplate(tone: Tone, final: boolean, prev?: Tone): [number, number][] {
  switch (tone) {
    case 1:
      return [
        [0, 5],
        [1, 4.9],
      ];
    case 2:
      return final
        ? [
            [0, 3],
            [0.25, 2.7],
            [1, 5],
          ]
        : [
            [0, 3],
            [0.3, 2.8],
            [1, 4.6],
          ];
    case 3:
      return final
        ? [
            [0, 2.3],
            [0.4, 1],
            [0.62, 1.1],
            [1, 4],
          ]
        : [
            [0, 2.2],
            [0.6, 1],
            [1, 1.2],
          ];
    case 4:
      return final
        ? [
            [0, 5],
            [0.12, 5],
            [1, 1.2],
          ]
        : [
            [0, 5],
            [0.1, 5],
            [1, 2],
          ];
    case 5: {
      const lvl = prev === 1 ? 2 : prev === 2 ? 3 : prev === 3 ? 4 : prev === 4 ? 1.6 : 3;
      return [
        [0, lvl],
        [1, lvl - 0.3],
      ];
    }
  }
}

/** Échantillonne un gabarit sur n points (niveaux Chao). */
export function sampleTemplate(pts: [number, number][], n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = n === 1 ? 0 : i / (n - 1);
    let k = 0;
    while (k < pts.length - 2 && x > pts[k + 1][0]) k++;
    const [x0, y0] = pts[k];
    const [x1, y1] = pts[k + 1];
    const f = x1 > x0 ? Math.min(1, Math.max(0, (x - x0) / (x1 - x0))) : 0;
    out.push(y0 + (y1 - y0) * f);
  }
  return out;
}

/** Découpe une syllabe en pinyin numérique : « zhong1 » → {zh, ong, 1} ; ü normalisé (ju → jü). */
export function splitSyllable(pn: string): { initial: string; final: string; tone: Tone } | null {
  const m = pn.trim().toLowerCase().match(/^(zh|ch|sh|[bpmfdtnlgkhjqxrzcsyw])?([a-zü:v]+)([1-5])$/);
  if (!m) return null;
  const initial = m[1] ?? '';
  let final = m[2].replace(/u:|v/g, 'ü');
  if (/^[jqxy]$/.test(initial) && final.startsWith('u')) final = 'ü' + final.slice(1);
  return { initial, final, tone: +m[3] as Tone };
}

// ---------- WAV ----------
export function decodeWav(buf: Buffer): { samples: Float32Array; sampleRate: number } {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('WAV invalide');
  let o = 12;
  let sr = 22050;
  let bits = 16;
  let ch = 1;
  let data: Buffer | null = null;
  while (o + 8 <= buf.length) {
    const id = buf.toString('ascii', o, o + 4);
    const sz = buf.readUInt32LE(o + 4);
    if (id === 'fmt ') {
      ch = buf.readUInt16LE(o + 10);
      sr = buf.readUInt32LE(o + 12);
      bits = buf.readUInt16LE(o + 22);
    } else if (id === 'data') data = buf.subarray(o + 8, Math.min(buf.length, o + 8 + sz));
    o += 8 + sz + (sz % 2);
  }
  if (!data || bits !== 16) throw new Error('WAV non supporté (PCM 16 bits attendu)');
  const n = Math.floor(data.length / 2 / ch);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = data.readInt16LE(i * 2 * ch) / 32768;
  return { samples: x, sampleRate: sr };
}

export function encodeWav(x: Float32Array, sr: number): Buffer {
  const b = Buffer.alloc(44 + x.length * 2);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + x.length * 2, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24);
  b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), 44 + i * 2);
  return b;
}

// ---------- segmentation en syllabes ----------
/** Découpe les trames voisées en `n` syllabes : [début, fin) en indices de trame. */
export function syllableSegments(track: PitchPoint[], energy: number[], n: number): [number, number][] | null {
  // zones voisées ; fusion des micro-coupures (≤ 2 trames)
  let segs = voicedSegments(track).filter(([a, b]) => b - a >= 3);
  const merged: [number, number][] = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && s[0] - last[1] <= 2) last[1] = s[1];
    else merged.push([s[0], s[1]]);
  }
  segs = merged;
  if (!segs.length) return null;
  // trop de zones : on fusionne les deux plus proches (ou la plus petite avec sa voisine)
  while (segs.length > n) {
    let best = 0;
    let bestGap = Infinity;
    for (let i = 0; i < segs.length - 1; i++) {
      const gap = segs[i + 1][0] - segs[i][1] - 0.3 * Math.min(segs[i][1] - segs[i][0], segs[i + 1][1] - segs[i + 1][0]);
      if (gap < bestGap) {
        bestGap = gap;
        best = i;
      }
    }
    // une zone minuscule isolée est plus probablement du bruit : on la supprime plutôt
    const a = segs[best];
    const b = segs[best + 1];
    if (b[0] - a[1] > 8 && Math.min(a[1] - a[0], b[1] - b[0]) < 6) segs.splice(a[1] - a[0] < b[1] - b[0] ? best : best + 1, 1);
    else segs.splice(best, 2, [a[0], b[1]]);
  }
  // pas assez : on coupe la plus longue au minimum d'énergie de sa partie centrale
  while (segs.length < n) {
    let li = 0;
    for (let i = 1; i < segs.length; i++) if (segs[i][1] - segs[i][0] > segs[li][1] - segs[li][0]) li = i;
    const [a, b] = segs[li];
    if (b - a < 8) return null;
    const lo = a + Math.floor((b - a) * 0.3);
    const hi = a + Math.ceil((b - a) * 0.7);
    let cut = lo;
    for (let k = lo; k <= hi; k++) if (energy[k] < energy[cut]) cut = k;
    segs.splice(li, 1, [a, cut], [cut, b]);
  }
  return segs;
}

// ---------- TD-PSOLA ----------
/** Modifie la hauteur de `x` sur [s, e) : `fa(n)` = F0 d'analyse (Hz) à l'échantillon n, `ft(n)` = F0 cible. */
export function psolaRegion(x: Float32Array, y: Float32Array, sr: number, s: number, e: number, fa: (n: number) => number, ft: (n: number) => number): void {
  // marques d'analyse : pics d'une version lissée du signal (le fondamental y domine, ce qui évite
  // de sauter d'un pic de formant à l'autre), espacés d'une période et cherchés à ±15 % de la prédiction
  const p0 = sr / fa(s);
  const L = Math.max(1, Math.round(p0 / 3));
  const lo = Math.max(0, s - Math.round(2 * p0));
  const hi = Math.min(x.length, e + Math.round(2 * p0));
  const xs = new Float32Array(hi - lo);
  let acc = 0;
  for (let i = lo; i < hi + L; i++) {
    if (i < hi) acc += x[i];
    if (i - L >= lo) acc -= x[i - L];
    const j = i - (L >> 1) - lo;
    if (j >= 0 && j < xs.length) xs[j] = acc / L;
  }
  const v = (k: number) => xs[k - lo] ?? -Infinity;
  const epochs: number[] = [];
  let first = s;
  for (let k = s; k < Math.min(e, s + Math.round(p0)); k++) if (v(k) > v(first)) first = k;
  epochs.push(first);
  for (;;) {
    const last = epochs[epochs.length - 1];
    const P = sr / fa(last);
    const pred = Math.round(last + P);
    if (pred >= e) break;
    const r = Math.max(1, Math.round(P * 0.15));
    let best = pred;
    for (let k = pred - r; k <= pred + r && k < hi; k++) if (v(k) > v(best)) best = k;
    epochs.push(best);
  }
  if (epochs.length < 3) return;
  const a0 = epochs[0];
  const aN = epochs[epochs.length - 1];
  const out = new Float32Array(aN - a0 + 1);
  let to = a0;
  let k = 0;
  while (to <= aN) {
    while (k < epochs.length - 1 && Math.abs(epochs[k + 1] - to) <= Math.abs(epochs[k] - to)) k++;
    const Ps = sr / ft(Math.round(to));
    const half = Math.max(2, Math.round(Ps));
    const c = epochs[k];
    const ti = Math.round(to);
    for (let j = -half; j <= half; j++) {
      const oi = ti + j - a0;
      const xi = c + j;
      if (oi < 0 || oi >= out.length || xi < 0 || xi >= x.length) continue;
      const w = 0.5 * (1 + Math.cos((Math.PI * j) / half));
      out[oi] += x[xi] * w;
    }
    to += Ps;
  }
  // compensation de gain (le recouvrement des grains atténue légèrement le signal)
  let ex = 0;
  let eo = 0;
  for (let i = 0; i < out.length; i++) {
    ex += x[a0 + i] * x[a0 + i];
    eo += out[i] * out[i];
  }
  const g = eo > 0 ? Math.min(2, Math.sqrt(ex / eo)) : 1;
  for (let i = 0; i < out.length; i++) out[i] *= g;
  // recollage avec fondu de 3 ms aux bords
  const fade = Math.max(1, Math.round(sr * 0.003));
  for (let i = 0; i < out.length; i++) {
    const n = a0 + i;
    const r = Math.min(1, i / fade, (out.length - 1 - i) / fade);
    y[n] = x[n] * (1 - r) + out[i] * r;
  }
}

export interface ToneFixResult {
  samples: Float32Array;
  changed: boolean;
  /** pour chaque syllabe : ton attendu, distance mesurée (demi-tons) au gabarit, corrigée ? */
  syllables: { tone: Tone; distance: number; fixed: boolean }[];
  reason?: string;
}

/** Seuil (demi-tons, DTW sur contours centrés) au-delà duquel une syllabe est jugée fausse. */
export const FIX_THRESHOLD_ST = 1.2;
/** Amplitude minimale (fraction de celle du gabarit) d'un 2e, 3e ou 4e ton. */
export const MIN_RANGE_RATIO = 0.45;
/** Écart de registre toléré (demi-tons) entre la syllabe mesurée et son gabarit. */
export const LEVEL_TOLERANCE_ST = 3;

/** Analyse et, si besoin, corrige la hauteur des syllabes d'un mot court. `tones` = tons réalisés (après sandhi). */
export function fixTones(x: Float32Array, sr: number, tones: Tone[], opts: { force?: boolean } = {}): ToneFixResult {
  const track = pitchTrack(x, sr, { silenceDb: -38 });
  const hop = 0.01;
  const t0 = track.length ? track[0].t : 0.02;
  const energy = track.map((p) => {
    const c = Math.round(p.t * sr);
    const h = Math.round(0.015 * sr);
    let s = 0;
    for (let i = Math.max(0, c - h); i < Math.min(x.length, c + h); i++) s += x[i] * x[i];
    return s;
  });
  const segs = syllableSegments(track, energy, tones.length);
  if (!segs) return { samples: x, changed: false, syllables: [], reason: 'segmentation impossible' };

  const voicedHz = track.map((p) => p.f0).filter((v): v is number => v != null);
  const st = (v: number[]) => v.map((f) => 12 * Math.log2(f / VOICE_REF_HZ));
  // 1re passe : mesure de chaque syllabe face à son gabarit
  const per = segs.map(([a, b], i) => {
    const tone = tones[i];
    const tplChao = sampleTemplate(chaoTemplate(tone, i === tones.length - 1, tones[i - 1]), b - a);
    const meas: number[] = [];
    for (let k = a; k < b; k++) if (track[k].f0 != null) meas.push(track[k].f0!);
    const tplSt = tplChao.map((c) => (c - 3) * CHAO_STEP_ST);
    const { distance } = compareContours(st(meas), tplSt);
    // amplitude : un 2e/3e/4e ton trop « tassé » s'entend comme un 1er ton
    const range = (v: number[]) => (v.length ? Math.max(...v) - Math.min(...v) : 0);
    const flat = tone >= 2 && tone <= 4 && range(st(meas)) < MIN_RANGE_RATIO * range(tplSt);
    return { tone, tplSt, distance, flat, levelDiff: median(st(meas)) - median(tplSt) };
  });
  // registre propre à l'énoncé : décalage médian (borné à ±3 demi-tons)
  const offset = Math.max(-3, Math.min(3, median(per.map((p) => p.levelDiff))));
  const syll: ToneFixResult['syllables'] = [];
  const target = new Float64Array(track.length).fill(NaN); // cible par trame (Hz)
  segs.forEach(([a, b], i) => {
    const p = per[i];
    const relLevel = per.length > 1 ? Math.abs(p.levelDiff - offset) : 0;
    const bad = !!opts.force || (p.tone !== 5 && (p.distance > FIX_THRESHOLD_ST || p.flat || relLevel > LEVEL_TOLERANCE_ST));
    syll.push({ tone: p.tone, distance: Math.round(p.distance * 100) / 100, fixed: bad });
    for (let k = a; k < b; k++) target[k] = bad ? VOICE_REF_HZ * Math.pow(2, (p.tplSt[k - a] + offset) / 12) : track[k].f0 ?? NaN;
  });
  if (!syll.some((s) => s.fixed)) return { samples: x, changed: false, syllables: syll };

  // F0 d'analyse continue par trame (interpolation des trous) + cible lissée (≈ 30 ms)
  const fa = fillGaps(track.map((p) => p.f0 ?? NaN), median(voicedHz));
  const ftRaw = fillGaps(Array.from(target), median(voicedHz));
  const ft = ftRaw.map((_, i) => {
    let s = 0;
    let n = 0;
    for (let j = i - 1; j <= i + 1; j++)
      if (j >= 0 && j < ftRaw.length) {
        s += ftRaw[j];
        n++;
      }
    return s / n;
  });
  const atFrame = (arr: number[]) => (n: number) => {
    const fi = (n / sr - t0) / hop;
    const i0 = Math.max(0, Math.min(arr.length - 1, Math.floor(fi)));
    const i1 = Math.min(arr.length - 1, i0 + 1);
    const f = Math.max(0, Math.min(1, fi - i0));
    return arr[i0] + (arr[i1] - arr[i0]) * f;
  };
  const y = new Float32Array(x);
  // une région PSOLA par zone voisée continue contenant une syllabe corrigée
  const runs = voicedSegments(Array.from(target, (v) => ({ f0: Number.isNaN(v) ? null : v })));
  for (const [a, b] of runs) {
    let needs = false;
    segs.forEach(([sa, sb], i) => {
      if (syll[i].fixed && sa < b && sb > a) needs = true;
    });
    if (!needs) continue;
    const s = Math.max(0, Math.round((track[a].t - 0.012) * sr));
    const e = Math.min(x.length - 1, Math.round((track[b - 1].t + 0.012) * sr));
    psolaRegion(x, y, sr, s, e, atFrame(fa), atFrame(ft));
  }
  // pas d'écrêtage
  let peak = 0;
  for (let i = 0; i < y.length; i++) peak = Math.max(peak, Math.abs(y[i]));
  if (peak > 0.97) for (let i = 0; i < y.length; i++) y[i] *= 0.97 / peak;
  return { samples: y, changed: true, syllables: syll };
}

function fillGaps(v: number[], fallback: number): number[] {
  const out = [...v];
  const idx = out.map((x, i) => (Number.isNaN(x) ? -1 : i)).filter((i) => i >= 0);
  if (!idx.length) return out.map(() => fallback);
  for (let i = 0; i < out.length; i++) {
    if (!Number.isNaN(out[i])) continue;
    let l = i - 1;
    while (l >= 0 && Number.isNaN(v[l])) l--;
    let r = i + 1;
    while (r < out.length && Number.isNaN(v[r])) r++;
    if (l < 0) out[i] = v[r];
    else if (r >= out.length) out[i] = v[l];
    else out[i] = v[l] + ((v[r] - v[l]) * (i - l)) / (r - l);
  }
  return out;
}
