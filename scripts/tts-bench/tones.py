"""Expected (realised) tones for Mandarin text: curriculum pinyin + pypinyin fallback + tone sandhi. Shared by
build_testset.py and calibrate_fleurs.py."""
import re
import jieba
from pypinyin import lazy_pinyin, Style

jieba.setLogLevel(60)
HAN = re.compile(r"[\u4e00-\u9fff]")


def tones_of(pn):
    return [int(s[-1]) if s[-1] in "12345" else 5 for s in pn.split()]


def sandhi_word(chars, t):
    """Sandhi inside one lexical word → list of sets of accepted tones."""
    r = list(t)
    for i in range(len(r) - 1):
        nxt = t[i + 1]
        if chars[i] == "不" and t[i] == 4 and nxt == 4:
            r[i] = 2
        elif chars[i] == "一" and t[i] == 1 and (nxt != 5 or chars[i + 1] == "个"):
            r[i] = 2 if (nxt == 4 or chars[i + 1] == "个") else 4
    for i in range(len(r) - 2, -1, -1):
        if r[i] == 3 and t[i + 1] == 3:
            r[i] = 2
    return [{x} for x in r]


def sentence_expect(zh, by_w):
    """→ (chars, citation tones, accepted realised tones per char as sets)."""
    toks = jieba.lcut(zh)
    chars, cit, exp, boundary = [], [], [], []
    for w in toks:
        h = [c for c in w if HAN.match(c)]
        if not h:
            if chars and re.search(r"[，。！？、,.!?；;：:]", w):
                boundary[-1] = "pause"
            continue
        if w in by_w and len(by_w[w]["pn"].split()) == len(h):
            t = tones_of(by_w[w]["pn"].lower())
        else:
            t = [int(p[-1]) if p[-1].isdigit() else 5 for p in lazy_pinyin(w, style=Style.TONE3, neutral_tone_with_five=True)]
        if len(t) != len(h):
            t = (t + [5] * len(h))[: len(h)]
        chars += h
        cit += t
        exp += sandhi_word(h, t)
        boundary += ["word"] * (len(h) - 1) + ["wb"]
    # cross-word sandhi (not across a pause)
    for i in range(len(chars) - 1):
        if boundary[i] != "wb":
            continue
        nxt = cit[i + 1]
        if chars[i] == "不" and cit[i] == 4 and nxt == 4:
            exp[i] = {2}
        elif chars[i] == "一" and cit[i] == 1 and nxt != 5 and not (i > 0 and chars[i - 1] in "第十") and chars[i + 1] not in "月号":
            exp[i] = {2} if nxt == 4 else {4}
        elif cit[i] == 3 and nxt == 3:
            exp[i] = {2, 3}  # 3-3 across a word boundary: prosody-dependent → both accepted
    return chars, cit, exp
