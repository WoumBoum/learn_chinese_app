#!/usr/bin/env bash
# Downloads everything the TTS benchmark needs into $DL (default: ./tts-bench-data/dl). ~3.5 GB in total.
# Each archive is extracted into its own m_<name>/ folder (untrusted data: nothing in there is executed except
# through the sherpa-onnx Python wheel / onnxruntime).
set -euo pipefail
DL=${DL:-$PWD/tts-bench-data/dl}
mkdir -p "$DL"/voc "$DL"/align "$DL"/whisper "$DL"/fleurs "$DL"/fleurs_test
R=https://github.com/k2-fsa/sherpa-onnx/releases/download
get() { [ -s "$2" ] || curl -fsSL -o "$2" "$1"; }

# --- TTS models (sherpa-onnx "tts-models" release)
for n in kokoro-multi-lang-v1_1 kokoro-int8-multi-lang-v1_1 kokoro-multi-lang-v1_0 matcha-icefall-zh-baker matcha-icefall-zh-en \
         vits-melo-tts-zh_en sherpa-onnx-vits-zh-ll vits-icefall-zh-aishell3 vits-piper-zh_CN-xiao_ya-medium \
         vits-piper-zh_CN-chaowen-medium sherpa-onnx-zipvoice-distill-int8-zh-en-emilia; do
  if [ ! -d "$DL/m_$n/$n" ]; then
    mkdir -p "$DL/m_$n"
    get "$R/tts-models/$n.tar.bz2" "$DL/m_$n/$n.tar.bz2"
    tar xjf "$DL/m_$n/$n.tar.bz2" -C "$DL/m_$n" && rm "$DL/m_$n/$n.tar.bz2"
  fi
done
# --- vocoders (Matcha / ZipVoice)
for v in vocos-22khz-univ.onnx vocos-16khz-univ.onnx vocos_24khz.onnx; do get "$R/vocoder-models/$v" "$DL/voc/$v"; done

# --- CTC aligner (char-level WeNet WenetSpeech conformer, int8)
H=https://huggingface.co/csukuangfj/sherpa-onnx-zh-wenet-wenetspeech/resolve/main
get "$H/model.int8.onnx" "$DL/align/model.int8.onnx"
get "$H/tokens.txt" "$DL/align/tokens.txt"

# --- Whisper small (ggml) for intelligibility
get https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin "$DL/whisper/ggml-small.bin"

# --- Human reference speech (Google FLEURS cmn_hans_cn): dev = validation of the tone metric, test = classifier training
F=https://huggingface.co/datasets/google/fleurs/resolve/main/data/cmn_hans_cn
get "$F/dev.tsv" "$DL/fleurs/dev.tsv"
[ -d "$DL/fleurs/dev" ] || { get "$F/audio/dev.tar.gz" "$DL/fleurs/dev.tar.gz"; tar xzf "$DL/fleurs/dev.tar.gz" -C "$DL/fleurs"; rm "$DL/fleurs/dev.tar.gz"; }
get "$F/test.tsv" "$DL/fleurs_test/test.tsv"
[ -d "$DL/fleurs_test/test" ] || { get "$F/audio/test.tar.gz" "$DL/fleurs_test/test.tar.gz"; tar xzf "$DL/fleurs_test/test.tar.gz" -C "$DL/fleurs_test"; rm "$DL/fleurs_test/test.tar.gz"; }
echo "done → $DL"
