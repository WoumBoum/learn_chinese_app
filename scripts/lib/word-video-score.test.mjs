// node --test scripts/lib/word-video-score.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreCandidate, rankCandidates, focusScore, pinyinHit, durationScore, queriesFor } from './word-video-score.mjs';

const E = (title, extra = {}) => ({ id: title.slice(0, 11).padEnd(11, '_'), title, channel: 'x', channel_id: 'UCx', duration: 90, view_count: 1000, description: '', ...extra });

test('target must be in the title', () => {
  assert.equal(scoreCandidate({ w: '木', py: 'mù', slot: 'etymology' }, E('Chinese characters for trees')).rejected, 'target-not-in-title');
});

test('focus: delimited/isolated vs embedded and lists', () => {
  assert.equal(focusScore('好', '汉字[好]'), 1);
  assert.ok(focusScore('觉', 'How to write 觉得 (jué de)') < 0.5); // embedded in a compound
  assert.ok(focusScore('人', '【常青藤爸爸 字源识字】第一讲：人 从 比 北 众 | 中文汉字 | 国学启蒙 | 动画') < 0.5); // list of many chars
  assert.equal(focusScore('朋友', 'Péng you 朋友 - Chinese Word of the Day 每日一词'), 1);
});

test('pinyin: whole-token for single syllables', () => {
  assert.ok(pinyinHit('mù', 'How to write 木 (mù) – tree'));
  assert.ok(!pinyinHit('mù', 'Chinese music for study'));
  assert.ok(pinyinHit('péngyou', 'pengyou (朋友)'));
  assert.ok(pinyinHit('jué de', 'Juéde 觉得 Think or Feel'));
  assert.ok(pinyinHit('xǐ huan', '喜欢/喜歡/xihuan(like)'));
});

test('duration trapezoid', () => {
  assert.equal(durationScore(9), 0);
  assert.equal(durationScore(120), 1);
  assert.equal(durationScore(1500), 0);
  assert.ok(durationScore(800) > 0 && durationScore(800) < 1);
});

test('negative keywords (other-language learning, podcasts) are pushed down', () => {
  const t = { w: '朋友', py: 'péngyou', slot: 'usage' };
  const good = scoreCandidate(t, E('Péng you 朋友 - Chinese Word of the Day 每日一词'));
  const bad = scoreCandidate(t, E('交友英語101：如何成功交到外國朋友？', { duration: 222 }));
  assert.ok(good.score > 2 * bad.score, `${good.score} vs ${bad.score}`);
});

test('curated channel weight and kind influence the etymology slot', () => {
  const t = { w: '木', py: 'mù', slot: 'etymology' };
  const ch = { UCety: { weight: 1, kind: 'etymology', language: 'en' }, UCword: { weight: 0.8, kind: 'word', language: 'en' } };
  const r = rankCandidates(t, [
    E('How to write 木 (mù) – tree; wood – stroke order, radical, examples', { id: 'aaaaaaaaaaa', channel_id: 'UCword', duration: 61 }),
    E('The Story of Chinese Character : 木', { id: 'bbbbbbbbbbb', channel_id: 'UCety', duration: 71 }),
  ], ch);
  assert.equal(r[0].entry.id, 'bbbbbbbbbbb');
});

test('blocked channel (weight 0) and live streams are rejected; ranking is deterministic', () => {
  const t = { w: '好', py: 'hǎo', slot: 'usage' };
  assert.equal(scoreCandidate(t, E('好 good', { channel_id: 'UCbad' }), { UCbad: { weight: 0, kind: 'word', language: 'zh' } }).rejected, 'blocked-channel');
  assert.equal(scoreCandidate(t, E('好 good', { live_status: 'is_live' })).rejected, 'live');
  const xs = [E('好 hǎo good', { id: 'b' }), E('好 hǎo good', { id: 'a' })];
  assert.deepEqual(rankCandidates(t, xs).map((x) => x.entry.id), ['a', 'b']);
});

test('query plan: one etymology query pair per distinct char + usage queries', () => {
  const q = queriesFor('朋友', 'péngyou');
  assert.deepEqual(q.filter((x) => x.slot === 'etymology').map((x) => x.target), ['朋', '朋', '友', '友']);
  assert.ok(q.some((x) => x.query === '朋友 pengyou Chinese word meaning example'));
});

test('traditional spelling (alt) is accepted for the title match', () => {
  const t = { w: '马', py: 'mǎ', slot: 'etymology', alt: ['馬'] };
  assert.ok(scoreCandidate(t, E('漢字的故事 : 馬')).score > 0.35);
  assert.equal(scoreCandidate({ ...t, alt: [] }, E('漢字的故事 : 馬')).rejected, 'target-not-in-title');
});

test('etymology slot: a clip with no origin signal is a flagged, down-weighted fallback', () => {
  const ch = { UCw: { weight: 0.8, kind: 'word', language: 'en' }, UCe: { weight: 0.8, kind: 'etymology', language: 'en' } };
  const t = { w: '得', py: 'dé', slot: 'etymology' };
  const a = scoreCandidate(t, E('How to write 得 (dé) – obtain – stroke order', { channel_id: 'UCw' }), ch);
  const b = scoreCandidate(t, E('The Story of Chinese Character : 得', { channel_id: 'UCe' }), ch);
  assert.equal(a.offSlot, true);
  assert.equal(b.offSlot, false);
  assert.ok(b.score > a.score);
});
