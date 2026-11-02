#!/usr/bin/env bash
# Télécharge Piper (TTS local) + la voix mandarin zh_CN-huayan-medium dans resources/bin/piper/.
# Idempotent : ne retélécharge pas ce qui est déjà présent. Usage : bash scripts/fetch-piper.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/resources/bin/piper"
VOICES="$DEST/voices"
PIPER_URL="https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz"
VOICE_BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium"
VOICE="zh_CN-huayan-medium"

mkdir -p "$VOICES"
CURL=(curl -fL --retry 4 --retry-delay 2 --connect-timeout 30 --progress-bar)

if [ ! -x "$DEST/piper" ]; then
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  echo "→ Téléchargement du binaire Piper…"
  "${CURL[@]}" -o "$TMP/piper.tar.gz" "$PIPER_URL"
  # L'archive contient un dossier « piper/ » : binaire, libs (onnxruntime, espeak-ng, piper_phonemize) et espeak-ng-data.
  tar -xzf "$TMP/piper.tar.gz" -C "$TMP"
  cp -a "$TMP/piper/." "$DEST/"
  chmod +x "$DEST/piper" "$DEST"/espeak-ng 2>/dev/null || chmod +x "$DEST/piper"
else
  echo "✓ Binaire Piper déjà présent"
fi

for f in "$VOICE.onnx" "$VOICE.onnx.json"; do
  if [ ! -s "$VOICES/$f" ]; then
    echo "→ Téléchargement de la voix $f…"
    "${CURL[@]}" -o "$VOICES/$f.part" "$VOICE_BASE/$f?download=true"
    mv "$VOICES/$f.part" "$VOICES/$f"
  else
    echo "✓ $f déjà présent"
  fi
done

# Test rapide
if echo '你好。' | LD_LIBRARY_PATH="$DEST" "$DEST/piper" --model "$VOICES/$VOICE.onnx" --espeak_data "$DEST/espeak-ng-data" --output_file /dev/null -q >/dev/null 2>&1; then
  echo "✓ Piper fonctionne"
else
  echo "⚠ Piper installé mais le test de synthèse a échoué (vérifiez les dépendances système)" >&2
fi
du -sh "$DEST"
