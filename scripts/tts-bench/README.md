# TTS benchmark (Mandarin, local models)

Compares local Chinese TTS voices against the app's current Piper `zh_CN-huayan-medium` on what matters for a learner:
**are the tones right?** (especially on isolated 1-2 syllable words), **is it intelligible?**, **is it fast/small enough?**
Results and the recommendation: [`docs/tts-bench.md`](../../docs/tts-bench.md).

Nothing here is used by the app at runtime; it does not modify `src/`. The tone analysis *imports* the app's own
`src/renderer/components/pitch.ts` (YIN F0, DTW) and `src/main/services/tonefix.ts` (Chao templates, syllable segmentation).

## Setup

```bash
python3 -m venv .venv && .venv/bin/pip install -r scripts/tts-bench/requirements.txt
DL=$PWD/tts-bench-data/dl bash scripts/tts-bench/fetch.sh        # ≈ 3.5 GB: models, vocoders, aligner, whisper small, FLEURS
PY=.venv/bin/python bash scripts/tts-bench/run.sh                 # ≈ 2-3 h on 4 cores (Whisper dominates)
PY=.venv/bin/python WHISPER_WORDS=0 bash scripts/tts-bench/run.sh # ≈ 20 min, no per-word Whisper
```
Needs `node`/`npx esbuild` (repo devDependencies) and the bundled binaries in `resources/bin` (piper, ffmpeg, whisper-cli).

## Pipeline

| step | script | what |
|---|---|---|
| test set | `build_testset.py` (+ `tones.py`) | 120 words from `resources/data/words.json` (48 monosyllables balanced over tones 1-4; 3-3 sandhi, 不/一 sandhi, neutral-tone, polyphone (长/行/还/得/觉/乐/重/只/教/发) and all 15 other tone pairs) + 60 Tatoeba sentences from `sentences.json` (6-16 characters, curriculum vocabulary, no erhua). Expected *realised* tones: curriculum pinyin → pypinyin fallback → sandhi (3-3 inside words; 3-3 across word boundaries accepts 2 or 3; 不/一 rules). |
| synthesis | `synth.py` | sherpa-onnx 2.0.1 Python wheel (same C++ core as the static `sherpa-onnx-offline-tts` CLI of the v2.0.1 release); Piper = the app's binary, invoked like `src/main/services/tts.ts`. `piper_tonefix.ts` re-applies the app's PSOLA tone correction to Piper's words (= what the app plays today). |
| alignment | `align.py` | CTC forced alignment of the characters with a char-level WeNet (WenetSpeech) CTC model (onnxruntime). The CTC spike of a character fires near the *end* of its syllable (verified on F0 tracks), so syllable boundaries = previous char's spike, snapped to the nearest unvoiced frame. Also gives a greedy CTC transcript (LM-free CER). |
| tone metric | `analyze.ts` | YIN F0 (app code), per-syllable contour (semitones re. utterance median); words: 1 syllable = whole voiced part, 2 syllables = `tonefix.syllableSegments` (energy). Classification among tones 1-4 by DTW distance to the app's Chao templates + level term; per-utterance range/offset normalisation fitted *without* the expected tones. Neutral syllables are not scored. |
| learned tone metric | `tone_clf.py` | For sentences: gradient-boosted classifier trained on 5.7 k syllables of **human** read speech (FLEURS cmn test split), validated on held-out human speech (FLEURS dev) → gives the human ceiling. |
| intelligibility | `evaluate.py` | whisper-cli + ggml-small, prompt `以下是普通话的句子。`. Words: one file each. Sentences: concatenated in ≤ 25 s groups (0.8 s gaps) — Whisper always encodes 30 s, so this is ~8× cheaper; CER is computed on the concatenation. |
| signal checks | `analyze.ts` | clipping (|x| ≥ 0.999), peak, leading/trailing silence, longest internal pause, silent outputs. |
| speed | `bench_speed.py` | warm-model latency and RTF (median of 3), 1 and 2 threads, plus load time. |
| report | `score.py` | aggregates everything into `results.json`. |

System names: `piper_huayan`, `piper_huayan_fix`, `piper_xiao_ya`, `piper_chaowen`, `matcha_baker`, `matcha_zh_en`,
`melo_zh_en`, `kokoro11_<voice>` (e.g. `kokoro11_zf_001`, `kokoro11_zm_009`), `kokoro11int8_<voice>`, `kokoro10_<voice>`
(`zf_xiaobei` …), `vits_zh_ll_<sid>`, `aishell3_<sid>`, `zipvoice_<news-female|leijun-1|news-female-2>`; append `@0.8`
to change the speed (e.g. `kokoro11_zf_001@0.8`).

## Caveats
- The template tone metric uses the same Chao templates that `tonefix.ts` imposes with PSOLA, so `piper_huayan_fix`
  is favoured by construction on that metric; judge it with Whisper's toned-pinyin error rate instead.
- Whisper has a language model: on isolated words it often "repairs" a wrong tone into the most frequent word.
  The toned-pinyin error rate (TER) still exposes many tone errors (e.g. 是 → 十).
- Timings were taken on a shared 4-core VM; treat RTF as ±30 %.
