// Study channels: review queues, new-word batches, introductions, sentence mining, writing sessions.
import type { Ctx } from '../ctx';
import { handle } from '../ctx';
import type { CardRow, CharInfo, Grade, Sentence, StudyCard, Word } from '../../shared/types';
import { Srs, composeQueue } from '../../core/srs';
import { numericToMarks } from '../../core/content';
import { isHan } from '../../core/nlp';

export function wordInfo(ctx: Ctx, w: string): Word {
  const word = ctx.content.wordMap.get(w);
  if (word) return word;
  const d = ctx.content.dict[w];
  return {
    w,
    py: d ? numericToMarks(d.p) : '',
    pn: d?.p ?? '',
    fr: d?.f ?? [],
    en: d?.e ?? [],
    band: 9,
    old: 9,
    freq: 999999,
    pos: [],
    cl: [],
    rank: 99999,
  };
}

function charInfo(ctx: Ctx, c: string): CharInfo {
  return ctx.content.chars[c] ?? { c, i: -1, py: [], fr: ctx.content.comps[c]?.fr ?? [], en: ctx.content.comps[c]?.en ?? '', dec: '', rad: '', ety: null, n: 0 };
}

export function toStudyCard(ctx: Ctx, card: CardRow, now = Date.now()): StudyCard {
  const sc: StudyCard = { card };
  const pv = ctx.srs.preview(card, now);
  sc.intervals = { 1: String(pv[1]), 2: String(pv[2]), 3: String(pv[3]), 4: String(pv[4]) };
  if (card.kind === 'word') sc.word = wordInfo(ctx, card.ref);
  else if (card.kind === 'char') sc.char = charInfo(ctx, card.ref);
  else if (card.kind === 'grammar') sc.grammarId = card.ref;
  else if (card.kind === 'sentence') {
    const m = ctx.db.get<{ zh: string; fr: string | null; video_id: string | null; start: number | null; end: number | null }>('SELECT * FROM mined WHERE id=?', [card.ref]);
    if (m) {
      const v = m.video_id ? ctx.db.get<{ path: string | null }>('SELECT path FROM videos WHERE id=?', [m.video_id]) : undefined;
      sc.sentence = { zh: m.zh, fr: m.fr ?? '', videoPath: v?.path ?? undefined, start: m.start ?? undefined, end: m.end ?? undefined };
    }
  }
  return sc;
}

/** Sentences whose characters are all known (or in `extra`), for writing and reading practice. */
export function sentencesWithin(ctx: Ctx, chars: Set<string>, opts: { min?: number; max?: number; limit?: number; mustContain?: string } = {}): Sentence[] {
  const out: Sentence[] = [];
  const { min = 4, max = 14, limit = 10, mustContain } = opts;
  const pool = ctx.content.sentences;
  const start = Math.floor(Math.random() * pool.length);
  for (let k = 0; k < pool.length && out.length < limit; k++) {
    const s = pool[(start + k) % pool.length];
    const han = [...s.zh].filter((c) => isHan(c));
    if (han.length < min || han.length > max) continue;
    if (mustContain && !s.zh.includes(mustContain)) continue;
    if (han.every((c) => chars.has(c))) out.push(s);
  }
  return out;
}

const CURRENT_MISSION_SQL = "SELECT id, preteach FROM missions WHERE status IN ('planned','briefing','ready') ORDER BY planned_date LIMIT 1";

/** The mission being briefed: the one the renderer names, else the next one (same choice as the daily plan). */
function briefedMission(ctx: Ctx, missionId?: string): { id: string; preteach: { w: string; status?: string; contextFr?: string }[] } | undefined {
  const m = missionId
    ? ctx.db.get<{ id: string; preteach: string }>('SELECT id, preteach FROM missions WHERE id=?', [missionId])
    : ctx.db.get<{ id: string; preteach: string }>(CURRENT_MISSION_SQL);
  if (!m) return undefined;
  let pre: { w: string; status?: string; contextFr?: string }[] = [];
  try {
    pre = JSON.parse(m.preteach);
  } catch {
    /* empty */
  }
  return { id: m.id, preteach: pre };
}

export function register(ctx: Ctx): void {
  handle('study:queue', (opts: { queue: 'main' | 'grammar' | 'writing'; limit?: number; includeNew?: boolean }) => {
    const now = Date.now();
    const limit = opts.limit ?? 500;
    const kinds = opts.queue === 'main' ? (['word', 'sentence'] as const) : opts.queue === 'grammar' ? (['grammar'] as const) : (['char'] as const);
    const due = ctx.srs.due([...kinds], now, limit);
    const withNew = opts.includeNew !== false && opts.queue !== 'grammar';
    const fresh = withNew ? ctx.srs.fresh([...kinds], limit) : [];
    // words introduced today always get their first review, even when due cards fill the limit (the daily
    // plan counts them in the review block: Curriculum.freshIntroducedToday)
    const reserved = withNew && opts.queue === 'main' ? ctx.cur.freshIntroducedToday(now) : [];
    return composeQueue(due, fresh, reserved, limit).map((c) => toStudyCard(ctx, c, now));
  });

  handle('study:answer', (id: string, grade: Grade, durationMs?: number) => {
    const card = ctx.srs.review(id, grade, Date.now(), durationMs ?? 0);
    return toStudyCard(ctx, card);
  });

  handle('study:counts', () => ({
    main: ctx.srs.countDue(['word', 'sentence']),
    mainNew: ctx.srs.fresh(['word', 'sentence']).length,
    grammar: ctx.srs.countDue(['grammar']),
    writing: ctx.srs.countDue(['char']) + ctx.srs.fresh(['char']).length,
  }));

  handle('study:newBatch', (opts: { count: number; source?: 'curriculum' | 'mission'; missionId?: string }) => {
    const knownChars = ctx.cur.knownChars();
    const introChars = ctx.cur.introducedChars();
    let list: Word[] = [];
    if (opts.source === 'mission') {
      const m = briefedMission(ctx, opts.missionId);
      const pre = m?.preteach ?? [];
      // shared rule: skips words already introduced and words marked known / ignored by the learner
      const remaining = new Set(ctx.cur.missionRemaining(pre));
      list = pre.filter((p) => remaining.has(p.w)).slice(0, Math.max(0, opts.count)).map((p) => {
        const w = wordInfo(ctx, p.w);
        return p.contextFr ? { ...w, fr: [p.contextFr, ...w.fr.filter((f) => f !== p.contextFr)] } : w;
      });
    } else list = ctx.cur.nextWords(opts.count);
    const seenChars = new Set(introChars);
    return list.map((w) => {
      const chars = [...w.w].filter((c) => isHan(c)).map((c) => ({ ...charInfo(ctx, c), isNew: !seenChars.has(c) }));
      for (const c of w.w) seenChars.add(c);
      const comps = chars.flatMap((ch) =>
        [...(ch.dec || '')]
          .filter((k) => !/[⿰-⿻？]/.test(k) && k !== ch.c)
          .map((k) => ({ c: k, fr: (ctx.content.chars[k]?.fr ?? ctx.content.comps[k]?.fr ?? []).slice(0, 2), en: ctx.content.chars[k]?.en ?? ctx.content.comps[k]?.en ?? '' })),
      );
      return { word: w, chars, comps, examples: ctx.content.examplesFor(w.w, new Set([...knownChars, ...w.w]), 2) };
    });
  });

  handle('study:introduce', (words: string[], source: string = 'curriculum', missionId?: string) => {
    const newChars: string[] = [];
    for (const w of words) newChars.push(...ctx.cur.introduceWord(w, source).newChars);
    if (source === 'mission') {
      // update the mission actually being briefed (not merely the earliest one)
      const m = briefedMission(ctx, missionId);
      const status = m && ctx.db.get<{ status: string }>('SELECT status FROM missions WHERE id=?', [m.id])?.status;
      if (m && status !== 'done') {
        // 'ready' = vocabulary in place; the daily plan still waits one night before offering the field mission
        const left = ctx.cur.missionRemaining(m.preteach).length;
        ctx.db.run('UPDATE missions SET status=? WHERE id=?', [left === 0 ? 'ready' : 'briefing', m.id]);
      }
    }
    return { newChars };
  });

  handle('study:addWord', (w: string, source: string = 'video') => {
    const r = ctx.cur.introduceWord(w, source);
    return r;
  });

  handle('study:mine', (m: { videoId?: string; zh: string; fr?: string; start?: number; end?: number }) => {
    const id = `${m.videoId ?? 'x'}-${Math.round((m.start ?? Date.now()) * 1000)}`;
    ctx.db.run('INSERT OR REPLACE INTO mined(id,video_id,zh,fr,start,end,created) VALUES(?,?,?,?,?,?,?)', [
      id,
      m.videoId ?? null,
      m.zh,
      m.fr ?? null,
      m.start ?? null,
      m.end ?? null,
      Date.now(),
    ]);
    ctx.srs.ensureCard('sentence', 'listen', id);
    return id;
  });

  handle('study:mined', () => ctx.db.all('SELECT * FROM mined ORDER BY created DESC LIMIT 200'));

  handle('study:examples', (w: string) => ctx.content.examplesFor(w, ctx.cur.knownChars(), 5));

  handle('study:suspend', (id: string) => {
    ctx.db.run('UPDATE cards SET suspended=1 WHERE id=?', [id]);
    return true;
  });

  /** Paper writing session: characters (due + new), words, sentences to copy / write from memory / dictation. */
  handle('study:writingSession', (opts: { long?: boolean }) => {
    const now = Date.now();
    const due = ctx.srs.due(['char'], now, opts.long ? 15 : 10);
    const fresh = ctx.srs.fresh(['char'], Math.max(0, (opts.long ? 15 : 10) - due.length));
    const introWords = [...ctx.cur.introducedWords()];
    const chars = [...fresh, ...due].map((card) => {
      const info = charInfo(ctx, card.ref);
      return {
        cardId: card.id,
        isNew: card.state === 0,
        char: info,
        words: introWords.filter((w) => w.includes(card.ref)).slice(0, 4).map((w) => ({ w, fr: wordInfo(ctx, w).fr.slice(0, 2) })),
        intervals: (() => {
          const p = ctx.srs.preview(card, now);
          return { 1: p[1], 2: p[2], 3: p[3], 4: p[4] };
        })(),
      };
    });
    if (!opts.long) return { chars, words: [], copy: [], recall: [], dictation: [] };
    const introChars = ctx.cur.introducedChars();
    const pool = sentencesWithin(ctx, introChars, { min: 4, max: 12, limit: 9 });
    const words = introWords
      .filter((w) => w.length > 1)
      .sort(() => Math.random() - 0.5)
      .slice(0, 5)
      .map((w) => ({ w, fr: wordInfo(ctx, w).fr.slice(0, 2) }));
    return {
      chars,
      words,
      copy: pool.slice(0, 3).map((s) => ({ zh: s.zh, fr: s.fr[0] })),
      recall: pool.slice(3, 6).map((s) => ({ zh: s.zh, fr: s.fr[0] })),
      dictation: pool.slice(6, 9).map((s) => ({ zh: s.zh, fr: s.fr[0] })),
    };
  });

  handle('study:cardId', (kind: 'word' | 'char', face: string, ref: string) => Srs.id(kind, face as never, ref));
}
