// Curriculum engine: what has been introduced, what is known, phases, mastery gates, projections.
import type { Db } from './db';
import type { Content } from './content';
import { Srs } from './srs';
import type { CardRow, GrammarStatus, Word } from '../shared/types';
import { addDays, dayEnd, daysBetween, dayKey, dayStart, DAY_MS } from './time';

export const PHASES = [
  { n: 0, name: 'Phase 0 — Phonétique', until: 100 },
  { n: 1, name: 'Phase 1 — Fondations', until: 450 },
  { n: 2, name: 'Phase 2 — Consolidation', until: 1000 },
  { n: 3, name: 'Phase 3 — Autonomie', until: 1500 },
  { n: 4, name: 'Phase 4 — Évaluation', until: Infinity },
];

/** Stability (days) above which a word counts as "known" for coverage purposes. */
export const KNOWN_STABILITY = 4;
export const WEEKLY_PASS = 0.85;

export class Curriculum {
  constructor(private db: Db, private content: Content, private srs: Srs) {}

  introducedWords(): Set<string> {
    return new Set(this.db.all<{ ref: string }>("SELECT ref FROM introduced WHERE kind='word'").map((r) => r.ref));
  }

  introducedChars(): Set<string> {
    return new Set(this.db.all<{ ref: string }>("SELECT ref FROM introduced WHERE kind='char'").map((r) => r.ref));
  }

  /** word -> 'known' | 'learning' | 'ignored' for every word the learner has met. */
  wordStatus(): Map<string, 'known' | 'learning' | 'ignored'> {
    const out = new Map<string, 'known' | 'learning' | 'ignored'>();
    const rows = this.db.all<{ ref: string; stability: number; state: number }>(
      "SELECT ref, stability, state FROM cards WHERE kind='word' AND face='meaning'",
    );
    for (const r of rows) out.set(r.ref, r.state === 2 && r.stability >= KNOWN_STABILITY ? 'known' : 'learning');
    for (const r of this.db.all<{ word: string; status: string }>('SELECT * FROM known_override'))
      out.set(r.word, r.status as 'known' | 'ignored');
    return out;
  }

  knownChars(): Set<string> {
    const s = new Set<string>();
    for (const [w, st] of this.wordStatus()) if (st !== 'ignored') for (const c of w) s.add(c);
    return s;
  }

  phase(): number {
    const n = this.introducedWords().size;
    return PHASES.find((p) => n < p.until)!.n;
  }

  phaseName(p = this.phase()): string {
    return PHASES[p].name;
  }

  week(today = dayKey()): number {
    const start = this.db.getSetting<string>('startDate', today);
    return Math.max(1, Math.floor(daysBetween(start, today) / 7) + 1);
  }

  /** Next words to learn in curriculum order (skipping already introduced ones). */
  nextWords(n: number, exclude: Set<string> = new Set()): Word[] {
    const intro = this.introducedWords();
    const ov = new Set(this.db.all<{ word: string }>('SELECT word FROM known_override').map((r) => r.word));
    const out: Word[] = [];
    for (const w of this.content.words) {
      if (out.length >= n) break;
      if (intro.has(w.w) || ov.has(w.w) || exclude.has(w.w)) continue;
      out.push(w);
    }
    return out;
  }

  /** Introduce a word: create its cards (meaning + listen) and introduce its new characters (writing cards). */
  introduceWord(w: string, source = 'curriculum', now = Date.now()): { newChars: string[] } {
    const newChars: string[] = [];
    const introChars = this.introducedChars();
    this.db.tx(() => {
      this.db.run('INSERT OR IGNORE INTO introduced(kind,ref,ts,source) VALUES(?,?,?,?)', ['word', w, now, source]);
      this.srs.ensureCard('word', 'meaning', w, now);
      this.srs.ensureCard('word', 'listen', w, now);
      for (const c of w) {
        if (!/\p{Script=Han}/u.test(c) || introChars.has(c) || newChars.includes(c)) continue;
        if (!this.content.chars[c]) continue;
        newChars.push(c);
        this.db.run('INSERT OR IGNORE INTO introduced(kind,ref,ts,source) VALUES(?,?,?,?)', ['char', c, now, source]);
        this.srs.ensureCard('char', 'write', c, now);
      }
    });
    return { newChars };
  }

  /** Words introduced today (study day). */
  introducedToday(now = Date.now()): { words: string[]; chars: string[] } {
    const start = new Date(dayKey(now) + 'T04:00:00').getTime();
    const rows = this.db.all<{ kind: string; ref: string }>('SELECT kind, ref FROM introduced WHERE ts >= ? ORDER BY ts', [start]);
    return { words: rows.filter((r) => r.kind === 'word').map((r) => r.ref), chars: rows.filter((r) => r.kind === 'char').map((r) => r.ref) };
  }

  /**
   * Never-reviewed cards (meaning + listen) of the words introduced today: they always get their first
   * review today, even when due reviews fill the session (same rule in the planner and study:queue).
   */
  freshIntroducedToday(now = Date.now()): CardRow[] {
    return this.db.all<CardRow>(
      `SELECT c.* FROM cards c WHERE c.suspended=0 AND c.state=0 AND c.kind='word' AND c.face IN ('meaning','listen')
       AND EXISTS (SELECT 1 FROM introduced i WHERE i.kind='word' AND i.ref=c.ref AND i.ts >= ?) ORDER BY c.created, c.id`,
      [dayStart(dayKey(now))],
    );
  }

  /**
   * Production cards (français → chinois) are added once a word's meaning card is mature.
   * Eligibility (curriculum word, HSK band ≤ 3) is checked before limiting, so ineligible mature words
   * (band > 3, mission/video words) can never take all the slots and stall promotion.
   * At most `perDay` recall cards are created per study day so they don't flood the review queue.
   */
  promoteRecallCards(now = Date.now(), perDay = 15): number {
    const since = dayStart(dayKey(now));
    const createdToday =
      this.db.get<{ n: number }>("SELECT COUNT(*) n FROM cards WHERE kind='word' AND face='recall' AND created >= ?", [since])?.n ?? 0;
    const room = perDay - createdToday;
    if (room <= 0) return 0;
    const rows = this.db.all<{ ref: string }>(
      `SELECT c.ref FROM cards c WHERE c.kind='word' AND c.face='meaning' AND c.state=2 AND c.stability >= 10
       AND NOT EXISTS (SELECT 1 FROM cards r WHERE r.id = 'word:recall:' || c.ref) ORDER BY c.stability DESC, c.ref`,
    );
    let n = 0;
    for (const r of rows) {
      if (n >= room) break;
      const w = this.content.wordMap.get(r.ref);
      if (!w || w.band > 3) continue;
      this.srs.ensureCard('word', 'recall', r.ref, now);
      n++;
    }
    return n;
  }

  // ---------- missions ----------
  /**
   * Single source of truth for the briefing words of a mission still to teach:
   * pre-teach entries with status 'new', not introduced yet, and not marked by the learner
   * (known_override 'known' / 'ignored', or any word already met). Used by the planner, study:newBatch,
   * study:introduce and the media module.
   */
  missionRemaining(pre: { w: string; status?: string }[]): string[] {
    const intro = this.introducedWords();
    const st = this.wordStatus();
    return pre.filter((p) => (p.status ?? 'new') === 'new' && !intro.has(p.w) && !st.has(p.w)).map((p) => p.w);
  }

  /**
   * A mission is field-ready when nothing is left to teach and its briefing words were introduced
   * before the current study day (one night of consolidation). A mission without new words is ready at once.
   */
  missionReadiness(pre: { w: string; status?: string }[], now = Date.now()): { remaining: string[]; ready: boolean; lastIntro: number | null } {
    const remaining = this.missionRemaining(pre);
    const words = pre.filter((p) => (p.status ?? 'new') === 'new').map((p) => p.w);
    const lastIntro = words.length
      ? this.db.get<{ ts: number | null }>(`SELECT MAX(ts) ts FROM introduced WHERE kind='word' AND ref IN (${words.map(() => '?').join(',')})`, words)?.ts ?? null
      : null;
    const ready = remaining.length === 0 && (lastIntro == null || lastIntro < dayStart(dayKey(now)));
    return { remaining, ready, lastIntro };
  }

  // ---------- grammar ----------
  grammarStatus(now = Date.now()): GrammarStatus[] {
    const phase = this.phase();
    const prog = new Map(
      this.db.all<{ id: string; lesson_done: number | null; best_score: number | null }>('SELECT * FROM grammar_progress').map((r) => [r.id, r]),
    );
    const cards = new Map(
      this.db.all<{ ref: string; stability: number; state: number; due: number }>("SELECT ref, stability, state, due FROM cards WHERE kind='grammar'").map((r) => [r.ref, r]),
    );
    const out: GrammarStatus[] = [];
    let prevOk = true;
    for (const g of this.content.grammar) {
      const p = prog.get(g.id);
      const c = cards.get(g.id);
      let state: GrammarStatus['state'];
      if (p?.lesson_done) state = c && c.state === 2 && c.stability >= 21 ? 'mastered' : 'learning';
      // Unlock: previous point practiced with ≥ 80 %, and the vocabulary phase has reached the point's phase.
      else if (prevOk && g.phase <= Math.max(1, phase)) state = 'available';
      else state = 'locked';
      out.push({
        id: g.id,
        title: g.title,
        phase: g.phase,
        pattern: g.pattern,
        state,
        lessonDone: !!p?.lesson_done,
        bestScore: p?.best_score ?? null,
        // same horizon as Srs.due(): due before the end of the current study day
        due: !!c && c.state > 0 && c.due < dayEnd(dayKey(now)),
      });
      // Mastery gate: the next point unlocks once this lesson scored ≥ 80 % (or the rule is mastered through reviews).
      prevOk = !!p?.lesson_done && ((p.best_score ?? 0) >= 0.8 || state === 'mastered');
    }
    return out;
  }

  nextGrammarPoint(): GrammarStatus | undefined {
    return this.grammarStatus().find((g) => g.state === 'available');
  }

  completeGrammarLesson(id: string, score: number, now = Date.now()): void {
    const prev = this.db.get<{ best_score: number | null; attempts: number }>('SELECT * FROM grammar_progress WHERE id=?', [id]);
    const best = Math.max(prev?.best_score ?? 0, score);
    this.db.run(
      `INSERT INTO grammar_progress(id, lesson_done, best_score, attempts, last_ts) VALUES(?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET lesson_done=COALESCE(lesson_done, excluded.lesson_done), best_score=excluded.best_score, attempts=attempts+1, last_ts=excluded.last_ts`,
      [id, score >= 0.6 ? now : null, best, 1, now],
    );
    if (score >= 0.6) {
      const cid = this.srs.ensureCard('grammar', 'rule', id, now);
      const card = this.srs.getCard(cid)!;
      if (card.state === 0) this.srs.review(cid, score >= 0.95 ? 4 : score >= 0.8 ? 3 : score >= 0.6 ? 2 : 1, now);
    }
  }

  // ---------- weekly gates ----------
  lastWeeklyTest(): { week: number; score: number; ts: number } | undefined {
    return this.db.get("SELECT week, score, ts FROM tests WHERE kind='weekly' ORDER BY ts DESC LIMIT 1");
  }

  /** Consolidation mode: last weekly test failed → fewer new words until a retest passes. */
  consolidation(): boolean {
    const t = this.lastWeeklyTest();
    return !!t && t.score < WEEKLY_PASS;
  }

  weeklyTestDoneThisWeek(today = dayKey()): boolean {
    const t = this.lastWeeklyTest();
    return !!t && t.week === this.week(today) && t.score >= WEEKLY_PASS;
  }

  /** Projected date to reach goalWords, from the actual intro pace of the last 14 days (or the planned pace). */
  projectGoalDate(goalWords: number, plannedPerDay: number, today = dayKey()): string | null {
    const n = this.introducedWords().size;
    if (n >= goalWords) return today;
    const since = Date.now() - 14 * DAY_MS;
    const recent = this.db.get<{ n: number }>("SELECT COUNT(*) n FROM introduced WHERE kind='word' AND ts >= ?", [since])?.n ?? 0;
    const start = this.db.getSetting<string>('startDate', today);
    const daysActive = Math.min(14, Math.max(1, daysBetween(start, today) + 1));
    const pace = recent > 0 ? recent / daysActive : plannedPerDay;
    if (pace <= 0) return null;
    return addDays(today, Math.ceil((goalWords - n) / pace));
  }
}
