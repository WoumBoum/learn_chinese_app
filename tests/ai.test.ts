import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Db, initSql } from '../src/core/db';
import { Content } from '../src/core/content';
import { Srs } from '../src/core/srs';
import { Curriculum } from '../src/core/curriculum';
import { initNlp, segment } from '../src/core/nlp';
import { AiService, decomposable, extractJson, textCoverage, type LlmClient, type LlmRequest } from '../src/main/services/ai';
import { ReadingService } from '../src/main/services/reading';
import type { Settings } from '../src/shared/types';

const DEFAULT_SETTINGS_FOR_TEST: Settings = {
  onboarded: true,
  startDate: '2026-10-01',
  availability: { minutes: [60, 60, 60, 60, 60, 60, 60] },
  newWordsPerDay: 8,
  grammarDays: [3],
  writingDay: 0,
  testDay: 0,
  interests: ['nourriture'],
  apiKey: '',
  aiModel: 'claude-sonnet-5-5',
  desiredRetention: 0.9,
  pinyinOnUnknownInPlayer: false,
  goalWords: 1500,
  goalDate: '',
};

const root = path.resolve(__dirname, '..');
let content: Content;
let SQL: Awaited<ReturnType<typeof initSql>>;

beforeAll(async () => {
  SQL = await initSql();
  content = new Content(path.join(root, 'resources/data'), path.join(root, 'content')).load();
  initNlp(content.words.map((w) => w.w));
}, 60_000);

/** Fake LLM: a queue of handlers; each request is recorded. */
class FakeLlm implements LlmClient {
  calls: LlmRequest[] = [];
  constructor(public responder: (req: LlmRequest, n: number) => string) {}
  async complete(req: LlmRequest) {
    this.calls.push(req);
    return { text: this.responder(req, this.calls.length) };
  }
}

function setup(responder: (req: LlmRequest, n: number) => string, settings: Partial<Settings> = { apiKey: 'sk-test' }) {
  const db = new Db(SQL, null);
  const srs = new Srs(db);
  const cur = new Curriculum(db, content, srs);
  let s: Settings = { ...DEFAULT_SETTINGS_FOR_TEST, ...settings };
  const fake = new FakeLlm(responder);
  const keys: string[] = [];
  const ai = new AiService({ db, content, cur, settings: () => s }, (k) => (keys.push(k), fake));
  const setSettings = (p: Partial<Settings>) => (s = { ...s, ...p });
  /** Mark words as known (override table). */
  const know = (words: string[]) => {
    for (const w of words) db.run("INSERT OR REPLACE INTO known_override(word,status) VALUES(?, 'known')", [w]);
  };
  const addVideo = (id: string, lines: string[]) => {
    db.run("INSERT INTO videos(id,url,title,status,added_at) VALUES(?,?,?,'ready',?)", [id, 'https://x', 'Test vidéo', Date.now()]);
    lines.forEach((t, i) =>
      db.run('INSERT INTO segments(video_id,idx,start,end,text,tokens) VALUES(?,?,?,?,?,?)', [id, i, i * 2, i * 2 + 2, t, JSON.stringify(segment(t, (w) => !!content.dict[w]))]),
    );
  };
  return { db, cur, ai, fake, keys, setSettings, know, addVideo };
}

const BASIC = ['我', '你', '他', '是', '的', '了', '不', '很', '好', '有', '在', '去', '吃', '喝', '水', '茶', '人', '大', '小', '天', '今天', '明天', '我们', '他们', '说', '看', '想', '要', '和', '一', '个', '这', '那', '吗', '呢', '家', '朋友', '学生', '老师', '中国', '吧', '也', '都', '买', '东西', '喜欢', '来', '多', '少', '钱'];

describe('JSON extraction', () => {
  it('handles fences, prose and nested strings with braces', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Voici : {"a":"x}y","b":[1,{"c":2}]} merci')).toEqual({ a: 'x}y', b: [1, { c: 2 }] });
    expect(extractJson('[1,2] puis {"z":1}')).toEqual([1, 2]);
    expect(extractJson('bla {cassé} {"ok":true}')).toEqual({ ok: true });
    expect(() => extractJson('pas de json')).toThrow();
  });
});

describe('coverage helpers', () => {
  it('decomposes free combinations but not lexical words', () => {
    const known = new Set(['我们', '的', '很', '好', '东', '西']);
    expect(decomposable('我们的', known)).toBe(true);
    expect(decomposable('东西', known)).toBe(true);
    const toks = [
      { t: '我们的', han: true },
      { t: '东西', han: true },
      { t: '很好', han: true },
      { t: '猫', han: true },
      { t: '。', han: false },
    ];
    const c = textCoverage(toks, known, new Set(['猫']), (w) => w === '东西');
    expect(c.total).toBe(4);
    expect(c.covered).toBe(3); // 东西 is a real word → unknown even if 东 and 西 are known
    expect(c.unknown).toEqual(['东西']);
    expect(c.targetsUsed).toEqual(['猫']);
  });
});

describe('AiService', () => {
  it('reports status and refuses without a key', async () => {
    const { ai, fake } = setup(() => '{}', { apiKey: '' });
    expect(ai.status()).toEqual({ configured: false, model: 'claude-sonnet-5-5' });
    await expect(ai.explainLine('你好')).rejects.toThrow('IA non configurée');
    await expect(ai.story()).rejects.toThrow('IA non configurée');
    expect(await ai.test()).toMatchObject({ ok: false, error: 'IA non configurée' });
    expect(fake.calls.length).toBe(0);
  });

  it('test() makes a small call with the configured model', async () => {
    const { ai, fake, setSettings } = setup(() => 'ok');
    setSettings({ aiModel: 'claude-haiku-5-5' });
    expect(await ai.test()).toEqual({ ok: true, model: 'claude-haiku-5-5' });
    expect(fake.calls[0].model).toBe('claude-haiku-5-5');
    expect(fake.calls[0].maxTokens).toBeLessThan(1000);
  });

  it('test() surfaces client errors', async () => {
    const db = new Db(SQL, null);
    const cur = new Curriculum(db, content, new Srs(db));
    const ai = new AiService({ db, content, cur, settings: () => ({ ...DEFAULT_SETTINGS_FOR_TEST, apiKey: 'bad' }) }, () => ({
      complete: async () => {
        throw new Error('Clé API invalide');
      },
    }));
    expect(await ai.test()).toMatchObject({ ok: false, error: 'Clé API invalide' });
  });

  it('retries once on invalid JSON then succeeds, and caches the result', async () => {
    const { ai, fake, addVideo, db } = setup((_req, n) =>
      n === 1 ? 'Désolé, voici: {pas du json' : '{"summary":"Une petite fille cherche son chat dans le quartier.","themes":["vie quotidienne","Nature","inventé"]}',
    );
    addVideo('v1', ['我的猫呢？']);
    const s = db;
    const r = await ai.analyzeVideo('v1');
    expect(r.themes).toEqual(['vie quotidienne', 'nature']);
    expect(fake.calls.length).toBe(2);
    // the retry carries the bad answer and an explanation
    expect(fake.calls[1].messages.length).toBe(3);
    expect(fake.calls[1].messages[2].content).toMatch(/inutilisable/);
    const v = s.get<{ summary: string; themes: string }>("SELECT summary, themes FROM videos WHERE id='v1'")!;
    expect(v.summary).toMatch(/chat/);
    expect(JSON.parse(v.themes)).toEqual(['vie quotidienne', 'nature']);
    await ai.analyzeVideo('v1');
    expect(fake.calls.length).toBe(2); // cache hit
  });

  it('fails clearly after two invalid answers', async () => {
    const { ai, addVideo } = setup(() => '{"summary":"","themes":[]}');
    addVideo('v2', ['你好']);
    await expect(ai.analyzeVideo('v2')).rejects.toThrow(/Réponse IA invalide/);
  });

  it('refinePreteach: AI keeps key words with contextual meaning and updates the mission', async () => {
    const lines = ['小明今天去超市买苹果。', '超市里的苹果很贵。', '哎呀，苹果太贵了！', '小明决定买香蕉。', '香蕉很便宜。'];
    const { ai, fake, know, addVideo, db } = setup((req) => {
      const cands = JSON.parse(req.messages[0].content.split('ex = contexte) :\n')[1]) as { w: string }[];
      return JSON.stringify({
        words: cands.map((c) => ({
          w: c.w,
          exclude: c.w === '小明' || c.w === '哎呀',
          key: c.w === '苹果' || c.w === '超市',
          contextFr: c.w === '苹果' ? 'pomme(s)' : 'sens ici',
        })),
      });
    });
    know(['今天', '去', '买', '里', '的', '很', '太', '了', '决定']);
    addVideo('v3', lines);
    db.run("INSERT INTO missions(id,video_id,planned_date,status,preteach,created) VALUES('m1','v3','2026-11-01','planned','[]',0)");
    const res = await ai.refinePreteach('v3');
    const ws = res.map((r) => r.w);
    expect(ws).not.toContain('小明');
    expect(ws).not.toContain('哎呀');
    expect(res[0].key).toBe(true); // key words first
    expect(res.find((r) => r.w === '苹果')).toMatchObject({ key: true, contextFr: 'pomme(s)', status: 'new' });
    const m = JSON.parse(db.get<{ preteach: string }>("SELECT preteach FROM missions WHERE id='m1'")!.preteach);
    expect(m.map((x: { w: string }) => x.w)).toEqual(ws);
    expect(fake.calls[0].system).toMatch(/noms propres/);
  });

  it('translateLines translates in batches and fills segments.fr', async () => {
    const { ai, fake, addVideo, db } = setup((req) => {
      const idx = [...req.messages[0].content.matchAll(/^\[(\d+)\]/gm)].map((m) => +m[1]);
      return JSON.stringify({ lines: idx.map((i) => ({ i, fr: `ligne ${i}` })) });
    });
    addVideo('v4', Array.from({ length: 55 }, (_, i) => `第${i}句话。`));
    expect(await ai.translateLines('v4')).toBe(55);
    expect(fake.calls.length).toBe(2);
    expect(db.get<{ fr: string }>("SELECT fr FROM segments WHERE video_id='v4' AND idx=54")!.fr).toBe('ligne 54');
    expect(await ai.translateLines('v4')).toBe(0); // nothing left to do
  });

  it('quiz validates and shuffles options keeping the right answer', async () => {
    const q = (k: number) => ({ question: `Q${k} ?`, options: ['bonne', 'b', 'c', 'd'], answer: 0, lineIdx: 99 });
    const { ai, addVideo } = setup(() => JSON.stringify({ questions: [q(1), q(2), q(3), q(4), q(5), { question: 'mauvaise', options: ['a'], answer: 3 }] }));
    addVideo('v5', ['你好。', '再见。']);
    const qs = await ai.quiz('v5');
    expect(qs.length).toBe(5);
    for (const x of qs) {
      expect(x.options[x.answer]).toBe('bonne');
      expect(x.lineIdx).toBe(0); // invalid line index replaced
    }
  });

  it('correct: exact answers skip the API, other answers are judged', async () => {
    const { ai, fake } = setup(() => '{"correct":true,"corrected":"我很喜欢茶","explanation":"Correct, ordre naturel."}');
    expect((await ai.correct({ fr: "J'aime le thé.", userZh: '我喜欢茶。', answers: ['我喜欢茶'] })).correct).toBe(true);
    expect(fake.calls.length).toBe(0);
    const r = await ai.correct({ fr: "J'aime beaucoup le thé.", userZh: '我很喜欢茶', answers: ['我非常喜欢茶'] });
    expect(r).toEqual({ correct: true, corrected: '我很喜欢茶', explanation: 'Correct, ordre naturel.' });
    expect(fake.calls[0].messages[0].content).toMatch(/我非常喜欢茶/);
  });

  it('story: uses known words + curriculum targets, regenerates when coverage < 90 %, stores it', async () => {
    let storyN = 0;
    const { ai, fake, know, db, cur } = setup((req) => {
      storyN++;
      const targets = req.messages[0].content.match(/Mots cibles \(à introduire\) : (.*)/)![1].split(', ').map((x) => x.split(' ')[0]);
      if (storyN === 1) return JSON.stringify({ title: '复杂的故事', paragraphs: [{ zh: '鳄鱼瞬间吞噬了伟大的皇帝。', fr: 'x' }] });
      return JSON.stringify({ title: '我的朋友', paragraphs: [{ zh: `我有一个朋友。他很好。${targets[0]}，${targets[0]}！`, fr: "J'ai un ami." }, { zh: `今天我们去他家喝茶。${targets[1]}。`, fr: 'Thé.' }] });
    });
    know(BASIC);
    const next = cur.nextWords(10).map((w) => w.w);
    const r = await ai.story({ theme: 'famille', length: 'short' });
    expect(fake.calls.length).toBe(2);
    expect(fake.calls[1].messages[0].content).toMatch(/trop de mots hors liste/);
    expect(r.attempts).toBe(2);
    expect(r.coverage).toBeGreaterThan(0.9);
    expect(r.targetWords.length).toBeGreaterThanOrEqual(2);
    expect(r.targetWords.every((t) => next.includes(t.w))).toBe(true);
    expect(fake.calls[0].messages[0].content).toMatch(/朋友/); // known list sent
    const row = db.get<{ title: string; zh: string; theme: string }>('SELECT * FROM stories WHERE id=?', [r.id])!;
    expect(row).toMatchObject({ title: '我的朋友', theme: 'famille' });
    expect(row.zh.split('\n\n').length).toBe(2);
    // reading service exposes it with tokens and new words (targets)
    const rs = new ReadingService({ db, content, cur });
    const full = rs.story(r.id);
    expect(full.paragraphs.length).toBe(2);
    expect(full.newWords.map((w) => w.w)).toContain(r.targetWords[0].w);
    expect(rs.stories()[0].id).toBe(r.id);
  });

  it('story refuses when the learner knows too few words', async () => {
    const { ai } = setup(() => '{}');
    await expect(ai.story()).rejects.toThrow(/au moins 40 mots/);
  });

  it('roleplay: returns reply, hidden translation, corrections only when the learner spoke', async () => {
    const { ai, fake, know } = setup(() =>
      JSON.stringify({
        reply: '你好！你要喝什么？',
        fr: 'Bonjour ! Que veux-tu boire ?',
        corrections: [{ yourText: '我要一茶', better: '我要一杯茶', explanation: 'Il faut un classificateur : 杯.' }],
        tiles: ['我', '要', '茶', 'coffee', '杯'],
        goalReached: false,
        hint: 'Commande une boisson.',
      }),
    );
    know(BASIC);
    const sc = { title: 'Au café', setting: 'Un café de Pékin', character: 'serveur', goal: 'commander un thé' };
    const first = await ai.roleplay({ scenario: sc, messages: [] });
    expect(first.corrections).toEqual([]); // nothing to correct yet
    expect(first.tiles).toEqual(['我', '要', '茶', '杯']);
    const r = await ai.roleplay({ scenario: sc, messages: [{ role: 'assistant', zh: '你好！' }, { role: 'user', zh: '我要一茶' }] });
    expect(r.corrections[0].better).toBe('我要一杯茶');
    expect(fake.calls[1].messages[0].content).toMatch(/Dernière réplique de l'apprenant à corriger : 我要一茶/);
    expect(fake.calls[1].system).toMatch(/Au café/);
  });

  it('explainLine sends unknown words and level, returns markdown (cached)', async () => {
    const { ai, fake, know } = setup(() => '### Sens\nJe bois du thé.');
    know(['我', '喝']);
    const md = await ai.explainLine('我喝绿茶。');
    expect(md).toMatch(/### Sens/);
    expect(fake.calls[0].messages[0].content).toMatch(/Mots inconnus de l'apprenant : .*绿茶|茶/);
    expect(fake.calls[0].system).toMatch(/pinyin/);
    await ai.explainLine('我喝绿茶。');
    expect(fake.calls.length).toBe(1);
  });

  it('confusions: aggregates failed reviews and validates drills', async () => {
    const { ai, fake, db, know } = setup(() =>
      JSON.stringify({
        summary: 'Tu confonds 再 et 又.',
        pairs: [{ a: '再', b: '又', explanation: '再 = futur, 又 = passé.' }],
        drills: [
          { type: 'cloze', zh: '明天＿＿来。', options: ['再', '又'], answer: '再', fr: 'Reviens demain.' },
          { type: 'cloze', zh: '他昨天又来了。', options: ['再', '又'], answer: '又', fr: 'Il est revenu hier.' },
          { type: 'cloze', zh: '错误', options: ['a'], answer: 'b', fr: '' },
        ],
      }),
    );
    know(['又', '再', '明天']);
    // no errors → no API call
    expect((await ai.confusions()).drills).toEqual([]);
    expect(fake.calls.length).toBe(0);
    const now = Date.now();
    db.run("INSERT INTO cards(id,kind,face,ref,due,created) VALUES('word:meaning:再','word','meaning','再',0,0)");
    for (let i = 0; i < 3; i++) db.run("INSERT INTO reviews(card_id,ts,rating,state,elapsed) VALUES('word:meaning:再',?,1,2,1)", [now - i * 1000]);
    db.run("INSERT INTO reviews(card_id,ts,rating,state,elapsed) VALUES('word:meaning:再',?,1,2,1)", [now - 40 * 86400000]); // too old
    const data = ai.confusionData(now);
    expect(data.failed).toEqual([{ w: '再', count: 3, faces: ['meaning'] }]);
    expect(data.neighbours[0].similar).toContain('又');
    const r = await ai.confusions();
    expect(r.pairs.length).toBe(1);
    expect(r.drills.length).toBe(2);
    expect(r.drills[1].zh).toBe('他昨天＿＿来了。'); // answer blanked automatically
  });
});

describe('ReadingService.sentences', () => {
  it('returns only fully known sentences, or exactly one unknown word in i+1 mode', () => {
    const { db, cur, know } = setup(() => '');
    know(BASIC);
    const rs = new ReadingService({ db, content, cur });
    const known = rs.sentences({ n: 5, mode: 'known' });
    expect(known.length).toBeGreaterThan(0);
    for (const s of known) {
      expect(s.unknown).toEqual([]);
      expect(s.tokens.filter((t) => t.han).every((t) => t.status === 'known')).toBe(true);
    }
    const ip1 = rs.sentences({ n: 5, mode: 'i+1' });
    expect(ip1.length).toBeGreaterThan(0);
    for (const s of ip1) {
      expect(s.unknown.length).toBe(1);
      const unk = s.tokens.filter((t) => t.status === 'new');
      expect(unk.every((t) => t.py !== undefined || t.t === s.unknown[0].w)).toBe(true);
    }
    const ex = rs.sentences({ n: 50, mode: 'known', exclude: known.map((k) => k.id) });
    expect(ex.some((s) => known.some((k) => k.id === s.id))).toBe(false);
  });
});
