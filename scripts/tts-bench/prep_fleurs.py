#!/usr/bin/env python3
"""Human reference for calibrating the tone metric: 60 native read sentences from Google FLEURS (cmn_hans_cn, dev split).

Download (≈ 220 MB):
  https://huggingface.co/datasets/google/fleurs/resolve/main/data/cmn_hans_cn/dev.tsv
  https://huggingface.co/datasets/google/fleurs/resolve/main/data/cmn_hans_cn/audio/dev.tar.gz  (tar xzf → dev/*.wav)
Usage: python prep_fleurs.py <dev.tsv> <dir with extracted dev/*.wav> <repo>/resources/data <out testset json> <wav out dir>/human_fleurs
             [N=60] [exclude.json] [prefix=f]
  The evaluation set uses N=60 (≤ 30 per gender, one clip per sentence); the tone-classifier training set is built with
  N=10000 and the evaluation set as exclude.json (no sentence shared with the evaluation set).
"""
import json, os, re, random, sys
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tones import HAN, sentence_expect  # noqa: E402

tsv, audio, data, out_json, out_wav = sys.argv[1:6]
N = int(sys.argv[6]) if len(sys.argv) > 6 else 60
excl = {x["fid"] for x in json.load(open(sys.argv[7]))} if len(sys.argv) > 7 else set()
prefix = sys.argv[8] if len(sys.argv) > 8 else "f"
cap = 30 if N == 60 else 10**9
by_w = {x["w"]: x for x in json.load(open(f"{data}/words.json"))}
rows = [l.rstrip("\n").split("\t") for l in open(tsv, encoding="utf-8")]
rnd = random.Random(7)
rnd.shuffle(rows)
os.makedirs(out_wav, exist_ok=True)
items, seen, gender = [], set(), {"MALE": 0, "FEMALE": 0}
for r in rows:
    fid, wav, raw, g = r[0], r[1], r[2], r[-1]
    zh = raw.strip()
    han = HAN.findall(zh)
    if not (8 <= len(han) <= 30) or re.search(r"[A-Za-z0-9０-９%“”\"《》（）()]", zh) or "儿" in zh:
        continue
    if fid in excl or (N == 60 and fid in seen):
        continue
    if gender.get(g, 10**9) >= cap or not os.path.exists(os.path.join(audio, wav)):
        continue
    seen.add(fid)
    gender[g] += 1
    chars, cit, exp = sentence_expect(zh, by_w)
    i = f"{prefix}{len(items):03d}"
    x, sr = sf.read(os.path.join(audio, wav), dtype="float32")
    sf.write(os.path.join(out_wav, i + ".wav"), x, sr, subtype="PCM_16")  # analyzer expects 16-bit PCM
    items.append({"id": i, "kind": "sent", "text": zh, "cat": "fleurs", "src": wav, "fid": fid, "gender": g,
                  "pn": " ".join(f"{c}{t}" for c, t in zip(chars, cit)), "tones": cit, "exp": [sorted(s) for s in exp]})
    if len(items) == N:
        break
json.dump(items, open(out_json, "w"), ensure_ascii=False, indent=1)
print(len(items), "FLEURS sentences", gender, sum(len(x["exp"]) for x in items), "syllables")
