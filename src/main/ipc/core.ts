// Core channels: settings, daily plan, progress, dictionary lookup, segmentation.
import type { Ctx } from '../ctx';
import { handle } from '../ctx';
import { planDay, extraNewAllowance } from '../../core/planner';
import { addDays, dayKey, weekday, DAY_MS } from '../../core/time';
import { segment } from '../../core/nlp';
import { numericToMarks } from '../../core/content';
import type { BlockType, DayMode, DayPlan, Progress, Settings, Token } from '../../shared/types';
import { PHASES, WEEKLY_PASS } from '../../core/curriculum';
import { composedStatus } from '../../core/coverage';

export function buildPlan(ctx: Ctx, modeOverride?: DayMode, now = Date.now()): DayPlan {
  const s = ctx.settings();
  const today = dayKey(now);
  const ds = ctx.db.get<{ mode: string; done: string }>('SELECT * FROM day_state WHERE date=?', [today]);
  const mode = (modeOverride ?? (ds?.mode as DayMode) ?? 'standard') as DayMode;
  const done = ds ? (JSON.parse(ds.done) as BlockType[]) : [];
  const wd = weekday(today);
  const avg = s.availability.minutes.reduce((a, b) => a + b, 0) / 7;
  const mission = ctx.db.get<{ id: string; status: string; preteach: string; video_id: string }>(
    "SELECT * FROM missions WHERE status IN ('planned','briefing','ready') ORDER BY planned_date LIMIT 1",
  );
  let briefingPending = 0;
  let missionReady = false;
  let missionTitle: string | undefined;
  if (mission) {
    let pre: { w: string; status?: string }[] = [];
    try {
      pre = JSON.parse(mission.preteach);
    } catch {
      /* empty */
    }
    // Same "remaining words" rule as the Mission screen (Curriculum.missionRemaining). Ready only when every
    // briefing word was introduced before today (one night of consolidation) — the stored status is not enough.
    const r = ctx.cur.missionReadiness(pre, now);
    briefingPending = r.remaining.length;
    missionReady = r.ready;
    missionTitle = ctx.db.get<{ title: string }>('SELECT title FROM videos WHERE id=?', [mission.video_id])?.title;
  }
  const intro = ctx.cur.introducedToday(now);
  const next = ctx.cur.nextGrammarPoint();
  const plan = planDay({
    date: today,
    mode,
    weekdayMinutes: s.availability.minutes[wd],
    avgDailyMinutes: avg,
    dueMain: ctx.srs.countDue(['word', 'sentence'], now),
    freshMain: ctx.srs.fresh(['word', 'sentence']).length,
    freshIntroducedToday: ctx.cur.freshIntroducedToday(now).length,
    overdueMain: ctx.srs.countOverdue(['word', 'sentence'], now),
    dueGrammar: ctx.srs.countDue(['grammar'], now),
    dueWriting: ctx.srs.countDue(['char'], now),
    forecastMain: ctx.srs.forecast(['word', 'sentence'], 7, now),
    secPerReview: ctx.srs.avgSeconds('word', 8),
    newTarget: s.newWordsPerDay,
    phase: ctx.cur.phase(),
    week: ctx.cur.week(today),
    isGrammarDay: s.grammarDays.includes(wd),
    isWritingDay: s.writingDay === wd,
    isTestDay: s.testDay === wd,
    testDoneThisWeek: ctx.cur.weeklyTestDoneThisWeek(today),
    testable: ctx.cur.introducedWords().size,
    consolidation: ctx.cur.consolidation(),
    missionReady,
    missionTitle,
    missionId: mission?.id,
    briefingPending,
    nextGrammarTitle: next?.title,
    introducedToday: intro.words.length,
    newCharsToday: intro.chars.length,
    done,
  });
  if (ctx.cur.week(today) === 1 && ctx.cur.introducedWords().size === 0)
    plan.notes.unshift('Bienvenue, agent. Semaine 1 : on installe les sons (pinyin, tons) et tes 100 premiers mots de survie. Commence par « Tons & oral », puis tes premiers mots.');
  return plan;
}

export function register(ctx: Ctx): void {
  handle('core:getSettings', () => ctx.settings());
  handle('core:saveSettings', (s: Partial<Settings>) => ctx.saveSettings(s));

  handle('core:plan', (mode?: DayMode) => {
    if (mode) {
      const today = dayKey();
      ctx.db.run('INSERT INTO day_state(date,mode,done) VALUES(?,?,?) ON CONFLICT(date) DO UPDATE SET mode=excluded.mode', [today, mode, '[]']);
    }
    ctx.cur.promoteRecallCards();
    return buildPlan(ctx);
  });

  handle('core:missionReadiness', (missionId: string) => {
    const m = ctx.db.get<{ preteach: string }>('SELECT preteach FROM missions WHERE id=?', [missionId]);
    if (!m) return { ready: false, remaining: [], lastIntro: null };
    return ctx.cur.missionReadiness(JSON.parse(m.preteach));
  });

  handle('core:markBlockDone', (type: BlockType) => {
    const today = dayKey();
    const ds = ctx.db.get<{ mode: string; done: string }>('SELECT * FROM day_state WHERE date=?', [today]);
    const done = new Set<string>(ds ? JSON.parse(ds.done) : []);
    done.add(type);
    ctx.db.run('INSERT INTO day_state(date,mode,done) VALUES(?,?,?) ON CONFLICT(date) DO UPDATE SET done=excluded.done', [
      today,
      ds?.mode ?? 'standard',
      JSON.stringify([...done]),
    ]);
    return true;
  });

  /** Marathon "continue": how many more new words can be added today without overloading the coming days. */
  handle('core:extraAllowance', () => {
    const s = ctx.settings();
    return extraNewAllowance({
      forecastMain: ctx.srs.forecast(['word', 'sentence'], 7),
      avgDailyMinutes: s.availability.minutes.reduce((a, b) => a + b, 0) / 7,
      secPerReview: ctx.srs.avgSeconds('word', 8),
    });
  });

  handle('core:logActivity', (type: string, minutes: number, detail?: unknown) => {
    ctx.db.run('INSERT INTO activity(date,ts,type,minutes,detail) VALUES(?,?,?,?,?)', [dayKey(), Date.now(), type, minutes, detail ? JSON.stringify(detail) : null]);
    return true;
  });

  handle('core:progress', (): Progress => progress(ctx));

  handle('core:lookup', (w: string) => {
    const g = ctx.content.gloss(w);
    const word = ctx.content.wordMap.get(w);
    const st = ctx.cur.wordStatus().get(w);
    const chars = [...w]
      .filter((c) => ctx.content.chars[c] || ctx.content.comps[c])
      .map((c) => ctx.content.chars[c] ?? { c, fr: ctx.content.comps[c].fr, py: [], en: ctx.content.comps[c].en, dec: '', rad: '', ety: null, n: 0, i: -1 });
    return { w, py: g.py, fr: g.fr, en: g.en, status: st ?? null, hsk: word?.band ?? null, inCurriculum: !!word, chars, cl: word?.cl ?? [] };
  });

  handle('core:searchDict', (q: string) => {
    q = q.trim();
    if (!q) return [];
    const out: { w: string; py: string; fr: string[]; en: string[]; hsk: number | null }[] = [];
    const isZh = /\p{Script=Han}/u.test(q);
    const ql = q.toLowerCase();
    const qpy = ql.replace(/\s+/g, '');
    for (const [w, d] of Object.entries(ctx.content.dict)) {
      let hit = false;
      if (isZh) hit = w.includes(q);
      else
        hit =
          d.p.toLowerCase().replace(/[\s\d]/g, '') === qpy.replace(/\d/g, '') ||
          (d.f ?? []).some((x) => x.toLowerCase().split(/[\s,;()]+/).includes(ql)) ||
          (d.f ?? []).some((x) => x.toLowerCase() === ql);
      if (hit) {
        out.push({ w, py: numericToMarks(d.p), fr: d.f ?? [], en: d.e ?? [], hsk: ctx.content.wordMap.get(w)?.band ?? null });
        if (out.length > 400) break;
      }
    }
    out.sort((a, b) => (a.hsk ?? 99) - (b.hsk ?? 99) || a.w.length - b.w.length);
    return out.slice(0, 80);
  });

  handle('core:setWordStatus', (w: string, status: 'known' | 'ignored' | null) => {
    if (status) ctx.db.run('INSERT INTO known_override(word,status) VALUES(?,?) ON CONFLICT(word) DO UPDATE SET status=excluded.status', [w, status]);
    else ctx.db.run('DELETE FROM known_override WHERE word=?', [w]);
    return true;
  });

  handle('core:segment', (text: string): Token[] => {
    const st = ctx.cur.wordStatus();
    const get = (w: string) => st.get(w);
    return segment(text, (w) => !!ctx.content.dict[w]).map((t) => (t.han ? { ...t, status: (composedStatus(t.t, get) as Token['status']) ?? 'new' } : t));
  });

  handle('core:knownWords', () => {
    const out: string[] = [];
    for (const [w, s] of ctx.cur.wordStatus()) if (s !== 'ignored') out.push(w);
    return out;
  });

  handle('core:strokes', (c: string) => ctx.content.strokeData(c));
  handle('core:charInfo', (c: string) => ctx.content.chars[c] ?? null);
  handle('core:openExternal', async (url: string) => {
    const { shell } = await import('electron');
    await shell.openExternal(url);
    return true;
  });
}

function canDo(words: number, grammar: number, listenMin: number): { text: string; ok: boolean }[] {
  return [
    { text: 'Je distingue les 4 tons et lis le pinyin', ok: words >= 30 },
    { text: 'Je me présente (nom, âge, nationalité, métier)', ok: words >= 100 && grammar >= 3 },
    { text: 'Je compte, donne l\'heure et la date', ok: words >= 200 },
    { text: 'Je commande au restaurant et j\'achète au marché', ok: words >= 350 && grammar >= 10 },
    { text: 'Je comprends une histoire HSK 1 sans traduction', ok: words >= 450 && listenMin >= 300 },
    { text: 'Je raconte ma journée au passé (了, 过)', ok: words >= 650 && grammar >= 30 },
    { text: 'Je compare, je donne mon avis, j\'explique pourquoi', ok: words >= 850 && grammar >= 40 },
    { text: 'Je suis un épisode de dessin animé avec sous-titres chinois', ok: words >= 1000 && listenMin >= 900 },
    { text: 'Je tiens une conversation simple de 10 minutes', ok: words >= 1200 && grammar >= 60 },
    { text: 'Niveau HSK 3 : je comprends l\'essentiel d\'un podcast lent', ok: words >= 1500 && grammar >= 80 && listenMin >= 1800 },
  ];
}

export function progress(ctx: Ctx): Progress {
  const s = ctx.settings();
  const st = ctx.cur.wordStatus();
  let known = 0;
  let learning = 0;
  for (const v of st.values()) if (v === 'known') known++;
  else if (v === 'learning') learning++;
  const intro = ctx.cur.introducedWords();
  const introChars = ctx.cur.introducedChars();
  const charKnown = ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM cards WHERE kind='char' AND state=2 AND stability>=4")?.n ?? 0;
  const gs = ctx.cur.grammarStatus();
  const listening = ctx.db.get<{ m: number }>("SELECT COALESCE(SUM(minutes),0) m FROM activity WHERE type IN ('mission','listening','shadowing')")?.m ?? 0;
  const study = ctx.db.get<{ m: number }>('SELECT COALESCE(SUM(minutes),0) m FROM activity')?.m ?? 0;
  const reviewsTotal = ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM reviews')?.n ?? 0;
  const ret = ctx.db.get<{ ok: number; n: number }>(
    'SELECT SUM(CASE WHEN rating>1 THEN 1 ELSE 0 END) ok, COUNT(*) n FROM reviews WHERE state=2 AND ts > ?',
    [Date.now() - 30 * DAY_MS],
  );
  // heatmap: last 26 weeks
  const today = dayKey();
  const reviewDays = new Map<string, number>();
  for (const r of ctx.db.all<{ ts: number }>('SELECT ts FROM reviews WHERE ts > ?', [Date.now() - 190 * DAY_MS])) {
    const k = dayKey(r.ts);
    reviewDays.set(k, (reviewDays.get(k) ?? 0) + 1);
  }
  const minDays = new Map<string, number>();
  for (const r of ctx.db.all<{ date: string; m: number }>('SELECT date, SUM(minutes) m FROM activity GROUP BY date')) minDays.set(r.date, r.m);
  const heatmap: Progress['heatmap'] = [];
  for (let i = 181; i >= 0; i--) {
    const d = addDays(today, -i);
    const reviews = reviewDays.get(d) ?? 0;
    // Review sessions already log their real minutes in `activity` (reviews, grammar, writing…): no per-review estimate.
    heatmap.push({ date: d, reviews, minutes: Math.round(minDays.get(d) ?? 0) });
  }
  let streak = 0;
  for (let i = heatmap.length - 1; i >= 0; i--) {
    if (heatmap[i].reviews > 0 || heatmap[i].minutes > 0) streak++;
    else if (i === heatmap.length - 1) continue; // today not started yet
    else break;
  }
  const phase = ctx.cur.phase();
  const tests = ctx.db
    .all<{ week: number; score: number; ts: number }>("SELECT week, score, ts FROM tests WHERE kind='weekly' ORDER BY ts")
    .map((t) => ({ week: t.week, score: t.score, passed: t.score >= WEEKLY_PASS, date: dayKey(t.ts) }));
  const grammarMastered = gs.filter((g) => g.state === 'mastered').length;
  const grammarStarted = gs.filter((g) => g.lessonDone).length;
  return {
    wordsKnown: known,
    wordsLearning: learning,
    wordsIntroduced: intro.size,
    charsKnown: charKnown,
    charsIntroduced: introChars.size,
    grammarMastered,
    grammarStarted,
    grammarTotal: gs.length,
    listeningMinutes: Math.round(listening),
    studyMinutes: Math.round(study),
    streak,
    reviewsTotal,
    retention30d: ret && ret.n > 20 ? ret.ok / ret.n : null,
    phase,
    phaseName: PHASES[phase].name,
    week: ctx.cur.week(today),
    projectedGoalDate: ctx.cur.projectGoalDate(s.goalWords, s.newWordsPerDay),
    goalWords: s.goalWords,
    heatmap,
    weeklyTests: tests,
    canDo: canDo(intro.size, grammarStarted, listening),
  };
}
