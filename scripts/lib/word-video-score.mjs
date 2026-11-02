// Pure, deterministic ranking of YouTube search candidates for "one video per learned word".
// Spec: docs/word-videos.md §4. Input fields are exactly those of a yt-dlp `--flat-playlist -J` entry
// (title, channel, channel_id, duration, view_count, description, live_status). No I/O, no clock, no randomness.
// Intended to be ported 1:1 to src/core/wordVideos.ts.

/** @typedef {{w:string, py:string, slot:'etymology'|'usage', alt?:string[]}} Target  py = marked pinyin of w (e.g. "péngyou");
 *  alt = traditional spellings (CEDICT, e.g. 朋友 → [], 马 → ['馬'], 觉得 → ['覺得']) accepted in titles. */
/** @typedef {{id:string,title:string,channel?:string|null,channel_id?:string|null,duration?:number|null,view_count?:number|null,description?:string|null,live_status?:string|null}} Entry */
/** @typedef {{channelId?:string,weight:number,kind:'etymology'|'word'|'mixed',language:string}} ChannelInfo */

export const HAN = /[㐀-鿿豈-﫿]/g;
const DELIMS = '[]【】「」『』“”"\'‘’()（）《》<>:：|｜/\\-–—_#,，.。!！?？ \t';

export const W = {
  focus: 0.30, // the target is THE subject of the video (not a passing mention)
  pinyin: 0.12, // pinyin of the target in title/description: strong "learner video about this word" signal
  channel: 0.22, // curated channel weight (content/catalog/word-video-channels.json)
  slotKind: 0.06, // channel kind matches the slot (etymology channel for etymology slot…)
  intent: 0.12, // slot-specific keywords (origin/字源… vs example/例句…)
  duration: 0.10, // 40 s–7 min is ideal for a per-word clip
  language: 0.04, // fr > en > zh-only titles for a French-speaking beginner
  popularity: 0.04, // log-scaled views, deliberately tiny
};

const INTENT = {
  etymology: /字源|字源|說文|说文|演变|演變|甲骨文|金文|象形|会意|會意|形声|形聲|origin|etymolog|evolution|story of|histoire|origine|pictogra|oracle|漢字的故事|汉字的故事|汉字趣谈|漢字趣談|造字|字的故事|primitive/i,
  usage: /例句|用法|怎么用|怎麼用|example|sentence|how to (use|say)|word of the day|每日一词|每日一詞|meaning|vocabulary|vocabulaire|signifie|phrases?|exemple|pronounce|dialogue/i,
};
/** Other-language learning, exams, long compilations, entertainment → strong penalty. */
const NEGATIVE = /podcast|英语|英語|英文|日文|日语|日語|한국어|韓語|vietsub|tiếng|sample (paper|exam)|样卷|樣卷|mock test|汉语水平考试|\btest\b|\bexam\b|\blive\b|直播|full course|compilation|合集|八卦|娱乐|娛樂|\bnews\b|新闻|新聞/i;
/** Japanese kanji channels match Han characters but teach Japanese readings. */
const JAPANESE = /[぀-ヿ]|kanji|JLPT|on'yomi|kun'yomi/i;

export function stripTones(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ü/g, 'v').toLowerCase();
}

/** Latin text of a title, lower-cased, tones removed, tone digits removed, punctuation → spaces. */
export function latinNorm(s) {
  return ` ${stripTones(s).replace(/[0-9]/g, '').replace(/[^a-zv]+/g, ' ').trim()} `;
}

export function pinyinHit(py, text) {
  const syl = latinNorm(py).trim();
  if (!syl) return false;
  const t = latinNorm(text);
  const compact = syl.replace(/ /g, '');
  // multi-syllable: "pengyou" or "peng you"; single syllable: whole-token match only ("mu" must not match "music").
  if (t.includes(` ${syl} `) || t.includes(` ${compact} `)) return true;
  return false;
}

export function hanChars(s) {
  return [...new Set(s.match(HAN) ?? [])];
}

/**
 * focus ∈ [0,1]: 1 when the title is clearly about the target, 0 when the target is absent.
 *  - only embedded in a longer Han run (觉 in 觉得) → ×0.4 ; list of ≥3 standalone chars (人 从 比 北 众) → ×0.5
 *  - target absent from the title → 0 (hard requirement; the caller drops these)
 *  - target delimited (【好】, "好", 汉字[好], 好 (hǎo)…) or title ≤ len(w)+4 Han chars → 1
 *  - otherwise decays with the number of OTHER Han characters (lists like "人 从 比 北 众" or sentences).
 */
export function focusScore(w, title) {
  if (!title.includes(w)) return 0;
  // Look at every occurrence: delimited (【好】, "好", 好 (hǎo)) and isolated (not inside a longer Han run,
  // e.g. 觉 inside 觉得, 学习 inside 笔画学习) occurrences are what make the target the subject.
  let delimited = false;
  let isolated = false;
  for (let i = title.indexOf(w); i >= 0; i = title.indexOf(w, i + 1)) {
    const before = i === 0 ? ' ' : title[i - 1];
    const after = i + w.length >= title.length ? ' ' : title[i + w.length];
    const isHan = (ch) => /[\u3400-\u9fff\uf900-\ufaff]/.test(ch);
    if (!isHan(before) && !isHan(after)) isolated = true;
    if (DELIMS.includes(before) && DELIMS.includes(after)) delimited = true;
  }
  const others = hanChars(title).filter((c) => !w.includes(c)).length;
  const base = others <= 4 ? 1 : Math.max(0, 1 - (others - 4) / 16);
  // "人 从 比 北 众" / "女 子 好": a list of ≥3 standalone characters is a multi-character lesson, not "the" video.
  const listLike = (title.match(/(?:^|[\s、,，/])[\u3400-\u9fff](?=$|[\s、,，/])/g) ?? []).length >= 3;
  const v = delimited && !listLike ? Math.max(0.6, base) : base * 0.8;
  return (isolated ? v : v * 0.4) * (listLike ? 0.5 : 1);
}

/** Trapezoid: 0 below 12 s (stroke-order Shorts), ramps to 1 at 40 s, 1 until 420 s, 0 at 1200 s. */
export function durationScore(d) {
  if (d == null || !(d > 0)) return 0.3;
  if (d < 12) return 0;
  if (d < 40) return (d - 12) / 28;
  if (d <= 420) return 1;
  if (d >= 1200) return 0;
  return 1 - (d - 420) / 780;
}

export function languageScore(title, channelLang) {
  if (channelLang === 'fr' || /\b(caract[eè]re|chinois|apprendre|le|la|les|du|des|signifie)\b/i.test(title)) return 1;
  if (channelLang === 'en' || /[a-z]{3,}/i.test(title)) return 0.6;
  return 0.3; // Chinese-only title: still usable (visual etymology), but less accessible to a beginner
}

/**
 * Score one candidate. Returns {score ∈ [0,1], reasons} or {score: 0, rejected} when a hard filter fails.
 * @param {Target} target
 * @param {Entry} e
 * @param {Record<string, ChannelInfo>} channels  keyed by channel_id
 */
export function scoreCandidate(target, e, channels = {}) {
  const title = e.title ?? '';
  const desc = e.description ?? '';
  if (e.live_status === 'is_live' || e.live_status === 'is_upcoming') return { score: 0, rejected: 'live' };
  const forms = [target.w, ...(target.alt ?? [])].filter((x) => x && title.includes(x));
  if (!forms.length) return { score: 0, rejected: 'target-not-in-title' };
  if (JAPANESE.test(title)) return { score: 0, rejected: 'japanese' };
  const ch = (e.channel_id && channels[e.channel_id]) || null;
  if (ch && ch.weight <= 0) return { score: 0, rejected: 'blocked-channel' };
  const f = {
    focus: Math.max(...forms.map((x) => focusScore(x, title))),
    pinyin: pinyinHit(target.py, title) ? 1 : pinyinHit(target.py, desc) ? 0.5 : 0,
    channel: ch ? ch.weight : 0,
    slotKind: ch ? (ch.kind === 'mixed' ? 0.5 : ch.kind === (target.slot === 'etymology' ? 'etymology' : 'word') ? 1 : 0) : 0,
    intent: INTENT[target.slot].test(title) ? 1 : INTENT[target.slot].test(desc) ? 0.5 : 0,
    duration: durationScore(e.duration),
    language: languageScore(title, ch?.language),
    popularity: Math.min(1, Math.log10((e.view_count ?? 0) + 1) / 6),
  };
  let score = 0;
  for (const k of Object.keys(W)) score += W[k] * f[k];
  const neg = NEGATIVE.test(title);
  if (neg) score *= 0.3;
  // Slot mismatch → soft fallback, flagged so the UI labels it honestly (« Écriture » / « Origine » instead of the slot):
  //  - etymology slot, no origin keyword, channel not an etymology channel (stroke-order clip, grammar lesson…);
  //  - usage slot, no usage keyword, served by an etymology-only channel (origin story without the word in context).
  const offSlot = f.intent === 0 && (target.slot === 'etymology' ? ch?.kind !== 'etymology' : ch?.kind === 'etymology');
  if (offSlot) score *= 0.7;
  return { score: Math.round(score * 1000) / 1000, f, neg, offSlot };
}

/** Rank candidates (deduplicated by id, best score kept), dropping rejected ones and those below `min`. */
export function rankCandidates(target, entries, channels = {}, min = 0.35) {
  const best = new Map();
  for (const e of entries) {
    const r = scoreCandidate(target, e, channels);
    if (!(r.score >= min)) continue;
    const prev = best.get(e.id);
    if (!prev || prev.score < r.score) best.set(e.id, { ...r, entry: e });
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
}

/** Query plan for a word: etymology queries per distinct character, usage queries for the whole word. */
export function queriesFor(w, py) {
  const chars = hanChars(w);
  const q = [];
  for (const c of chars) {
    q.push({ slot: 'etymology', target: c, query: `${c} Chinese character origin` });
    q.push({ slot: 'etymology', target: c, query: `${c} caractère chinois` });
  }
  q.push({ slot: 'usage', target: w, query: `${w} caractère chinois` });
  q.push({ slot: 'usage', target: w, query: `${w} ${stripTones(py).replace(/\s+/g, '')} Chinese word meaning example` });
  return q;
}
