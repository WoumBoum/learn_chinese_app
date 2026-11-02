#!/usr/bin/env python3
"""Cross-validation of the two word-level tone measures: F0/Chao-template verdict vs Whisper toned-pinyin verdict.

Usage: python agreement.py --testset testset.json --work W --systems a,b
For each (system, word): F0 says OK if every scored syllable is classified as an accepted tone; Whisper says OK if the
word's toned pinyin is recovered exactly (grouped transcription, Levenshtein alignment). Prints the pooled 2x2 table,
Cohen's kappa, and P(Whisper wrong | F0 wrong) vs P(Whisper wrong | F0 right).
"""
import argparse, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from score import norm, pinyin, align_ok  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--testset", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--systems", required=True)
    a = ap.parse_args()
    byid = {x["id"]: x for x in json.load(open(a.testset))}
    tab = {(f, w): 0 for f in (0, 1) for w in (0, 1)}
    for s in a.systems.split(","):
        an = json.load(open(os.path.join(a.work, s, "analysis.json")))
        gf = os.path.join(a.work, s, "whisper_groups_word.json")
        if not os.path.exists(gf):
            continue
        for g in json.load(open(gf)):
            ref, owner = [], []
            for i in g["ids"]:
                for sy in pinyin(norm(byid[i]["text"])):
                    ref.append(sy)
                    owner.append(i)
            good = align_ok(ref, pinyin(norm(g["text"])))
            wv = {}
            for o, gd in zip(owner, good):
                wv[o] = wv.get(o, True) and gd
            for i, w in wv.items():
                syl = [x for x in an[i].get("syl", []) if x["status"] != "neutral"]
                if not syl:
                    continue
                f = all(x.get("ok") for x in syl)
                tab[(int(f), int(w))] += 1
    n = sum(tab.values())
    po = (tab[(0, 0)] + tab[(1, 1)]) / n
    pf = (tab[(1, 0)] + tab[(1, 1)]) / n
    pw = (tab[(0, 1)] + tab[(1, 1)]) / n
    pe = pf * pw + (1 - pf) * (1 - pw)
    kappa = (po - pe) / (1 - pe)
    print(f"words {n}: F0 ok & Whisper ok {tab[(1, 1)]}, F0 ok & Whisper wrong {tab[(1, 0)]}, "
          f"F0 wrong & Whisper ok {tab[(0, 1)]}, both wrong {tab[(0, 0)]}")
    print(f"agreement {100 * po:.1f} %, Cohen kappa {kappa:.2f}; "
          f"P(Whisper wrong | F0 wrong) = {100 * tab[(0, 0)] / max(1, tab[(0, 0)] + tab[(0, 1)]):.1f} %, "
          f"P(Whisper wrong | F0 ok) = {100 * tab[(1, 0)] / max(1, tab[(1, 0)] + tab[(1, 1)]):.1f} %")


if __name__ == "__main__":
    main()
