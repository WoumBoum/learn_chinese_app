// Grammar channels: lesson list/status, lessons, exercise sets (least recently seen), FSRS reviews, daily session plan.
import type { Ctx } from '../ctx';
import { handle } from '../ctx';
import type { GrammarExercise, GrammarPoint, GrammarStatus } from '../../shared/types';
import { GRAMMAR_PASS, pointVocabulary, reviewGrade, selectExercises } from '../../core/grammar';
import { dayKey, DAY_MS } from '../../core/time';
import { segment } from '../../core/nlp';

/** An exercise as served to the renderer: `_pool` = other Chinese words of the same point (tile distractors). */
export type ServedExercise = GrammarExercise & { _pool?: string[]; _idx?: number };

export interface GrammarSessionPlan {
  due: { id: string; title: string; pattern: string }[];
  next: { id: string; title: string; pattern: string; reason: 'new' | 'retry'; bestScore: number | null } | null;
  totalDue: number;
}

const SESSION_MAX_REVIEWS = 12;

export function ensureGrammarTables(ctx: Ctx): void {
  ctx.db.run('CREATE TABLE IF NOT EXISTS grammar_seen (id TEXT NOT NULL, ex_idx INTEGER NOT NULL, ts INTEGER NOT NULL)');
  ctx.db.run('CREATE INDEX IF NOT EXISTS grammar_seen_id ON grammar_seen(id, ts)');
}

function point(ctx: Ctx, id: string): GrammarPoint {
  const p = ctx.content.grammarMap.get(id);
  if (!p) throw new Error(`Point de grammaire inconnu : ${id}`);
  return p;
}

export function lastSeenMap(ctx: Ctx, id: string): Map<number, number> {
  return new Map(
    ctx.db.all<{ ex_idx: number; ts: number }>('SELECT ex_idx, MAX(ts) ts FROM grammar_seen WHERE id=? GROUP BY ex_idx', [id]).map((r) => [r.ex_idx, r.ts]),
  );
}

export function markSeen(ctx: Ctx, id: string, idx: number[], now = Date.now()): void {
  if (!idx.length) return;
  ctx.db.tx(() => {
    for (const i of idx) ctx.db.run('INSERT INTO grammar_seen(id, ex_idx, ts) VALUES(?,?,?)', [id, i, now]);
    ctx.db.run('DELETE FROM grammar_seen WHERE id=? AND ts < ?', [id, now - 365 * DAY_MS]);
  });
}

const vocabCache = new Map<string, string[]>();
/** Words of the point: order tokens, cloze options and segmented answers (cached). */
function vocabulary(ctx: Ctx, p: GrammarPoint): string[] {
  const hit = vocabCache.get(p.id);
  if (hit) return hit;
  const set = new Set(pointVocabulary(p));
  const dict = (w: string) => !!ctx.content.dict[w];
  for (const ex of p.exercises) {
    const texts = ex.type === 'transform' || ex.type === 'error' || ex.type === 'translate' ? ex.answers.slice(0, 1) : [];
    for (const t of texts) {
      try {
        for (const tok of segment(t, dict)) if (tok.han && tok.t.length <= 3) set.add(tok.t);
      } catch {
        /* nlp not ready */
      }
    }
  }
  const out = [...set];
  vocabCache.set(p.id, out);
  return out;
}

/** Draw `n` exercises of a point, least recently seen first, record them as seen. */
export function drawExercises(ctx: Ctx, id: string, n: number, types?: GrammarExercise['type'][], now = Date.now()): ServedExercise[] {
  const p = point(ctx, id);
  const idx = selectExercises(p.exercises, lastSeenMap(ctx, id), n, { types });
  markSeen(ctx, id, idx, now);
  const pool = vocabulary(ctx, p);
  return idx.map((i) => ({ ...p.exercises[i], _pool: pool, _idx: i }));
}

function logActivity(ctx: Ctx, minutes: number, detail: unknown) {
  if (!(minutes > 0)) return;
  ctx.db.run('INSERT INTO activity(date,ts,type,minutes,detail) VALUES(?,?,?,?,?)', [dayKey(), Date.now(), 'grammar', Math.min(minutes, 120), JSON.stringify(detail)]);
}

export function sessionPlan(ctx: Ctx, now = Date.now()): GrammarSessionPlan {
  const status = ctx.cur.grammarStatus(now);
  const dueCards = ctx.srs.due(['grammar'], now).filter((c) => ctx.content.grammarMap.has(c.ref));
  const due = dueCards.slice(0, SESSION_MAX_REVIEWS).map((c) => {
    const p = ctx.content.grammarMap.get(c.ref)!;
    return { id: p.id, title: p.title, pattern: p.pattern };
  });
  // Frontier of the curriculum: first available point, or the point blocking the next one (< 80 %).
  let next: GrammarSessionPlan['next'] = null;
  for (const s of status) {
    if (s.state === 'available') {
      next = { id: s.id, title: s.title, pattern: s.pattern, reason: s.bestScore != null ? 'retry' : 'new', bestScore: s.bestScore };
      break;
    }
    if (s.state === 'learning' && (s.bestScore ?? 0) < GRAMMAR_PASS) {
      const i = status.indexOf(s);
      const following = status[i + 1];
      if (!following || following.state === 'locked') {
        next = { id: s.id, title: s.title, pattern: s.pattern, reason: 'retry', bestScore: s.bestScore };
        break;
      }
    }
  }
  if (next && due.some((d) => d.id === next!.id) && next.reason === 'retry') {
    // the lesson itself serves as the review of that point
    due.splice(
      due.findIndex((d) => d.id === next!.id),
      1,
    );
  }
  return { due, next, totalDue: dueCards.length };
}

export function register(ctx: Ctx): void {
  ensureGrammarTables(ctx);

  handle('grammar:list', (): GrammarStatus[] => ctx.cur.grammarStatus());

  handle('grammar:get', (id: string): GrammarPoint => point(ctx, id));

  handle('grammar:complete', (id: string, score: number, durationMs?: number) => {
    point(ctx, id);
    const s = Math.max(0, Math.min(1, Number(score) || 0));
    const before = ctx.cur.grammarStatus();
    ctx.cur.completeGrammarLesson(id, s);
    logActivity(ctx, (durationMs ?? 0) / 60000, { id, score: s, lesson: true });
    const after = ctx.cur.grammarStatus();
    const i = after.findIndex((g) => g.id === id);
    const nextBefore = before[i + 1];
    const nextAfter = after[i + 1];
    const unlocked = nextAfter && nextBefore?.state === 'locked' && nextAfter.state !== 'locked' ? { id: nextAfter.id, title: nextAfter.title } : null;
    const card = ctx.srs.getCard(`grammar:rule:${id}`);
    return { status: after[i], unlocked, nextDue: card && card.state > 0 ? card.due : null, hasNext: !!nextAfter };
  });

  handle('grammar:reviewSet', (id: string, n?: number): ServedExercise[] => drawExercises(ctx, id, Math.max(1, Math.min(30, n ?? 4))));

  handle('grammar:review', (id: string, results: boolean[], durationMsArg?: number) => {
    const durationMs = Math.max(0, Number(durationMsArg) || 0);
    point(ctx, id);
    const grade = reviewGrade(results, durationMs);
    const now = Date.now();
    const cid = ctx.srs.ensureCard('grammar', 'rule', id, now);
    const card = ctx.srs.review(cid, grade, now, durationMs);
    logActivity(ctx, durationMs / 60000, { id, review: true, grade });
    return { grade, due: card.due, intervalMs: card.due - now, correct: results.filter(Boolean).length, total: results.length };
  });

  handle('grammar:session', (): GrammarSessionPlan => sessionPlan(ctx));
}
