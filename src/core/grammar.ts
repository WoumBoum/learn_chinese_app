// Pure grammar logic (no Electron, no DB): FSRS grading of a review, exercise selection, tile distractors, lesson summary.
// Imported by the main process (ipc/grammar.ts, ipc/tests.ts) and by the renderer (GrammarExercise, Grammar screen).
import type { GrammarExercise, GrammarPoint, Grade } from '../shared/types';

/** Same normalisation as nlp.normZh (strip punctuation and spaces). Duplicated on purpose: importing core/nlp
 *  from the renderer would pull jieba-wasm (4 MB) into the renderer bundle. Kept in sync by tests/grammar.test.ts. */
export function normZh(s: string): string {
  return s.replace(/[\s。，、？！；：“”‘’「」『』（）《》…—．,.?!;:"'()\-]/g, '');
}

export type Rng = () => number;

/** Average time per exercise under which a perfect review counts as « Facile ». */
export const FAST_MS_PER_EXERCISE = 20_000;
/** Score required on the lesson exercises to unlock the next point. */
export const GRAMMAR_PASS = 0.8;
/** Below this, the lesson is not validated (no FSRS card) and should be redone. */
export const GRAMMAR_MIN = 0.6;

/** Grammatical words used as plausible distractor tiles. */
export const FUNCTION_WORDS = ['不', '没', '了', '的', '吗', '很', '在', '是', '有', '也', '都', '过', '着', '和', '就', '才', '还', '得', '地', '把', '被', '给', '要', '会', '能', '呢', '吧', '个', '比', '让', '从', '对'];

/**
 * Convert the results of a grammar review (one boolean per exercise) into an FSRS grade.
 * - ≥ 2 errors, or more than 40 % wrong → 1 (Again)
 * - exactly 1 error → 2 (Hard)
 * - all correct → 3 (Good), or 4 (Easy) if at least 4 exercises and fast on average
 */
export function reviewGrade(results: boolean[], durationMs = 0): Grade {
  const n = results.length;
  if (n === 0) return 1;
  const wrong = results.filter((r) => !r).length;
  if (wrong >= 2 || wrong / n > 0.4) return 1;
  if (wrong === 1) return 2;
  if (n >= 4 && durationMs > 0 && durationMs / n <= FAST_MS_PER_EXERCISE) return 4;
  return 3;
}

/** French label of an FSRS grade. */
export function gradeLabel(g: Grade): string {
  return g === 1 ? 'À revoir' : g === 2 ? 'Difficile' : g === 3 ? 'Bien' : 'Facile';
}

export function shuffleWith<T>(arr: T[], rng: Rng = Math.random): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Pick `n` exercise indices from a pool, least recently seen first (never seen = first), with type variety.
 * `lastSeen` maps exercise index → timestamp of its last presentation.
 * `types` optionally restricts the allowed exercise types.
 */
export function selectExercises(
  exercises: GrammarExercise[],
  lastSeen: Map<number, number>,
  n: number,
  opts: { rng?: Rng; types?: GrammarExercise['type'][] } = {},
): number[] {
  const rng = opts.rng ?? Math.random;
  let idx = exercises.map((_, i) => i);
  if (opts.types) idx = idx.filter((i) => opts.types!.includes(exercises[i].type));
  if (n <= 0 || idx.length === 0) return [];
  if (n >= idx.length) return shuffleWith(idx, rng);
  // Least recently seen first; random among ties (e.g. never seen, or seen in the same batch).
  const ordered = shuffleWith(idx, rng).sort((a, b) => (lastSeen.get(a) ?? -1) - (lastSeen.get(b) ?? -1));
  // Candidate window: the freshest items, a bit wider than n so that types can be mixed.
  const window = ordered.slice(0, Math.min(ordered.length, Math.max(n + 3, Math.ceil(n * 1.5))));
  const chosen: number[] = [];
  const typeCount = new Map<string, number>();
  while (chosen.length < n) {
    let best = -1;
    let bestScore = Infinity;
    for (let k = 0; k < window.length; k++) {
      const i = window[k];
      if (chosen.includes(i)) continue;
      // Prefer under-represented types, then earlier (less recently seen) positions.
      const score = (typeCount.get(exercises[i].type) ?? 0) * 100 + k;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) break;
    chosen.push(best);
    typeCount.set(exercises[best].type, (typeCount.get(exercises[best].type) ?? 0) + 1);
  }
  return chosen;
}

const LESSON_TYPE_RANK: Record<GrammarExercise['type'], number> = { choice: 0, cloze: 1, listen: 2, order: 3, transform: 4, error: 5, translate: 6 };

/** Lesson order: recognition first (choice, cloze, listen), then construction (order), then production. */
export function lessonOrder(exercises: GrammarExercise[]): GrammarExercise[] {
  return exercises.map((e, i) => ({ e, i })).sort((a, b) => LESSON_TYPE_RANK[a.e.type] - LESSON_TYPE_RANK[b.e.type] || a.i - b.i).map((x) => x.e);
}

/** Expected answers of an exercise in Chinese (for tile-based or typed answers). Empty for option-based types. */
export function expectedAnswers(ex: GrammarExercise): string[] {
  switch (ex.type) {
    case 'order': {
      const extra = (ex as { answers?: string[] }).answers ?? [];
      return [ex.answer, ...extra];
    }
    case 'transform':
    case 'error':
    case 'translate':
      return ex.answers;
    case 'cloze':
      return [ex.zh.replace('___', ex.answer)];
    default:
      return [];
  }
}

/** Is a Chinese answer (built from tiles or typed) one of the accepted answers? */
export function matchesAnswer(user: string, answers: string[]): boolean {
  const u = normZh(user);
  if (!u) return false;
  return answers.some((a) => normZh(a) === u);
}

/** Chinese words that appear in a grammar point (order tokens, cloze options, …) — extra tile candidates. */
export function pointVocabulary(p: GrammarPoint): string[] {
  const out = new Set<string>();
  for (const ex of p.exercises) {
    if (ex.type === 'order') ex.tokens.forEach((t) => out.add(t));
    if (ex.type === 'cloze') ex.options.forEach((t) => out.add(t));
  }
  return [...out].filter((t) => normZh(t) && /\p{Script=Han}/u.test(t) && t.length <= 3);
}

/**
 * Choose 2-3 plausible distractor tiles for a production exercise.
 * Priority: words of the source / wrong sentence that are not in the answer (e.g. 不 in 我不有书),
 * grammatical words of the point, other words of the point, then generic grammatical words.
 */
export function pickDistractors(opts: {
  answerTokens: string[];
  sourceTokens?: string[];
  pool?: string[];
  n?: number;
  rng?: Rng;
}): string[] {
  const rng = opts.rng ?? Math.random;
  const n = opts.n ?? 3;
  const answer = new Set(opts.answerTokens.map(normZh));
  const answerText = opts.answerTokens.join('');
  const out: string[] = [];
  const ok = (t: string) => {
    const k = normZh(t);
    return !!k && /\p{Script=Han}/u.test(k) && !answer.has(k) && !out.includes(k);
  };
  const take = (cands: string[], max: number) => {
    for (const c of shuffleWith(cands, rng)) {
      if (out.length >= n || max <= 0) break;
      if (ok(c)) {
        out.push(normZh(c));
        max--;
      }
    }
  };
  const pool = opts.pool ?? [];
  take(opts.sourceTokens ?? [], 2);
  // grammatical words that the point itself uses (most plausible confusions), but not ones present in the answer
  take(
    pool.filter((t) => FUNCTION_WORDS.includes(t) && !answerText.includes(t)),
    2,
  );
  take(
    pool.filter((t) => !answerText.includes(t)),
    n,
  );
  take(FUNCTION_WORDS.filter((t) => !answerText.includes(t)), n);
  return out.slice(0, n);
}

/** Tiles for a sentence built from tokens: shuffled, never in the solved order when avoidable. */
export function shuffleTiles(tokens: string[], rng: Rng = Math.random): string[] {
  if (tokens.length < 2) return [...tokens];
  const solved = tokens.join('|');
  for (let k = 0; k < 8; k++) {
    const s = shuffleWith(tokens, rng);
    if (s.join('|') !== solved) return s;
  }
  return [...tokens].reverse();
}

/** « À retenir » : sentences of the explanation that carry bold key points (markdown kept), max `max`.
 *  Skips sub-headings (« **Où exactement ?** », « **Négation :** »), list introductions (« … : ») and arrows (« → … »). */
export function keyPoints(explanation: string, max = 5): string[] {
  const out: string[] = [];
  for (const para of explanation.replace(/\r/g, '').split(/\n+/)) {
    const line = para.replace(/^\s*[-*•]\s+/, '').trim();
    if (!line.includes('**')) continue;
    // Sentence boundary: end punctuation (optionally closing a bold span), then a space, then a capital, a bold span or a Chinese character.
    const sentences = line.split(/(?<=[.!?。！？](?:\*\*)?)\s+(?=[A-ZÀ-Ý«*\p{Script=Han}])/u);
    let acc = '';
    for (const s of sentences) {
      acc += (acc ? ' ' : '') + s;
      if ((acc.match(/\*\*/g) ?? []).length % 2 === 1) continue; // bold spans across sentences
      const t = acc.trim();
      acc = '';
      if (!t.includes('**') || t.length < 8) continue;
      if (t.startsWith('→')) continue;
      const plain = t.replace(/\*\*/g, '').trim();
      if (/[:：]$/.test(plain)) continue; // introduces a list or an example
      const isHeading = /^\*\*[^*]+\*\*$/.test(t) && (/[?？]$/.test(plain) || plain.length < 28);
      if (isHeading) continue;
      out.push(t.length > 220 ? t.slice(0, 217) + '…' : t);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** Tokens to build tiles from: segmentation output without punctuation/spaces. */
export function cleanTokens(tokens: string[]): string[] {
  return tokens.map((t) => normZh(t)).filter(Boolean);
}
