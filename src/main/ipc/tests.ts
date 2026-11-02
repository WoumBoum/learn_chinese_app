// Exams: weekly debriefing (gate 85 %) and end-of-phase mock exam. Failed words go back into FSRS with « Again ».
import type { Ctx } from '../ctx';
import { handle } from '../ctx';
import type { GrammarExercise, Sentence, Word } from '../../shared/types';
import { WEEKLY_PASS } from '../../core/curriculum';
import { dayKey, weekday, DAY_MS } from '../../core/time';
import { shuffleWith } from '../../core/grammar';
import {
  composition,
  isQuizzable,
  makeMcq,
  pickSentenceDistractors,
  pickWordDistractors,
  scoreItems,
  shortGloss,
  type TestDetails,
  type TestItemResult,
  type TestKind,
  type TestPaper,
  type TestQuestion,
  type TestRow,
} from '../../core/exam';
import { wordInfo, sentencesWithin } from './study';
import { drawExercises, ensureGrammarTables } from './grammar';

const TEST_TYPES: GrammarExercise['type'][] = ['cloze', 'choice', 'order', 'listen'];

interface Pools {
  targets: Word[]; // quizzable introduced words, this week's first
  known: Word[]; // all quizzable introduced words (distractors)
  wide: Word[]; // curriculum words around the learner's level (fallback distractors)
}

function wordPools(ctx: Ctx, kind: TestKind, now: number): Pools {
  const rows = ctx.db.all<{ ref: string; ts: number }>("SELECT ref, ts FROM introduced WHERE kind='word'");
  const ignored = new Set(ctx.db.all<{ word: string }>("SELECT word FROM known_override WHERE status='ignored'").map((r) => r.word));
  const words = rows.filter((r) => !ignored.has(r.ref)).map((r) => ({ w: wordInfo(ctx, r.ref), ts: r.ts }));
  const quiz = words.filter((x) => isQuizzable(x.w));
  const weekAgo = now - 7 * DAY_MS;
  const recent = shuffleWith(quiz.filter((x) => x.ts >= weekAgo).map((x) => x.w));
  const older = shuffleWith(quiz.filter((x) => x.ts < weekAgo).map((x) => x.w));
  // Weekly: this week's words first. Mock: whole phase, mixed.
  const targets = kind === 'weekly' ? [...recent, ...older] : shuffleWith([...recent, ...older]);
  const maxRank = Math.max(0, ...words.map((x) => (x.w.rank < 99999 ? x.w.rank : 0)));
  const wide = ctx.content.words.slice(0, Math.max(300, maxRank + 300)).filter(isQuizzable);
  return { targets, known: quiz.map((x) => x.w), wide };
}

function distractors(target: Word, pools: Pools, listening: boolean): Word[] {
  let d = pickWordDistractors(target, pools.known, 3, { listening });
  if (d.length < 3) {
    const extra = pickWordDistractors(target, pools.wide, 6, { listening }).filter((w) => !d.some((x) => x.w === w.w || shortGloss(x.fr) === shortGloss(w.fr)));
    d = [...d, ...extra].slice(0, 3);
  }
  return d;
}

function wordQuestion(target: Word, pools: Pools, kind: 'word-listen' | 'word-read', id: string): TestQuestion | null {
  const d = distractors(target, pools, kind === 'word-listen');
  if (d.length < 2) return null;
  const fr = shortGloss(target.fr);
  const { options, answer } = makeMcq(
    fr,
    d.map((w) => shortGloss(w.fr)),
  );
  return {
    id,
    kind,
    skill: kind === 'word-listen' ? 'listening' : 'reading',
    prompt: kind === 'word-listen' ? 'Écoute le mot et choisis son sens.' : 'Que signifie ce mot ?',
    zh: target.w,
    options,
    answer,
    fr,
    word: target.w,
  };
}

function sentenceQuestions(ctx: Ctx, n: number, weekWords: string[], startId: number): TestQuestion[] {
  if (n <= 0) return [];
  let chars = ctx.cur.knownChars();
  if (chars.size < 15) chars = new Set([...chars, ...ctx.cur.introducedChars()]);
  const picked = new Map<number, Sentence>();
  const usable = (s: Sentence) => s.fr.length > 0 && s.fr[0].length <= 90;
  for (const w of weekWords.slice(0, Math.ceil(n / 2) + 2)) {
    if (picked.size >= Math.ceil(n / 2)) break;
    for (const s of sentencesWithin(ctx, chars, { min: 3, max: 14, limit: 2, mustContain: w })) if (usable(s) && !picked.has(s.id)) {
      picked.set(s.id, s);
      break;
    }
  }
  const more = sentencesWithin(ctx, chars, { min: 3, max: 14, limit: n * 4 + 20 });
  for (const s of more) {
    if (picked.size >= n) break;
    if (usable(s)) picked.set(s.id, s);
  }
  if (picked.size === 0) return [];
  // distractor translations: other sentences the learner could read, plus random ones of similar length
  const pool = [...more.map((s) => s.fr[0])];
  const all = ctx.content.sentences;
  for (let k = 0; k < 120 && all.length; k++) pool.push(all[Math.floor(Math.random() * all.length)].fr[0]);
  const out: TestQuestion[] = [];
  let i = startId;
  for (const s of picked.values()) {
    const fr = s.fr[0];
    const d = pickSentenceDistractors(fr, pool.filter((p) => !s.fr.includes(p)), 3);
    if (d.length < 2) continue;
    const { options, answer } = makeMcq(fr, d);
    out.push({ id: `q${i++}`, kind: 'sentence-listen', skill: 'listening', prompt: 'Écoute la phrase et choisis la bonne traduction.', zh: s.zh, options, answer, fr, sentenceId: s.id });
  }
  return out;
}

function grammarQuestions(ctx: Ctx, kind: TestKind, n: number, startId: number, now: number): TestQuestion[] {
  if (n <= 0) return [];
  const rows = ctx.db.all<{ id: string; last_ts: number | null }>('SELECT id, last_ts FROM grammar_progress WHERE lesson_done IS NOT NULL');
  let pts = rows.filter((r) => ctx.content.grammarMap.has(r.id));
  if (!pts.length) return [];
  if (kind === 'weekly') {
    // points studied or reviewed this week first, then the others
    const weekAgo = now - 7 * DAY_MS;
    const reviewed = new Set(
      ctx.db
        .all<{ card_id: string }>("SELECT DISTINCT card_id FROM reviews WHERE kind='grammar' AND ts >= ?", [weekAgo])
        .map((r) => r.card_id.replace('grammar:rule:', '')),
    );
    const recent = pts.filter((p) => (p.last_ts ?? 0) >= weekAgo || reviewed.has(p.id));
    const older = pts.filter((p) => !recent.includes(p));
    pts = [...shuffleWith(recent), ...shuffleWith(older)];
  } else {
    const phase = ctx.cur.phase();
    const inPhase = pts.filter((p) => ctx.content.grammarMap.get(p.id)!.phase === Math.max(1, Math.min(3, phase)));
    pts = shuffleWith(inPhase.length >= 3 ? inPhase : pts);
  }
  // round-robin quotas over points
  const quota = new Map<string, number>();
  const cap = (id: string) => ctx.content.grammarMap.get(id)!.exercises.filter((e) => TEST_TYPES.includes(e.type)).length;
  let left = n;
  let progress = true;
  while (left > 0 && progress) {
    progress = false;
    for (const p of pts) {
      if (left <= 0) break;
      const q = quota.get(p.id) ?? 0;
      if (q < cap(p.id)) {
        quota.set(p.id, q + 1);
        left--;
        progress = true;
      }
    }
  }
  const out: TestQuestion[] = [];
  let i = startId;
  for (const [id, q] of quota) {
    const g = ctx.content.grammarMap.get(id)!;
    for (const ex of drawExercises(ctx, id, q, TEST_TYPES, now))
      out.push({ id: `q${i++}`, kind: 'grammar', skill: 'grammar', prompt: g.title, ex, grammarId: id, grammarTitle: g.title });
  }
  return shuffleWith(out);
}

export function buildPaper(ctx: Ctx, kind: TestKind, now = Date.now()): TestPaper {
  const notes: string[] = [];
  const pools = wordPools(ctx, kind, now);
  const studied = ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM grammar_progress WHERE lesson_done IS NOT NULL')?.n ?? 0;
  const knownChars = ctx.cur.knownChars().size;
  const comp = composition(kind, {
    words: pools.targets.length,
    sentences: knownChars >= 12 ? (kind === 'weekly' ? 5 : 10) : 0,
    grammar: studied > 0 ? 99 : 0,
  });
  const qs: TestQuestion[] = [];
  let id = 0;
  // (a) listening — words
  const listenTargets = pools.targets.slice(0, comp.wordListen);
  for (const w of listenTargets) {
    const q = wordQuestion(w, pools, 'word-listen', `q${id++}`);
    if (q) qs.push(q);
  }
  // (b) reading — use different words when possible, else reuse
  let readTargets = pools.targets.slice(comp.wordListen, comp.wordListen + comp.wordRead);
  if (readTargets.length < comp.wordRead) readTargets = [...readTargets, ...shuffleWith(listenTargets)].slice(0, comp.wordRead);
  for (const w of shuffleWith(readTargets)) {
    const q = wordQuestion(w, pools, 'word-read', `q${id++}`);
    if (q) qs.push(q);
  }
  // (c) sentences
  const weekWords = pools.targets.slice(0, 12).map((w) => w.w);
  const sq = sentenceQuestions(ctx, comp.sentences, weekWords, id);
  id += sq.length;
  qs.push(...sq);
  // (d) grammar
  qs.push(...grammarQuestions(ctx, kind, comp.grammar, id, now));

  if (!pools.targets.length) notes.push('Aucun mot introduit pour l\'instant : apprends tes premiers mots avant de passer un test.');
  if (!studied) notes.push('Aucune leçon de grammaire terminée : le test ne contient pas encore de grammaire.');
  if (!sq.length && comp.sentences === 0 && pools.targets.length) notes.push('Pas encore assez de caractères connus pour des phrases complètes : elles apparaîtront bientôt.');
  return { kind, week: ctx.cur.week(dayKey(now)), questions: qs, notes };
}

function toRow(r: { id: number; kind: string; week: number; score: number; ts: number; details: string | null }): TestRow {
  let details: TestDetails | null = null;
  try {
    details = r.details ? (JSON.parse(r.details) as TestDetails) : null;
  } catch {
    details = null;
  }
  return {
    id: r.id,
    kind: r.kind as TestKind,
    week: r.week,
    score: r.score,
    ts: r.ts,
    date: dayKey(r.ts),
    passed: r.score >= WEEKLY_PASS,
    bySkill: details?.bySkill ?? {},
    errors: details?.items?.filter((i) => !i.correct).length ?? 0,
  };
}

export function register(ctx: Ctx): void {
  ensureGrammarTables(ctx);

  handle('tests:status', () => {
    const s = ctx.settings();
    const today = dayKey();
    const week = ctx.cur.week(today);
    const last = ctx.cur.lastWeeklyTest() ?? null;
    const lastMock = ctx.db.get<{ week: number; score: number; ts: number }>("SELECT week, score, ts FROM tests WHERE kind='mock' ORDER BY ts DESC LIMIT 1") ?? null;
    const takenThisWeek = (ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM tests WHERE kind='weekly' AND week=?", [week])?.n ?? 0) > 0;
    return {
      week,
      passMark: WEEKLY_PASS,
      isTestDay: weekday(today) === s.testDay,
      testDay: s.testDay,
      passedThisWeek: ctx.cur.weeklyTestDoneThisWeek(today),
      takenThisWeek,
      consolidation: ctx.cur.consolidation(),
      lastWeekly: last,
      lastMock,
      phase: ctx.cur.phase(),
      phaseName: ctx.cur.phaseName(),
      wordsIntroduced: ctx.cur.introducedWords().size,
    };
  });

  handle('tests:weekly', (): TestPaper => buildPaper(ctx, 'weekly'));
  handle('tests:mock', (): TestPaper => buildPaper(ctx, 'mock'));

  handle('tests:submit', (payload: { kind: TestKind; score?: number; answers?: TestItemResult[]; details?: TestDetails }) => {
    const kind: TestKind = payload.kind === 'mock' ? 'mock' : 'weekly';
    const items: TestItemResult[] = payload.details?.items ?? payload.answers ?? [];
    const { score: computed, bySkill } = scoreItems(items);
    const score = items.length ? computed : Math.max(0, Math.min(1, Number(payload.score) || 0));
    const now = Date.now();
    const week = ctx.cur.week(dayKey(now));
    const details: TestDetails = { items, bySkill, durationMs: payload.details?.durationMs };
    ctx.db.run('INSERT INTO tests(kind, week, score, ts, details) VALUES(?,?,?,?,?)', [kind, week, score, now, JSON.stringify(details)]);
    const id = ctx.db.get<{ id: number }>('SELECT MAX(id) id FROM tests')?.id ?? 0;
    // Missed words come back soon: « Again » on the matching FSRS card.
    let relearned = 0;
    const done = new Set<string>();
    for (const it of items) {
      if (it.correct || !it.word) continue;
      const cid = it.kind === 'word-listen' ? `word:listen:${it.word}` : `word:meaning:${it.word}`;
      if (done.has(cid)) continue;
      done.add(cid);
      const card = ctx.srs.getCard(cid);
      if (!card || card.suspended) continue;
      ctx.srs.review(cid, 1, now);
      relearned++;
    }
    const minutes = (payload.details?.durationMs ?? 0) / 60000;
    if (minutes > 0)
      ctx.db.run('INSERT INTO activity(date,ts,type,minutes,detail) VALUES(?,?,?,?,?)', [dayKey(now), now, 'test', Math.min(minutes, 120), JSON.stringify({ kind, score })]);
    return { id, score, passed: score >= WEEKLY_PASS, week, relearned, bySkill, consolidation: ctx.cur.consolidation() };
  });

  handle('tests:history', (): TestRow[] =>
    ctx.db.all<{ id: number; kind: string; week: number; score: number; ts: number; details: string | null }>('SELECT * FROM tests ORDER BY ts DESC LIMIT 60').map(toRow),
  );

  handle('tests:get', (id: number) => {
    const r = ctx.db.get<{ id: number; kind: string; week: number; score: number; ts: number; details: string | null }>('SELECT * FROM tests WHERE id=?', [id]);
    if (!r) throw new Error('Test introuvable');
    let details: TestDetails | null = null;
    try {
      details = r.details ? JSON.parse(r.details) : null;
    } catch {
      details = null;
    }
    return { ...toRow(r), items: details?.items ?? [] };
  });
}
