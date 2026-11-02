// Une vidéo YouTube par mot : score (port de scripts/lib/word-video-score.mjs), parité, index, cycle, limiteur, IA.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Db, initSql } from '../src/core/db';
import { Content } from '../src/core/content';
import { Srs } from '../src/core/srs';
import { Curriculum } from '../src/core/curriculum';
import {
  BROKEN_TTL_MS,
  RateLimiter,
  SEARCHED_TTL_MS,
  altFor,
  avoidSameTop,
  classifyYtError,
  currentOf,
  diversify,
  durationScore,
  embedUrl,
  focusScore,
  indexLookup,
  isStoppingYtError,
  isolatedIn,
  orderForSlot,
  parseIndex,
  parseSearchEntries,
  pauseFor,
  pinyinHit,
  playerErrorKind,
  queriesFor,
  queriesForTarget,
  rankCandidates,
  refineOffSlot,
  scoreCandidate,
  shouldAskAi,
  skipCurrent,
  slotLabel,
  stopMessage,
  validateAiPick,
  type ChannelInfo,
  type Entry,
  type Slot,
  type Target,
  type WordVideoIndex,
} from '../src/core/wordVideos';
import { WordVideoService, loadIndex, type WordVideoDeps } from '../src/main/services/wordvideo';
import { AiService, type LlmClient, type LlmRequest } from '../src/main/services/ai';
import type { Settings } from '../src/shared/types';

const root = path.resolve(__dirname, '..');
type RefModule = {
  scoreCandidate: (t: Target, e: Entry, ch?: Record<string, ChannelInfo>) => unknown;
  rankCandidates: (t: Target, es: Entry[], ch?: Record<string, ChannelInfo>, min?: number) => { score: number; offSlot?: boolean; entry: Entry }[];
  queriesFor: (w: string, py: string) => unknown;
  focusScore: (w: string, t: string) => number;
  pinyinHit: (py: string, t: string) => boolean;
};
let ref: RefModule;
let SQL: Awaited<ReturnType<typeof initSql>>;

beforeAll(async () => {
  const refPath = path.join(root, 'scripts/lib/word-video-score.mjs');
  ref = (await import(/* @vite-ignore */ refPath)) as RefModule;
  SQL = await initSql();
}, 60_000);

const E = (title: string, extra: Partial<Entry> = {}): Entry => ({
  id: title.slice(0, 11).padEnd(11, '_'),
  title,
  channel: 'x',
  channel_id: 'UCx',
  duration: 90,
  view_count: 1000,
  description: '',
  ...extra,
});

// ---------------------------------------------------------------- port des tests node --test
describe('score (spécification §4)', () => {
  it('target must be in the title', () => {
    expect(scoreCandidate({ w: '木', py: 'mù', slot: 'etymology' }, E('Chinese characters for trees')).rejected).toBe('target-not-in-title');
  });

  it('focus: delimited/isolated vs embedded and lists', () => {
    expect(focusScore('好', '汉字[好]')).toBe(1);
    expect(focusScore('觉', 'How to write 觉得 (jué de)')).toBeLessThan(0.5);
    expect(focusScore('人', '【常青藤爸爸 字源识字】第一讲：人 从 比 北 众 | 中文汉字 | 国学启蒙 | 动画')).toBeLessThan(0.5);
    expect(focusScore('朋友', 'Péng you 朋友 - Chinese Word of the Day 每日一词')).toBe(1);
  });

  it('pinyin: whole-token for single syllables', () => {
    expect(pinyinHit('mù', 'How to write 木 (mù) – tree')).toBe(true);
    expect(pinyinHit('mù', 'Chinese music for study')).toBe(false);
    expect(pinyinHit('péngyou', 'pengyou (朋友)')).toBe(true);
    expect(pinyinHit('jué de', 'Juéde 觉得 Think or Feel')).toBe(true);
    expect(pinyinHit('xǐ huan', '喜欢/喜歡/xihuan(like)')).toBe(true);
  });

  it('duration trapezoid', () => {
    expect(durationScore(9)).toBe(0);
    expect(durationScore(120)).toBe(1);
    expect(durationScore(1500)).toBe(0);
    expect(durationScore(800)).toBeGreaterThan(0);
    expect(durationScore(800)).toBeLessThan(1);
  });

  it('negative keywords are pushed down', () => {
    const t: Target = { w: '朋友', py: 'péngyou', slot: 'usage' };
    const good = scoreCandidate(t, E('Péng you 朋友 - Chinese Word of the Day 每日一词'));
    const bad = scoreCandidate(t, E('交友英語101：如何成功交到外國朋友？', { duration: 222 }));
    expect(good.score).toBeGreaterThan(2 * bad.score);
  });

  it('curated channel weight and kind influence the etymology slot', () => {
    const t: Target = { w: '木', py: 'mù', slot: 'etymology' };
    const ch: Record<string, ChannelInfo> = { UCety: { weight: 1, kind: 'etymology', language: 'en' }, UCword: { weight: 0.8, kind: 'word', language: 'en' } };
    const r = rankCandidates(
      t,
      [
        E('How to write 木 (mù) – tree; wood – stroke order, radical, examples', { id: 'aaaaaaaaaaa', channel_id: 'UCword', duration: 61 }),
        E('The Story of Chinese Character : 木', { id: 'bbbbbbbbbbb', channel_id: 'UCety', duration: 71 }),
      ],
      ch,
    );
    expect(r[0].entry.id).toBe('bbbbbbbbbbb');
  });

  it('blocked channel and live streams are rejected; ranking is deterministic', () => {
    const t: Target = { w: '好', py: 'hǎo', slot: 'usage' };
    expect(scoreCandidate(t, E('好 good', { channel_id: 'UCbad' }), { UCbad: { weight: 0, kind: 'word', language: 'zh' } }).rejected).toBe('blocked-channel');
    expect(scoreCandidate(t, E('好 good', { live_status: 'is_live' })).rejected).toBe('live');
    const xs = [E('好 hǎo good', { id: 'b' }), E('好 hǎo good', { id: 'a' })];
    expect(rankCandidates(t, xs).map((x) => x.entry.id)).toEqual(['a', 'b']);
  });

  it('query plan: one etymology pair per distinct char + usage queries', () => {
    const q = queriesFor('朋友', 'péngyou');
    expect(q.filter((x) => x.slot === 'etymology').map((x) => x.target)).toEqual(['朋', '朋', '友', '友']);
    expect(q.some((x) => x.query === '朋友 pengyou Chinese word meaning example')).toBe(true);
    expect(queriesForTarget('朋友', 'usage', 'péng you')).toEqual(['朋友 caractère chinois', '朋友 pengyou Chinese word meaning example']);
    expect(queriesForTarget('友', 'etymology', 'yǒu')).toEqual(['友 Chinese character origin', '友 caractère chinois']);
  });

  it('traditional spelling (alt) is accepted for the title match', () => {
    const t: Target = { w: '马', py: 'mǎ', slot: 'etymology', alt: ['馬'] };
    expect(scoreCandidate(t, E('漢字的故事 : 馬')).score).toBeGreaterThan(0.35);
    expect(scoreCandidate({ ...t, alt: [] }, E('漢字的故事 : 馬')).rejected).toBe('target-not-in-title');
  });

  it('etymology slot: a clip with no origin signal is a flagged, down-weighted fallback', () => {
    const ch: Record<string, ChannelInfo> = { UCw: { weight: 0.8, kind: 'word', language: 'en' }, UCe: { weight: 0.8, kind: 'etymology', language: 'en' } };
    const t: Target = { w: '得', py: 'dé', slot: 'etymology' };
    const a = scoreCandidate(t, E('How to write 得 (dé) – obtain – stroke order', { channel_id: 'UCw' }), ch);
    const b = scoreCandidate(t, E('The Story of Chinese Character : 得', { channel_id: 'UCe' }), ch);
    expect(a.offSlot).toBe(true);
    expect(b.offSlot).toBe(false);
    expect(b.score).toBeGreaterThan(a.score);
  });
});

// ---------------------------------------------------------------- parité TS ↔ .mjs
const CH: Record<string, ChannelInfo> = {
  UCety: { weight: 0.9, kind: 'etymology', language: 'zh-Hant+en' },
  UCword: { weight: 0.8, kind: 'word', language: 'en' },
  UCmix: { weight: 0.6, kind: 'mixed', language: 'fr' },
  UCbad: { weight: 0, kind: 'word', language: 'en' },
};
const FIXTURE_TITLES = [
  'The Story of Chinese Character : 馬',
  '漢字的故事 : 好',
  'How to write 好 (hǎo) – good – stroke order, radical, examples and spoken audio',
  'Hǎo 好 Good/well/nice/fine/OK - Chinese Word of the Day 每日一词',
  '【NEW HSK1】_#hsk1 _朋友/pengyou/(friend) How to Pronounce & Write Chinese Vocabulary',
  'Calligraphie chinoise un caractère par jour n°433 : 歡 (欢) joyeux',
  'Etymologie du caractère chinois 好 / Etymology of the Chinese character好',
  '【常青藤爸爸 字源识字】第一讲：人 从 比 北 众 | 中文汉字',
  'HSK 3 full course podcast 朋友 学习',
  '漢字「学」の成り立ち kanji',
  'Juéde 觉得 Think or Feel - Chinese Word of the Day 每日一词',
  'The Story of Chinese Character :覺',
  '人 people LIVE stream',
  '学习 xuéxí — étudier, apprendre (phrases exemple)',
  'Wéi / wèi 为 For / In Order To / Act As / Become - Chinese Word of the Day 每日一词',
];
const FIXTURE_TARGETS: Target[] = [
  { w: '好', py: 'hǎo', slot: 'usage' },
  { w: '好', py: 'hǎo', slot: 'etymology' },
  { w: '马', py: 'mǎ', slot: 'etymology', alt: ['馬'] },
  { w: '朋友', py: 'péngyou', slot: 'usage' },
  { w: '欢', py: 'huān', slot: 'etymology', alt: ['歡'] },
  { w: '人', py: 'rén', slot: 'etymology' },
  { w: '觉', py: 'jué', slot: 'etymology', alt: ['覺'] },
  { w: '觉得', py: 'juéde', slot: 'usage', alt: ['覺得'] },
  { w: '学习', py: 'xuéxí', slot: 'usage', alt: ['學習'] },
  { w: '学', py: 'xué', slot: 'etymology', alt: ['學'] },
  { w: '为', py: 'wèi', slot: 'etymology', alt: ['為', '爲'] },
];
const CHANNEL_IDS = ['UCety', 'UCword', 'UCmix', 'UCbad', 'UCunknown', null];
const fixtureEntries = (): Entry[] =>
  FIXTURE_TITLES.flatMap((title, i) =>
    CHANNEL_IDS.map((cid, j) => ({
      id: `v${String(i).padStart(2, '0')}c${j}_______`.slice(0, 11),
      title,
      channel: cid ?? 'Inconnue',
      channel_id: cid,
      duration: [8, 30, 75, 300, 900, null][(i + j) % 6],
      view_count: [0, 50, 12000, 2_000_000, null][(i * 3 + j) % 5],
      description: j % 2 ? 'Learn the origin and example sentences' : null,
      live_status: title.includes('LIVE') && j === 0 ? 'is_live' : null,
    })),
  );

describe('parité avec scripts/lib/word-video-score.mjs', () => {
  it('scoreCandidate identique sur toutes les combinaisons cible × entrée × chaîne', () => {
    let n = 0;
    for (const t of FIXTURE_TARGETS)
      for (const e of fixtureEntries()) {
        expect(scoreCandidate(t, e, CH)).toEqual(ref.scoreCandidate(t, e, CH));
        n++;
      }
    expect(n).toBe(FIXTURE_TARGETS.length * FIXTURE_TITLES.length * CHANNEL_IDS.length);
  });

  it('rankCandidates et queriesFor identiques', () => {
    for (const t of FIXTURE_TARGETS)
      for (const min of [0.35, 0.5]) {
        const a = rankCandidates(t, fixtureEntries(), CH, min).map((r) => [r.entry.id, r.score, !!r.offSlot]);
        const b = ref.rankCandidates(t, fixtureEntries(), CH, min).map((r) => [r.entry.id, r.score, !!r.offSlot]);
        expect(a).toEqual(b);
      }
    for (const [w, py] of [['朋友', 'péngyou'], ['好', 'hǎo'], ['觉得', 'jué de'], ['绿', 'lǜ']]) expect(queriesFor(w, py)).toEqual(ref.queriesFor(w, py));
  });

  // Données brutes (data-raw/, hors dépôt) : recalcul TS d'un échantillon de l'index généré.
  const dirs = ['data-raw/yt-channels', 'data-raw/yt-channels-full'].map((d) => path.join(root, d)).filter((d) => fs.existsSync(d));
  const indexFile = path.join(root, 'resources/data/word-videos.json');
  it.skipIf(!dirs.length || !fs.existsSync(indexFile))('index généré = pipeline TS (échantillon réel)', () => {
    const catalog = JSON.parse(fs.readFileSync(path.join(root, 'content/catalog/word-video-channels.json'), 'utf8')) as (ChannelInfo & { channelId: string; name: string })[];
    const channels = Object.fromEntries(catalog.filter((c) => c.channelId).map((c) => [c.channelId, c]));
    const byChan = new Map<string, Entry[]>();
    for (const dir of dirs)
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
        const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const cid = d.channel_id || d.id;
        if (!channels[cid]) continue;
        byChan.set(
          cid,
          (d.entries ?? []).filter((e: Entry | null) => e && e.id && e.title).map((e: Entry) => ({ ...e, channel_id: cid, channel: channels[cid].name.trim() })),
        );
      }
    const pool = [...byChan.values()].flat();
    const idx = parseIndex(JSON.parse(fs.readFileSync(indexFile, 'utf8')));
    const words = JSON.parse(fs.readFileSync(path.join(root, 'resources/data/words.json'), 'utf8')) as { w: string; py: string }[];
    const chars = JSON.parse(fs.readFileSync(path.join(root, 'resources/data/chars.json'), 'utf8')).chars as Record<string, { py: string[] }>;
    // mots de ≥ 2 caractères (usage) et caractères (origine) ; alt pris dans l'index (les mots : sans alt → on n'en garde que ceux sans graphie traditionnelle)
    const sample: { t: Target; key: string }[] = [];
    for (const c of ['好', '马', '觉', '学', '人', '水', '家', '朋', '友', '喜', '为', '得', '口', '日', '女', '和', '须', '只', '发', '机', '事', '我', '起'])
      sample.push({ key: `e:${c}`, t: { w: c, py: words.find((x) => x.w === c)?.py ?? chars[c]?.py?.[0] ?? '', slot: 'etymology', alt: idx.alt?.[c] } });
    for (const w of ['朋友', '喜欢', '因为', '认识', '学习', '觉得', '我们', '东西', '时候', '工作'])
      sample.push({ key: `u:${w}`, t: { w, py: words.find((x) => x.w === w)!.py, slot: 'usage', alt: altFor(w, idx.alt) } });
    let compared = 0;
    for (const { t, key } of sample) {
      const forms = [t.w, ...(t.alt ?? [])];
      const cand = pool.filter((e) => forms.some((f) => e.title.includes(f)));
      const ranked = refineOffSlot(t, rankCandidates(t, cand, channels, 0.5), 0.5).map((r) => ({
        id: r.entry.id,
        score: r.score,
        offSlot: !!r.offSlot,
        channel: r.entry.channel ?? '',
        title: r.entry.title,
        duration: r.entry.duration,
      }));
      const mine = diversify(orderForSlot(ranked), 5);
      const stored = indexLookup(idx, t.w, t.slot);
      // alt des mots recomposé caractère par caractère : peut différer de CEDICT (mot à mot) → comparer seulement si identique
      if (t.slot === 'usage' && stored.some((s) => !mine.find((m) => m.id === s.id))) continue;
      expect(stored.map((s) => [s.id, s.score, s.offSlot])).toEqual(mine.map((m) => [m.id, Math.round(m.score * 1000) / 1000, m.offSlot]));
      compared++;
    }
    expect(compared).toBeGreaterThanOrEqual(23);
  }, 60_000);
});

// ---------------------------------------------------------------- index, ordre, libellés
const IDX: WordVideoIndex = {
  v: 1,
  generated: '2026-11-02',
  channels: ['Chou Meizai', 'trainchinese'],
  t: {
    'u:好': [
      ['NVtxHUrcMqA', 'How to write 好 (hǎo)', 69, 1, 935],
      ['bad', 'id invalide', 10, 0, 900],
    ],
    'e:好': [
      ['ASMx2VnOClk', 'The Story of Chinese Character : 好', 80, 0, 833],
      ['j7d7KMvX2Ic', '漢字的故事 : 好', 80, 0, 799],
      ['MvpZCdVbeHc', 'How to write 好 – stroke order', 61, 1, 520, 1],
    ],
  },
  alt: { 马: ['馬'], 习: ['習'], 学: ['學'] },
};

describe('index pré-calculé', () => {
  it('lookup décode les lignes compactes et ignore les ids invalides', () => {
    const e = indexLookup(IDX, '好', 'etymology');
    expect(e.map((x) => x.id)).toEqual(['ASMx2VnOClk', 'j7d7KMvX2Ic', 'MvpZCdVbeHc']);
    expect(e[0]).toEqual({ id: 'ASMx2VnOClk', title: 'The Story of Chinese Character : 好', channel: 'Chou Meizai', duration: 80, score: 0.833, offSlot: false });
    expect(e[2].offSlot).toBe(true);
    expect(indexLookup(IDX, '好', 'usage')).toHaveLength(1);
    expect(indexLookup(IDX, '坏', 'usage')).toEqual([]);
    expect(parseIndex({ v: 2 }).t).toEqual({});
    expect(parseIndex(null).channels).toEqual([]);
  });

  it('le fichier généré existe, est compact et couvre les premiers mots', () => {
    const idx = loadIndex(path.join(root, 'resources/data'))();
    expect(fs.statSync(path.join(root, 'resources/data/word-videos.json')).size).toBeLessThan(1.5 * 1024 * 1024);
    expect(idx.channels.length).toBeGreaterThan(10);
    for (const w of ['好', '朋友', '喜欢']) expect(indexLookup(idx, w, 'usage').length).toBeGreaterThan(0);
    for (const c of ['好', '朋', '马']) expect(indexLookup(idx, c, 'etymology').length).toBeGreaterThan(0);
    for (const rows of Object.values(idx.t)) expect(rows.length).toBeLessThanOrEqual(5);
    // §4.4 : mot d'un caractère → pas la même vidéo en tête des deux emplacements
    for (const c of ['好', '人', '水', '马']) expect(indexLookup(idx, c, 'usage')[0]?.id).not.toBe(indexLookup(idx, c, 'etymology')[0]?.id);
  });

  it('index généré : bonne graphie traditionnelle, pas de vidéo d’un mot composé en « origine », pas de doublon EN/ZH', () => {
    const idx = loadIndex(path.join(root, 'resources/data'))();
    // variantes / caractères fusionnés : une seule forme principale, celle du sens du programme
    expect(idx.alt?.['和']).toBeUndefined(); // pas 龢 / 咊 (variantes)
    expect(idx.alt?.['是']).toBeUndefined(); // pas 昰
    expect(idx.alt?.['只']).toBeUndefined(); // zhǐ « seulement » : 只 (pas 隻 ni 衹)
    expect(idx.alt?.['板']).toBeUndefined(); // pas 闆 (« used in 老闆 »)
    expect(idx.alt?.['发']).toEqual(['發']); // pas 髮 (cheveux)
    expect(idx.alt?.['须']).toEqual(['須']); // pas 鬚 (barbe)
    expect(idx.alt?.['马']).toEqual(['馬']);
    const titles = (c: string) => indexLookup(idx, c, 'etymology').map((v) => v.title);
    for (const [c, bad] of [['和', '龢'], ['须', '鬚'], ['发', '髮'], ['只', '隻'], ['是', '昰']]) for (const t of titles(c)) expect(t).not.toContain(bad);
    // vidéo où le caractère n'est qu'à l'intérieur d'un mot (機器人, 故事, 起源) : jamais « Origine du caractère »
    for (const [k, rows] of Object.entries(idx.t)) {
      if (!k.startsWith('e:')) continue;
      const c = k.slice(2);
      const forms = [c, ...(idx.alt?.[c] ?? [])];
      for (const r of rows) if (r[5] !== 1) expect(forms.some((f) => isolatedIn(f, r[1], forms)), `${k} ${r[1]}`).toBe(true);
    }
    expect(indexLookup(idx, '机', 'etymology').filter((v) => !v.offSlot && v.title.includes('機器人'))).toEqual([]);
    // une chaîne ne propose jamais deux fois la même animation (même durée à ±2 s)
    let pairs = 0;
    for (const rows of Object.values(idx.t))
      for (let a = 0; a < rows.length; a++) for (let b = a + 1; b < rows.length; b++) if (rows[a][3] === rows[b][3] && rows[a][2] > 0 && Math.abs(rows[a][2] - rows[b][2]) <= 2) pairs++;
    expect(pairs).toBe(0);
    const ids = indexLookup(idx, '我', 'etymology').map((v) => v.title);
    expect(ids.filter((t) => /Story of Chinese Character : 我|漢字的故事 : 我/.test(t))).toHaveLength(1);
  });

  it('refineOffSlot : caractère seulement à l’intérieur d’un mot → repli ; ses propres graphies ne comptent pas', () => {
    expect(isolatedIn('机', 'Robot 機器人 jī qì rén', ['机', '機'])).toBe(false);
    expect(isolatedIn('機', 'Robot 機器人 jī qì rén', ['机', '機'])).toBe(false);
    expect(isolatedIn('吗', 'Origin of Chinese Characters - 0104 吗嗎 ma', ['吗', '嗎'])).toBe(true);
    expect(isolatedIn('事', '漢字的故事 : 人')).toBe(false);
    expect(isolatedIn('好', '【好】hǎo')).toBe(true);
    const t: Target = { w: '机', py: 'jī', slot: 'etymology', alt: ['機'] };
    const mk = (id: string, title: string, score: number, offSlot = false) => ({ score, offSlot, entry: { id, title } as Entry });
    const out = refineOffSlot(t, [mk('a', 'China Is in the Bull’s Eye of the Robot Revolution | Robot 機器人', 0.645), mk('b', 'The Story of Chinese Character : 機', 0.6), mk('c', '機器人', 0.4)], 0.35);
    expect(out.map((r) => [r.entry.id, r.score, r.offSlot])).toEqual([
      ['b', 0.6, false],
      ['a', 0.452, true],
    ]);
    // emplacement « usage » : inchangé
    const u = [mk('a', '机器人 jīqìrén', 0.7)];
    expect(refineOffSlot({ ...t, slot: 'usage' }, u, 0.35)).toBe(u);
  });

  it('altFor : variantes du caractère, mot recomposé', () => {
    expect(altFor('马', IDX.alt)).toEqual(['馬']);
    expect(altFor('学习', IDX.alt)).toEqual(['學習']);
    expect(altFor('好', IDX.alt)).toEqual([]);
    expect(altFor('你好', IDX.alt)).toEqual([]);
  });

  it('orderForSlot met les replis offSlot après, diversify limite chaque chaîne', () => {
    const xs = [
      { id: 'a', score: 0.6, offSlot: true, channel: 'A', title: 'x' },
      { id: 'b', score: 0.55, offSlot: false, channel: 'A', title: 'The Story : 覺' },
      { id: 'c', score: 0.54, offSlot: false, channel: 'A', title: 'The Story :覺' },
      { id: 'd', score: 0.53, offSlot: false, channel: 'A', title: '漢字的故事 : 覺' },
      { id: 'e', score: 0.52, offSlot: false, channel: 'A', title: 'autre' },
      { id: 'f', score: 0.51, offSlot: false, channel: 'B', title: 'autre' },
    ];
    expect(orderForSlot(xs).map((x) => x.id)).toEqual(['b', 'c', 'd', 'e', 'f', 'a']);
    // c = doublon de titre de b ; ≤ 2 par chaîne puis complément
    expect(diversify(orderForSlot(xs), 3).map((x) => x.id)).toEqual(['b', 'd', 'f']);
    expect(diversify(orderForSlot(xs), 5).map((x) => x.id)).toEqual(['b', 'd', 'e', 'f', 'a']);
    // même chaîne, même durée à ±2 s = même animation republiée (titre EN / titre ZH) ; autre chaîne : gardée
    const dup = [
      { id: 'en', score: 0.82, channel: 'Chou Meizai', title: 'The Story of Chinese Character : 我', duration: 73 },
      { id: 'zh', score: 0.79, channel: 'Chou Meizai', title: '漢字的故事 : 我', duration: 74 },
      { id: 'other', score: 0.78, channel: 'alittle', title: '[CC] 我 (me)', duration: 73 },
      { id: 'bushou', score: 0.7, channel: 'Chou Meizai', title: 'The BuShou of HanZi : 我', duration: 55 },
    ];
    expect(diversify(dup, 5).map((x) => x.id)).toEqual(['en', 'other', 'bushou']);
    expect(avoidSameTop([{ id: 'x' }, { id: 'y' }], 'x').map((v) => v.id)).toEqual(['y', 'x']);
    expect(avoidSameTop([{ id: 'x' }], 'x').map((v) => v.id)).toEqual(['x']);
  });

  it('libellés FR et URL d’intégration', () => {
    expect(slotLabel('etymology', false)).toBe('Origine du caractère');
    expect(slotLabel('usage', false)).toBe('Le mot en contexte');
    expect(slotLabel('etymology', true, 'How to write 为 (wèi) – stroke order')).toBe('Écriture');
    expect(slotLabel('usage', true, 'The Story of Chinese Character : 好')).toBe('Origine du caractère');
    const u = new URL(embedUrl('NVtxHUrcMqA', 42.7));
    expect(u.origin + u.pathname).toBe('https://www.youtube-nocookie.com/embed/NVtxHUrcMqA');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      enablejsapi: '1',
      rel: '0',
      playsinline: '1',
      cc_load_policy: '1',
      hl: 'fr',
      widget_referrer: 'https://app.operation-mandarin/',
      start: '42',
    });
    expect(embedUrl('NVtxHUrcMqA')).not.toContain('autoplay');
  });
});

// ---------------------------------------------------------------- cycle, limiteur, erreurs
describe('cycle « vidéo suivante »', () => {
  it('passe à la suivante puis boucle', () => {
    let rows = [
      { id: 'a', rank: 0, status: 'ok' },
      { id: 'b', rank: 1, status: 'ok' },
      { id: 'c', rank: 2, status: 'hidden' },
    ];
    const apply = (ch: Map<string, string>) => (rows = rows.map((r) => ({ ...r, status: ch.get(r.id) ?? r.status })));
    expect(currentOf(rows)?.id).toBe('a');
    apply(skipCurrent(rows));
    expect(currentOf(rows)?.id).toBe('b');
    apply(skipCurrent(rows));
    expect(currentOf(rows)?.id).toBe('a'); // boucle, la masquée reste exclue
    expect(rows.find((r) => r.id === 'c')?.status).toBe('hidden');
    expect(currentOf([{ id: 'z', rank: 0, status: 'broken' }])).toBeNull();
  });
});

describe('limiteur de débit', () => {
  it('au plus une requête toutes les 5 s, arrêt définitif', () => {
    let t = 1000;
    const l = new RateLimiter(5000, () => t);
    expect(l.tryTake()).toBe(true);
    expect(l.tryTake()).toBe(false);
    t += 4999;
    expect(l.waitMs()).toBe(1);
    t += 1;
    expect(l.tryTake()).toBe(true);
    l.stop('HTTP Error 429');
    t += 60_000;
    expect(l.tryTake()).toBe(false);
    expect(l.waitMs()).toBe(Infinity);
  });

  it('pause temporaire (réseau) levée à l’échéance ou par resume()', () => {
    let t = 0;
    const l = new RateLimiter(5000, () => t);
    expect(l.tryTake()).toBe(true);
    l.pause(600_000, 'getaddrinfo ENOTFOUND');
    expect(l.blockedReason()).toMatch(/ENOTFOUND/);
    expect(l.waitMs()).toBe(600_000);
    t += 600_000;
    expect(l.blockedReason()).toBeNull();
    expect(l.tryTake()).toBe(true);
    l.pause(600_000, 'timed out');
    l.resume();
    t += 5000;
    expect(l.tryTake()).toBe(true);
    expect(l.stopped).toBeNull();
  });

  it('erreurs bloquantes et entrées de recherche', () => {
    expect(isStoppingYtError('ERROR: [youtube:search] HTTP Error 403: Forbidden')).toBe(true);
    expect(isStoppingYtError('Sign in to confirm you’re not a bot')).toBe(true);
    expect(isStoppingYtError('HTTP Error 429: Too Many Requests')).toBe(true);
    expect(isStoppingYtError('yt-dlp introuvable')).toBe(true);
    // réseau : pause et nouvel essai, pas d'arrêt pour la session
    expect(isStoppingYtError('getaddrinfo ENOTFOUND www.youtube.com')).toBe(false);
    expect(classifyYtError('getaddrinfo ENOTFOUND www.youtube.com')).toBe('network');
    expect(classifyYtError('yt-dlp : délai dépassé (réseau lent ou bloqué ?)')).toBe('network');
    expect(classifyYtError('ERROR: Unable to download webpage: <urlopen error [Errno -3] Temporary failure in name resolution>')).toBe('network');
    expect(classifyYtError('ERROR: Unable to download webpage: HTTP Error 429: Too Many Requests')).toBe('blocked');
    expect(isStoppingYtError('Unexpected token in JSON')).toBe(false);
    expect(classifyYtError('yt-dlp a échoué (code 1) : ERROR: [youtube:search] Unable to extract yt initial data')).toBe('other');
    // cookies mal réglés : message dédié, pas « yt-dlp est absent »
    const ck = 'yt-dlp a échoué (code 1) : ERROR: could not find firefox cookies database in /home/u/.mozilla/firefox';
    expect(classifyYtError(ck)).toBe('cookies');
    expect(stopMessage(ck)).toMatch(/cookies du navigateur/);
    expect(stopMessage(ck)).not.toMatch(/absent/);
    expect(stopMessage('yt-dlp introuvable')).toMatch(/yt-dlp est absent/);
    expect(stopMessage('HTTP Error 403: Forbidden')).toMatch(/YouTube limite/);
    expect(stopMessage('getaddrinfo ENOTFOUND')).toMatch(/Hors ligne/);
    expect(pauseFor('network')).toBeGreaterThan(0);
    expect(pauseFor('other', 1)).toBe(0);
    expect(pauseFor('other', 3)).toBeGreaterThan(0);
    // lecteur : seules les vidéos supprimées / non intégrables sont écartées
    expect([100, 101, 150].map(playerErrorKind)).toEqual(['broken', 'broken', 'broken']);
    expect([2, 5, 153].map(playerErrorKind)).toEqual(['transient', 'transient', 'transient']);
    expect(playerErrorKind(undefined)).toBe('ignore');
    const es = parseSearchEntries({
      entries: [
        { id: 'NVtxHUrcMqA', title: '好', channel_id: 'UCx', uploader: 'X', duration: 69, view_count: 3 },
        { id: 'short', title: 'bad' },
        null,
      ],
    });
    expect(es).toEqual([{ id: 'NVtxHUrcMqA', title: '好', channel: 'X', channel_id: 'UCx', duration: 69, view_count: 3, description: null, live_status: null }]);
  });

  it('IA : seulement si les deux premiers scores sont proches ; réponse validée', () => {
    expect(shouldAskAi('usage', [0.9, 0.5])).toBe(false);
    expect(shouldAskAi('usage', [0.9, 0.88])).toBe(true);
    expect(shouldAskAi('usage', [0.9])).toBe(false);
    expect(shouldAskAi('etymology', [0.83, 0.8])).toBe(true);
    expect(shouldAskAi('etymology', [0.9, 0.6])).toBe(false);
    const c = [{ id: 'NVtxHUrcMqA', duration: 69 }];
    expect(validateAiPick({ id: 'NVtxHUrcMqA', startSec: 12.6, reason: 'ok' }, c)).toEqual({ id: 'NVtxHUrcMqA', startSec: 12, reason: 'ok' });
    expect(validateAiPick({ id: 'NVtxHUrcMqA', startSec: 500 }, c).startSec).toBeNull();
    expect(() => validateAiPick({ id: 'zzzzzzzzzzz' }, c)).toThrow(/absent/);
  });
});

// ---------------------------------------------------------------- service (dépendances factices)
function makeService(over: Partial<WordVideoDeps> = {}) {
  const db = new Db(SQL, null);
  const events: { target: string; slot: Slot }[] = [];
  const queries: string[] = [];
  let t = 0;
  const deps: WordVideoDeps = {
    db,
    index: () => IDX,
    channels: () => ({ UCety: { weight: 0.9, kind: 'etymology', language: 'en', name: 'Chou Meizai' } }),
    pinyin: (x) => ({ 好: 'hǎo', 猫: 'māo', 熊猫: 'xióngmāo', 熊: 'xióng' })[x] ?? '',
    search: async (q) => {
      queries.push(q);
      return [];
    },
    emit: (_ch, p) => events.push(p as { target: string; slot: Slot }),
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    ...over,
  };
  const svc = new WordVideoService(deps);
  return { svc, db, events, queries, advance: (ms: number) => (t += ms) };
}

describe('WordVideoService', () => {
  it('index → cache, puis suivante / pas pertinente / cassée', () => {
    const { svc, db, advance } = makeService();
    const r1 = svc.forTarget('好', 'etymology');
    expect(r1.source).toBe('index');
    expect(r1.video).toMatchObject({ id: 'ASMx2VnOClk', channel: 'Chou Meizai', label: 'Origine du caractère' });
    expect(r1.alternatives).toBe(2);
    expect(svc.forTarget('好', 'etymology').source).toBe('cache');
    const r2 = svc.next('好', 'etymology');
    expect(r2.video?.id).toBe('j7d7KMvX2Ic');
    const r3 = svc.next('好', 'etymology');
    expect(r3.video).toMatchObject({ id: 'MvpZCdVbeHc', offSlot: true, label: 'Écriture' });
    expect(svc.next('好', 'etymology').video?.id).toBe('ASMx2VnOClk'); // boucle
    const r4 = svc.hide('好', 'etymology', 'ASMx2VnOClk', 'irrelevant');
    expect(r4.video?.id).toBe('j7d7KMvX2Ic');
    svc.hide('好', 'etymology', 'j7d7KMvX2Ic', 'broken');
    expect(db.get<{ status: string }>("SELECT status FROM word_videos WHERE video_id='j7d7KMvX2Ic'")?.status).toBe('broken');
    expect(svc.forTarget('好', 'etymology').video?.id).toBe('MvpZCdVbeHc');
    // masquée : jamais ré-insérée depuis l'index
    expect(svc.forTarget('好', 'etymology').alternatives).toBe(0);
    // « broken » expire (blocage par IP, VPN…) ; « pas pertinente » reste
    advance(BROKEN_TTL_MS + 1);
    expect(svc.forTarget('好', 'etymology').alternatives).toBe(1);
    expect(db.get<{ status: string }>("SELECT status FROM word_videos WHERE video_id='j7d7KMvX2Ic'")?.status).toBe('ok');
    expect(db.get<{ status: string }>("SELECT status FROM word_videos WHERE video_id='ASMx2VnOClk'")?.status).toBe('hidden');
  });

  it('cible hors index → recherche en arrière-plan limitée, puis événement ; refaite après 90 jours', async () => {
    const found: Entry[] = [
      { id: 'cat00000001', title: '猫 māo - cat - Chinese Word of the Day 每日一词', channel: 'Taskpins', channel_id: 'UCw', duration: 120, view_count: 1000 },
      { id: 'cat00000002', title: 'English podcast 猫', channel: 'P', channel_id: 'UCp', duration: 3000 },
    ];
    const { svc, events, queries, advance } = makeService({
      search: async (q) => {
        queries.push(q);
        return found;
      },
    });
    const r = svc.forTarget('猫', 'usage');
    expect(r).toMatchObject({ video: null, pending: true, source: 'none' });
    await svc.idle;
    expect(queries).toEqual(['猫 caractère chinois', '猫 mao Chinese word meaning example']);
    expect(events).toContainEqual({ target: '猫', slot: 'usage' });
    const r2 = svc.forTarget('猫', 'usage');
    expect(r2.video?.id).toBe('cat00000001');
    expect(r2.source).toBe('cache');
    expect(r2.alternatives).toBe(0); // le podcast est sous le seuil
    // déjà cherchée : pas de nouvelle requête
    svc.forTarget('猫', 'usage');
    svc.hide('猫', 'usage', 'cat00000001', 'irrelevant');
    await svc.idle;
    expect(queries).toHaveLength(2);
    expect(svc.forTarget('猫', 'usage')).toMatchObject({ video: null, pending: false, source: 'none' });
    advance(SEARCHED_TTL_MS + 1);
    expect(svc.forTarget('猫', 'usage').pending).toBe(true);
    await svc.idle;
    expect(queries).toHaveLength(4);
  });

  it('base existante sans colonne status_at : ajoutée au démarrage', () => {
    const raw = new SQL.Database();
    raw.exec(
      'CREATE TABLE word_videos (target TEXT NOT NULL, slot TEXT NOT NULL, video_id TEXT NOT NULL, title TEXT, channel TEXT, duration INTEGER, score REAL, rank INTEGER, source TEXT, start INTEGER, status TEXT, fetched_at INTEGER, off_slot INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (target, slot, video_id))',
    );
    raw.exec("INSERT INTO word_videos VALUES ('好','etymology','ASMx2VnOClk','t','c',80,0.8,0,'index',NULL,'broken',0,0)");
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wv-')), 'old.db');
    fs.writeFileSync(file, Buffer.from(raw.export()));
    const db = new Db(SQL, file);
    expect(db.all<{ name: string }>('PRAGMA table_info(word_videos)').map((c) => c.name)).toContain('status_at');
    // « broken » sans date (ancienne règle) : redevient candidate
    const { svc } = makeService({ db });
    expect(svc.forTarget('好', 'etymology').video?.id).toBe('ASMx2VnOClk');
  });

  it('recherche ratée (yt-dlp obsolète…) : pas marquée « faite », refaite à la session suivante', async () => {
    const db = new Db(SQL, null);
    let calls = 0;
    const fail = makeService({
      db,
      search: async () => {
        calls++;
        throw new Error('yt-dlp a échoué (code 1) : ERROR: [youtube:search] Unable to extract yt initial data');
      },
    });
    expect(fail.svc.forTarget('奇怪词', 'usage').pending).toBe(true);
    await fail.svc.idle;
    expect(calls).toBe(2);
    expect(fail.svc.limiter.stopped).toBeNull();
    expect(db.get("SELECT 1 FROM word_videos WHERE target='奇怪词' AND video_id='__searched__'")).toBeUndefined();
    // nouvelle session, yt-dlp à jour
    const found: Entry[] = [{ id: 'odd00000001', title: '奇怪词 - Chinese Word of the Day 每日一词', channel_id: 'UCw', duration: 120 }];
    const ok = makeService({
      db,
      search: async () => {
        calls++;
        return found;
      },
    });
    expect(ok.svc.forTarget('奇怪词', 'usage').pending).toBe(true);
    await ok.svc.idle;
    expect(calls).toBe(4);
    expect(ok.svc.forTarget('奇怪词', 'usage').video?.id).toBe('odd00000001');
  });

  it('échecs « other » répétés : pause (pas d’arrêt), puis reprise', async () => {
    let calls = 0;
    const { svc, advance } = makeService({
      search: async () => {
        calls++;
        throw new Error('yt-dlp a échoué (code 1) : ERROR: Unable to extract yt initial data');
      },
    });
    svc.prefetch(['熊猫']);
    await svc.idle;
    expect(calls).toBe(3); // 3ᵉ échec d'affilée → pause, file vidée
    expect(svc.blocked()).toBe(true);
    expect(svc.limiter.stopped).toBeNull();
    expect(svc.forTarget('猫', 'etymology').error).toMatch(/yt-dlp à mettre à jour/);
    advance(31 * 60_000);
    expect(svc.blocked()).toBe(false);
    expect(svc.forTarget('猫', 'etymology').pending).toBe(true);
  });

  it('hors ligne : pause de quelques minutes (pas d’arrêt pour la session), reprise au retour du réseau', async () => {
    let online = false;
    let calls = 0;
    const { svc, events } = makeService({
      search: async () => {
        calls++;
        if (!online) throw new Error('yt-dlp a échoué (code 1) : ERROR: Unable to download webpage: <urlopen error [Errno -3] Temporary failure in name resolution>');
        return [];
      },
    });
    expect(svc.prefetch(['熊猫'])).toBe(3);
    await svc.idle;
    expect(calls).toBe(1); // une seule requête : pause dès la 1ʳᵉ erreur réseau
    expect(svc.limiter.stopped).toBeNull();
    expect(svc.blocked()).toBe(true);
    expect(events).toHaveLength(3); // les écrans en attente sont prévenus
    const r = svc.forTarget('猫', 'etymology');
    expect(r).toMatchObject({ pending: false });
    expect(r.error).toMatch(/Hors ligne/);
    online = true;
    expect(svc.resume()).toBe(true);
    expect(svc.forTarget('猫', 'etymology').pending).toBe(true);
    await svc.idle;
    expect(calls).toBe(3);
  });

  it('priorité : la cible affichée passe devant le pré-chargement', async () => {
    const order: string[] = [];
    const { svc } = makeService({
      search: async (q) => {
        order.push(q.split(' ')[0]);
        return [];
      },
    });
    svc.prefetch(['熊猫']); // 熊猫 (usage), 熊, 猫 (origine)
    svc.forTarget('狗', 'usage'); // affiché à l'écran pendant que la 1ʳᵉ recherche tourne
    svc.forTarget('猫', 'etymology'); // déjà en file : remonte en tête
    await svc.idle;
    expect(order).toEqual(['熊猫', '熊猫', '猫', '猫', '狗', '狗', '熊', '熊']);
  });

  it('1 requête / 5 s et arrêt pour la session au premier 429', async () => {
    const stamps: number[] = [];
    let now = 0;
    let n = 0;
    const { svc, queries } = makeService({
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      search: async (q) => {
        stamps.push(now);
        queries.push(q);
        if (++n === 3) throw new Error('yt-dlp a échoué (code 1) : ERROR: HTTP Error 429: Too Many Requests');
        return [];
      },
    });
    expect(svc.prefetch(['熊猫'])).toBe(3); // usage 熊猫 + origine 熊, 猫
    await svc.idle;
    expect(stamps).toEqual([0, 5000, 10000]);
    expect(svc.limiter.stopped).toMatch(/429/);
    const r = svc.forTarget('猫', 'etymology');
    expect(r.pending).toBe(false);
    expect(r.error).toMatch(/YouTube limite/);
    expect(svc.ensureSearch('熊', 'etymology')).toBe(false);
  });

  it('prefetch ignore les cibles couvertes par l’index', () => {
    const { svc } = makeService();
    expect(svc.prefetch(['好'])).toBe(0);
  });

  it('IA : choix en arrière-plan, jamais bloquant, une fois par cible, pour l’affichage suivant', async () => {
    const picks: string[] = [];
    let resolve!: () => void;
    const gate = new Promise<void>((r) => (resolve = r));
    const { svc, events } = makeService({
      ai: {
        configured: () => true,
        pick: async (target, _slot, cands) => {
          picks.push(target);
          await gate;
          return { id: cands[1].id, startSec: 15 };
        },
      },
    });
    const r = svc.forTarget('好', 'etymology'); // 0.833 vs 0.799 : scores proches
    expect(r.video?.id).toBe('ASMx2VnOClk'); // choix par règles immédiat
    resolve();
    await new Promise((r2) => setTimeout(r2, 0));
    await new Promise((r2) => setTimeout(r2, 0));
    expect(events).toEqual([]); // pas de rechargement : la vidéo à l'écran ne change pas sous les yeux
    const r2 = svc.forTarget('好', 'etymology');
    expect(r2).toMatchObject({ source: 'ai', video: { id: 'j7d7KMvX2Ic', start: 15 } });
    svc.forTarget('好', 'etymology');
    expect(picks).toEqual(['好']);
    // une seule vidéo « usage » → pas d'IA
    svc.forTarget('好', 'usage');
    expect(picks).toEqual(['好']);
  });

  it('IA : le choix de l’utilisateur (« suivante ») l’emporte sur une réponse arrivée après', async () => {
    let resolve!: () => void;
    const gate = new Promise<void>((r) => (resolve = r));
    const { svc } = makeService({
      ai: {
        configured: () => true,
        pick: async (_t, _s, cands) => {
          await gate;
          return { id: cands[0].id, startSec: null };
        },
      },
    });
    expect(svc.forTarget('好', 'etymology').video?.id).toBe('ASMx2VnOClk');
    expect(svc.next('好', 'etymology').video?.id).toBe('j7d7KMvX2Ic');
    resolve();
    await new Promise((r2) => setTimeout(r2, 0));
    await new Promise((r2) => setTimeout(r2, 0));
    expect(svc.forTarget('好', 'etymology')).toMatchObject({ source: 'cache', video: { id: 'j7d7KMvX2Ic' } });
  });

  it('IA non configurée ou en échec : rien ne change', async () => {
    const { svc } = makeService({
      ai: {
        configured: () => true,
        pick: async () => {
          throw new Error('IA non configurée');
        },
      },
    });
    expect(svc.forTarget('好', 'etymology').video?.id).toBe('ASMx2VnOClk');
    await new Promise((r) => setTimeout(r, 0));
    expect(svc.forTarget('好', 'etymology').source).toBe('cache');
  });
});

// ---------------------------------------------------------------- AiService.pickWordVideo (client factice)
describe('AiService.pickWordVideo', () => {
  const settings: Settings = {
    onboarded: true,
    startDate: '2026-10-01',
    availability: { minutes: [60, 60, 60, 60, 60, 60, 60] },
    newWordsPerDay: 8,
    grammarDays: [3],
    writingDay: 0,
    testDay: 0,
    interests: [],
    apiKey: 'sk-test',
    aiModel: 'claude-sonnet-5-5',
    desiredRetention: 0.9,
    pinyinOnUnknownInPlayer: false,
    goalWords: 1500,
    goalDate: '',
  };
  let content: Content;
  beforeAll(() => {
    content = new Content(path.join(root, 'resources/data'), path.join(root, 'content')).load();
  }, 60_000);

  it('valide l’id parmi les candidats (relance une fois sinon) et met en cache', async () => {
    const calls: LlmRequest[] = [];
    const fake: LlmClient = {
      async complete(req) {
        calls.push(req);
        return { text: calls.length === 1 ? '{"id":"inventé1234","startSec":null,"reason":"x"}' : '```json\n{"id":"j7d7KMvX2Ic","startSec":5,"reason":"Explique l’origine."}\n```' };
      },
    };
    const db = new Db(SQL, null);
    const ai = new AiService({ db, content, cur: new Curriculum(db, content, new Srs(db)), settings: () => settings }, () => fake);
    const cands = [
      { id: 'ASMx2VnOClk', title: 'The Story of Chinese Character : 好', channel: 'Chou Meizai', duration: 80 },
      { id: 'j7d7KMvX2Ic', title: '漢字的故事 : 好', channel: 'Chou Meizai', duration: 80 },
    ];
    const r = await ai.pickWordVideo('好', 'etymology', cands);
    expect(r).toEqual({ id: 'j7d7KMvX2Ic', startSec: 5, reason: 'Explique l’origine.' });
    expect(calls).toHaveLength(2);
    expect(calls[0].system).toContain('ORIGINE');
    expect(calls[0].messages[0].content).toContain('id=ASMx2VnOClk');
    expect(calls[1].messages.at(-1)?.content).toMatch(/absent des candidats/);
    await ai.pickWordVideo('好', 'etymology', cands);
    expect(calls).toHaveLength(2); // cache
  });

  it('sans clé : IA non configurée', async () => {
    const db = new Db(SQL, null);
    const ai = new AiService({ db, content, cur: new Curriculum(db, content, new Srs(db)), settings: () => ({ ...settings, apiKey: '' }) });
    await expect(ai.pickWordVideo('好', 'usage', [{ id: 'ASMx2VnOClk', title: 't' }])).rejects.toThrow('IA non configurée');
  });
});
