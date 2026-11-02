#!/usr/bin/env python3
"""Synthesize the test set with each TTS system → <out>/<system>/<id>.wav (16-bit PCM, native rate) + timing.json.

Usage: python synth.py --testset testset.json --models <dir with m_* model folders> --out <wav dir> \
                       --systems kokoro11_zf_001,matcha_baker,... [--threads 2] [--only word|sent] [--limit N]

sherpa-onnx systems use the official Python wheel (`pip install sherpa-onnx==2.0.1`, same C++ core as the
static CLI `sherpa-onnx-offline-tts` of release v2.0.1). Piper baseline = the app's bundled binary, invoked exactly like
src/main/services/tts.ts (one process per utterance, LD_LIBRARY_PATH, --espeak_data, --sentence_silence 0.25).
"""
import argparse, json, os, subprocess, sys, time
import numpy as np
import soundfile as sf

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

# --------------------------------------------------------------------------------------------- systems
KOKORO11_ZF = {f"zf_{n:03d}": i for i, n in enumerate([1, 2, 3, 4, 5, 6, 7, 8, 17, 18, 19, 21, 22, 23, 24, 26, 27, 28, 32, 36, 38, 39, 40, 42, 43, 44, 46, 47, 48, 49, 51, 59, 60, 67, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 83, 84, 85, 86, 87, 88, 90, 92, 93, 94, 99], start=3)}
KOKORO11_ZM = {f"zm_{n:03d}": i for i, n in enumerate([9, 10, 11, 12, 13, 14, 15, 16, 20, 25, 29, 30, 31, 33, 34, 35, 37, 41, 45, 50, 52, 53, 54, 55, 56, 57, 58, 61, 62, 63, 64, 65, 66, 68, 69, 80, 81, 82, 89, 91, 95, 96, 97, 98, 100], start=58)}
KOKORO10 = {"zf_xiaobei": 45, "zf_xiaoni": 46, "zf_xiaoxiao": 47, "zf_xiaoyi": 48, "zm_yunjian": 49, "zm_yunxi": 50, "zm_yunxia": 51, "zm_yunyang": 52}


def system_spec(name):
    """name → (engine, model-config-factory(models_dir), sid, speed, extra)."""
    import sherpa_onnx as so

    speed = 1.0
    if name.endswith("+p") or name.endswith("+t"):  # word variants, see text_for / tokens_for
        name = name[:-2]
    if "@" in name:  # e.g. kokoro11_zf_001@0.8
        name, sp = name.split("@")
        speed = float(sp)

    def kokoro(d, model="model.onnx"):
        return lambda M, th: so.OfflineTtsModelConfig(kokoro=so.OfflineTtsKokoroModelConfig(
            model=f"{M}/{d}/{model}", voices=f"{M}/{d}/voices.bin", tokens=f"{M}/{d}/tokens.txt",
            lexicon=f"{M}/{d}/lexicon-us-en.txt,{M}/{d}/lexicon-zh.txt"), num_threads=th)

    def vits(d, model, lexicon="lexicon.txt"):
        return lambda M, th: so.OfflineTtsModelConfig(vits=so.OfflineTtsVitsModelConfig(
            model=f"{M}/{d}/{model}", lexicon=f"{M}/{d}/{lexicon}", tokens=f"{M}/{d}/tokens.txt"), num_threads=th)

    def matcha(d, voc):
        return lambda M, th: so.OfflineTtsModelConfig(matcha=so.OfflineTtsMatchaModelConfig(
            acoustic_model=f"{M}/{d}/model-steps-3.onnx", vocoder=f"{M}/voc/{voc}", lexicon=f"{M}/{d}/lexicon.txt",
            tokens=f"{M}/{d}/tokens.txt"), num_threads=th)

    if name in ("piper_huayan", "piper_huayan_fix"):
        return ("piper", None, 0, speed, {})
    if name.startswith("kokoro11int8_"):
        return ("sherpa", kokoro("m_kokoro-int8-multi-lang-v1_1/kokoro-int8-multi-lang-v1_1", "model.int8.onnx"), {**KOKORO11_ZF, **KOKORO11_ZM}[name[len("kokoro11int8_"):]], speed, {})
    if name.startswith("kokoro11_"):
        return ("sherpa", kokoro("m_kokoro-multi-lang-v1_1/kokoro-multi-lang-v1_1"), {**KOKORO11_ZF, **KOKORO11_ZM}[name[len("kokoro11_"):]], speed, {})
    if name.startswith("kokoro10_"):
        return ("sherpa", kokoro("m_kokoro-multi-lang-v1_0/kokoro-multi-lang-v1_0"), KOKORO10[name[len("kokoro10_"):]], speed, {})
    if name == "matcha_baker":
        return ("sherpa", matcha("m_matcha-icefall-zh-baker/matcha-icefall-zh-baker", "vocos-22khz-univ.onnx"), 0, speed, {})
    if name == "matcha_zh_en":
        return ("sherpa", matcha("m_matcha-icefall-zh-en/matcha-icefall-zh-en", "vocos-16khz-univ.onnx"), 0, speed, {})
    if name == "melo_zh_en":
        return ("sherpa", vits("m_vits-melo-tts-zh_en/vits-melo-tts-zh_en", "model.onnx"), 0, speed, {})
    if name.startswith("vits_zh_ll_"):
        return ("sherpa", vits("m_sherpa-onnx-vits-zh-ll/sherpa-onnx-vits-zh-ll", "model.onnx"), int(name.rsplit("_", 1)[1]), speed, {})
    if name.startswith("aishell3_"):
        return ("sherpa", vits("m_vits-icefall-zh-aishell3/vits-icefall-zh-aishell3", "model.onnx"), int(name.rsplit("_", 1)[1]), speed, {})
    if name == "piper_xiao_ya":
        return ("sherpa", vits("m_vits-piper-zh_CN-xiao_ya-medium/vits-piper-zh_CN-xiao_ya-medium", "zh_CN-xiao_ya-medium.onnx"), 0, speed, {})
    if name == "piper_chaowen":
        return ("sherpa", vits("m_vits-piper-zh_CN-chaowen-medium/vits-piper-zh_CN-chaowen-medium", "zh_CN-chaowen-medium.onnx"), 0, speed, {})
    if name.startswith("zipvoice_"):
        d = "m_sherpa-onnx-zipvoice-distill-int8-zh-en-emilia/sherpa-onnx-zipvoice-distill-int8-zh-en-emilia"
        ref = name[len("zipvoice_"):]  # news-female | leijun-1 | news-female-2
        f = lambda M, th: so.OfflineTtsModelConfig(zipvoice=so.OfflineTtsZipvoiceModelConfig(
            tokens=f"{M}/{d}/tokens.txt", encoder=f"{M}/{d}/encoder.int8.onnx", decoder=f"{M}/{d}/decoder.int8.onnx",
            vocoder=f"{M}/voc/vocos_24khz.onnx", lexicon=f"{M}/{d}/lexicon.txt"), num_threads=th)
        return ("zipvoice", f, 0, speed, {"ref": f"{d}/test_wavs/{ref}.wav", "prompts": f"{d}/test_wavs/prompt.txt", "ref_name": ref})
    raise SystemExit(f"unknown system {name}")


def model_bytes(name, M):
    """Total on-disk size of the files a system needs (MB)."""
    eng, f, *_ = system_spec(name)
    if eng == "piper":
        d = f"{REPO}/resources/bin/piper"
        return sum(os.path.getsize(os.path.join(r, x)) for r, _, fs in os.walk(d) for x in fs) / 1e6
    cfg = f(M, 1)
    paths = []
    for sub in ("kokoro", "vits", "matcha", "zipvoice"):
        c = getattr(cfg, sub)
        for attr in ("model", "voices", "tokens", "lexicon", "acoustic_model", "vocoder", "encoder", "decoder"):
            v = getattr(c, attr, "")
            if v:
                paths += v.split(",")
    return sum(os.path.getsize(p) for p in set(paths) if os.path.isfile(p)) / 1e6


def text_for(system, x):
    """`<system>+p`: append a full stop to 1-2 syllable words (sentence-final prosody instead of a bare token)."""
    t = x["text"]
    if system.endswith("+p") and x["kind"] == "word" and t[-1] not in "。！？":
        t += "。"
    return t


_LEX = {}


def tokens_for(system, x, model_dir=None):
    """`<system>+t` (Matcha zh-baker only): words are synthesized from explicit pinyin tokens — the curriculum pinyin
    with sandhi already applied (testset "exp"), ü = v — plus a final ".". This bypasses the model's lexicon (which
    reads isolated 长 as zhang3, 还 as hai2 …). Neutral-tone syllables and tokens missing from tokens.txt (e.g. shei2)
    fall back to the model's own single-character lexicon reading (its toneless tokens are badly trained)."""
    if not system.endswith("+t") or x["kind"] != "word":
        return None
    if not _LEX and model_dir:
        d = f"{model_dir}/m_matcha-icefall-zh-baker/matcha-icefall-zh-baker"
        _LEX["tok"] = {l.split()[0] for l in open(f"{d}/tokens.txt", encoding="utf-8") if l.strip()}
        _LEX["lex"] = {}
        for l in open(f"{d}/lexicon.txt", encoding="utf-8"):
            p = l.split()
            if len(p) == 2 and p[0] not in _LEX["lex"]:
                _LEX["lex"][p[0]] = p[1]
    out = []
    for ch, syl, exp in zip(x["text"], x["pn"].lower().split(), x["exp"]):
        base = syl.rstrip("12345").replace("ü", "v").replace("u:", "v")
        tok = f"{base}{exp[0]}"
        if exp[0] == 5 or tok not in _LEX.get("tok", {tok}):
            tok = _LEX.get("lex", {}).get(ch, tok)
        out.append(tok)
    return [out + ["."]]


# --------------------------------------------------------------------------------------------- piper
def piper_say(text, out, length_scale=None):
    P = f"{REPO}/resources/bin/piper"
    args = [f"{P}/piper", "--model", f"{P}/voices/zh_CN-huayan-medium.onnx", "--espeak_data", f"{P}/espeak-ng-data",
            "--output_file", out, "-q", "--sentence_silence", "0.25"]
    if length_scale:
        args += ["--length_scale", str(length_scale)]
    env = {**os.environ, "LD_LIBRARY_PATH": P}
    subprocess.run(args, input=(text + "\n").encode(), env=env, check=True, capture_output=True, timeout=60)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--testset", required=True)
    ap.add_argument("--models", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--systems", required=True)
    ap.add_argument("--threads", type=int, default=2)
    ap.add_argument("--only", choices=["word", "sent"])
    ap.add_argument("--ids", help="comma-separated item ids")
    a = ap.parse_args()
    items = json.load(open(a.testset))
    if a.only:
        items = [x for x in items if x["kind"] == a.only]
    if a.ids:
        keep = set(a.ids.split(","))
        items = [x for x in items if x["id"] in keep]
    for name in a.systems.split(","):
        eng, factory, sid, speed, extra = system_spec(name)
        od = os.path.join(a.out, name)
        os.makedirs(od, exist_ok=True)
        tfile = os.path.join(od, "timing.json")
        timing = json.load(open(tfile)) if os.path.exists(tfile) else {}
        todo = [x for x in items if not os.path.exists(os.path.join(od, x["id"] + ".wav"))]
        if not todo:
            print(name, "up to date")
            continue
        load = None
        if eng in ("sherpa", "zipvoice"):
            import sherpa_onnx as so
            t = time.time()
            tts = so.OfflineTts(so.OfflineTtsConfig(model=factory(a.models, a.threads), max_num_sentences=1))
            load = time.time() - t
            if eng == "zipvoice":
                prompts = dict(l.split(" ", 1) for l in open(os.path.join(a.models, extra["prompts"]), encoding="utf-8").read().splitlines() if l.strip())
                ref_text = prompts[extra["ref_name"] + ".wav"].strip()
                ref, ref_sr = sf.read(os.path.join(a.models, extra["ref"]), dtype="float32")
            # warm-up (first run allocates)
            if eng == "sherpa":
                tts.generate("你好", sid=sid, speed=speed)
        for x in todo:
            out = os.path.join(od, x["id"] + ".wav")
            t = time.time()
            if eng == "piper":
                ls = 1.0 / speed if speed != 1.0 else None
                piper_say(text_for(name, x), out, ls)
                dt = time.time() - t
                info = sf.info(out)
                dur, sr = info.frames / info.samplerate, info.samplerate
            else:
                if eng == "zipvoice":
                    g = tts.generate(text_for(name, x), ref_text, ref.tolist(), ref_sr, speed=speed, num_steps=4)
                elif tokens_for(name, x, a.models):
                    gc = so.GenerationConfig()
                    gc.sid, gc.speed, gc.tokens = sid, speed, tokens_for(name, x, a.models)
                    g = tts.generate(x["text"], gc)
                else:
                    g = tts.generate(text_for(name, x), sid=sid, speed=speed)
                dt = time.time() - t
                s = np.asarray(g.samples, dtype=np.float32)
                sr = g.sample_rate
                dur = len(s) / sr
                sf.write(out, np.clip(s, -1, 1), sr, subtype="PCM_16")
            timing[x["id"]] = {"gen": round(dt, 4), "dur": round(dur, 4), "sr": sr}
        timing["_load"] = load
        timing["_threads"] = a.threads
        timing["_model_mb"] = round(model_bytes(name, a.models), 1)
        json.dump(timing, open(tfile, "w"))
        gens = [v["gen"] for k, v in timing.items() if not k.startswith("_")]
        durs = [v["dur"] for k, v in timing.items() if not k.startswith("_")]
        print(f"{name}: {len(todo)} files, load {load and round(load, 2)} s, RTF {sum(gens) / max(1e-9, sum(durs)):.3f}", flush=True)


if __name__ == "__main__":
    main()
