# Opération Mandarin — architecture (lire avant de coder)

App desktop Electron 45 + React 19 + TypeScript, empaquetée en **AppImage** (`npm run dist`).
Langue de l'interface : **français**. Caractères **simplifiés**. Tout fonctionne **hors-ligne** (sauf téléchargement de vidéos, vidéos YouTube par mot, formes anciennes des caractères et IA optionnelle — ces fonctions se dégradent proprement, message en français, sans bloquer l'interface).

## Commandes
- `npm run build` : bundle main (esbuild → `dist/main`) + renderer (vite → `dist/renderer`)
- `npx tsc --noEmit -p .` : typecheck (doit rester à 0 erreur)
- `npm test` : vitest (`tests/**/*.test.ts`)
- Lancer : `npm run build && xvfb-run -a npx electron . --no-sandbox` (root dans le conteneur → `--no-sandbox`)
- Les données utilisateur vont dans `~/.config/Operation Mandarin/` (`user.db`, `media/`, `tts/`, `models/`, `recordings/`, `ancient/` = cache des formes anciennes Commons).

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
  wordVideos.ts             score titre ↔ mot/caractère (port de scripts/lib/word-video-score.mjs, test de parité), index, rotation, URL d'embed
  time.ts                   dayKey() (jour d'étude, bascule à 4h), addDays, daysBetween, weekday
src/main/
  main.ts, preload.ts       fenêtre + pont `window.om.invoke(channel, ...args)` ; main.ts ajoute le Referer des embeds YouTube
  tts-worker.ts             processus séparé (ELECTRON_RUN_AS_NODE) qui charge sherpa-onnx (Matcha) ; protocole JSON-lines init/gen/ping
  ctx.ts                    Ctx {paths, db, content, srs, cur, settings(), saveSettings(), emit(channel,payload)} + handle(channel, fn)
  ipc/index.ts              enregistre chaque module : core, study, grammar, tests, media, tts, ai, reading, wordvideo (`video:*`), chars
  ipc/<module>.ts           export function register(ctx) — un module = un préfixe de canal (`media:*`, `tts:*`…)
  services/                 code non-IPC (binaires externes, IA…) : tts.ts (chaîne de voix + gestion du worker), nativeAudio.ts (enregistrements natifs + Tatoeba),
                            wordvideo.ts (vidéo par mot : cache → index → recherche yt-dlp), ancient.ts (formes anciennes Wikimedia Commons, assainissement SVG)
src/renderer/
  App.tsx                   navigation (useNav() → {go(screen, params), back, settings, reloadSettings})
  api.ts                    call<T>(channel, ...args), listen(channel, cb), fileUrl(path)
  components/common.tsx     speak(text, rate?) (ne lève jamais), playFile(path, rate, start, end), AudioButton, Markdown, Modal, toast(), ProgressBar,
                            Loading, ErrorBox, useAsync(fn, deps), useKeys({key: fn}), shuffle, fmtInterval
  components/CharCard.tsx   fiche caractère illustrée (CharCard {char, compact?, showVideo?, onClose?}, CharChip)
  components/WordVideo.tsx  vidéo YouTube d'un mot / caractère (WordVideo {target, slot:'usage'|'etymology', compact?}) — vignette, iframe au clic
  screens/*.tsx             un fichier par écran (exports nommés utilisés par App.tsx — NE PAS renommer)
  styles.css                classes utilitaires documentées en tête de fichier (réutiliser, ne pas réinventer)
resources/data/             words.json (3317 mots HSK ordonnés), chars.json, strokes.json, dict.json (FR+EN), sentences.json (Tatoeba zh-fr),
                            char-stories.json (origine + dessin SVG de 1312 caractères, + `_ancient` = graphies candidates ; `node scripts/build-chars.mjs`
                            depuis content/chars/parts — non empaqueté), word-videos.json (index vidéo précalculé ; `node scripts/build-word-videos.mjs`),
                            tatoeba-audio.json (phrases avec audio humain sous licence ; `node scripts/build-tatoeba-audio.mjs`, à relancer après build-data)
resources/tts/              modèle Matcha zh-baker + vocodeur vocos (`bash scripts/fetch-tts.sh`, gitignoré, à lancer avant `npm run dist`) → extraResources "tts"
resources/audio/            enregistrements natifs mots + syllabes (audio-cmn, CC BY-SA, voir CREDITS.md) → extraResources "audio"
resources/bin/              binaires embarqués (yt-dlp, ffmpeg, whisper-cli, piper/…) → copiés dans l'AppImage (extraResources "bin")
content/grammar/phaseN.json leçons de grammaire (schéma : content/grammar/SCHEMA.md)
content/catalog/catalog.json sources vidéo/podcast vérifiées + starterVideos
```
Chemins à l'exécution : `ctx.paths.bin`, `ctx.paths.data`, `ctx.paths.content`, `ctx.paths.media`, `ctx.paths.tts`, `ctx.paths.models`, `ctx.paths.recordings`, `ctx.paths.ttsModels` (resources/tts), `ctx.paths.audio` (resources/audio).
Empaquetage : `node_modules/sherpa-onnx-linux-x64/**` est dans `asarUnpack` (addon natif) ; `content/chars/**` est exclu (fusionné dans char-stories.json).

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
- **tts** : `tts:speak(text, opts?: {slow?, raw?, engine?: 'auto'|'synth', pn?, syllable?})` → `{path, source: 'native'|'tatoeba'|'matcha'|'piper', rate?} | null`
  (fichier en cache dans `ctx.paths.tts`). Chaîne : enregistrement natif du mot (ou de la syllabe) → audio Tatoeba sous licence (téléchargé à la demande, 5 s max)
  → Matcha (sherpa-onnx, dans `tts-worker.ts` ; mots ≤ 4 caractères envoyés en jetons pinyin + sandhi ; textes longs découpés en morceaux ≤ 50 caractères)
  → Piper en secours. `slow` = lecture ralentie côté renderer (`rate: 0.75`, hauteur conservée), jamais une synthèse plus lente.
  `tts:status()` → `{ok, engine, detail}` ; `tts:selfTest()` (synthèse seulement) ; `tts:syllable(pn)` → `{path, source:'native'} | null`.
  `tts:tones(text)` → tons prononcés (sandhi inclus ; `null` pour les variantes 儿) ; `tts:clip(path, start, end)` → `{path}` wav mono 16 kHz (ffmpeg) ou `null` ; `tts:readAudio(path)` → octets ;
  `tts:toneDrill(n, {syllables:1|2})`, `tts:minimalPairs(n)` (sans mots en 儿 ni variantes), `tts:shadowSet(n)` (exercices).
  Modèles : `bash scripts/fetch-tts.sh` (→ `resources/tts/`) ; Piper : `bash scripts/fetch-piper.sh` (→ `resources/bin/piper/`) — à lancer avant `npm run dist`.
- **video** (vidéo par mot) : `video:forTarget(target, slot)`, `video:next(target, slot)`, `video:hide(target, slot, id, 'irrelevant'|'broken')`
  → `{video: {id, title, channel, duration, start?, offSlot?, label} | null, alternatives, pending, source: 'cache'|'index'|'search'|'ai'|'none', error?, retryInMs?}` (`retryInMs` : recherches en pause réseau → le composant recharge une fois à l'échéance) ;
  `video:prefetch(words[])` → nb de cibles en file (mot = « usage », chaque caractère = « etymology ») ; `video:resume()` → boolean ; évènement `video:updated {target, slot}`.
  Table `word_videos` (cache, `status` ok/hidden/broken, `status_at` : « broken » expire après 30 j). Recherche yt-dlp métadonnées seules, ≤ 1 requête / 5 s, arrêt sur 403/429.
  Les titres peuvent contenir du pinyin : n'afficher `WordVideo` que là où le pinyin est permis. Détails : `docs/word-videos.md`.
- **chars** (fiche caractère) : `chars:card(c)` (sens : FR du programme / du dictionnaire, puis `core/radicals.ts` pour 扌 辶 纟…, `(en) …` en dernier recours ; `card:false` = composant sans fiche ni sens FR, non cliquable) → `{c, py[], fr[], story?: {type, origin, components:[{c, role, fr, py?, card?}], mnemonic, scene, svg, source:'curated'|'mmah'}, dec, rad, strokes, words:[{w, py, fr}], inCurriculum}` ;
  `chars:ancient(c)` → `{forms:[{form, svg, license, author, url, src?}], status:'ok'|'none'|'offline'|'pending'}` (Wikimedia Commons, ≤ 1 requête / 1,5 s, arrêt sur 429,
  SVG assainis, cache `userData/ancient/` v2, « none » revérifié après 30 j). Détails : `docs/ancient-forms.md`.
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
- `src/renderer/components/WordPopup.tsx` (fourni par le noyau) : `export function WordPopup(props: { word: string; onClose: () => void; context?: string })` — sens, pinyin, audio, statut, bouton « Apprendre ce mot », « Origine du caractère » (CharCard) et vidéo d'usage.
- `src/renderer/components/CharCard.tsx` : `CharCard({char, compact?, showVideo?, onClose?})` — dessin SVG en fond, type, origine, composants cliquables, aide-mémoire, formes anciennes, mots, vidéo d'origine repliée. Montre du pinyin : seulement en présentation, popup, dictionnaire, écriture (observer) ou après la réponse.
- `src/renderer/components/WordVideo.tsx` : `WordVideo({target, slot, compact?})` — vignette d'abord, lecteur youtube-nocookie au clic, jamais d'autoplay ; rien si l'IPC échoue.

## Règles de travail en parallèle
- Ne modifie QUE les fichiers de ton module (+ nouveaux fichiers). Si tu as besoin d'un changement ailleurs (types partagés, db.ts SCHEMA, App.tsx), ajoute-le de façon **additive** et minimale (ex. ajouter un champ optionnel, une table `CREATE TABLE IF NOT EXISTS`), sans casser l'existant.
- Garde `npx tsc --noEmit -p .` à 0 erreur pour tes fichiers et `npm run build` fonctionnel.
- Ajoute des tests vitest pour la logique pure que tu écris (dans `tests/`).
