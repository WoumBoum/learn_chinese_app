import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { Db, initSql } from '../src/core/db';
import { Content, numericToMarks } from '../src/core/content';
import { Srs } from '../src/core/srs';
import { Curriculum } from '../src/core/curriculum';
import { planDay, type PlannerInput } from '../src/core/planner';
import { parseSubtitles } from '../src/core/subtitles';
import { analyseCoverage } from '../src/core/coverage';
import { initNlp, segment } from '../src/core/nlp';
import { addDays, dayKey, dayStart, weekday } from '../src/core/time';
import type { DayMode } from '../src/shared/types';

const ROOT = path.resolve(__dirname, '..');
let content: Content;

beforeAll(async () => {
  await initSql(path.join(ROOT, 'node_modules/sql.js/dist'));
  content = new Content(path.join(ROOT, 'resources/data'), path.join(ROOT, 'content')).load();
  initNlp(content.words.map((w) => w.w));
});

async function freshDb() {
  const SQL = await initSql(path.join(ROOT, 'node_modules/sql.js/dist'));
  return new Db(SQL, null);
}

describe('content', () => {
  it('loads curriculum words in HSK order with French glosses', () => {
    expect(content.words.length).toBeGreaterThan(3000);
    expect(content.words.slice(0, 500).every((w) => w.band <= 2 || w.old <= 1)).toBe(true);
    expect(content.words.every((w) => w.fr.length > 0)).toBe(true);
  });
  it('converts numeric pinyin to tone marks', () => {
    expect(numericToMarks('ni3 hao3')).toBe('nǐ hǎo');
    expect(numericToMarks('lu:4')).toBe('lǜ');
    expect(numericToMarks('xie4 xie5')).toBe('xiè xie');
    expect(numericToMarks('gou3')).toBe('gǒu');
  });
  it('loads grammar points', () => {
    expect(content.grammar.length).toBeGreaterThan(20);
    for (const g of content.grammar) expect(g.exercises.length).toBeGreaterThan(5);
  });
});

describe('srs + curriculum', () => {
  it('introduces a word with meaning + listen cards and char writing cards', async () => {
    const db = await freshDb();
    const srs = new Srs(db);
    const cur = new Curriculum(db, content, srs);
    const r = cur.introduceWord('朋友');
    expect(r.newChars).toEqual(['朋', '友']);
    expect(srs.fresh(['word']).length).toBe(2);
    expect(srs.fresh(['char']).length).toBe(2);
    const id = Srs.id('word', 'meaning', '朋友');
    const c = srs.review(id, 3);
    expect(c.state).toBeGreaterThan(0);
    expect(cur.wordStatus().get('朋友')).toBe('learning');
  });

  it('grammar mastery gate: next point unlocks only after ≥ 80 %', async () => {
    const db = await freshDb();
    const srs = new Srs(db);
    const cur = new Curriculum(db, content, srs);
    const st = cur.grammarStatus();
    expect(st[0].state).toBe('available');
    expect(st[1].state).toBe('locked');
    cur.completeGrammarLesson(st[0].id, 0.7);
    expect(cur.grammarStatus()[1].state).toBe('locked');
    cur.completeGrammarLesson(st[0].id, 0.9);
    expect(cur.grammarStatus()[1].state).toBe('available');
    expect(srs.getCard(Srs.id('grammar', 'rule', st[0].id))).toBeTruthy();
  });
});

describe('subtitles + coverage', () => {
  it('parses VTT with rolling auto-captions', () => {
    const vtt = `WEBVTT\n\n00:00:01.000 --> 00:00:02.500\n你好\n\n00:00:02.500 --> 00:00:04.000\n你好我是小明\n\n00:00:04.000 --> 00:00:06.000\n我是学生\n`;
    const cues = parseSubtitles(vtt, { rolling: true });
    expect(cues.map((c) => c.text)).toEqual(['你好我是小明', '我是学生']);
  });
  it('dedupes YouTube 2-line rolling auto-captions (with 10 ms transition cues)', () => {
    const vtt = [
      'WEBVTT\nKind: captions\nLanguage: zh-Hans',
      '00:00:00.000 --> 00:00:02.330 align:start position:0%\n \n大家好<00:00:00.800><c>我是</c><00:00:01.200><c>小明</c>',
      '00:00:02.330 --> 00:00:02.340 align:start position:0%\n大家好我是小明\n ',
      '00:00:02.340 --> 00:00:04.500 align:start position:0%\n大家好我是小明\n今天<00:00:03.000><c>我们</c><00:00:03.500><c>去北京</c>',
      '00:00:04.500 --> 00:00:04.510 align:start position:0%\n今天我们去北京\n ',
      '00:00:04.510 --> 00:00:06.800 align:start position:0%\n今天我们去北京\n看看<00:00:05.200><c>天安门</c>',
      '00:00:06.800 --> 00:00:06.810 align:start position:0%\n看看天安门\n ',
      '00:00:06.810 --> 00:00:09.000 align:start position:0%\n看看天安门\n然后<00:00:07.500><c>吃饭</c>',
    ].join('\n\n');
    for (const cues of [parseSubtitles(vtt), parseSubtitles(vtt, { rolling: true })]) {
      expect(cues.map((c) => c.text)).toEqual(['大家好我是小明', '今天我们去北京', '看看天安门', '然后吃饭']);
      for (let i = 1; i < cues.length; i++) expect(cues[i].start).toBeGreaterThanOrEqual(cues[i - 1].end);
    }
  });
  it('keeps legitimate repeated / suffix lines in CC, SRT and Whisper subtitles', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\n不对。\n\n2\n00:00:03,000 --> 00:00:04,000\n对。\n\n3\n00:00:05,000 --> 00:00:06,000\n对。\n\n4\n00:00:07,000 --> 00:00:08,000\n对不对？\n';
    expect(parseSubtitles(srt).map((c) => c.text)).toEqual(['不对。', '对。', '对。', '对不对？']);
    // Whisper output: contiguous cues, the second one being a suffix of the first.
    const whisper = '1\n00:00:00,000 --> 00:00:02,000\n你说得很好。\n\n2\n00:00:02,000 --> 00:00:03,500\n很好。\n';
    expect(parseSubtitles(whisper, { rolling: false }).map((c) => c.text)).toEqual(['你说得很好。', '很好。']);
    // A cue duplicated over the same time range is still collapsed.
    const dup = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n我们走吧\n\n00:00:02.000 --> 00:00:04.000\n我们走吧\n';
    expect(parseSubtitles(dup)).toEqual([{ start: 1, end: 4, text: '我们走吧' }]);
  });
  it('selects words to pre-teach to reach the coverage target', () => {
    const lines = ['我今天去图书馆看书。', '图书馆很大，书很多。', '我喜欢在图书馆学习。'].map((t) => segment(t, (w) => !!content.dict[w]));
    const known = new Set(['我', '今天', '去', '看', '很', '大', '书', '多', '喜欢', '在', '学习']);
    const rep = analyseCoverage(lines, {
      target: 0.95,
      status: (w) => (known.has(w) ? 'known' : undefined),
      gloss: (w) => content.gloss(w),
      rank: (w) => content.wordMap.get(w)?.rank ?? 1e9,
    });
    expect(rep.preteach[0].w).toBe('图书馆');
    expect(rep.afterPreteach).toBeGreaterThanOrEqual(0.95);
  });
});

/** Simulates 26 weeks of study with an irregular schedule and missed days. */
describe('planner simulation (26 weeks)', () => {
  it('keeps the review load sustainable, recovers after missed days, and reaches the goal pace', async () => {
    const db = await freshDb();
    const srs = new Srs(db);
    const cur = new Curriculum(db, content, srs);
    const start = '2026-01-05'; // lundi
    db.setSetting('startDate', start);
    const minutes = [120, 40, 40, 40, 40, 40, 120];
    const avg = minutes.reduce((a, b) => a + b, 0) / 7;
    const secPerReview = 8;
    let rng = 42;
    const rand = () => ((rng = (rng * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const missed = new Set(Array.from({ length: 12 }, (_, i) => addDays('2026-02-14', i))); // 12 jours sans réviser
    const overloads: string[] = [];
    let recoveryDays = 0;
    let recoveredAfter = -1;
    let day = start;
    for (let d = 0; d < 182; d++, day = addDays(start, d)) {
      const now = dayStart(day) + 15 * 3600_000; // 19h
      if (missed.has(day)) continue;
      const wd = weekday(day);
      const mode: DayMode = wd === 3 ? 'express' : 'standard'; // le mercredi est chargé : mode Express
      const input: PlannerInput = {
        date: day,
        mode,
        weekdayMinutes: minutes[wd],
        avgDailyMinutes: avg,
        dueMain: srs.countDue(['word', 'sentence'], now),
        overdueMain: srs.countOverdue(['word', 'sentence'], now),
        dueGrammar: 0,
        dueWriting: 0,
        forecastMain: srs.forecast(['word', 'sentence'], 7, now),
        secPerReview,
        newTarget: 12,
        phase: cur.phase(),
        week: cur.week(day),
        isGrammarDay: false,
        isWritingDay: false,
        isTestDay: false,
        testDoneThisWeek: true,
        consolidation: false,
        missionReady: false,
        briefingPending: 0,
        introducedToday: 0,
        newCharsToday: 0,
        done: [],
      };
      const plan = planDay(input);
      if (plan.recovery.active) recoveryDays++;
      if (recoveryDays > 0 && recoveredAfter < 0 && !plan.recovery.active && day > '2026-02-25') recoveredAfter = d;
      const reviewBlock = plan.blocks.find((b) => b.type === 'reviews');
      if (reviewBlock && reviewBlock.minutes > plan.budgetMinutes) overloads.push(`${day}: ${reviewBlock.minutes}/${plan.budgetMinutes}`);
      if (process.env.SIM_LOG && (d % 7 === 0 || plan.recovery.active)) console.log(day, mode, 'due', input.dueMain, 'rev-min', reviewBlock?.minutes, 'budget', plan.budgetMinutes, 'new', plan.newCap, 'intro', cur.introducedWords().size, plan.recovery.active ? 'RECOVERY ' + plan.recovery.backlog : '');
      // do the reviews (success probability = retrievability, slightly optimistic for learning cards)
      const due = srs.due(['word', 'sentence'], now, reviewBlock?.count ?? 0);
      let t = now;
      for (const c of due) {
        const r = c.state === 2 ? srs.retrievability(c, t) : 0.85;
        srs.review(c.id, rand() < r ? 3 : 1, t, 8000);
        t += 8000;
      }
      // new words + their first reviews
      for (const w of cur.nextWords(plan.newCap)) cur.introduceWord(w.w, 'curriculum', t);
      for (const c of srs.fresh(['word'])) {
        srs.review(c.id, rand() < 0.8 ? 3 : 1, t, 8000);
        t += 8000;
      }
    }
    const introduced = cur.introducedWords().size;
    console.log({ introduced, overloads: overloads.length, recoveryDays, recoveredAfter });
    expect(introduced).toBeGreaterThan(1400);
    expect(overloads.length).toBe(0);
    expect(recoveryDays).toBeGreaterThan(0); // la semaine manquée déclenche le rattrapage
    expect(recoveredAfter).toBeGreaterThan(0); // …qui se résorbe
    expect(recoveredAfter - 52).toBeLessThan(21);
  }, 120_000);

  it('express day never adds new words', () => {
    const plan = planDay({
      date: dayKey(), mode: 'express', weekdayMinutes: 40, avgDailyMinutes: 60, dueMain: 50, overdueMain: 0, dueGrammar: 2, dueWriting: 3,
      forecastMain: [50, 40, 40, 40, 40, 40, 40], secPerReview: 8, newTarget: 8, phase: 1, week: 3, isGrammarDay: true, isWritingDay: true,
      isTestDay: false, testDoneThisWeek: true, consolidation: false, missionReady: true, briefingPending: 5, introducedToday: 0, newCharsToday: 0, done: [],
    });
    expect(plan.newCap).toBe(0);
    expect(plan.blocks.some((b) => b.type === 'new' || b.type === 'briefing')).toBe(false);
    expect(plan.budgetMinutes).toBeLessThanOrEqual(20);
  });
});
