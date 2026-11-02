#!/usr/bin/env bash
# Full TTS benchmark pipeline (see README.md). Usage:
#   bash scripts/tts-bench/run.sh [systems]          (default: the systems of docs/tts-bench.md)
# Env: WORK (default ./tts-bench-data), DL (default $WORK/dl), PY (python with requirements.txt installed),
#      WHISPER_WORDS=1 to also run per-file Whisper on words (≈ 6 s per file on 4 idle cores).
set -euo pipefail
export OMP_NUM_THREADS=${OMP_NUM_THREADS:-1}  # sklearn/OpenMP thrashes on a busy machine
REPO=$(cd "$(dirname "$0")/../.." && pwd)
B=$REPO/scripts/tts-bench
WORK=${WORK:-$PWD/tts-bench-data}
DL=${DL:-$WORK/dl}
PY=${PY:-python3}
SYSTEMS=${1:-piper_huayan,piper_xiao_ya,piper_chaowen,matcha_baker,matcha_zh_en,melo_zh_en,kokoro11_zf_001,kokoro10_zf_xiaobei,vits_zh_ll_2,zipvoice_news-female}
mkdir -p "$WORK"

# 0. bundle the TS analysers (they import the app's own src/renderer/components/pitch.ts and src/main/services/tonefix.ts)
(cd "$REPO" && npx esbuild scripts/tts-bench/analyze.ts --bundle --platform=node --format=cjs --outfile="$WORK/analyze.js" --log-level=warning \
            && npx esbuild scripts/tts-bench/piper_tonefix.ts --bundle --platform=node --format=cjs --outfile="$WORK/piper_tonefix.js" --log-level=warning)

# 1. test set (120 words + 60 sentences) and human reference sets
$PY -I "$B/build_testset.py" "$REPO/resources/data" "$WORK/testset.json"
$PY -I "$B/prep_fleurs.py" "$DL/fleurs/dev.tsv" "$DL/fleurs/dev" "$REPO/resources/data" "$WORK/fleurs.json" "$WORK/wav/human_fleurs"
$PY -I "$B/prep_fleurs.py" "$DL/fleurs_test/test.tsv" "$DL/fleurs_test/test" "$REPO/resources/data" "$WORK/fleurs_train.json" "$WORK/wav/human_fleurs_train" 10000 "$WORK/fleurs.json" t

# 2. synthesis (piper_huayan_fix = Piper + the app's tone correction, derived from piper_huayan)
$PY -I "$B/synth.py" --testset "$WORK/testset.json" --models "$DL" --out "$WORK/wav" --systems "$SYSTEMS"
if [[ ",$SYSTEMS," == *",piper_huayan,"* ]]; then
  TB_REPO=$REPO node "$WORK/piper_tonefix.js" "$WORK/wav/piper_huayan" "$WORK/wav/piper_huayan_fix" "$WORK/testset.json"
  cp "$WORK/wav/piper_huayan/timing.json" "$WORK/wav/piper_huayan_fix/"
  SYSTEMS="$SYSTEMS,piper_huayan_fix"
fi

# 3. analysis: CTC alignment, F0/tone templates, signal checks, Whisper
EV=("$PY" -I "$B/evaluate.py" --wav "$WORK/wav" --work "$WORK/work" --align-model "$DL/align" --analyze-js "$WORK/analyze.js")
"${EV[@]}" --testset "$WORK/fleurs.json" --systems human_fleurs
"${EV[@]}" --testset "$WORK/fleurs_train.json" --systems human_fleurs_train
W=(--whisper-model "$DL/whisper/ggml-small.bin" --whisper-groups sent,word --whisper-only word)
[ "${WHISPER_WORDS:-0}" = 1 ] || W+=(--no-whisper-files)
"${EV[@]}" --testset "$WORK/testset.json" --systems "$SYSTEMS" "${W[@]}"

# 4. learned tone classifier (human-trained) for sentences, then scores
$PY -I "$B/tone_clf.py" train --work "$WORK/work" --model "$WORK/work/tone_clf.pkl" \
    --train-set "$WORK/fleurs_train.json" --train-sys human_fleurs_train --val-set "$WORK/fleurs.json" --val-sys human_fleurs
$PY -I "$B/tone_clf.py" apply --work "$WORK/work" --model "$WORK/work/tone_clf.pkl" --set "$WORK/testset.json" --systems "$SYSTEMS"
$PY -I "$B/score.py" --testset "$WORK/testset.json" --work "$WORK/work" --wav "$WORK/wav" --systems "$SYSTEMS" --out "$WORK/results.json"
