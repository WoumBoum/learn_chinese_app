// Régression : artefacts de la piste F0 sur des enregistrements natifs (voix humaine) —
// bord doublé à l'octave (attaque soufflée / craquée dont le fondamental est faible), îlot court
// parasite après la fin de la voix (harmonique d'une voix craquée, souffle), sans pour autant
// supprimer un vrai saut de registre (chute d'un 4e ton coupée par une trame douteuse).
import { describe, it, expect } from 'vitest';
import { pitchTrack, voicedSegments, hysteresisVoicing, trimWeakEdges, pruneRegions, bridgeGaps, contour, guessTone, type PitchPoint } from '../src/renderer/components/pitch';

const SR = 24000; // comme les .opus natifs

interface Piece {
  dur: number; // s
  f0?: (u: number) => number; // absent = silence
  amp?: number;
  /** 'even' : harmoniques paires seulement → signal réellement périodique à 2×F0 (fondamental absent) */
  harmonics?: 'all' | 'even';
}

/** Concatène des segments à phase continue (somme d'harmoniques décroissantes, rampes de 5 ms). */
function synth(pieces: Piece[], sr = SR): Float32Array {
  const total = pieces.reduce((s, p) => s + Math.round(p.dur * sr), 0);
  const x = new Float32Array(total);
  let o = 0;
  let phase = 0;
  for (const p of pieces) {
    const n = Math.round(p.dur * sr);
    const ramp = Math.round(0.005 * sr);
    for (let i = 0; i < n && p.f0; i++) {
      phase += (2 * Math.PI * p.f0(i / n)) / sr;
      let s = 0;
      for (let h = 1; h <= 10; h++) if (p.harmonics !== 'even' || h % 2 === 0) s += Math.sin(h * phase) / h;
      const env = Math.min(1, i / ramp, (n - i) / ramp);
      x[o + i] = (p.amp ?? 0.3) * s * env;
    }
    o += n;
  }
  return x;
}

const voiced = (tr: PitchPoint[]) => tr.filter((p) => p.f0 != null) as { t: number; f0: number }[];
const st = (a: number, b: number) => 12 * Math.log2(a / b);

// « wǒ » simplifié : creux vers 140 Hz, fin remontante — précédé d'une attaque doublée à l'octave et
// suivi (après 40 ms de silence) d'un îlot faible de 40 ms, 6 demi-tons trop haut.
const main = (u: number) => 150 - 12 * Math.sin(Math.PI * Math.min(1, u * 1.25)) + (u > 0.8 ? 40 * (u - 0.8) : 0);
const wo3 = () =>
  synth([
    { dur: 0.1 },
    { dur: 0.07, f0: () => main(0), amp: 0.12, harmonics: 'even' }, // bord doublé (YIN y lit ~300 Hz)
    { dur: 0.4, f0: main, amp: 0.3 },
    { dur: 0.04 },
    { dur: 0.04, f0: () => main(1) * 1.42, amp: 0.025 }, // îlot parasite faible (≈ -22 dB)
    { dur: 0.1 },
  ]);

describe('artefacts de bord (voix native)', () => {
  it('bord doublé à l’octave : corrigé ou écarté, jamais affiché à l’octave', () => {
    const tr = pitchTrack(wo3(), SR);
    const v = voiced(tr);
    expect(v.length).toBeGreaterThan(30);
    // aucune trame ne s'écarte de plus de 4 demi-tons de la vraie courbe (≈ 138-158 Hz)
    for (const p of v) expect(Math.abs(st(p.f0, 148)), `t=${p.t.toFixed(2)} f0=${p.f0.toFixed(0)}`).toBeLessThan(4);
  });

  it('îlot court parasite après la voix : supprimé (une seule zone voisée)', () => {
    const tr = pitchTrack(wo3(), SR);
    const segs = voicedSegments(tr);
    expect(segs.length).toBe(1);
    const lastT = tr[segs[0][1] - 1].t;
    // la zone voisée s'arrête avec la voix principale (fin à 0,57 s, fenêtre de 40 ms)
    expect(lastT).toBeLessThan(0.6);
  });

  it('îlot isolé et faible : écarté, même sans saut de hauteur', () => {
    const x = synth([{ dur: 0.1 }, { dur: 0.35, f0: () => 200 }, { dur: 0.2 }, { dur: 0.04, f0: () => 200, amp: 0.02 }, { dur: 0.1 }]);
    expect(voicedSegments(pitchTrack(x, SR)).length).toBe(1);
  });

  it('vrai saut de registre conservé : chute d’un 4e ton coupée par 20 ms de silence', () => {
    const x = synth([
      { dur: 0.1 },
      { dur: 0.22, f0: (u) => 300 - 50 * u, amp: 0.3 },
      { dur: 0.02 },
      { dur: 0.12, f0: (u) => 215 - 25 * u, amp: 0.15 },
      { dur: 0.1 },
    ]);
    const tr = pitchTrack(x, SR);
    const v = voiced(tr);
    // la fin grave est toujours là (≈ 190-215 Hz) et le contour reste descendant
    expect(v.some((p) => p.f0 < 215)).toBe(true);
    expect(guessTone(contour(tr))).toBe(4);
  });

  it('le 3e ton simulé reste reconnu malgré les artefacts', () => {
    const tr = pitchTrack(
      synth([{ dur: 0.1 }, { dur: 0.06, f0: () => 220, amp: 0.1, harmonics: 'even' }, { dur: 0.45, f0: (u) => 200 * Math.pow(2, (u < 0.55 ? -7 * (u / 0.55) : -7 + 10 * ((u - 0.55) / 0.45)) / 12) }, { dur: 0.1 }]),
      SR,
    );
    expect(guessTone(contour(tr))).toBe(3);
  });
});

describe('post-traitement : étapes unitaires', () => {
  it('voisement à hystérésis : prolonge une zone sûre (à l’octave près), ignore une trame douteuse isolée', () => {
    const cand = [null, 210, 205, 200, 198, 99, null, 300, null];
    const ap = [1, 0.45, 0.3, 0.05, 0.04, 0.4, 1, 0.45, 1];
    const out = hysteresisVoicing(cand, ap, 0.25);
    expect(out).toEqual([null, 210, 205, 200, 198, 198, null, null, null]);
  });

  it('rognage des bords faibles (énergie, apériodicité)', () => {
    const f = [200, 200, 200, 200, 200, 200];
    const rms = [0.001, 0.5, 1, 1, 0.5, 0.01];
    const ap = [0.1, 0.1, 0.1, 0.1, 0.45, 0.1];
    expect(trimWeakEdges(f, rms, ap, -25, 0.4)).toEqual([null, 200, 200, 200, null, null]);
  });

  it('zones parasites : saut vers l’aigu d’une zone faible supprimé, chute franche conservée', () => {
    const N = null;
    // zone principale descendante, puis îlot faible 7 demi-tons plus haut (harmonique de voix craquée)
    const f = [300, 290, 280, 270, 260, 250, 240, 230, N, N, 345, 345, 340, 340];
    const rms = [1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0.08, 0.08, 0.08, 0.08];
    const ap = [0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 1, 1, 0.25, 0.25, 0.25, 0.25];
    expect(pruneRegions(f, rms, ap).slice(10)).toEqual([N, N, N, N]);
    // zones de 60 ms après la même zone principale
    const r6 = [...rms.slice(0, 10), ...new Array(6).fill(0.08)];
    const a6 = [...ap.slice(0, 10), ...new Array(6).fill(0.25)];
    // vers le grave (chute d'un 4e ton qui se poursuit) : conservée
    const g = [...f.slice(0, 10), 190, 185, 180, 175, 172, 170];
    expect(pruneRegions(g, r6, a6).slice(10)).toEqual([190, 185, 180, 175, 172, 170]);
    // zone faible à l'octave : transposée
    const h = [...f.slice(0, 10), 460, 460, 455, 455, 450, 450];
    expect(pruneRegions(h, r6, a6).slice(10)).toEqual([230, 230, 227.5, 227.5, 225, 225]);
  });

  it('comble les micro-coupures continues, pas les sauts', () => {
    expect(bridgeGaps([200, null, 210], 2, 4)[1]).toBeCloseTo(Math.sqrt(200 * 210), 6);
    expect(bridgeGaps([200, null, 300], 2, 4)[1]).toBeNull();
    expect(bridgeGaps([200, null, null, null, 205], 2, 4).slice(1, 4)).toEqual([null, null, null]);
  });
});
