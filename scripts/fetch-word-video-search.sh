#!/usr/bin/env bash
# Evaluation helper (word-videos): runs yt-dlp "ytsearchN:" for sample words × query templates and stores the
# raw --flat-playlist JSON (one file per query) so the ranking can be designed/replayed offline.
#   bash scripts/fetch-word-video-search.sh OUT_DIR [N=10] [words...]
#   QUERIES_FILE=list.tsv bash scripts/fetch-word-video-search.sh OUT_DIR [N]   (lines: word<TAB>template<TAB>query-or-URL;
#   a URL such as https://www.youtube.com/@choumeizai/search?query=木 is fetched as a channel-scoped search)
# Stops at the first bot-check / HTTP 429 instead of retrying (never hammer YouTube).
set -u
OUT=${1:?out dir}; N=${2:-10}; shift 2 || true
WORDS=("$@")
[ ${#WORDS[@]} -eq 0 ] && WORDS=(木 人 好 水 口 日 女 家 马 朋友 喜欢 觉得 学习 因为 认识)
HERE=$(cd "$(dirname "$0")/.." && pwd)
Y=${YTDLP:-$HERE/resources/bin/yt-dlp}
TEMPLATES=('{w} 汉字 字源' '{w} Chinese character origin' 'HSK {w}' '{w} 怎么用 例句' '{w} caractère chinois')
mkdir -p "$OUT"
i=0
JOBS=()
if [ -n "${QUERIES_FILE:-}" ]; then
  while IFS=$'\t' read -r w t q; do [ -n "$w" ] && JOBS+=("$w"$'\t'"$t"$'\t'"$q"); done < "$QUERIES_FILE"
else
  for w in "${WORDS[@]}"; do for t in "${TEMPLATES[@]}"; do JOBS+=("$w"$'\t'"$t"$'\t'"${t//\{w\}/$w}"); done; done
fi
for job in "${JOBS[@]}"; do
  IFS=$'\t' read -r w t q <<< "$job"
  {
    f="$OUT/$(printf '%s' "$q" | md5sum | cut -c1-12).json"
    [ -s "$f" ] && continue
    start=$(date +%s.%N)
    case "$q" in http*) target=$q; lim=(--playlist-end "$N");; *) target="ytsearch$N:$q"; lim=();; esac
    if ! timeout 90 "$Y" --ignore-config --no-warnings -J --flat-playlist "${lim[@]}" "$target" > "$f.tmp" 2> "$f.err"; then
      echo "FAIL [$q]: $(head -c 300 "$f.err")"
      if grep -qiE "not a bot|429|Too Many" "$f.err"; then echo "bot-check/429 → stop"; exit 2; fi
      continue
    fi
    end=$(date +%s.%N)
    python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); d["_query"]=sys.argv[2]; d["_word"]=sys.argv[3]; d["_template"]=sys.argv[4]; d["_elapsed"]=float(sys.argv[5]); json.dump(d,open(sys.argv[6],"w"),ensure_ascii=False)' \
      "$f.tmp" "$q" "$w" "$t" "$(echo "$end - $start" | bc)" "$f" && rm -f "$f.tmp" "$f.err"
    i=$((i+1)); echo "ok $i [$q]"
    sleep 2
  }
done
echo "done: $i queries"
