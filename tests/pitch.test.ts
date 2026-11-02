import { describe, it, expect } from 'vitest';
import {
  pitchTrack,
  toSemitones,
  speakerMedian,
  contour,
  similarity,
  compareContours,
  dtw,
  guessTone,
  voicedSegments,
  resample,
  smoothF0,
  fixOctaves,
  removeShortIslands,
  fixJumps,
  compareTracks,
  type PitchPoint,
} from '../src/renderer/components/pitch';
import {
  parseTones,
  applySandhi,
  tonesFromEspeak,
  splitSyllable,
  sampleTemplate,
  chaoTemplate,
  decodeWav,
  encodeWav,
  fixTones,
} from '../src/main/services/tonefix';

const SR = 22050;

/** Signal « voisé » synthétique : somme d'harmoniques décroissantes, F0 donnée par f(t) (t ∈ [0,1] normalisé). */
function voice(f: (u: number) => number, dur = 0.5, sr = SR, opts: { pad?: number; noise?: number } = {}): Float32Array {
  const pad = Math.round((opts.pad ?? 0.1) * sr);
  const n = Math.round(dur * sr);
  const x = new Float32Array(n + 2 * pad);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const u = i / n;
    phase += (2 * Math.PI * f(u)) / sr;
    let s = 0;
    for (let h = 1; h <= 8; h++) s += Math.sin(h * phase) / h;
    const env = Math.min(1, i / (0.02 * sr), (n - i) / (0.02 * sr));
    x[pad + i] = 0.3 * s * env + (opts.noise ?? 0) * (Math.random() * 2 - 1);
  }
  return x;
}

const voicedF0 = (tr: PitchPoint[]) => tr.map((p) => p.f0).filter((v): v is number => v != null);
const st = (a: number, b: number) => 12 * Math.log2(b / a);

// Contours des 4 tons (Hz) pour une voix « masculine » (~120 Hz) et « féminine » (~230 Hz)
const tone = (t: 1 | 2 | 3 | 4, base: number) => (u: number) => {
  const k = (s: number) => base * Math.pow(2, s / 12);
  switch (t) {
    case 1:
      return k(4);
    case 2:
      return k(-1 + 6 * u * u);
    case 3:
      return k(u < 0.55 ? -2 - 5 * (u / 0.55) : -7 + 9 * ((u - 0.55) / 0.45));
    case 4:
      return k(5 - 10 * u);
  }
};

describe('pitchTrack (YIN)', () => {
  it('mesure une fréquence constante à moins de 1 %', () => {
    for (const f of [90, 150, 220, 330]) {
      const tr = pitchTrack(voice(() => f), SR);
      const m = speakerMedian(tr)!;
      expect(Math.abs(m - f) / f).toBeLessThan(0.01);
    }
  });

  it('pas d’erreur d’octave sur un son riche en harmoniques', () => {
    const tr = pitchTrack(voice(() => 140), SR);
    const v = voicedF0(tr);
    expect(v.every((f) => Math.abs(f - 140) < 6)).toBe(true);
  });

  it('hop de 10 ms et zones non voisées sur le silence', () => {
    const tr = pitchTrack(voice(() => 200, 0.5, SR, { pad: 0.3 }), SR);
    expect(tr[1].t - tr[0].t).toBeCloseTo(0.01, 5);
    expect(tr.slice(0, 20).every((p) => p.f0 == null)).toBe(true);
    expect(tr.slice(-20).every((p) => p.f0 == null)).toBe(true);
    const segs = voicedSegments(tr);
    expect(segs.length).toBe(1);
    const [a, b] = segs[0];
    expect((b - a) * 0.01).toBeGreaterThan(0.4);
    expect((b - a) * 0.01).toBeLessThan(0.56);
  });

  it('le bruit blanc est classé non voisé', () => {
    const x = new Float32Array(SR / 2).map(() => (Math.random() * 2 - 1) * 0.3);
    const tr = pitchTrack(x, SR);
    expect(voicedF0(tr).length / tr.length).toBeLessThan(0.15);
  });

  it('suit un glissando montant et descendant', () => {
    const up = voicedF0(pitchTrack(voice((u) => 150 + 150 * u), SR));
    const down = voicedF0(pitchTrack(voice((u) => 300 - 150 * u), SR));
    expect(up[up.length - 1]).toBeGreaterThan(up[0] * 1.7);
    expect(down[0]).toBeGreaterThan(down[down.length - 1] * 1.7);
    // monotonie (à quelques trames près)
    let inv = 0;
    for (let i = 1; i < up.length; i++) if (up[i] < up[i - 1] - 1) inv++;
    expect(inv).toBeLessThan(3);
  });

  it('fonctionne à 48 kHz (micro) grâce au rééchantillonnage interne', () => {
    const tr = pitchTrack(voice(() => 180, 0.4, 48000), 48000);
    expect(Math.abs(speakerMedian(tr)! - 180)).toBeLessThan(2);
    expect(resample(new Float32Array(48000), 48000, 16000).length).toBe(16000);
  });

  it('résiste à un bruit modéré', () => {
    const tr = pitchTrack(voice(() => 200, 0.5, SR, { noise: 0.03 }), SR);
    expect(Math.abs(speakerMedian(tr)! - 200)).toBeLessThan(4);
  });
});

describe('post-traitement', () => {
  it('lissage médian, octaves, îlots', () => {
    expect(smoothF0([100, 100, 300, 100, 100], 5)[2]).toBe(100);
    expect(fixOctaves([200, 200, 400, 200, 100, 200])).toEqual([200, 200, 200, 200, 200, 200]);
    expect(removeShortIslands([null, 1, 1, null, 1, 1, 1, 1, null], 3)).toEqual([null, null, null, null, 1, 1, 1, 1, null]);
  });

  it('continuité : sauts d’octave corrigés, sauts impossibles supprimés', () => {
    expect(fixJumps([200, 202, 101, 204, 206])).toEqual([200, 202, 202, 204, 206]);
    expect(fixJumps([172, 174, 330, 332, 330, 328, 326])).toEqual([344, 348, 330, 332, 330, 328, 326]);
    expect(fixJumps([200, 201, 300, 202, 203])[2]).toBeNull();
  });

  it('demi-tons relatifs à la médiane du locuteur', () => {
    const tr: PitchPoint[] = [100, 200, 400].map((f, i) => ({ t: i * 0.01, f0: f }));
    expect(toSemitones(tr).map((p) => Math.round(p.st!))).toEqual([-12, 0, 12]);
  });
});

describe('tons simulés', () => {
  for (const base of [120, 230]) {
    it(`reconnaît les 4 tons (voix à ${base} Hz)`, () => {
      for (const t of [1, 2, 3, 4] as const) {
        const c = contour(pitchTrack(voice(tone(t, base), 0.45), SR));
        expect(guessTone(c), `ton ${t}`).toBe(t);
      }
    });
  }

  it('contours attendus : 2 monte, 4 descend, 3 a un creux au milieu', () => {
    const c2 = contour(pitchTrack(voice(tone(2, 200)), SR));
    const c4 = contour(pitchTrack(voice(tone(4, 200)), SR));
    const c3 = contour(pitchTrack(voice(tone(3, 200)), SR));
    expect(c2[c2.length - 1] - c2[0]).toBeGreaterThan(4);
    expect(c4[0] - c4[c4.length - 1]).toBeGreaterThan(7);
    const minI = c3.indexOf(Math.min(...c3));
    expect(minI / c3.length).toBeGreaterThan(0.3);
    expect(minI / c3.length).toBeLessThan(0.75);
  });
});

describe('similarité', () => {
  it('même ton, voix et durées différentes → score élevé', () => {
    const a = pitchTrack(voice(tone(4, 230), 0.4), SR);
    const b = pitchTrack(voice(tone(4, 115), 0.7), SR);
    expect(similarity(a, b)).toBeGreaterThan(85);
  });

  it('ton montant vs ton descendant → score faible', () => {
    const a = pitchTrack(voice(tone(2, 200)), SR);
    const b = pitchTrack(voice(tone(4, 200)), SR);
    expect(similarity(a, b)).toBeLessThan(30);
  });

  it('ordre des scores : identique > proche > opposé', () => {
    const ref = pitchTrack(voice(tone(3, 200)), SR);
    const same = pitchTrack(voice(tone(3, 180), 0.6), SR);
    const close = pitchTrack(voice(tone(2, 200)), SR);
    const far = pitchTrack(voice(tone(4, 200)), SR);
    const s = [similarity(ref, same), similarity(ref, close), similarity(ref, far)];
    expect(s[0]).toBeGreaterThan(s[1]);
    expect(s[1]).toBeGreaterThan(s[2]);
  });

  it('paire de tons (2 syllabes séparées par une consonne sourde)', () => {
    const word = (t1: 1 | 2 | 3 | 4, t2: 1 | 2 | 3 | 4, base: number) => {
      const s1 = voice(tone(t1, base), 0.25, SR, { pad: 0.05 });
      const s2 = voice(tone(t2, base), 0.3, SR, { pad: 0.05 });
      const x = new Float32Array(s1.length + s2.length);
      x.set(s1);
      x.set(s2, s1.length);
      return pitchTrack(x, SR);
    };
    const ref = word(4, 1, 230);
    expect(voicedSegments(ref).length).toBe(2);
    expect(similarity(ref, word(4, 1, 120))).toBeGreaterThan(80);
    expect(similarity(ref, word(1, 4, 230))).toBeLessThan(40);
  });

  it('débit différent syllabe par syllabe : alignement par segments voisés', () => {
    const word = (d1: number, d2: number, base: number) => {
      const s1 = voice(tone(2, base), d1, SR, { pad: 0.05 });
      const s2 = voice(tone(4, base), d2, SR, { pad: 0.05 });
      const x = new Float32Array(s1.length + s2.length);
      x.set(s1);
      x.set(s2, s1.length);
      return pitchTrack(x, SR);
    };
    const r = compareTracks(word(0.15, 0.45, 220), word(0.45, 0.15, 130));
    expect(r.method).toBe('segments');
    expect(r.score).toBeGreaterThan(85);
  });

  it('DTW : séquences identiques décalées dans le temps → coût faible', () => {
    const a = Array.from({ length: 50 }, (_, i) => Math.sin(i / 8));
    const b = Array.from({ length: 50 }, (_, i) => Math.sin((i - 3) / 8));
    expect(dtw(a, b, 0.2)).toBeLessThan(0.08);
    expect(compareContours(a, a).score).toBe(100);
    expect(compareContours([], a).score).toBe(0);
  });
});

describe('tons du mandarin (tonefix)', () => {
  it('parse le pinyin numérique', () => {
    expect(parseTones('ni3 hao3')).toEqual([3, 3]);
    expect(parseTones('ma5')).toEqual([5]);
    expect(parseTones('abc')).toBeNull();
  });

  it('sandhi : 3-3, 不, 一', () => {
    expect(applySandhi([...'你好'], [3, 3])).toEqual([2, 3]);
    expect(applySandhi([...'不是'], [4, 4])).toEqual([2, 4]);
    expect(applySandhi([...'不好'], [4, 3])).toEqual([4, 3]);
    expect(applySandhi([...'一起'], [1, 3])).toEqual([4, 3]);
    expect(applySandhi([...'一样'], [1, 4])).toEqual([2, 4]);
    expect(applySandhi([...'一个'], [1, 5])).toEqual([2, 5]);
    expect(applySandhi([...'第一'], [4, 1])).toEqual([4, 1]);
  });

  it('lit les tons dans la sortie espeak-ng', () => {
    expect(tonesFromEspeak("ni35X'Au214_|")).toEqual([2, 3]);
    expect(tonesFromEspeak("mA55mA22_|")).toEqual([1, 5]);
    expect(tonesFromEspeak("pu35s.'i.51_|")).toEqual([2, 4]);
    expect(tonesFromEspeak("w'o21_| m@44n_|")).toEqual([3, 5]);
  });

  it('découpe les syllabes (initiale / finale / ton)', () => {
    expect(splitSyllable('zhong1')).toEqual({ initial: 'zh', final: 'ong', tone: 1 });
    expect(splitSyllable('qu4')).toEqual({ initial: 'q', final: 'ü', tone: 4 });
    expect(splitSyllable('lu:4')).toEqual({ initial: 'l', final: 'ü', tone: 4 });
    expect(splitSyllable('ai4')).toEqual({ initial: '', final: 'ai', tone: 4 });
  });

  it('gabarits de Chao', () => {
    const t4 = sampleTemplate(chaoTemplate(4, true), 11);
    expect(t4[0]).toBe(5);
    expect(t4[10]).toBeCloseTo(1.2);
    const t3 = sampleTemplate(chaoTemplate(3, true), 21);
    expect(Math.min(...t3)).toBeCloseTo(1, 0);
    expect(t3[20]).toBe(4);
  });

  it('WAV : aller-retour', () => {
    const x = voice(() => 200, 0.1);
    const y = decodeWav(encodeWav(x, SR));
    expect(y.sampleRate).toBe(SR);
    expect(y.samples.length).toBe(x.length);
    expect(Math.abs(y.samples[500] - x[500])).toBeLessThan(1e-4);
  });

  it('corrige un 4e ton « plat » par PSOLA (chute ≥ 6 demi-tons, durée conservée)', () => {
    const flat = voice(() => 280, 0.3);
    const r = fixTones(flat, SR, [4]);
    expect(r.changed).toBe(true);
    expect(r.syllables[0].fixed).toBe(true);
    expect(r.samples.length).toBe(flat.length);
    const v = voicedF0(pitchTrack(r.samples, SR));
    const q = Math.floor(v.length / 5);
    const m = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
    expect(st(m(v.slice(-q)), m(v.slice(0, q)))).toBeGreaterThan(6);
    // une fois corrigé, plus rien à corriger
    expect(fixTones(r.samples, SR, [4]).changed).toBe(false);
  });

  it('laisse intact un ton déjà correct', () => {
    const ok = voice(tone(2, 228), 0.3);
    const r = fixTones(ok, SR, [2]);
    expect(r.changed).toBe(false);
    expect(r.samples).toBe(ok);
  });
});

// ---------- intégration : vrai binaire Piper (ignoré s'il n'est pas installé) ----------
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PiperTts } from '../src/main/services/tts';

const BIN = path.resolve(__dirname, '../resources/bin');
const hasPiper = fs.existsSync(path.join(BIN, 'piper/piper')) && fs.existsSync(path.join(BIN, 'piper/voices/zh_CN-huayan-medium.onnx'));

describe.skipIf(!hasPiper)('PiperTts (intégration)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'om-tts-'));
  const tts = new PiperTts(BIN, path.join(tmp, 'tts'), tmp);
  const fallOf = (p: string) => {
    const { samples, sampleRate } = decodeWav(fs.readFileSync(p));
    const v = voicedF0(pitchTrack(samples, sampleRate));
    const q = Math.max(1, Math.floor(v.length / 5));
    const m = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
    return st(m(v.slice(-q)), m(v.slice(0, q)));
  };

  it('statut et tons espeak (sandhi inclus)', async () => {
    expect(tts.status().ok).toBe(true);
    expect(await tts.tones('你好')).toEqual([2, 3]);
    expect(await tts.tones('看')).toEqual([4]);
  });

  it('synthétise une phrase, met en cache (même chemin, pas de régénération)', async () => {
    const a = await tts.speak('你好，我是学生。');
    expect(a).not.toBeNull();
    const st1 = fs.statSync(a!.path);
    expect(st1.size).toBeGreaterThan(20000);
    const b = await tts.speak('你好，我是学生。');
    expect(b!.path).toBe(a!.path);
    expect(fs.statSync(b!.path).mtimeMs).toBe(st1.mtimeMs);
    const slow = await tts.speak('你好，我是学生。', { slow: true });
    expect(fs.statSync(slow!.path).size).toBeGreaterThan(st1.size * 1.2);
  }, 30000);

  it('caractère isolé au 4e ton : la hauteur descend nettement (correction active)', async () => {
    for (const c of ['是', '骂', '四']) {
      const fixed = await tts.speak(c);
      expect(fallOf(fixed!.path), c).toBeGreaterThan(5);
    }
  }, 30000);

  it('file d’attente : 12 demandes simultanées aboutissent', async () => {
    const words = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '谢谢', '再见'];
    const r = await Promise.all(words.map((w) => tts.speak(w)));
    expect(r.every((x) => x && fs.existsSync(x.path))).toBe(true);
  }, 60000);
});
