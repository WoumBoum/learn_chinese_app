#!/usr/bin/env python3
"""Controlled speed measurement (warm model, median of 3 repetitions) for the finalists.

Usage: python bench_speed.py --testset testset.json --models DL --systems a,b --threads 1,2 --out speed.json
Reports, per system and thread count: model load time, median latency for a 1-2 syllable word and for a sentence,
real-time factor (synthesis time / audio duration). Piper is measured as the app runs it (one process per utterance,
model load included in every call).
"""
import argparse, json, os, statistics, sys, tempfile, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from synth import system_spec, piper_say  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--testset", required=True)
    ap.add_argument("--models", required=True)
    ap.add_argument("--systems", required=True)
    ap.add_argument("--threads", default="1,2")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    items = json.load(open(a.testset))
    words = [x for x in items if x["kind"] == "word"][::12][:10]
    sents = [x for x in items if x["kind"] == "sent"][::6][:10]
    res = json.load(open(a.out)) if os.path.exists(a.out) else {}
    import sherpa_onnx as so
    import soundfile as sf
    for name in a.systems.split(","):
        eng, factory, sid, speed, extra = system_spec(name)
        for th in [int(t) for t in a.threads.split(",")]:
            key = f"{name}@{th}"
            if eng == "piper" and th != 1:
                continue
            r = {}
            if eng == "piper":
                tmp = tempfile.mktemp(suffix=".wav")
                for kind, sel in (("word", words), ("sent", sents)):
                    lat, gen, dur = [], 0.0, 0.0
                    for x in sel:
                        ts = []
                        for _ in range(3):
                            t = time.time()
                            piper_say(x["text"], tmp)
                            ts.append(time.time() - t)
                        d = sf.info(tmp).duration
                        lat.append(statistics.median(ts))
                        gen += statistics.median(ts)
                        dur += d
                    r[f"lat_ms_{kind}"] = round(1000 * statistics.median(lat))
                    r[f"rtf_{kind}"] = round(gen / dur, 3)
                r["load_s"] = None
            else:
                t = time.time()
                tts = so.OfflineTts(so.OfflineTtsConfig(model=factory(a.models, th), max_num_sentences=1))
                r["load_s"] = round(time.time() - t, 2)
                if eng == "zipvoice":
                    prompts = dict(l.split(" ", 1) for l in open(os.path.join(a.models, extra["prompts"]), encoding="utf-8").read().splitlines() if l.strip())
                    ref_text = prompts[extra["ref_name"] + ".wav"].strip()
                    ref, ref_sr = sf.read(os.path.join(a.models, extra["ref"]), dtype="float32")
                    gen_fn = lambda s: tts.generate(s, ref_text, ref.tolist(), ref_sr, speed=speed, num_steps=4)
                else:
                    gen_fn = lambda s: tts.generate(s, sid=sid, speed=speed)
                gen_fn("你好")
                for kind, sel in (("word", words), ("sent", sents)):
                    lat, gen, dur = [], 0.0, 0.0
                    for x in sel:
                        ts = []
                        for _ in range(3):
                            t = time.time()
                            g = gen_fn(x["text"])
                            ts.append(time.time() - t)
                        lat.append(statistics.median(ts))
                        gen += statistics.median(ts)
                        dur += len(g.samples) / g.sample_rate
                    r[f"lat_ms_{kind}"] = round(1000 * statistics.median(lat))
                    r[f"rtf_{kind}"] = round(gen / dur, 3)
                del tts
            res[key] = r
            print(key, r, flush=True)
            json.dump(res, open(a.out, "w"), indent=1)


if __name__ == "__main__":
    main()
