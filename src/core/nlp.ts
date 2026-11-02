// Chinese segmentation (jieba-wasm) aligned with the curriculum vocabulary.
import type { Token } from '../shared/types';

type Jieba = { cut: (s: string, hmm: boolean) => string[]; add_word: (w: string, freq?: number, tag?: string) => number };
let jieba: Jieba | null = null;

export function initNlp(words: string[]): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  jieba = require('jieba-wasm') as Jieba;
  for (const w of words) if (w.length > 1) jieba.add_word(w, 2000);
}

export const isHan = (s: string) => /\p{Script=Han}/u.test(s);

/** Segment a line into tokens. Unknown multi-char tokens not in `dict` are split into dictionary words/chars. */
export function segment(text: string, dict?: (w: string) => boolean): Token[] {
  if (!jieba) throw new Error('nlp not initialised');
  const raw = jieba.cut(text, true);
  const out: Token[] = [];
  for (const t of raw) {
    if (!t.trim()) {
      if (t) out.push({ t, han: false });
      continue;
    }
    if (isHan(t) && dict && t.length > 1 && !dict(t)) {
      // greedy longest-match split on the dictionary
      let i = 0;
      while (i < t.length) {
        let j = Math.min(t.length, i + 4);
        while (j > i + 1 && !dict(t.slice(i, j))) j--;
        out.push({ t: t.slice(i, j), han: true });
        i = j;
      }
    } else out.push({ t, han: isHan(t) });
  }
  return out;
}

/** Normalise a Chinese answer for comparison (strip punctuation and spaces). */
export function normZh(s: string): string {
  return s.replace(/[\s。，、？！；：“”‘’「」『』（）《》…—．,.?!;:"'()\-]/g, '');
}
