// Tone + signal analysis of synthesized audio, reusing the app's own pitch code (YIN, segmentation, Chao templates).
//   src/renderer/components/pitch.ts : pitchTrack (YIN), compareContours (DTW on mean-centred contours), voicedSegments, median
//   src/main/services/tonefix.ts     : decodeWav, chaoTemplate, sampleTemplate, syllableSegments, CHAO_STEP_ST
//
// Usage (bundled by run.sh with esbuild): node analyze.js jobs.json results.json
// jobs.json: [{key, wav, exp: number[][] (accepted realised tones per syllable), finals: boolean[], emit?: number[]|null}]
//
// Tone classification of each syllable (4-way among tones 1-4; neutral syllables are not scored):
//   measured contour = F0 (semitones re. the utterance median) of the voiced frames of the syllable, first 20 % / last 10 % trimmed (rhyme only);
//   cost(tone) = DTW shape distance to the Chao template (scaled by s) + LAMBDA * |level difference - o|;
//   the speaker normalisation (range scale s, register offset o) is fitted per utterance WITHOUT looking at the expected
//   tones (minimum total cost over a grid). Single-syllable utterances: level is meaningless → shape only.
import fs from 'node:fs';
import { pitchTrack, compareContours, voicedSegments, median, resampleSeq, type PitchPoint } from '../../src/renderer/components/pitch';
import { decodeWav, chaoTemplate, sampleTemplate, syllableSegments, CHAO_STEP_ST, type Tone } from '../../src/main/services/tonefix';

interface Job {
  key: string;
  wav: string;
  exp: number[][];
  finals: boolean[];
  /** first CTC emission time (s) of each Han char (WeNet CTC fires near the END of the syllable, measured ≈ 0.15-0.2 s after onset) */
  emit?: number[] | null;
}

const LAMBDA = Number(process.env.TB_LAMBDA ?? 0.35);
const WORDSEG = process.env.TB_WORDSEG ?? 'energy'; // segmentation of 2-syllable words: energy (tonefix.syllableSegments) | ctc
const SCALES = [0.5, 0.65, 0.8, 1.0, 1.25];
const OFFSETS = [-4, -3, -2, -1, 0, 1, 2, 3, 4];
const MIN_VOICED = 4; // frames (40 ms)
const LEVEL_RANGE_ST = 1.8;

/** Syllable frame ranges from CTC emissions: boundary k = emission of char k-1, snapped to the nearest unvoiced frame
 *  (± 80 ms) or, failing that, to the energy minimum (± 50 ms). Outer bounds = first/last voiced frame. */
function ctcRanges(track: PitchPoint[], energy: number[], emit: number[]): [number, number][] | null {
  const n = emit.length;
  const vi = track.map((p, i) => (p.f0 != null ? i : -1)).filter((i) => i >= 0);
  if (!vi.length) return null;
  const frameOf = (t: number) => {
    const i = track.findIndex((p) => p.t >= t);
    return i < 0 ? track.length - 1 : i;
  };
  const B: number[] = [vi[0]];
  for (let k = 1; k < n; k++) {
    const c = frameOf(emit[k - 1]);
    let best = -1;
    for (let d = 0; d <= 8 && best < 0; d++) {
      if (c - d >= 0 && track[c - d].f0 == null) best = c - d;
      else if (c + d < track.length && track[c + d].f0 == null) best = c + d;
    }
    if (best < 0) {
      best = c;
      for (let j = Math.max(0, c - 5); j <= Math.min(track.length - 1, c + 5); j++) if (energy[j] < energy[best]) best = j;
    }
    B.push(best > B[B.length - 1] ? best : Math.max(c, B[B.length - 1] + 1));
  }
  B.push(vi[vi.length - 1] + 1);
  const r: [number, number][] = [];
  for (let k = 0; k < n; k++) r.push([B[k], Math.max(B[k], B[k + 1])]);
  return r;
}

function syllableContours(track: PitchPoint[], energy: number[], job: Job): { contours: (number[] | null)[]; method: string } {
  const n = job.exp.length;
  const voiced = track.map((p) => p.f0).filter((v): v is number => v != null);
  const ref = voiced.length ? median(voiced) : 200;
  const st = track.map((p) => (p.f0 != null ? 12 * Math.log2(p.f0 / ref) : null));
  let ranges: [number, number][] | null = null;
  let method = '';
  const haveCtc = !!job.emit && job.emit.length === n;
  if (n === 1) {
    const segs = voicedSegments(track);
    ranges = segs.length ? [[segs[0][0], segs[segs.length - 1][1]]] : null;
    method = 'single';
  } else if (haveCtc && (n > 2 || WORDSEG === 'ctc')) {
    ranges = ctcRanges(track, energy, job.emit!);
    method = 'ctc';
  } else {
    ranges = syllableSegments(track, energy, n);
    method = 'energy';
    if (!ranges && haveCtc) {
      ranges = ctcRanges(track, energy, job.emit!);
      method = 'ctc-fallback';
    }
  }
  if (!ranges) return { contours: new Array(n).fill(null), method: 'none' };
  const contours = ranges.map(([a, b]) => {
    const v: number[] = [];
    for (let k = a; k < b; k++) if (st[k] != null) v.push(st[k]!);
    if (v.length < MIN_VOICED) return null;
    // tone = contour of the rhyme: drop the first 20 % (onset/glide perturbation) and the last 10 %
    return resampleSeq(v.slice(Math.floor(v.length * 0.2), v.length - Math.floor(v.length * 0.1)), 30);
  });
  return { contours, method };
}

function tplSt(tone: Tone, final: boolean, s: number): number[] {
  return sampleTemplate(chaoTemplate(tone, final), 30).map((c) => (c - 3) * CHAO_STEP_ST * s);
}

const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;

function classify(contours: (number[] | null)[], finals: boolean[], scored: boolean[]) {
  const idx = contours.map((c, i) => (c && scored[i] ? i : -1)).filter((i) => i >= 0);
  const multi = contours.filter((c) => c).length >= 2;
  let best: { total: number; s: number; o: number; got: Record<number, { tone: number; cost: number; costs: number[] }> } | null = null;
  for (const s of SCALES) {
    // shape distance does not depend on the offset: compute once per scale
    const shape: Record<number, { d: number[]; lvl: number[] }> = {};
    for (const i of idx) {
      const c = contours[i]!;
      const d: number[] = [];
      const lvl: number[] = [];
      for (const t of [1, 2, 3, 4] as Tone[]) {
        const tp = tplSt(t, finals[i], s);
        d.push(compareContours(c, tp).distance);
        lvl.push(mean(c) - mean(tp));
      }
      shape[i] = { d, lvl };
    }
    for (const o of multi ? OFFSETS : [0]) {
      let total = 0;
      const got: Record<number, { tone: number; cost: number; costs: number[] }> = {};
      for (const i of idx) {
        const costs = shape[i].d.map((d, k) => d + (multi ? LAMBDA * Math.abs(shape[i].lvl[k] - o) : 0));
        let k = 0;
        for (let j = 1; j < 4; j++) if (costs[j] < costs[k]) k = j;
        got[i] = { tone: k + 1, cost: costs[k], costs };
        total += costs[k];
      }
      if (!best || total < best.total - 1e-9) best = { total, s, o, got };
    }
  }
  // citation forms (1-2 syllable words): a contour moving less than LEVEL_RANGE_ST is heard as level → tone 1
  // (same a-priori threshold as guessTone() in pitch.ts); otherwise tiny wiggles could match a compressed template.
  if (best && contours.length <= 2)
    for (const i of idx) {
      const c = contours[i]!;
      if (Math.max(...c) - Math.min(...c) < LEVEL_RANGE_ST) best.got[i] = { ...best.got[i], tone: 1 };
    }
  return best;
}

function signalStats(x: Float32Array, sr: number, track: PitchPoint[]) {
  let peak = 0;
  let clip = 0;
  let ss = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > peak) peak = a;
    if (a >= 0.999) clip++;
    ss += x[i] * x[i];
  }
  // 10 ms frame energies → silence analysis (−40 dB below the loudest frame)
  const hop = Math.round(sr * 0.01);
  const e: number[] = [];
  for (let o = 0; o + hop <= x.length; o += hop) {
    let s = 0;
    for (let j = 0; j < hop; j++) s += x[o + j] * x[o + j];
    e.push(10 * Math.log10(s / hop + 1e-12));
  }
  const mx = Math.max(...e);
  const act = e.map((v) => v > mx - 40);
  const first = act.indexOf(true);
  const last = act.lastIndexOf(true);
  let maxGap = 0;
  let gap = 0;
  for (let i = Math.max(0, first); i <= last; i++) {
    if (!act[i]) gap++;
    else {
      maxGap = Math.max(maxGap, gap);
      gap = 0;
    }
  }
  const voicedFrames = track.filter((p) => p.f0 != null).length;
  return {
    dur: x.length / sr,
    peak,
    clipFrac: clip / x.length,
    rmsDb: 10 * Math.log10(ss / Math.max(1, x.length) + 1e-12),
    leadSil: first < 0 ? x.length / sr : first * 0.01,
    trailSil: last < 0 ? 0 : x.length / sr - (last + 1) * 0.01,
    maxGap: maxGap * 0.01,
    activeDur: first < 0 ? 0 : (last - first + 1) * 0.01,
    voicedFrac: track.length ? voicedFrames / track.length : 0,
    silent: first < 0 || mx < -60,
  };
}

const [, , jobsPath, outPath] = process.argv;
const jobs: Job[] = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));
const out: Record<string, unknown> = {};
for (const job of jobs) {
  try {
    const { samples, sampleRate } = decodeWav(fs.readFileSync(job.wav));
    const track = pitchTrack(samples, sampleRate, { silenceDb: -38, fmin: 60, fmax: 500 });
    const energy = track.map((p) => {
      const c = Math.round(p.t * sampleRate);
      const h = Math.round(0.015 * sampleRate);
      let s = 0;
      for (let i = Math.max(0, c - h); i < Math.min(samples.length, c + h); i++) s += samples[i] * samples[i];
      return s;
    });
    const sig = signalStats(samples, sampleRate, track);
    const { contours, method } = syllableContours(track, energy, job);
    const scored = job.exp.map((e) => !e.includes(5));
    const fit = classify(contours, job.finals, scored);
    const syl = job.exp.map((e, i) => {
      if (!scored[i]) return { exp: e, got: null, status: 'neutral' };
      if (!contours[i]) return { exp: e, got: null, status: 'unvoiced' };
      const g = fit?.got[i];
      return { exp: e, got: g?.tone ?? null, ok: g ? e.includes(g.tone) : false, cost: g ? +g.cost.toFixed(3) : null, costs: g?.costs.map((c) => +c.toFixed(2)), status: 'scored' };
    });
    out[job.key] = { sig, method, fit: fit ? { s: fit.s, o: fit.o } : null, syl, contours: contours.map((c) => (c ? c.map((v) => +v.toFixed(2)) : null)) };
  } catch (e) {
    out[job.key] = { error: String(e) };
  }
}
fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`analysed ${jobs.length} files → ${outPath}`);
