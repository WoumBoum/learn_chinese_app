// Engine fixes: shared mission "remaining words" rule, one-night consolidation, recall promotion,
// planner review block with new cards, test-day gate, block payloads.
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { Db, initSql } from '../src/core/db';
import { Content } from '../src/core/content';
import { Srs, composeQueue } from '../src/core/srs';
import { Curriculum } from '../src/core/curriculum';
import { planDay, MIN_TESTABLE_WORDS, type PlannerInput } from '../src/core/planner';
import { addDays, dayKey, dayStart } from '../src/core/time';

const ROOT = path.resolve(__dirname, '..');
let content: Content;

beforeAll(async () => {
  await initSql(path.join(ROOT, 'node_modules/sql.js/dist'));
  content = new Content(path.join(ROOT, 'resources/data'), path.join(ROOT, 'content')).load();
});

async function setup() {
  const SQL = await initSql(path.join(ROOT, 'node_modules/sql.js/dist'));
  const db = new Db(SQL, null);
  const srs = new Srs(db);
  const cur = new Curriculum(db, content, srs);
  return { db, srs, cur };
}

function input(over: Partial<PlannerInput> = {}): PlannerInput {
  return {
    date: '2026-03-04',
    mode: 'standard',
    weekdayMinutes: 60,
    avgDailyMinutes: 60,
    dueMain: 0,
    overdueMain: 0,
    dueGrammar: 0,
    dueWriting: 0,
    forecastMain: [0, 0, 0, 0, 0, 0, 0],
    secPerReview: 8,
    newTarget: 12,
    phase: 1,
    week: 3,
    isGrammarDay: false,
    isWritingDay: false,
    isTestDay: false,
    testDoneThisWeek: false,
    consolidation: false,
    missionReady: false,
    briefingPending: 0,
    introducedToday: 0,
    newCharsToday: 0,
    done: [],
    ...over,
  };
}

describe('mission remaining words (shared rule)', () => {
  it('skips introduced words, words marked known/ignored, and non-new entries', async () => {
    const { db, cur } = await setup();
    const pre = [
      { w: '朋友', status: 'new' },
      { w: '图书馆', status: 'new' },
      { w: '北京', status: 'new' },
      { w: '学生', status: 'learning' },
      { w: '老师', status: 'new' },
    ];
    expect(cur.missionRemaining(pre)).toEqual(['朋友', '图书馆', '北京', '老师']);
    cur.introduceWord('朋友', 'mission');
    db.run("INSERT INTO known_override(word,status) VALUES('北京','ignored')");
    db.run("INSERT INTO known_override(word,status) VALUES('老师','known')");
    expect(cur.missionRemaining(pre)).toEqual(['图书馆']);
  });

  it('mission is ready only after one night of consolidation', async () => {
    const { cur } = await setup();
    const today = dayKey();
    const now = dayStart(today) + 10 * 3600_000;
    const pre = [{ w: '朋友', status: 'new' }, { w: '学生', status: 'learning' }];
    expect(cur.missionReadiness(pre, now).ready).toBe(false); // nothing learnt yet
    cur.introduceWord('朋友', 'mission', now - 3600_000); // learnt today
    const r = cur.missionReadiness(pre, now);
    expect(r.remaining).toEqual([]);
    expect(r.ready).toBe(false);
    // next study day: ready
    expect(cur.missionReadiness(pre, dayStart(addDays(today, 1)) + 3600_000).ready).toBe(true);
  });

  it('a mission without new words (or whose words were marked known) is ready at once', async () => {
    const { db, cur } = await setup();
    expect(cur.missionReadiness([{ w: '学生', status: 'learning' }]).ready).toBe(true);
    db.run("INSERT INTO known_override(word,status) VALUES('北京','ignored')");
    expect(cur.missionReadiness([{ w: '北京', status: 'new' }]).ready).toBe(true);
  });
});

describe('promoteRecallCards', () => {
  it('does not stall behind ineligible mature words and caps creations per day', async () => {
    const { db, srs, cur } = await setup();
    const now = dayStart(dayKey()) + 10 * 3600_000;
    const mature = (w: string) => {
      srs.ensureCard('word', 'meaning', w, now - 30 * 86_400_000);
      db.run("UPDATE cards SET state=2, stability=50 WHERE id=?", [Srs.id('word', 'meaning', w)]);
    };
    // 20 ineligible words with the highest stability order (band > 3 or outside the curriculum)
    const high = content.words.filter((w) => w.band > 3).slice(0, 18).map((w) => w.w);
    for (const w of [...high, '某某甲', '某某乙']) mature(w);
    const low = content.words.filter((w) => w.band <= 3).slice(0, 20).map((w) => w.w);
    for (const w of low) {
      srs.ensureCard('word', 'meaning', w, now - 30 * 86_400_000);
      db.run("UPDATE cards SET state=2, stability=12 WHERE id=?", [Srs.id('word', 'meaning', w)]);
    }
    expect(cur.promoteRecallCards(now)).toBe(15);
    expect(cur.promoteRecallCards(now)).toBe(0); // per-day cap reached
    const next = now + 86_400_000;
    expect(cur.promoteRecallCards(next)).toBe(5); // the remaining eligible words are reached the next day
    const recall = db.all<{ ref: string }>("SELECT ref FROM cards WHERE face='recall'").map((r) => r.ref);
    expect(new Set(recall)).toEqual(new Set(low));
  });
});

describe('planner fixes', () => {
  it('review block includes new (never reviewed) cards, even when nothing is due', () => {
    const plan = planDay(input({ dueMain: 0, freshMain: 24, introducedToday: 12 }));
    const b = plan.blocks.find((x) => x.type === 'reviews');
    expect(b?.count).toBe(24);
    const plan2 = planDay(input({ dueMain: 10, freshMain: 6 }));
    expect(plan2.blocks.find((x) => x.type === 'reviews')?.count).toBe(16);
  });

  it('express review block only takes the cards of words introduced today', () => {
    const plan = planDay(input({ mode: 'express', dueMain: 10, freshMain: 30, introducedToday: 0 }));
    expect(plan.blocks.find((x) => x.type === 'reviews')?.count).toBe(10);
    const plan2 = planDay(input({ mode: 'express', dueMain: 10, freshMain: 30, introducedToday: 3 }));
    expect(plan2.blocks.find((x) => x.type === 'reviews')?.count).toBe(16);
  });

  it('test day with nothing to test keeps new words and shows no test', () => {
    const plan = planDay(input({ isTestDay: true, week: 1, testable: 0, phase: 0 }));
    expect(plan.blocks.some((b) => b.type === 'test')).toBe(false);
    expect(plan.blocks.some((b) => b.type === 'new')).toBe(true);
    const plan2 = planDay(input({ isTestDay: true, testable: MIN_TESTABLE_WORDS }));
    expect(plan2.blocks.some((b) => b.type === 'test')).toBe(true);
    expect(plan2.blocks.some((b) => b.type === 'new')).toBe(false);
  });

  it('review-only grammar blocks carry reviewsOnly; shadowing opens the shadow tab; briefing names its mission', () => {
    const p1 = planDay(input({ dueGrammar: 2 }));
    expect(p1.blocks.find((b) => b.type === 'grammar')?.payload).toEqual({ reviewsOnly: true });
    const p2 = planDay(input({ mode: 'express', dueGrammar: 2 }));
    expect(p2.blocks.find((b) => b.type === 'grammar')?.payload).toEqual({ reviewsOnly: true });
    const p3 = planDay(input({ isGrammarDay: true, dueGrammar: 2, nextGrammarTitle: 'X' }));
    expect(p3.blocks.find((b) => b.type === 'grammar')?.payload?.reviewsOnly).toBeFalsy();
    const p4 = planDay(input({ phase: 2 }));
    expect(p4.blocks.find((b) => b.type === 'tones')?.payload).toEqual({ tab: 'shadow' });
    const p5 = planDay(input({ briefingPending: 4, missionId: 'm1' }));
    expect(p5.blocks.find((b) => b.type === 'briefing')?.payload).toEqual({ missionId: 'm1' });
  });
});

describe('review session with words introduced today', () => {
  it('reserves the new cards of today\'s words even when due cards fill the plan limit', async () => {
    const { db, srs, cur } = await setup();
    const now = dayStart(dayKey()) + 10 * 3600_000;
    // 30 due review cards from long ago
    const old = content.words.slice(100, 130).map((w) => w.w);
    for (const w of old) {
      srs.ensureCard('word', 'meaning', w, now - 40 * 86_400_000);
      db.run('UPDATE cards SET state=2, stability=5, due=?, last_review=? WHERE id=?', [now - 86_400_000, now - 6 * 86_400_000, Srs.id('word', 'meaning', w)]);
    }
    // an older waiting new card (not from today) and 3 words introduced today
    srs.ensureCard('word', 'recall', old[0], now - 5 * 86_400_000);
    for (const w of ['朋友', '学生', '老师']) cur.introduceWord(w, 'curriculum', now - 3600_000);
    const reserved = cur.freshIntroducedToday(now);
    expect(reserved.length).toBe(6);
    // recovery-like day: the plan allows 10 reviews + today's 6 new cards
    const plan = planDay(input({ dueMain: 30, overdueMain: 30, freshMain: srs.fresh(['word', 'sentence']).length, freshIntroducedToday: reserved.length, introducedToday: 3, weekdayMinutes: 15, avgDailyMinutes: 15, secPerReview: 40 }));
    const count = plan.blocks.find((b) => b.type === 'reviews')!.count!;
    const due = srs.due(['word', 'sentence'], now, count);
    const fresh = srs.fresh(['word', 'sentence'], count);
    const q = composeQueue(due, fresh, reserved, count);
    expect(q.length).toBe(count);
    expect(q.filter((c) => c.state === 0).map((c) => c.ref).sort()).toEqual(['学生', '学生', '朋友', '朋友', '老师', '老师'].sort());
    expect(q.filter((c) => c.state === 2).length).toBe(count - 6);
    // without a limit, everything is served: today's cards, the older new card and all due cards
    expect(composeQueue(srs.due(['word'], now, 500), srs.fresh(['word'], 500), reserved, 500).length).toBe(30 + 1 + 6);
  });

  it('fresh cards only fill the slots left by due cards when nothing was introduced today', () => {
    const card = (id: string, state: number, face = 'meaning') => ({ id, state, face }) as unknown as import('../src/shared/types').CardRow;
    const q = composeQueue([card('l', 1), card('r1', 2), card('r2', 2)], [card('f1', 0), card('f2', 0, 'listen')], [], 4);
    expect(q.map((c) => c.id)).toEqual(['l', 'f1', 'r1', 'r2']);
  });
});

