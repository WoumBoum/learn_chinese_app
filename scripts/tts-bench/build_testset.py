#!/usr/bin/env python3
"""Build the TTS benchmark test set (120 short words + 60 sentences) → testset.json.

Usage: python build_testset.py <repo>/resources/data <out>/testset.json

Each item: {id, kind: word|sent, text, cat, pn: [citation tones per Han char], exp: [accepted realised tones per char]}
 - words: pinyin from words.json (authoritative curriculum pinyin, citation tones), then sandhi.
 - sentences: Tatoeba (resources/data/sentences.json); pinyin from words.json for every jieba word found there,
   pypinyin (phrase-aware) otherwise.
Sandhi (same rules as src/main/services/tonefix.ts applySandhi):
   3-3 → 2-3 inside a word (and inside a 1-2 syllable test word);
   across a word boundary 3-3 is prosody-dependent → both 2 and 3 accepted;
   不 + 4 → bu2 ; 一 + 4 (or 个) → yi2 ; 一 + 1/2/3 → yi4 ; ordinal/number 一 (第一, 十一, 一月…) stays yi1.
Neutral-tone syllables (5) are NOT scored by the tone metric (kept for CER).
"""
import json, os, re, sys, random

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tones import HAN, tones_of, sandhi_word, sentence_expect, jieba  # noqa: E402
from collections import Counter

DATA, OUT = sys.argv[1], sys.argv[2]
words = json.load(open(f"{DATA}/words.json"))
by_w = {x["w"]: x for x in words}


items = []

# ---------------------------------------------------------------- words (120)
def pick(pred, n, used, key=lambda x: x["rank"]):
    out = []
    for x in sorted(words, key=key):
        if len(out) >= n:
            break
        if x["w"] in used or not pred(x):
            continue
        out.append(x)
        used.add(x["w"])
    return out

used = set()
cat_words = []
# explicit categories (all present in words.json)
explicit = {
    "sandhi33": ["可以", "所以", "水果", "手表", "洗澡", "老板", "了解", "好久", "已经", "只有"],
    "bu": ["不要", "不用", "不对", "不同", "不", "不客气"],
    "yi": ["一起", "一样", "一定", "一般", "一共", "一直", "一"],
    "neutral": ["妈妈", "朋友", "东西", "谢谢", "喜欢", "时候", "什么", "认识"],
    "polyphone": ["长", "长大", "行", "银行", "还", "还是", "得到", "觉得", "睡觉", "音乐", "快乐", "重要", "重新", "只", "教室", "头发"],
}
for cat, ws in explicit.items():
    for w in ws:
        x = by_w[w]
        if len(x["pn"].split()) > 3:
            continue
        used.add(w)
        cat_words.append((cat, x))

mono_needed = 48 - sum(1 for c, x in cat_words if len(x["w"]) == 1)
basic = lambda x: x["band"] <= 3 and all(HAN.match(c) for c in x["w"]) and x["pn"].islower()
# monosyllables: balanced over tones 1-4
per_tone = mono_needed // 4
for t in (1, 2, 3, 4):
    for x in pick(lambda x: basic(x) and len(x["w"]) == 1 and tones_of(x["pn"]) == [t], per_tone, used):
        cat_words.append((f"mono{t}", x))
# disyllables: balanced tone pairs (excluding 3-3 and neutral which are covered above)
remaining = 120 - len(cat_words)
pairs = [(a, b) for a in (1, 2, 3, 4) for b in (1, 2, 3, 4) if not (a == 3 and b == 3)]
k = 0
while remaining > 0:
    a, b = pairs[k % len(pairs)]
    got = pick(lambda x: basic(x) and len(x["w"]) == 2 and tones_of(x["pn"]) == [a, b] and "不" not in x["w"] and "一" not in x["w"], 1, used)
    if got:
        cat_words.append((f"pair{a}{b}", got[0]))
        remaining -= 1
    k += 1

for i, (cat, x) in enumerate(cat_words):
    chars = list(x["w"])
    t = tones_of(x["pn"])
    assert len(t) == len(chars), x
    exp = sandhi_word(chars, t)
    items.append({"id": f"w{i:03d}", "kind": "word", "text": x["w"], "cat": cat, "pn": x["pn"], "tones": t, "exp": [sorted(s) for s in exp]})

# ---------------------------------------------------------------- sentences (60)
sents = json.load(open(f"{DATA}/sentences.json"))
rnd = random.Random(20261102)
cands = []
for s in sents:
    zh = s["zh"].strip()
    han = HAN.findall(zh)
    if not (6 <= len(han) <= 16):
        continue
    if re.search(r"[A-Za-z0-9０-９\"“”《》（）()]", zh) or "的的" in zh:
        continue
    # everyday: every jieba word must be in the curriculum (or a single Han char)
    segs = [w for w in jieba.lcut(zh) if HAN.search(w)]
    if not all(w in by_w or len(w) == 1 for w in segs):
        continue
    # erhua (这儿, 一点儿…) merges two characters into one syllable → excluded (syllable count ≠ char count)
    if any(w.endswith("儿") and w not in ("女儿", "儿子", "婴儿") for w in segs):
        continue
    cands.append((s["id"], zh, segs))
rnd.shuffle(cands)
chosen = []
seen = set()
for c in cands:
    if c[1] in seen:
        continue
    seen.add(c[1])
    chosen.append(c)
    if len(chosen) == 60:
        break

for j, (sid, zh, _) in enumerate(chosen):
    chars, cit, exp = sentence_expect(zh, by_w)
    items.append({"id": f"s{j:03d}", "kind": "sent", "text": zh, "cat": "sentence", "tatoeba": sid,
                  "pn": " ".join(f"{c}{t}" for c, t in zip(chars, cit)), "tones": cit, "exp": [sorted(s) for s in exp]})


json.dump(items, open(OUT, "w"), ensure_ascii=False, indent=1)
wc = Counter(x["cat"] for x in items)
print(len(items), "items", dict(wc))
syl = Counter(t for x in items if x["kind"] == "word" for s in x["exp"] for t in s)
print("word syllables by realised tone", dict(sorted(syl.items())))
syl = Counter(t for x in items if x["kind"] == "sent" for s in x["exp"] for t in s)
print("sentence syllables by realised tone", dict(sorted(syl.items())))
