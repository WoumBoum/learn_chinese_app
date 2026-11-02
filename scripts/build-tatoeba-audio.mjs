// Génère resources/data/tatoeba-audio.json : enregistrements humains Tatoeba des phrases de sentences.json
// dont la LICENCE permet la réutilisation hors de Tatoeba (les autres — sans licence — sont exclus :
// « If the license field is empty, you may not reuse the audio outside the Tatoeba project »).
// Source : data-raw/cmn_sentences_with_audio.tsv (bash scripts/fetch-data.sh) — colonnes :
//   id de phrase, id d'audio, auteur, licence, URL d'attribution
// L'audio est téléchargé à la demande par l'app : https://tatoeba.org/audio/download/<id d'audio>
// (l'URL attend l'id d'AUDIO, pas l'id de phrase — cf. docs/native-audio.md §6).
// Usage : node scripts/build-tatoeba-audio.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSV = path.join(ROOT, 'data-raw/cmn_sentences_with_audio.tsv');
const SENT = path.join(ROOT, 'resources/data/sentences.json');
const OUT = path.join(ROOT, 'resources/data/tatoeba-audio.json');

if (!fs.existsSync(TSV)) {
  console.error(`${TSV} absent : lancez « bash scripts/fetch-data.sh ».`);
  process.exit(1);
}
const ids = new Set(JSON.parse(fs.readFileSync(SENT, 'utf8')).map((s) => s.id));
const sentences = {};
const skipped = {};
let withAudio = 0;
for (const line of fs.readFileSync(TSV, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const [sid, aid, by = '', lic = '', url = ''] = line.split('\t');
  const id = Number(sid);
  if (!ids.has(id)) continue;
  withAudio++;
  if (!lic.trim()) {
    skipped[by || '?'] = (skipped[by || '?'] ?? 0) + 1;
    continue;
  }
  if (sentences[sid]) continue; // un seul enregistrement par phrase (le premier)
  const e = { a: Number(aid), by, lic: lic.trim() };
  if (url.trim()) e.url = url.trim();
  sentences[sid] = e;
}
const licences = {};
for (const e of Object.values(sentences)) licences[e.lic] = (licences[e.lic] ?? 0) + 1;
const out = {
  version: 1,
  source: 'Tatoeba (https://tatoeba.org), export cmn_sentences_with_audio.tsv',
  url: 'https://tatoeba.org/audio/download/<a>',
  note: 'Seuls les enregistrements avec licence de réutilisation sont listés ; auteur et licence conservés par phrase.',
  stats: { sentencesWithAudio: withAudio, licensed: Object.keys(sentences).length, licences, excludedWithoutLicence: skipped },
  sentences,
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
console.log(`✓ ${OUT} : ${Object.keys(sentences).length} phrases avec licence (sur ${withAudio} enregistrées)`, licences);
