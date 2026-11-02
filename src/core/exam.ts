// Pure logic for the weekly debriefing test and the end-of-phase mock exam (no Electron, no DB).
import type { GrammarExercise, Word } from '../shared/types';
import { shuffleWith, type Rng } from './grammar';

export type Skill = 'listening' | 'reading' | 'grammar';
export type QuestionKind = 'word-listen' | 'word-read' | 'sentence-listen' | 'grammar';
export type TestKind = 'weekly' | 'mock';

export const SKILL_LABEL: Record<Skill, string> = { listening: 'Écoute', reading: 'Lecture', grammar: 'Grammaire' };
export const KIND_SKILL: Record<QuestionKind, Skill> = {
  'word-listen': 'listening',
  'sentence-listen': 'listening',
  'word-read': 'reading',
  grammar: 'grammar',
};

export interface TestQuestion {
  id: string;
  kind: QuestionKind;
  skill: Skill;
  prompt: string; // consigne en français
  zh?: string; // texte chinois (non affiché avant la réponse pour l'écoute)
  options?: string[];
  answer?: number;
  fr?: string; // bonne réponse en français (pour la correction)
  ex?: GrammarExercise; // question de grammaire
  word?: string;
  grammarId?: string;
  grammarTitle?: string;
  sentenceId?: number;
}

export interface TestPaper {
  kind: TestKind;
  week: number;
  questions: TestQuestion[];
  notes: string[];
}

export interface TestItemResult {
  id: string;
  kind: QuestionKind;
  skill: Skill;
  correct: boolean;
  zh?: string;
  fr?: string;
  chosen?: string | null;
  word?: string;
  grammarId?: string;
  grammarTitle?: string;
}

export interface SkillScore {
  n: number;
  ok: number;
  score: number;
}

export interface TestDetails {
  items: TestItemResult[];
  bySkill: Partial<Record<Skill, SkillScore>>;
  durationMs?: number;
}

export interface TestRow {
  id: number;
  kind: TestKind;
  week: number;
  score: number;
  ts: number;
  date: string;
  passed: boolean;
  bySkill: Partial<Record<Skill, SkillScore>>;
  errors: number;
}

/** A short, readable French meaning for a multiple-choice option. */
export function shortGloss(fr: string[]): string {
  const clean = fr.map((f) => f.trim()).filter(Boolean);
  if (!clean.length) return '';
  // Prefer a gloss that is not a pure grammatical note in parentheses.
  let g = clean.find((f) => !f.startsWith('(')) ?? clean[0];
  if (g.length > 45) g = g.replace(/\s*\([^)]*\)\s*/g, ' ').trim() || g;
  if (g.length > 50) g = g.slice(0, 47).trimEnd() + '…';
  // Two short glosses read better than one ("maison ; famille").
  const second = clean.find((f) => f !== g && !f.startsWith('(') && f.length <= 20);
  if (second && g.length + second.length <= 34) g = `${g} ; ${second}`;
  return g;
}

const NON_LEXICAL_POS = new Set(['u', 'y', 'e', 'o', 'k', 'h']);

/** Can this word be asked as « meaning » (content word with a French gloss)? */
export function isQuizzable(w: Word): boolean {
  if (!w.fr.length || !shortGloss(w.fr)) return false;
  if (w.pos.length && w.pos.every((p) => NON_LEXICAL_POS.has(p))) return false;
  return true;
}

function glossKeys(w: Word): Set<string> {
  return new Set([shortGloss(w.fr), ...w.fr].map((f) => f.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').trim()).filter(Boolean));
}

/**
 * Distractor words for a meaning question: same category (part of speech) and length first, close level,
 * never a word with an overlapping French gloss; for listening, never a homophone (same pinyin and tones).
 */
export function pickWordDistractors(target: Word, pool: Word[], n = 3, opts: { rng?: Rng; listening?: boolean } = {}): Word[] {
  const rng = opts.rng ?? Math.random;
  const tKeys = glossKeys(target);
  const tPos = target.pos[0];
  const tPn = target.pn.toLowerCase();
  const scored: { w: Word; s: number }[] = [];
  const seen = new Set<string>([target.w]);
  for (const w of shuffleWith(pool, rng)) {
    if (seen.has(w.w) || !isQuizzable(w)) continue;
    if (opts.listening && w.pn.toLowerCase() === tPn) continue;
    const keys = glossKeys(w);
    if ([...keys].some((k) => tKeys.has(k))) continue;
    seen.add(w.w);
    let s = 0;
    if (tPos && w.pos.includes(tPos)) s += 3;
    if (w.w.length === target.w.length) s += 2;
    if (Math.abs(w.rank - target.rank) < 400) s += 1;
    scored.push({ w, s });
  }
  scored.sort((a, b) => b.s - a.s);
  const out: Word[] = [];
  const glosses = new Set<string>([shortGloss(target.fr)]);
  for (const { w } of scored) {
    if (out.length >= n) break;
    const g = shortGloss(w.fr);
    if (glosses.has(g)) continue;
    glosses.add(g);
    out.push(w);
  }
  return out;
}

/** Distractor translations for a sentence: other translations of similar length, all distinct. */
export function pickSentenceDistractors(targetFr: string, pool: string[], n = 3, rng: Rng = Math.random): string[] {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const t = norm(targetFr);
  const len = targetFr.length;
  const cands = shuffleWith(
    pool.filter((p) => p && norm(p) !== t),
    rng,
  ).sort((a, b) => Math.abs(a.length - len) - Math.abs(b.length - len));
  const out: string[] = [];
  const seen = new Set<string>([t]);
  for (const c of cands.slice(0, Math.max(12, n * 4))) {
    if (out.length >= n) break;
    if (seen.has(norm(c))) continue;
    seen.add(norm(c));
    out.push(c);
  }
  return shuffleWith(out, rng);
}

/** Shuffle the correct option among distractors. */
export function makeMcq(correct: string, distractors: string[], rng: Rng = Math.random): { options: string[]; answer: number } {
  const options = shuffleWith([correct, ...distractors.filter((d) => d !== correct)], rng);
  return { options, answer: options.indexOf(correct) };
}

/** How many questions of each kind, given what is available. */
export function composition(
  kind: TestKind,
  avail: { words: number; sentences: number; grammar: number },
): { wordListen: number; wordRead: number; sentences: number; grammar: number } {
  const total = kind === 'weekly' ? 25 : 40;
  const grammar = Math.min(kind === 'weekly' ? 6 : 10, avail.grammar);
  const sentences = Math.min(kind === 'weekly' ? 5 : 10, avail.sentences);
  const rest = total - grammar - sentences;
  const wordListen = Math.min(Math.ceil(rest / 2), avail.words);
  const wordRead = Math.min(rest - Math.ceil(rest / 2), avail.words);
  return { wordListen, wordRead, sentences, grammar };
}

export function scoreItems(items: { skill: Skill; correct: boolean }[]): { score: number; bySkill: Partial<Record<Skill, SkillScore>> } {
  const bySkill: Partial<Record<Skill, SkillScore>> = {};
  for (const it of items) {
    const s = (bySkill[it.skill] ??= { n: 0, ok: 0, score: 0 });
    s.n++;
    if (it.correct) s.ok++;
  }
  for (const s of Object.values(bySkill)) if (s) s.score = s.n ? s.ok / s.n : 0;
  const ok = items.filter((i) => i.correct).length;
  return { score: items.length ? ok / items.length : 0, bySkill };
}

/** Recommendation (French) for one skill after a test. */
export function skillAdvice(skill: Skill, score: number): string {
  if (skill === 'listening') {
    if (score >= 0.85) return 'Écoute solide : continue les missions vidéo et le shadowing.';
    if (score >= 0.7) return 'Écoute correcte mais fragile : ajoute 10 min par jour de réécoute de contenus déjà travaillés et fais tes cartes « audio → sens » sans regarder les caractères.';
    return 'Écoute à renforcer en priorité : ralentis les nouveaux mots, réécoute chaque mot raté plusieurs fois, et fais du shadowing quotidien sur des phrases connues.';
  }
  if (skill === 'reading') {
    if (score >= 0.85) return 'Lecture solide : passe à des textes gradués un peu plus longs.';
    if (score >= 0.7) return 'Lecture correcte : revois les mots ratés et lis une courte histoire graduée par jour.';
    return 'Lecture à renforcer : les caractères ne sont pas encore fixés. Fais tes révisions « caractère → sens » chaque jour et une séance d\'écriture sur papier de plus cette semaine.';
  }
  if (score >= 0.85) return 'Grammaire solide : tu peux aborder les points suivants.';
  if (score >= 0.7) return 'Grammaire correcte : relis la règle des points ratés et fais leurs révisions dès qu\'elles sont dues.';
  return 'Grammaire à reprendre : refais les leçons des points ratés (80 % requis) avant d\'en commencer de nouveaux.';
}
