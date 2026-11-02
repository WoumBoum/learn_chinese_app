#!/usr/bin/env bash
# Voix de synthèse Matcha (sherpa-onnx) : modèle acoustique matcha-icefall-zh-baker + vocodeur vocos-22khz-univ
# dans resources/tts/ (≈ 131 Mo). Évaluation et choix : docs/tts-bench.md. Moteur : npm sherpa-onnx-node (dépendance).
#
#   bash scripts/fetch-tts.sh             # télécharge ce qui manque, vérifie les SHA-256 (idempotent, reprise)
#   bash scripts/fetch-tts.sh --check     # vérifie seulement les fichiers présents (aucun téléchargement)
#   bash scripts/fetch-tts.sh --dry-run   # affiche ce qui serait téléchargé
#
# Licence : corpus Baker (DataBaker) — usage non commercial ; modèles k2-fsa/icefall (Apache-2.0).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/resources/tts"
MODEL="matcha-icefall-zh-baker"
MODEL_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/$MODEL.tar.bz2"
VOCODER="vocos-22khz-univ.onnx"
VOCODER_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/vocoder-models/$VOCODER"
CURL=(curl -fL --retry 4 --retry-delay 2 --connect-timeout 30 --progress-bar)

MODE=fetch
for a in "$@"; do
  case "$a" in
    --check) MODE=check ;;
    --dry-run|-n) MODE=dry ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "option inconnue : $a" >&2; exit 2 ;;
  esac
done

# chemin relatif à resources/tts → sha256 attendu
declare -A SUM=(
  ["$MODEL/README.md"]=d47ef70781df15845b6f28c6c071dee9e51b52c36797a8130a620c5c8895929c
  ["$MODEL/date.fst"]=eb8aa079ae3cb81d8f4404992f39d61a0cb990947512b5b8d1e54d1f6980e718
  ["$MODEL/lexicon.txt"]=38b886d46aefa50da6322a64d72fd595d5f4fae1051adb160d647541b1e0a4a2
  ["$MODEL/model-steps-3.onnx"]=78a9fd17e9a6c20198dca4e69d18f941303f8ab39ec61dde04cfc7595262ddfd
  ["$MODEL/number.fst"]=743f402181fcfebf76cc2f0546b71fa26476e626fbe4e460fb7b4c3a7a8bd5bd
  ["$MODEL/phone.fst"]=1ac2b6fa56b1442320c4de7db08353bab8963a2b57f365eebcdd3a2d3562f8d7
  ["$MODEL/tokens.txt"]=56209b2bf609d5ac1d66ede6dae7bf5254bd3f8aa24c4a6823713d5b884d87ba
  ["$VOCODER"]=0574a135aa1db2de6e181050db2ec528496cacd4a4701fc5d7faf9f9804c0081
)
MODEL_FILES=(README.md date.fst lexicon.txt model-steps-3.onnx number.fst phone.fst tokens.txt)

sha() { sha256sum "$1" | cut -d' ' -f1; }
ok() { [ -s "$DEST/$1" ] && [ "$(sha "$DEST/$1")" = "${SUM[$1]}" ]; }

missing_model=0
for f in "${MODEL_FILES[@]}"; do ok "$MODEL/$f" || missing_model=1; done
missing_voc=0
ok "$VOCODER" || missing_voc=1

if [ "$MODE" = check ] || [ "$MODE" = dry ]; then
  bad=0
  for k in "${!SUM[@]}"; do
    if ok "$k"; then echo "✓ $k"; else echo "✗ $k (absent ou SHA-256 différent)"; bad=1; fi
  done
  if [ "$MODE" = dry ]; then
    [ $missing_model = 1 ] && echo "→ téléchargerait $MODEL_URL"
    [ $missing_voc = 1 ] && echo "→ téléchargerait $VOCODER_URL"
    [ $missing_model = 0 ] && [ $missing_voc = 0 ] && echo "Rien à télécharger."
    exit 0
  fi
  exit $bad
fi

mkdir -p "$DEST/$MODEL" "$DEST/.download"
DL="$DEST/.download"

if [ $missing_model = 1 ]; then
  echo "→ Modèle $MODEL…"
  # reprise d'un téléchargement interrompu (-C -)
  "${CURL[@]}" -C - -o "$DL/$MODEL.tar.bz2" "$MODEL_URL"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  tar -xjf "$DL/$MODEL.tar.bz2" -C "$TMP" || { rm -f "$DL/$MODEL.tar.bz2"; echo "✗ archive illisible (supprimée) : relancez le script." >&2; exit 1; }
  for f in "${MODEL_FILES[@]}"; do
    [ -f "$TMP/$MODEL/$f" ] || { echo "✗ $f absent de l'archive" >&2; exit 1; }
    cp "$TMP/$MODEL/$f" "$DEST/$MODEL/$f"
  done
  rm -f "$DL/$MODEL.tar.bz2"
else
  echo "✓ $MODEL déjà présent"
fi

if [ $missing_voc = 1 ]; then
  echo "→ Vocodeur $VOCODER…"
  "${CURL[@]}" -C - -o "$DL/$VOCODER.part" "$VOCODER_URL"
  mv "$DL/$VOCODER.part" "$DEST/$VOCODER"
else
  echo "✓ $VOCODER déjà présent"
fi
rmdir "$DL" 2>/dev/null || true

# on ne garde que les fichiers utiles (le dossier dict/ de l'archive n'est plus utilisé depuis sherpa-onnx 2.0)
for e in "$DEST/$MODEL"/*; do
  b="$(basename "$e")"
  keep=0
  for f in "${MODEL_FILES[@]}"; do [ "$b" = "$f" ] && keep=1; done
  [ $keep = 1 ] || rm -rf "$e"
done

bad=0
for k in "${!SUM[@]}"; do
  if ok "$k"; then :; else echo "✗ SHA-256 incorrect : $k" >&2; rm -f "$DEST/$k"; bad=1; fi
done
[ $bad = 0 ] || { echo "Fichiers corrompus supprimés : relancez le script." >&2; exit 1; }
echo "✓ Voix Matcha prête ($(du -sh "$DEST" | cut -f1)) dans $DEST"
