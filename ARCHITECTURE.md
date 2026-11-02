# Opération Mandarin — architecture (lire avant de coder)

App desktop Electron 45 + React 19 + TypeScript, empaquetée en **AppImage** (`npm run dist`).
Langue de l'interface : **français**. Caractères **simplifiés**. Tout fonctionne **hors-ligne** (sauf téléchargement de vidéos et IA optionnelle).

## Commandes
- `npm run build` : bundle main (esbuild → `dist/main`) + renderer (vite → `dist/renderer`)
- `npx tsc --noEmit -p .` : typecheck (doit rester à 0 erreur)
- `npm test` : vitest (`tests/**/*.test.ts`)
- Lancer : `npm run build && xvfb-run -a npx electron . --no-sandbox` (root dans le conteneur → `--no-sandbox`)
- Les données utilisateur vont dans `~/.config/Operation Mandarin/` (`user.db`, `media/`, `tts/`, `models/`, `recordings/`).

## Arborescence
```
src/shared/types.ts         Types partagés main/renderer (Word, CardRow, DayPlan, Segment, VideoRow, Mission, GrammarPoint…)
src/core/                   Logique pure, sans Electron (testable avec vitest)
  db.ts                     sql.js (SQLite WASM). SCHEMA = contrat de données entre modules. Db.all/get/run/tx/getSetting/setSetting
  srs.ts                    FSRS (ts-fsrs 5) : ensureCard, review, due, fresh, countDue, forecast, retrievability
  curriculum.ts             mots introduits/connus, phases, déblocage grammaire, tests hebdo, projection
  planner.ts                plan du jour adaptatif (Express / Standard / Marathon, rattrapage)
  content.ts                charge resources/data/*.json + content/grammar + content/catalog ; gloss(), examplesFor(), numericToMarks()
  nlp.ts                    segment(text) via jieba-wasm, isHan, normZh
  subtitles.ts              parseSubtitles(vtt|srt) → Cue[]
  coverage.ts               analyseCoverage(lines, opts) → CoverageReport (mots à pré-enseigner)
  time.ts                   dayKey() (jour d'étude, bascule à 4h), addDays, daysBetween, weekday
src/main/
  main.ts, preload.ts       fenêtre + pont `window.om.invoke(channel, ...args)`
  ctx.ts                    Ctx {paths, db, content, srs, cur, settings(), saveSettings(), emit(channel,payload)} + handle(channel, fn)
  ipc/index.ts              enregistre chaque module : core, study, grammar, tests, media, tts, ai
  ipc/<module>.ts           export function register(ctx) — un module = un préfixe de canal (`media:*`, `tts:*`…)
  services/                 code non-IPC (binaires externes, IA…)
src/renderer/
  App.tsx                   navigation (useNav() → {go(screen, params), back, settings, reloadSettings})
  api.ts                    call<T>(channel, ...args), listen(channel, cb), fileUrl(path)
  components/common.tsx     speak(text), playFile(path, rate, start, end), AudioButton, Markdown, Modal, toast(), ProgressBar,
                            Loading, ErrorBox, useAsync(fn, deps), useKeys({key: fn}), shuffle, fmtInterval
  screens/*.tsx             un fichier par écran (exports nommés utilisés par App.tsx — NE PAS renommer)
  styles.css                classes utilitaires documentées en tête de fichier (réutiliser, ne pas réinventer)
resources/data/             words.json (3317 mots HSK ordonnés), chars.json, strokes.json, dict.json (FR+EN), sentences.json (Tatoeba zh-fr)
resources/bin/              binaires embarqués (yt-dlp, ffmpeg, whisper-cli, piper/…) → copiés dans l'AppImage (extraResources "bin")
content/grammar/phaseN.json leçons de grammaire (schéma : content/grammar/SCHEMA.md)
content/catalog/catalog.json sources vidéo/podcast vérifiées + starterVideos
```
Chemins à l'exécution : `ctx.paths.bin`, `ctx.paths.data`, `ctx.paths.content`, `ctx.paths.media`, `ctx.paths.tts`, `ctx.paths.models`, `ctx.paths.recordings`.

## Principes pédagogiques (à respecter dans chaque écran)
1. **Pinyin seulement quand il sert à apprendre le son** :
   - jamais sur les cartes caractère → sens, audio → sens, ni dans les exercices de traduction FR↔ZH ni la grammaire ;
   - affiché une fois à la présentation d'un nouveau mot, dans les exercices de tons, et dans la réponse « prononciation » ;
   - dans le lecteur vidéo / la lecture : désactivé par défaut, au clic sur un mot (popup), option « pinyin au-dessus des mots inconnus » (`settings.pinyinOnUnknownInPlayer`).
2. **Audio d'abord** : tout texte chinois doit pouvoir être écouté (`AudioButton` / `speak()` → canal `tts:speak`).
3. **Tout ce qui est appris passe par FSRS** (`ctx.srs`), y compris la grammaire (carte `grammar:rule:<id>`) et les phrases minées (`sentence:listen:<id>`).
4. **Écriture : sur papier** (pas de stylet). L'app donne des consignes de répétition, montre le modèle, l'utilisateur compare et s'auto-évalue.
5. **IA optionnelle** : si pas de clé API, chaque fonction a un repli déterministe ou se masque proprement.
6. Thème « agent secret / centre de formation », sobre, lisible. Interface 100 % français.

## Contrat des canaux IPC
Existants (core/study — déjà implémentés) :
- `core:getSettings`, `core:saveSettings(partial)`, `core:plan(mode?)`, `core:markBlockDone(type)`, `core:logActivity(type, minutes, detail?)`
  - types d'activité utilisés pour les stats : `mission`, `listening`, `shadowing` (comptent comme minutes d'écoute), `grammar`, `writing`, `reading`, `tones`, `roleplay`, `test`
- `core:progress`, `core:lookup(word)` → {w, py, fr, en, status, hsk, inCurriculum, chars, cl}, `core:searchDict(q)`, `core:setWordStatus(w, 'known'|'ignored'|null)`
- `core:segment(text)` → Token[] (avec status known/learning/new), `core:knownWords()` → string[], `core:strokes(char)`, `core:charInfo(char)`, `core:openExternal(url)`
- `study:queue({queue:'main'|'grammar'|'writing', limit?})` → StudyCard[], `study:answer(cardId, grade 1-4, durationMs)` → StudyCard
- `study:newBatch({count, source:'curriculum'|'mission', missionId?})`, `study:introduce(words[], source)`, `study:addWord(w, source)`
- `study:mine({videoId, zh, fr?, start, end})` → id (crée une carte d'écoute FSRS), `study:examples(w)`, `study:writingSession({long})`

À implémenter par les modules (noms imposés car utilisés par d'autres écrans) :
- **tts** : `tts:speak(text)` → `{path}` (wav en cache dans `ctx.paths.tts`) ; `tts:status()` → `{ok, engine, detail}`
  - (module tons, implémenté) `tts:speak(text, {slow:true})` = débit lent ; renvoie `null` si Piper est absent. Mots de 1-2 syllabes : tons corrigés automatiquement (PSOLA, cf. `services/tonefix.ts`).
    `tts:tones(text)` → tons prononcés (sandhi inclus) ; `tts:clip(path, start, end)` → `{path}` wav mono 16 kHz (ffmpeg) ou `null` ; `tts:readAudio(path)` → octets ;
    `tts:toneDrill(n, {syllables:1|2})`, `tts:minimalPairs(n)`, `tts:shadowSet(n)` (exercices). Binaires : `bash scripts/fetch-piper.sh` (→ `resources/bin/piper/`, ~112 Mo, à lancer avant `npm run dist`).
- **media** : `media:*` (voir module vidéo) ; tables `videos`, `segments`, `missions`, `mined` (schéma dans core/db.ts)
  - ingestion : `media:add(url, {sourceId?, n?})` (vidéo, playlist/chaîne → N dernières, ou flux RSS) → VideoInfo[] ; `media:addLocal(path?)` (dialogue si absent ; .srt/.vtt du même nom importé) ; `media:addRss(url, n)`, `media:rssEpisodes(url)` ; `media:importSubs(id, path?)`
  - préparation (progression poussée sur `media:progress` {id, pct, stage, message}) : `media:fetchSubs(id)`, `media:download(id)`, `media:transcribe(id, 'base'|'small')`, `media:prepare(id)` (tout en un), `media:downloadModel(size)`, `media:cancel(id)`, `media:jobs()`
  - lecture : `media:list()`, `media:get(id)`, `media:segments(id)` → PlayerSegment[] (tokens avec statut + pinyin des mots non connus), `media:coverage(id)` → CoverageReport + `projected[]` + `readyInDays`, `media:projectedCoverage(id, date)`
  - missions : `media:planMission(videoId, date?)`, `media:missions()`, `media:mission(id)`, `media:missionForVideo(videoId)`, `media:nextMission()`, `media:setPreteach(missionId, words)`, `media:setMissionDate(id, date)`, `media:completeMission(id, comprehension, minutes?)`, `media:markWatched(videoId, comprehension?, minutes?)`, `media:quiz(videoId, n?)` (quiz d'écoute déterministe)
  - catalogue / écoute : `media:recommend()`, `media:sources()`, `media:scanSource(sourceId, n)`, `media:exportAudio(id)` → {path}, `media:listeningQueue()`, `media:prefs()` / `media:setPrefs({cookiesBrowser, whisperModel, autoDownload})`, `media:binStatus()`
  - types : `src/shared/media.ts` ; logique pure : `src/core/media.ts` ; binaires : `bash scripts/fetch-binaries.sh` (yt-dlp, ffmpeg statique, whisper-cli compilé)
- **ai** : `ai:status()` → `{configured:boolean, model}` ; `ai:translateLines(videoId)` → remplit `segments.fr` ; `ai:explainLine(zh, context?)` → markdown FR ;
  `ai:refinePreteach(videoId)` → PreteachWord[] ; `ai:analyzeVideo(videoId)` → {summary, themes[]} (stocké dans videos) ; `ai:quiz(videoId)` → questions ;
  `ai:correct({fr, userZh, answers})` → {correct, explanation, corrected} ; `ai:story(opts)` ; `ai:roleplay(...)` ; `ai:confusions()`
  Toute fonction `ai:*` lève une Error('IA non configurée') si pas de clé — l'appelant doit masquer la fonction (vérifier `ai:status` d'abord).
- **grammar** : `grammar:list()`, `grammar:get(id)`, `grammar:complete(id, score)`, `grammar:reviewSet(id)` (exercices pour une révision)
- **tests** : `tests:weekly()`, `tests:submit(...)`, `tests:history()`

## Composants partagés à fournir
- `src/renderer/components/PitchCompare.tsx` (module tons) :
  `export function PitchCompare(props: { text: string; refPath?: string; refStart?: number; refEnd?: number; compact?: boolean })`
  — enregistre le micro, calcule la courbe F0 (YIN) de l'utilisateur et de la référence (audio TTS de `text` si `refPath` absent, sinon extrait [refStart,refEnd] du fichier), les affiche superposées (demi-tons normalisés), score de similarité. Utilisé par le lecteur vidéo (shadowing) et l'écran Tons.
- `src/renderer/components/GrammarExercise.tsx` (module grammaire) :
  `export function GrammarExercise(props: { ex: GrammarExercise; onDone: (correct: boolean) => void })` — rend n'importe quel type d'exercice (tuiles cliquables pour les réponses en chinois : pas besoin d'IME ; champ libre optionnel corrigé par `ai:correct` si IA configurée).
- `src/renderer/components/WordPopup.tsx` (fourni par le noyau) : `export function WordPopup(props: { word: string; onClose: () => void; context?: string })` — sens, pinyin, audio, statut, bouton « Apprendre ce mot ».

## Règles de travail en parallèle
- Ne modifie QUE les fichiers de ton module (+ nouveaux fichiers). Si tu as besoin d'un changement ailleurs (types partagés, db.ts SCHEMA, App.tsx), ajoute-le de façon **additive** et minimale (ex. ajouter un champ optionnel, une table `CREATE TABLE IF NOT EXISTS`), sans casser l'existant.
- Garde `npx tsc --noEmit -p .` à 0 erreur pour tes fichiers et `npm run build` fonctionnel.
- Ajoute des tests vitest pour la logique pure que tu écris (dans `tests/`).
