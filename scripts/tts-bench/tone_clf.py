#!/usr/bin/env python3
"""Learned tone classifier for continuous speech (sentences), trained on HUMAN read speech (FLEURS cmn test split),
validated on held-out human speech (FLEURS dev, other sentences), then applied to every TTS system's sentences.

Why: the Chao-template matcher (analyze.ts) is adequate for citation-form words but reaches only ~40 % on human
sentences (coarticulation, declination, reduced tones). A classifier trained on human syllable contours measures how
well a TTS sentence's tones are recognisable *as a native listener's tones would be*, with a known human ceiling.

Usage:
  python tone_clf.py train --work W --train-set fleurs_train.json --train-sys human_fleurs_train \
                           --val-set fleurs.json --val-sys human_fleurs --model W/tone_clf.pkl
  python tone_clf.py apply --work W --set testset.json --systems a,b --model W/tone_clf.pkl  → W/<sys>/tone_ml.json
Inputs are the per-syllable contours stored by analyze.ts in <W>/<sys>/analysis.json (F0 in semitones re. the
utterance median, voiced frames of the syllable, 10 % trimmed, resampled to 30 points).
"""
import argparse, json, os, pickle, sys
import numpy as np

NAN = float("nan")


def feats(contours, finals, i, utt_std):
    c = contours[i]
    n = len(contours)
    f = []
    if c is None:
        return None
    c = np.asarray(c, dtype=float)
    c8 = c.reshape(8, -1).mean(1) if len(c) % 8 == 0 else np.interp(np.linspace(0, len(c) - 1, 8), np.arange(len(c)), c)
    f += list(c8)                       # level + shape
    f += list((c8 - c8.mean()) / max(utt_std, 0.5))  # range-normalised shape
    x = np.linspace(0, 1, len(c))
    p2 = np.polyfit(x, c, 2)
    f += [c.mean(), c[-5:].mean() - c[:5].mean(), p2[0], p2[1], c.max() - c.min(), np.argmin(c) / len(c), np.argmax(c) / len(c)]
    prev = contours[i - 1] if i > 0 else None
    nxt = contours[i + 1] if i + 1 < n else None
    f += [np.mean(prev[-5:]) if prev else NAN, np.mean(prev) if prev else NAN, np.mean(nxt[:5]) if nxt else NAN, np.mean(nxt) if nxt else NAN]
    f += [c[:5].mean() - (np.mean(prev[-5:]) if prev else c[:5].mean()), (np.mean(nxt[:5]) if nxt else c[-5:].mean()) - c[-5:].mean()]
    f += [float(finals[i]), i / max(1, n - 1), utt_std]
    return f


def finals_of(text):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from evaluate import finals_of as fo
    return fo(text)


def dataset(items, an, single_only=True):
    X, y, keys = [], [], []
    for x in items:
        a = an.get(x["id"])
        if not a or "contours" not in a:
            continue
        cs = a["contours"]
        allv = [v for c in cs if c for v in c]
        utt_std = float(np.std(allv)) if allv else 1.0
        fin = finals_of(x["text"])
        for i, e in enumerate(x["exp"]):
            if 5 in e or cs[i] is None or i >= len(fin):
                continue
            if single_only and len(e) != 1:
                continue
            f = feats(cs, fin, i, utt_std)
            if f is None:
                continue
            X.append(f)
            y.append(e[0] if len(e) == 1 else e)
            keys.append((x["id"], i, e))
    return np.array(X, dtype=float), y, keys


def load(work, sys_name):
    return json.load(open(os.path.join(work, sys_name, "analysis.json")))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["train", "apply"])
    ap.add_argument("--work", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--train-set")
    ap.add_argument("--train-sys")
    ap.add_argument("--val-set")
    ap.add_argument("--val-sys")
    ap.add_argument("--set")
    ap.add_argument("--systems")
    a = ap.parse_args()
    if a.mode == "train":
        from sklearn.ensemble import HistGradientBoostingClassifier
        from sklearn.metrics import confusion_matrix
        Xt, yt, _ = dataset(json.load(open(a.train_set)), load(a.work, a.train_sys))
        clf = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.06, max_leaf_nodes=24, l2_regularization=1.0,
                                             class_weight="balanced", random_state=0)
        clf.fit(Xt, np.array(yt))
        Xv, yv, kv = dataset(json.load(open(a.val_set)), load(a.work, a.val_sys), single_only=False)
        pv = clf.predict(Xv)
        ok = [int(p) in (k[2]) for p, k in zip(pv, kv)]
        single = [i for i, k in enumerate(kv) if len(k[2]) == 1]
        print(f"train syllables {len(yt)} (by tone {dict(zip(*np.unique(yt, return_counts=True)))})")
        print(f"held-out human (FLEURS dev): {100 * np.mean(ok):.1f} % of {len(ok)} voiced scored syllables")
        print("confusion (rows = expected 1-4, cols = predicted):")
        print(confusion_matrix([kv[i][2][0] for i in single], [int(pv[i]) for i in single], labels=[1, 2, 3, 4]))
        pickle.dump({"clf": clf, "val_acc": float(np.mean(ok)), "n_train": len(yt)}, open(a.model, "wb"))
    else:
        m = pickle.load(open(a.model, "rb"))
        items = json.load(open(a.set))
        for s in a.systems.split(","):
            an = load(a.work, s)
            sel = [x for x in items if x["kind"] == "sent"]
            X, _, keys = dataset(sel, an, single_only=False)
            out = {"n": 0, "ok": 0, "per": {}}
            if len(X):
                p = m["clf"].predict(X)
                for pi, k in zip(p, keys):
                    out["n"] += 1
                    out["ok"] += int(int(pi) in k[2])
                    out["per"].setdefault(k[0], []).append([k[1], k[2], int(pi)])
            # syllables that should be scored but were unvoiced/unsegmented
            out["unvoiced"] = sum(1 for x in sel if x["id"] in an for i, e in enumerate(x["exp"])
                                  if 5 not in e and an[x["id"]].get("contours") and an[x["id"]]["contours"][i] is None)
            out["acc"] = round(100 * out["ok"] / max(1, out["n"]), 1)
            out["val_acc_human"] = round(100 * m["val_acc"], 1)
            json.dump(out, open(os.path.join(a.work, s, "tone_ml.json"), "w"))
            print(f"{s}: ML tone accuracy (sentences) {out['acc']} % of {out['n']} (+{out['unvoiced']} unvoiced)")


if __name__ == "__main__":
    main()
