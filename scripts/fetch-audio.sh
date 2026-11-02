#!/usr/bin/env bash
# Enregistrements NATIFS (voix humaines) des mots du programme et des 1 688 syllabes toniques.
# Source : https://github.com/hugolpz/audio-cmn (CC BY-SA ; mots : Yue Tan / Shtooka ; syllabes : Chen Wang).
# Rapport d'évaluation, licence et attribution : docs/native-audio.md
#
#   bash scripts/fetch-audio.sh            # mots de resources/data/words.json + syllabes (≈ 15 Mo)
#   bash scripts/fetch-audio.sh --all      # + tous les autres enregistrements HSK 2000 (≈ 8 600 mots)
#   JOBS=8 bash scripts/fetch-audio.sh     # parallélisme ffmpeg (défaut : nproc)
#
# Résultat :
#   resources/audio/words/<codepoints>.opus     ex. 好 → words/597d.opus, 银行 → words/94f6-884c.opus
#   resources/audio/syllables/<pinyin>.opus     pinyin numérique ASCII, ü → v (lv4.opus, nve4.opus)
#   resources/audio/index.json                  { words: {mot → fichier}, syllables: {pinyin → fichier}, ... }
#   resources/audio/CREDITS.md                  texte d'attribution à distribuer avec l'app
# Traitement : silence de début/fin coupé (on garde 60 ms), loudness ramenée à -18 LUFS (crête ≤ -2 dBTP avant codage,
# gain linéaire sans compression), Opus mono 24 kHz ~32 kb/s (VBR) dans un conteneur Ogg.
# Idempotent : un fichier déjà converti n'est pas refait (supprimer resources/audio pour tout refaire).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_URL="https://github.com/hugolpz/audio-cmn"
COMMIT="f759a0f18f27690742957619e1248ed91e9b3f2c" # 2026-10-26, vérifié par l'évaluation
CACHE="${AUDIO_CMN_CACHE:-$ROOT/data-raw/audio-cmn}"
OUT="$ROOT/resources/audio"
FFMPEG="${FFMPEG:-$ROOT/resources/bin/ffmpeg}"
[ -x "$FFMPEG" ] || FFMPEG="$(command -v ffmpeg || true)"
[ -n "$FFMPEG" ] || { echo "ffmpeg introuvable (bash scripts/fetch-binaries.sh)" >&2; exit 1; }
command -v node >/dev/null || { echo "node requis" >&2; exit 1; }
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 4)}"
ALL=0
for a in "$@"; do case "$a" in --all) ALL=1 ;; *) echo "option inconnue : $a" >&2; exit 2 ;; esac; done

# ---------------------------------------------------------------------------------------------
# 1. Récupération partielle du dépôt (≈ 125 Mo : 64k/hsk + 64k/syllabs ; le dépôt complet fait ≈ 390 Mo
#    avec 18k/24k/96k). Clone « blobless » + sparse checkout, épinglé sur $COMMIT.
if [ ! -f "$CACHE/.om-commit" ] || [ "$(cat "$CACHE/.om-commit")" != "$COMMIT" ]; then
  echo "→ Téléchargement d'audio-cmn ($COMMIT, 64k/hsk + 64k/syllabs)…"
  rm -rf "$CACHE"
  mkdir -p "$(dirname "$CACHE")"
  GIT_LFS_SKIP_SMUDGE=1 git clone -q --filter=blob:none --no-checkout --depth 1 "$REPO_URL" "$CACHE"
  git -C "$CACHE" config gc.auto 0
  git -C "$CACHE" config core.quotepath off
  if [ "$(git -C "$CACHE" rev-parse HEAD)" != "$COMMIT" ]; then
    git -C "$CACHE" fetch -q --depth 1 --filter=blob:none origin "$COMMIT"
  fi
  git -C "$CACHE" sparse-checkout init --no-cone
  printf '/README.md\n/lists/\n/64k/hsk/\n/64k/syllabs/\n' > "$CACHE/.git/info/sparse-checkout"
  git -C "$CACHE" checkout -q "$COMMIT"
  echo "$COMMIT" > "$CACHE/.om-commit"
else
  echo "✓ audio-cmn déjà présent ($CACHE)"
fi
[ "$(ls "$CACHE/64k/hsk" | wc -l)" -ge 8000 ] || { echo "dépôt incomplet : $CACHE/64k/hsk" >&2; exit 1; }

mkdir -p "$OUT/words" "$OUT/syllables"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ---------------------------------------------------------------------------------------------
# 2. Sélection (node) → jobs.tsv : kind<TAB>clé<TAB>source<TAB>destination relative
ALL="$ALL" CACHE="$CACHE" ROOT="$ROOT" node - > "$WORK/jobs.tsv" <<'NODE'
const fs = require('fs');
const path = require('path');
const { CACHE, ROOT, ALL } = process.env;
const words = JSON.parse(fs.readFileSync(path.join(ROOT, 'resources/data/words.json'), 'utf8'));
const hskDir = path.join(CACHE, '64k/hsk');
const sylDir = path.join(CACHE, '64k/syllabs');
const rec = new Set(fs.readdirSync(hskDir).filter((f) => f.endsWith('.mp3')).map((f) => f.slice(4, -4)));
// Enregistrements dont la lecture ≠ celle du programme (contrôle de hauteur, docs/native-audio.md §5) → exclus
// (l'app retombe sur la synthèse Piper pour ces mots).
const EXCLUDE = { 喂: 'wèi', 长: 'zhǎng', 转: 'zhuàn', 处: 'chù', 卷: 'juǎn', 量: 'liáng', 挑: 'tiāo', 散: 'sàn', 血: 'xiě' };
// Mots en 儿 dont la forme sans 儿 est un AUTRE mot (这儿 « ici » ≠ 这 « ce ») : jamais d'enregistrement de repli
// (la voix de 这 pour 这儿 ferait entendre « zhè » à la question d'écoute « ici ») → synthèse.
const ERHUA_DISTINCT = new Set(['这儿', '那儿', '哪儿']);
const fileOf = (w) => 'words/' + [...w].map((c) => c.codePointAt(0).toString(16)).join('-') + '.opus';
const out = [];
const done = new Set();
const add = (key, recWord) => {
  if (done.has(key)) return;
  done.add(key);
  out.push(['word', key, path.join(hskDir, `cmn-${recWord}.mp3`), fileOf(key)].join('\t'));
};
for (const x of words) {
  if (EXCLUDE[x.w]) continue;
  if (rec.has(x.w)) add(x.w, x.w);
  else if (!ERHUA_DISTINCT.has(x.w)) {
    // variante avec / sans 儿 (玩 ↔ 玩儿, 味儿 ↔ 味…) : même mot, prononciation sans/avec érhua
    const alt = x.w.endsWith('儿') ? x.w.slice(0, -1) : x.w + '儿';
    if (rec.has(alt)) add(x.w, alt);
  }
}
if (ALL === '1') for (const w of [...rec].sort()) if (!EXCLUDE[w] && !w.includes('_')) add(w, w);
// Syllabes : tons 1-4 uniquement (les 19 fichiers « *5 » ne sont pas des syllabes isolées : 1,7-5 s de parole).
for (const f of fs.readdirSync(sylDir).sort()) {
  const m = f.match(/^cmn-_?([a-z]+)([1-4])\.mp3$/);
  if (!m) continue;
  let base = m[1];
  if (['lvan', 'nia'].includes(base)) continue; // noms non standard (pas du pinyin)
  if (base === 'jv') base = 'ju'; // erreur de nommage de la source : cmn-jv4.mp3 = ju4
  out.push(['syl', base.replace(/v/g, 'ü') + m[2], path.join(sylDir, f), `syllables/${base}${m[2]}.opus`].join('\t'));
}
process.stdout.write(out.join('\n') + '\n');
NODE

# ---------------------------------------------------------------------------------------------
# 3. Conversion (2 passes ffmpeg par fichier : mesure de loudness après découpe, puis gain + Opus)
TRIM="silenceremove=start_periods=1:start_duration=0.02:start_threshold=-45dB:start_silence=0.06:detection=rms"
TRIM="$TRIM,areverse,$TRIM,areverse"
convert_one() {
  local kind="$1" key="$2" src="$3" rel="$4"
  local dst="$OUT/$rel"
  if [ ! -s "$dst" ]; then
    local meas I TP gain
    # Mesure sur le clip découpé répété 4× : l'intégration EBU R128 (blocs de 400 ms) renvoie -inf pour les
    # clips < 0,4 s (≈ 9 % des syllabes) ; la répétition donne la même loudness sans ce défaut.
    meas="$("$FFMPEG" -hide_banner -nostats -i "$src" -filter_complex \
      "[0:a]$TRIM,asplit=4[a][b][c][d];[a][b][c][d]concat=n=4:v=0:a=1,loudnorm=print_format=json" -f null - 2>&1 | tr -d ' \n')"
    I="$(sed -n 's/.*"input_i":"\([-0-9.inf]*\)".*/\1/p' <<<"$meas")"
    TP="$(sed -n 's/.*"input_tp":"\([-0-9.inf]*\)".*/\1/p' <<<"$meas")"
    gain="$(awk -v i="$I" -v tp="$TP" 'BEGIN{ if (i=="" || i ~ /inf/) { print 0; exit } g=-18-i; h=-2-tp; if (h<g) g=h; printf "%.2f", g }')"
    "$FFMPEG" -nostdin -v error -y -i "$src" -af "$TRIM,volume=${gain}dB" -ac 1 -ar 24000 \
      -c:a libopus -b:a 32k -vbr on -application audio -map_metadata -1 "$dst.tmp.opus"
    mv "$dst.tmp.opus" "$dst"
  fi
  printf '%s\t%s\t%s\t%s\n' "$kind" "$key" "$rel" "$(stat -c %s "$dst")"
}
export -f convert_one
export FFMPEG OUT TRIM
N="$(wc -l < "$WORK/jobs.tsv")"
echo "→ Conversion de $N fichiers (JOBS=$JOBS)…"
xargs -d '\n' -n 1 -P "$JOBS" bash -c 'IFS=$'"'"'\t'"'"' read -r a b c d <<<"$1"; convert_one "$a" "$b" "$c" "$d"' _ \
  < "$WORK/jobs.tsv" > "$WORK/done.tsv"

# ---------------------------------------------------------------------------------------------
# 4. Index + crédits
ROOT="$ROOT" OUT="$OUT" COMMIT="$COMMIT" WORK="$WORK" node - <<'NODE'
const fs = require('fs');
const path = require('path');
const { ROOT, OUT, COMMIT, WORK } = process.env;
const words = JSON.parse(fs.readFileSync(path.join(ROOT, 'resources/data/words.json'), 'utf8'));
const rows = fs.readFileSync(path.join(WORK, 'done.tsv'), 'utf8').trim().split('\n').map((l) => l.split('\t'));
const jobs = fs.readFileSync(path.join(WORK, 'jobs.tsv'), 'utf8').trim().split('\n').map((l) => l.split('\t'));
const srcOf = Object.fromEntries(jobs.map((j) => [j[0] + ':' + j[1], path.basename(j[2], '.mp3').slice(4)]));
const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const W = {}, S = {}, variants = {};
let bytes = 0;
for (const [kind, key, rel, size] of rows) {
  bytes += +size;
  if (kind === 'word') {
    W[key] = rel;
    const s = srcOf['word:' + key];
    if (s !== key) variants[key] = s;
  } else S[key] = rel;
}
// Fichiers orphelins (ex. après retrait d'un mot) : supprimés pour que le dossier = l'index.
const keep = new Set([...Object.values(W), ...Object.values(S)]);
for (const d of ['words', 'syllables'])
  for (const f of fs.readdirSync(path.join(OUT, d))) if (!keep.has(`${d}/${f}`)) fs.rmSync(path.join(OUT, d, f));
const cur = words.filter((x) => W[x.w]).length;
const cur1700 = words.filter((x) => x.rank < 1700);
const index = {
  version: 1,
  generated: new Date().toISOString().slice(0, 10),
  format: 'Ogg Opus, mono, 24 kHz, ~32 kb/s VBR ; silences de bord coupés (60 ms conservés) ; -18 LUFS, crête ≤ -2 dBTP avant codage',
  naming: {
    words: 'words/<codepoints hexadécimaux du mot séparés par « - »>.opus (好 → words/597d.opus)',
    syllables: 'syllables/<pinyin numérique ASCII, ü → v>.opus ; clés de l’index en pinyin numérique avec ü (nü3, lüe4), tons 1-4 seulement',
  },
  sources: {
    words: { name: 'audio-cmn (HSK 2000) ← Shtooka cmn-caen-tan', speaker: 'Yue Tan (voix féminine, Liaoning)', license: 'CC BY-SA 3.0 (cc-by-sa-3.0-us sur Wikimedia Commons)', url: 'https://github.com/hugolpz/audio-cmn', commit: COMMIT },
    syllables: { name: 'audio-cmn syllabs v.2', speaker: 'Chen Wang (王琛)', license: 'CC BY-SA (version non précisée par la source)', url: 'https://github.com/hugolpz/audio-cmn', commit: COMMIT },
  },
  stats: {
    words: Object.keys(W).length,
    syllables: Object.keys(S).length,
    curriculumCovered: cur,
    curriculumTotal: words.length,
    curriculumRankLt1700Covered: cur1700.filter((x) => W[x.w]).length,
    curriculumRankLt1700Total: cur1700.length,
    bytes,
  },
  // mot du programme → mot effectivement enregistré (érhua ajouté / retiré)
  variants: sortObj(variants),
  // exclus car la lecture enregistrée diffère de celle du programme (→ synthèse vocale)
  excluded: { 喂: 'wèi (programme : wéi)', 长: 'zhǎng (programme : cháng)', 转: 'zhuàn (programme : zhuǎn)', 处: 'chù (programme : chǔ)', 卷: 'juǎn (programme : juàn)', 量: 'liáng (programme : liàng)', 挑: 'tiāo (programme : tiǎo)', 散: 'sàn (programme : sǎn)', 血: 'xiě (programme : xuè)' },
  words: sortObj(W),
  syllables: sortObj(S),
};
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1) + '\n');
fs.writeFileSync(
  path.join(OUT, 'CREDITS.md'),
  `# Enregistrements audio natifs

Prononciations des mots : **Yue Tan**, projet Shtooka (collection « cmn-caen-tan »),
licence Creative Commons Attribution – Partage dans les mêmes conditions 3.0 (CC BY-SA 3.0 ; « 3.0 US »
selon Wikimedia Commons), https://creativecommons.org/licenses/by-sa/3.0/ .
Syllabes : **Chen Wang** (王琛), licence CC BY-SA (dépôt audio-cmn).
Sélection, renommage et compression d'origine : Hugo Lopez (PLIDAM, INALCO), dépôt « audio-cmn »
https://github.com/hugolpz/audio-cmn (commit ${COMMIT.slice(0, 7)}) ; logiciel d'enregistrement : Nicolas Vion.

Modifications apportées par Opération Mandarin : coupe des silences de début et de fin, normalisation
du volume (-18 LUFS), conversion en Opus mono 32 kb/s, renommage. Ces fichiers modifiés sont
redistribués sous la même licence CC BY-SA.

Phrases (audio humain Tatoeba, téléchargé à la demande, jamais embarqué) : enregistrements de **GlossaMatik**,
licence CC BY-NC 4.0 (usage non commercial), https://creativecommons.org/licenses/by-nc/4.0/ —
https://tatoeba.org ; auteur et licence de chaque phrase dans resources/data/tatoeba-audio.json.
`,
);
console.log(JSON.stringify(index.stats));
NODE
du -sh "$OUT" "$OUT/words" "$OUT/syllables"
echo "✓ resources/audio prêt"
