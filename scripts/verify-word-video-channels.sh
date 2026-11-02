#!/usr/bin/env bash
# Evaluation helper (word-videos): lists the latest uploads of candidate channels with yt-dlp --flat-playlist
# (one request batch per channel, no retry loop) and stores the raw JSON in OUT_DIR/<handle>.json.
#   bash scripts/verify-word-video-channels.sh OUT_DIR [MAX=300] [channel-url...]
# Summarise with: python3 scripts/summarise-word-video-channels.py OUT_DIR
set -u
OUT=${1:?out dir}; MAX=${2:-300}; shift 2 || true
HERE=$(cd "$(dirname "$0")/.." && pwd)
Y=${YTDLP:-$HERE/resources/bin/yt-dlp}
URLS=("$@")
if [ ${#URLS[@]} -eq 0 ]; then
  for h in choumeizai moomichinese8384 ChineseCharacters trainchinese EsChineseClass hsktips MandarinChinesewithTaskpins \
           alittlechineseword EDEO_LEGOOMANDARIN Chinese-learning keershao318 shuohanyu8377 weilicalligraphie chinoisauthentique \
           LinlinTong-k8k ChineseInMinutes 808CJK LitaoChinese SkritterHQ HskAcademy ShaoLanOfficial UncleHanzi yoyotvebc \
           FiveADayKanji Chineeze-Apprendrelechinois chinois150mots4 ginkgoacademy5871 javierchile88 HanziKid \
           learnchineseonyoutube2685 JingleChinese ChineseCharacters3000 Apprendrelechinoisenvideo \
           HanziWhisper hanzikite owadcn jojochinois7095 mandarinchinese8159 MrSmile_181 DANLIAOFreeToLearnChinese parfumsdubois; do
    URLS+=("https://www.youtube.com/@$h/videos")
  done
  URLS+=("https://www.youtube.com/user/theforeverastudent/videos" "https://www.youtube.com/channel/UC3x7FnFPBayEmJenwjJmSgg/videos")
fi
mkdir -p "$OUT"
for u in "${URLS[@]}"; do
  key=$(printf '%s' "$u" | sed -E 's#.*/(@|user/|channel/)([^/]+).*#\2#')
  f="$OUT/$key.json"
  [ -s "$f" ] && continue
  if timeout 240 "$Y" --ignore-config --no-warnings -J --flat-playlist --playlist-end "$MAX" "$u" > "$f.tmp" 2> "$f.err"; then
    mv "$f.tmp" "$f"; rm -f "$f.err"; echo "ok $key"
  else
    echo "FAIL $key: $(head -c 200 "$f.err")"; rm -f "$f.tmp"
    grep -qiE "not a bot|429|Too Many" "$f.err" && { echo "bot-check/429 → stop"; exit 2; }
  fi
  sleep 3
done
