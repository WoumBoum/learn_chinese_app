#!/usr/bin/env python3
"""Aggregate metrics per system → results.json (+ a markdown table on stdout).

Usage: python score.py --testset testset.json --work <work dir> --wav <wav dir> --systems a,b [--out results.json] [--md]

Metrics
  tone_acc_*   : % of scored syllables (realised tone 1-4) whose measured F0 contour is classified as an accepted tone.
                 Unvoiced/unsegmentable syllables count as errors in *_strict, are excluded otherwise.
  cer_whisper  : character error rate of whisper-cli (ggml-small) vs the text (both simplified, Han characters only).
  ter_whisper  : toned-pinyin syllable error rate (hyp/ref → pypinyin TONE3): homophones are not errors, tone errors are.
  ser_whisper  : toneless-pinyin syllable error rate (segmental intelligibility).
  cer_ctc      : CER of the greedy WeNet CTC decoder (no language model; secondary ASR).
  rtf          : synthesis time / audio duration (warm model, per utterance), load_s = model load time.
  signal       : clipping (|x| ≥ 0.999), leading/trailing silence, longest internal pause, silent outputs.
"""
import argparse, json, os, re, sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
HAN = re.compile(r"[一-鿿]")
DIG = dict(zip("0123456789", "零一二三四五六七八九"))


def norm(s):
    from zhconv import convert
    s = "".join(DIG.get(c, c) for c in s)
    return "".join(HAN.findall(convert(s, "zh-cn")))


def ed(a, b):
    d = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        p, d[0] = d[0], i
        for j in range(1, len(b) + 1):
            p, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, p + (a[i - 1] != b[j - 1]))
    return d[len(b)]


def align_ok(ref, hyp):
    """Levenshtein alignment; returns for each ref element whether it was matched exactly."""
    n, m = len(ref), len(hyp)
    D = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        D[i][0] = i
    for j in range(m + 1):
        D[0][j] = j
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            D[i][j] = min(D[i - 1][j] + 1, D[i][j - 1] + 1, D[i - 1][j - 1] + (ref[i - 1] != hyp[j - 1]))
    ok = [False] * n
    i, j = n, m
    while i > 0 and j > 0:
        if D[i][j] == D[i - 1][j - 1] + (ref[i - 1] != hyp[j - 1]):
            ok[i - 1] = ref[i - 1] == hyp[j - 1]
            i, j = i - 1, j - 1
        elif D[i][j] == D[i - 1][j] + 1:
            i -= 1
        else:
            j -= 1
    return ok


def pinyin(s, tone=True):
    from pypinyin import lazy_pinyin, Style
    return lazy_pinyin(s, style=Style.TONE3 if tone else Style.NORMAL, neutral_tone_with_five=True) if s else []


def score_system(items, work, wav, name):
    wd = os.path.join(work, name)
    an = json.load(open(os.path.join(wd, "analysis.json")))
    al = json.load(open(os.path.join(wd, "align.json")))
    wf = os.path.join(wd, "whisper.json")
    wh = json.load(open(wf)) if os.path.exists(wf) else {}
    tf = os.path.join(wav, name, "timing.json")
    tm = json.load(open(tf)) if os.path.exists(tf) else {}
    R = {"system": name}
    for kind in ("word", "sent", "all"):
        sel = [x for x in items if (kind == "all" or x["kind"] == kind) and x["id"] in an]
        R[f"analysis_errors_{kind}"] = sum(1 for x in sel if "error" in an[x["id"]])
        if not sel:
            continue
        ok = tot = unv = 0
        by_tone = defaultdict(lambda: [0, 0])
        conf = Counter()
        for x in sel:
            for s in an[x["id"]].get("syl", []):
                if s["status"] == "neutral":
                    continue
                tot += 1
                key = "/".join(map(str, s["exp"]))
                by_tone[key][1] += 1
                if s["status"] != "scored":
                    unv += 1
                    continue
                conf[(key, s["got"])] += 1
                if s["ok"]:
                    ok += 1
                    by_tone[key][0] += 1
        R[f"tone_acc_{kind}"] = round(100 * ok / max(1, tot - unv), 1)
        R[f"tone_acc_{kind}_strict"] = round(100 * ok / max(1, tot), 1)
        R[f"tone_n_{kind}"] = tot
        R[f"unvoiced_{kind}"] = unv
        R[f"tone_by_exp_{kind}"] = {k: round(100 * v[0] / max(1, v[1]), 1) for k, v in sorted(by_tone.items())}
        R[f"confusion_{kind}"] = {f"{k[0]}->{k[1]}": v for k, v in sorted(conf.items())}
        # CTC greedy CER
        e = n = 0
        for x in sel:
            ref = norm(x["text"])
            e += ed(ref, norm(al.get(x["id"], {}).get("greedy", "")))
            n += len(ref)
        R[f"cer_ctc_{kind}"] = round(100 * e / max(1, n), 1)
        # Whisper
        ws = [x for x in sel if x["id"] in wh]
        if ws:
            e = n = te = se = pn = 0
            exact = 0
            for x in ws:
                ref, hyp = norm(x["text"]), norm(wh[x["id"]])
                e += ed(ref, hyp)
                n += len(ref)
                rp, hp = pinyin(ref), pinyin(hyp)
                te += ed(rp, hp)
                se += ed(pinyin(ref, False), pinyin(hyp, False))
                pn += len(rp)
                exact += rp == hp
            R[f"cer_whisper_{kind}"] = round(100 * e / max(1, n), 1)
            R[f"ter_whisper_{kind}"] = round(100 * te / max(1, pn), 1)
            R[f"ser_whisper_{kind}"] = round(100 * se / max(1, pn), 1)
            R[f"pinyin_exact_{kind}"] = round(100 * exact / len(ws), 1)
            R[f"whisper_n_{kind}"] = len(ws)
        # Whisper on concatenated groups (CER/TER over each concatenation)
        gf = os.path.join(wd, f"whisper_groups_{kind}.json")
        if kind in ("sent", "word") and os.path.exists(gf):
            byid = {x["id"]: x for x in items}
            e = n = te = se = pn = 0
            for g in json.load(open(gf)):
                ref = "".join(norm(byid[i]["text"]) for i in g["ids"])
                hyp = norm(g["text"])
                e += ed(ref, hyp)
                n += len(ref)
                rp, hp = pinyin(ref), pinyin(hyp)
                te += ed(rp, hp)
                se += ed(pinyin(ref, False), pinyin(hyp, False))
                pn += len(rp)
            if kind == "word":
                # per-word verdicts: align the group's toned-pinyin syllables with the reference (Levenshtein
                # backtrace); a word is correct when all its syllables are matched exactly.
                ok_t = ok_s = nw = mono_n = mono_ok = 0
                wok = {}
                for g in json.load(open(gf)):
                    hyp = norm(g["text"])
                    for tone in (True, False):
                        ref_syl, owner = [], []
                        for i in g["ids"]:
                            for sy in pinyin(norm(byid[i]["text"]), tone):
                                ref_syl.append(sy)
                                owner.append(i)
                        good = align_ok(ref_syl, pinyin(hyp, tone))
                        per = {}
                        for o, gd in zip(owner, good):
                            per[o] = per.get(o, True) and gd
                        for i, v in per.items():
                            if tone:
                                wok[i] = v
                                nw += 1
                                ok_t += v
                                if byid[i]["cat"].startswith("mono"):
                                    mono_n += 1
                                    mono_ok += v
                            else:
                                ok_s += v
                cats = defaultdict(lambda: [0, 0, 0])  # [n, F0 ok, Whisper ok]
                for i, v in wok.items():
                    c = byid[i]["cat"]
                    c = "mono" if c.startswith("mono") else "pair" if c.startswith("pair") else c
                    syl = [z for z in an[i].get("syl", []) if z["status"] != "neutral"]
                    cats[c][0] += 1
                    cats[c][1] += bool(syl) and all(z.get("ok") for z in syl)
                    cats[c][2] += v
                R["by_cat_word"] = {c: {"n": v[0], "f0_ok": round(100 * v[1] / v[0]), "whisper_ok": round(100 * v[2] / v[0])} for c, v in sorted(cats.items())}
                R["word_toned_ok_pct"] = round(100 * ok_t / max(1, nw), 1)
                R["word_toneless_ok_pct"] = round(100 * ok_s / max(1, nw), 1)
                R["mono_toned_ok_pct"] = round(100 * mono_ok / max(1, mono_n), 1)
            R[f"cer_whisper_grp_{kind}"] = round(100 * e / max(1, n), 1)
            R[f"ter_whisper_grp_{kind}"] = round(100 * te / max(1, pn), 1)
            R[f"ser_whisper_grp_{kind}"] = round(100 * se / max(1, pn), 1)
        # signal
        sig = [an[x["id"]]["sig"] for x in sel if "sig" in an[x["id"]]]
        if not sig:
            continue
        R[f"clipped_files_{kind}"] = sum(1 for s in sig if s["clipFrac"] > 0)
        R[f"peak_max_{kind}"] = round(max(s["peak"] for s in sig), 3)
        R[f"silent_files_{kind}"] = sum(1 for s in sig if s["silent"])
        R[f"lead_sil_ms_{kind}"] = round(1000 * sum(s["leadSil"] for s in sig) / len(sig))
        R[f"trail_sil_ms_{kind}"] = round(1000 * sum(s["trailSil"] for s in sig) / len(sig))
        R[f"max_gap_ms_{kind}"] = round(1000 * max(s["maxGap"] for s in sig))
        R[f"dur_s_{kind}"] = round(sum(s["dur"] for s in sig) / len(sig), 3)
        R[f"active_s_{kind}"] = round(sum(s["activeDur"] for s in sig) / len(sig), 3)
        if tm:
            g = [tm[x["id"]]["gen"] for x in sel if x["id"] in tm]
            d = [tm[x["id"]]["dur"] for x in sel if x["id"] in tm]
            if g:
                R[f"rtf_{kind}"] = round(sum(g) / sum(d), 3)
                R[f"gen_ms_{kind}"] = round(1000 * sum(g) / len(g))
    mf = os.path.join(wd, "tone_ml.json")
    if os.path.exists(mf):
        m = json.load(open(mf))
        R["tone_ml_sent"] = m["acc"]
        R["tone_ml_sent_strict"] = round(100 * m["ok"] / max(1, m["n"] + m["unvoiced"]), 1)
        R["tone_ml_human_ceiling"] = m["val_acc_human"]
    if tm:
        R["load_s"] = tm.get("_load")
        R["model_mb"] = tm.get("_model_mb")
        R["threads"] = tm.get("_threads")
        R["sample_rate"] = next((v["sr"] for k, v in tm.items() if not k.startswith("_")), None)
    return R


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--testset", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--wav", required=True)
    ap.add_argument("--systems", required=True)
    ap.add_argument("--out")
    a = ap.parse_args()
    items = json.load(open(a.testset))
    res = [score_system(items, a.work, a.wav, s) for s in a.systems.split(",")]
    if a.out:
        json.dump(res, open(a.out, "w"), ensure_ascii=False, indent=1)
    cols = ["system", "tone_acc_word", "tone_acc_word_strict", "tone_acc_sent", "cer_whisper_word", "ter_whisper_word", "cer_whisper_sent",
            "ter_whisper_sent", "cer_ctc_word", "cer_ctc_sent", "rtf_all", "load_s", "model_mb", "clipped_files_all"]
    print("| " + " | ".join(cols) + " |")
    print("|" + "---|" * len(cols))
    for r in res:
        print("| " + " | ".join(str(r.get(c, "")) for c in cols) + " |")


if __name__ == "__main__":
    main()
