#!/usr/bin/env python3
"""Evaluate synthesized audio: 16 kHz copies, CTC alignment, tone/signal analysis (node), Whisper transcription.

Usage: python evaluate.py --testset testset.json --wav <wav dir> --work <work dir> --systems a,b,c
                          --align-model <wenet ctc dir> --analyze-js <bundled analyze.js>
                          [--whisper-model ggml-small.bin] [--whisper-bin resources/bin/whisper-cli]
Writes <work>/<system>/{align.json, analysis.json, whisper.json}. Everything is cached (delete to recompute).
"""
import argparse, json, os, re, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
HAN = re.compile(r"[一-鿿]")
PUNCT = set("，。！？、,.!?；;：:…~～")


def finals_of(text):
    """A syllable is phrase-final if followed by punctuation or the end of the text."""
    out = []
    chars = list(text)
    for i, c in enumerate(chars):
        if not HAN.match(c):
            continue
        rest = [d for d in chars[i + 1:] if HAN.match(d) or d in PUNCT]
        out.append(not rest or rest[0] in PUNCT)
    return out


def to16k(src, dst, ffmpeg):
    if not os.path.exists(dst):
        subprocess.run([ffmpeg, "-loglevel", "error", "-y", "-i", src, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", dst], check=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--testset", required=True)
    ap.add_argument("--wav", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--systems", required=True)
    ap.add_argument("--align-model", required=True)
    ap.add_argument("--analyze-js", required=True)
    ap.add_argument("--whisper-model")
    ap.add_argument("--whisper-bin", default=f"{REPO}/resources/bin/whisper-cli")
    ap.add_argument("--whisper-threads", type=int, default=4)
    ap.add_argument("--whisper-only", choices=["word", "sent"], help="per-file Whisper only for this kind")
    ap.add_argument("--whisper-groups", help="Whisper on concatenated groups for these kinds, e.g. sent,word")
    ap.add_argument("--no-whisper-files", action="store_true", help="skip per-file Whisper")
    ap.add_argument("--ffmpeg", default=f"{REPO}/resources/bin/ffmpeg")
    a = ap.parse_args()
    items = json.load(open(a.testset))
    aligner = None
    import soundfile as sf

    for name in a.systems.split(","):
        wd = os.path.join(a.work, name)
        os.makedirs(os.path.join(wd, "16k"), exist_ok=True)
        present = [x for x in items if os.path.exists(os.path.join(a.wav, name, x["id"] + ".wav"))]
        for x in present:
            to16k(os.path.join(a.wav, name, x["id"] + ".wav"), os.path.join(wd, "16k", x["id"] + ".wav"), a.ffmpeg)
        # ---- CTC alignment + greedy CTC transcript
        af = os.path.join(wd, "align.json")
        al = json.load(open(af)) if os.path.exists(af) else {}
        todo = [x for x in present if x["id"] not in al]
        if todo:
            if aligner is None:
                from align import Aligner
                aligner = Aligner(a.align_model)
            for x in todo:
                s, sr = sf.read(os.path.join(wd, "16k", x["id"] + ".wav"), dtype="float32")
                al[x["id"]] = aligner.align(s, x["text"])
            json.dump(al, open(af, "w"), ensure_ascii=False)
        # ---- tone + signal analysis (node, app pitch code)
        anf = os.path.join(wd, "analysis.json")
        an = json.load(open(anf)) if os.path.exists(anf) else {}
        todo = [x for x in present if x["id"] not in an]
        if todo:
            jobs = [{"key": x["id"], "wav": os.path.join(a.wav, name, x["id"] + ".wav"), "exp": x["exp"], "finals": finals_of(x["text"]),
                     "emit": [e[0] for e in (al.get(x["id"], {}).get("emit") or [])] or None} for x in todo]
            jf = os.path.join(wd, "jobs.json")
            json.dump(jobs, open(jf, "w"))
            tmp = os.path.join(wd, "analysis.part.json")
            subprocess.run(["node", a.analyze_js, jf, tmp], check=True)
            an.update(json.load(open(tmp)))
            json.dump(an, open(anf, "w"))
        # ---- Whisper (slow: ~6 s per file on 4 threads)
        if a.whisper_model and not a.no_whisper_files:
            wf = os.path.join(wd, "whisper.json")
            wh = json.load(open(wf)) if os.path.exists(wf) else {}
            todo = [x for x in present if x["id"] not in wh and (not a.whisper_only or x["kind"] == a.whisper_only)]
            for k in range(0, len(todo), 30):
                chunk = todo[k:k + 30]
                args = [a.whisper_bin, "-m", a.whisper_model, "-l", "zh", "-nt", "-np", "-t", str(a.whisper_threads),
                        "--prompt", "以下是普通话的句子。", "-otxt"]
                for x in chunk:
                    args += ["-f", os.path.join(wd, "16k", x["id"] + ".wav")]
                subprocess.run(args, check=True, capture_output=True)
                for x in chunk:
                    tf = os.path.join(wd, "16k", x["id"] + ".wav.txt")
                    wh[x["id"]] = open(tf, encoding="utf-8").read().strip() if os.path.exists(tf) else ""
                json.dump(wh, open(wf, "w"), ensure_ascii=False)
                print(f"  whisper {name}: {len(wh)}/{len(present)}", flush=True)
        # ---- Whisper on concatenated groups: the encoder always processes a 30 s window (≈ 6 s per call on 4 idle
        # cores, much more on a shared machine), so utterances are concatenated with silent gaps into ≤ 25 s groups
        # (sentences: 0.8 s gaps; words: 1.0 s gaps, ≤ 12 words). CER/TER are computed over each concatenation.
        if a.whisper_model and a.whisper_groups:
            for kind, gap, maxn in (("sent", 0.8, 99), ("word", 1.0, 12)):
                if kind not in a.whisper_groups.split(","):
                    continue
                gf = os.path.join(wd, f"whisper_groups_{kind}.json")
                if os.path.exists(gf):
                    continue
                import numpy as np
                sel = [x for x in present if x["kind"] == kind]
                groups, cur, dur = [], [], 0.0
                for x in sel:
                    d = sf.info(os.path.join(wd, "16k", x["id"] + ".wav")).duration + gap
                    if cur and (dur + d > 25 or len(cur) >= maxn):
                        groups.append(cur)
                        cur, dur = [], 0.0
                    cur.append(x["id"])
                    dur += d
                if cur:
                    groups.append(cur)
                out = []
                for gi, ids in enumerate(groups):
                    parts = [np.zeros(int(16000 * 0.3), dtype=np.float32)]
                    for i in ids:
                        s, _ = sf.read(os.path.join(wd, "16k", i + ".wav"), dtype="float32")
                        parts += [s, np.zeros(int(16000 * gap), dtype=np.float32)]
                    p = os.path.join(wd, f"group_{kind}{gi:02d}.wav")
                    sf.write(p, np.concatenate(parts), 16000, subtype="PCM_16")
                    subprocess.run([a.whisper_bin, "-m", a.whisper_model, "-l", "zh", "-nt", "-np", "-t", str(a.whisper_threads),
                                    "--prompt", "以下是普通话的句子。" if kind == "sent" else "以下是普通话的词语。", "-otxt", "-f", p],
                                   check=True, capture_output=True)
                    out.append({"ids": ids, "text": open(p + ".txt", encoding="utf-8").read().strip()})
                json.dump(out, open(gf, "w"), ensure_ascii=False)
                print(f"  whisper {name}: {len(groups)} {kind} groups", flush=True)
        print(f"{name}: evaluated {len(present)} files", flush=True)


if __name__ == "__main__":
    main()
