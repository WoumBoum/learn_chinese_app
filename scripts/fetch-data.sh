#!/usr/bin/env bash
# Downloads the open datasets used by scripts/build-data.mjs into data-raw/.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data-raw && cd data-raw
curl -fsSL -o cfdict.u8 https://chine.in/assets/cfdict/cfdict.u8
curl -fsSL -o cedict.txt.gz https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz
curl -fsSL -o hsk-complete.json https://raw.githubusercontent.com/drkameleon/complete-hsk-vocabulary/main/complete.json
curl -fsSL -o mmah-graphics.txt https://raw.githubusercontent.com/skishore/makemeahanzi/master/graphics.txt
curl -fsSL -o mmah-dictionary.txt https://raw.githubusercontent.com/skishore/makemeahanzi/master/dictionary.txt
for f in per_language/cmn/cmn_sentences.tsv.bz2 per_language/fra/fra_sentences.tsv.bz2 per_language/cmn/cmn-fra_links.tsv.bz2 per_language/cmn/cmn_sentences_with_audio.tsv.bz2; do
  curl -fsSL -o "$(basename "$f")" "https://downloads.tatoeba.org/exports/$f"
done
bunzip2 -kf ./*.bz2
echo "data-raw prêt"
