// Spaced repetition on top of ts-fsrs (FSRS-5/6 scheduler).
import { fsrs, generatorParameters, createEmptyCard, State, type Card, type FSRS, type Grade as FGrade } from 'ts-fsrs';
import type { Db } from './db';
import type { CardFace, CardKind, CardRow, Grade } from '../shared/types';
import { dayEnd, dayKey, DAY_MS } from './time';

export class Srs {
  private f: FSRS;
  constructor(private db: Db, retention = 0.9) {
    this.f = fsrs(generatorParameters({ request_retention: retention, enable_fuzz: true, enable_short_term: true }));
  }

  setRetention(r: number) {
    this.f = fsrs(generatorParameters({ request_retention: r, enable_fuzz: true, enable_short_term: true }));
  }

  static id(kind: CardKind, face: CardFace, ref: string) {
    return `${kind}:${face}:${ref}`;
  }

  ensureCard(kind: CardKind, face: CardFace, ref: string, now = Date.now()): string {
    const id = Srs.id(kind, face, ref);
    const exists = this.db.get('SELECT id FROM cards WHERE id=?', [id]);
    if (!exists) {
      this.db.run(
        `INSERT INTO cards(id,kind,face,ref,due,stability,difficulty,elapsed_days,scheduled_days,learning_steps,reps,lapses,state,last_review,created,suspended)
         VALUES(?,?,?,?,?,0,0,0,0,0,0,0,0,NULL,?,0)`,
        [id, kind, face, ref, now, now],
      );
    }
    return id;
  }

  getCard(id: string): CardRow | undefined {
    return this.db.get<CardRow>('SELECT * FROM cards WHERE id=?', [id]);
  }

  private toFsrs(c: CardRow): Card {
    const base = createEmptyCard(new Date(c.created));
    return {
      ...base,
      due: new Date(c.due),
      stability: c.stability,
      difficulty: c.difficulty,
      elapsed_days: c.elapsed_days,
      scheduled_days: c.scheduled_days,
      learning_steps: c.learning_steps,
      reps: c.reps,
      lapses: c.lapses,
      state: c.state as State,
      last_review: c.last_review ? new Date(c.last_review) : undefined,
    } as Card;
  }

  preview(c: CardRow, now = Date.now()): Record<Grade, number> {
    const rec = this.f.repeat(this.toFsrs(c), new Date(now));
    return {
      1: rec[1 as FGrade].card.due.getTime() - now,
      2: rec[2 as FGrade].card.due.getTime() - now,
      3: rec[3 as FGrade].card.due.getTime() - now,
      4: rec[4 as FGrade].card.due.getTime() - now,
    };
  }

  review(id: string, grade: Grade, now = Date.now(), durationMs = 0): CardRow {
    const c = this.getCard(id);
    if (!c) throw new Error('card not found ' + id);
    const { card, log } = this.f.next(this.toFsrs(c), new Date(now), grade as FGrade);
    this.db.tx(() => {
      this.db.run(
        `UPDATE cards SET due=?, stability=?, difficulty=?, elapsed_days=?, scheduled_days=?, learning_steps=?, reps=?, lapses=?, state=?, last_review=? WHERE id=?`,
        [
          card.due.getTime(),
          card.stability,
          card.difficulty,
          card.elapsed_days,
          card.scheduled_days,
          card.learning_steps ?? 0,
          card.reps,
          card.lapses,
          card.state,
          now,
          id,
        ],
      );
      this.db.run('INSERT INTO reviews(card_id,ts,rating,state,elapsed,duration_ms,kind) VALUES(?,?,?,?,?,?,?)', [
        id,
        now,
        grade,
        log.state,
        log.elapsed_days,
        durationMs,
        c.kind,
      ]);
    });
    return this.getCard(id)!;
  }

  retrievability(c: CardRow, now = Date.now()): number {
    if (c.state === 0) return 0;
    return this.f.get_retrievability(this.toFsrs(c), new Date(now), false) as number;
  }

  /** Cards due before the end of today, filtered by kind. Learning cards first, then lowest retrievability. */
  due(kinds: CardKind[], now = Date.now(), limit = 9999): CardRow[] {
    const end = dayEnd(dayKey(now));
    const ph = kinds.map(() => '?').join(',');
    const rows = this.db.all<CardRow>(
      `SELECT * FROM cards WHERE suspended=0 AND state>0 AND kind IN (${ph}) AND due < ? ORDER BY due`,
      [...kinds, end],
    );
    const scored = rows.map((c) => ({ c, r: c.state === 1 || c.state === 3 ? -1 : this.retrievability(c, now) }));
    scored.sort((a, b) => a.r - b.r);
    return scored.slice(0, limit).map((s) => s.c);
  }

  /** New (never reviewed) cards waiting, in creation order. */
  fresh(kinds: CardKind[], limit = 9999): CardRow[] {
    const ph = kinds.map(() => '?').join(',');
    return this.db.all<CardRow>(
      `SELECT * FROM cards WHERE suspended=0 AND state=0 AND kind IN (${ph}) ORDER BY created, id LIMIT ?`,
      [...kinds, limit],
    );
  }

  countDue(kinds: CardKind[], now = Date.now()): number {
    const end = dayEnd(dayKey(now));
    const ph = kinds.map(() => '?').join(',');
    const r = this.db.get<{ n: number }>(
      `SELECT COUNT(*) n FROM cards WHERE suspended=0 AND state>0 AND kind IN (${ph}) AND due < ?`,
      [...kinds, end],
    );
    return r?.n ?? 0;
  }

  /** Cards overdue by more than one day (backlog from missed days). */
  countOverdue(kinds: CardKind[], now = Date.now()): number {
    const ph = kinds.map(() => '?').join(',');
    const r = this.db.get<{ n: number }>(
      `SELECT COUNT(*) n FROM cards WHERE suspended=0 AND state=2 AND kind IN (${ph}) AND due < ?`,
      [...kinds, now - DAY_MS],
    );
    return r?.n ?? 0;
  }

  /** Number of reviews due on each of the next `days` days (index 0 = today, includes overdue). */
  forecast(kinds: CardKind[], days = 7, now = Date.now()): number[] {
    const ph = kinds.map(() => '?').join(',');
    const rows = this.db.all<{ due: number }>(
      `SELECT due FROM cards WHERE suspended=0 AND state>0 AND kind IN (${ph})`,
      kinds,
    );
    const today = dayKey(now);
    const out = new Array(days).fill(0);
    const ends: number[] = [];
    let k = today;
    for (let i = 0; i < days; i++) {
      ends.push(dayEnd(k));
      const [y, m, d] = k.split('-').map(Number);
      const dt = new Date(y, m - 1, d + 1, 12);
      k = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    }
    for (const { due } of rows) {
      for (let i = 0; i < days; i++) {
        if (due < ends[i]) {
          out[i]++;
          break;
        }
      }
    }
    return out;
  }

  /** Mean seconds per review for a kind, from history (fallback default). */
  avgSeconds(kind: CardKind, fallback: number): number {
    const r = this.db.get<{ s: number | null; n: number }>(
      `SELECT AVG(MIN(duration_ms, 60000))/1000.0 s, COUNT(*) n FROM reviews WHERE kind=? AND duration_ms>0 AND id > (SELECT COALESCE(MAX(id),0)-500 FROM reviews)`,
      [kind],
    );
    if (!r || !r.s || r.n < 30) return fallback;
    return Math.max(3, Math.min(60, r.s));
  }
}

/**
 * Build a study session of at most `limit` cards: learning/relearning first, then new (never reviewed) cards,
 * then reviews by risk of forgetting. `reserved` new cards (words introduced today) always get a slot, even when
 * due cards would fill the limit — the daily plan counts them in its review block. Other new cards only take
 * the slots left over by due cards. `due` must come sorted as Srs.due() returns it (learning first).
 */
export function composeQueue(due: CardRow[], fresh: CardRow[], reserved: CardRow[], limit: number): CardRow[] {
  const res = reserved.slice(0, Math.max(0, limit));
  const resIds = new Set(res.map((c) => c.id));
  const dueKept = due.slice(0, Math.max(0, limit - res.length));
  const extra = fresh.filter((c) => !resIds.has(c.id)).slice(0, Math.max(0, limit - res.length - dueKept.length));
  const newCards = [...res, ...extra];
  const learning = dueKept.filter((c) => c.state === 1 || c.state === 3);
  const reviews = dueKept.filter((c) => c.state === 2);
  // interleave faces of the same word so meaning/listen of one word are not back to back
  const freshSorted = [...newCards.filter((c) => c.face === 'meaning'), ...newCards.filter((c) => c.face !== 'meaning')];
  return [...learning, ...freshSorted, ...reviews];
}
