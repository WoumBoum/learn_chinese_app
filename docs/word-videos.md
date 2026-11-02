# Une vidéo YouTube par mot appris — conception et dé-risquage

Évaluation du 2026-11-02 (bac à sable : IP de centre de données, sortie HTTPS via proxy ; YouTube partiellement bloqué).
Aucun fichier de `src/` n'a été modifié.

Scripts (tous rejouables) :

| Script | Rôle |
|---|---|
| `scripts/fetch-word-video-search.sh OUT [N] [mots…]` | `yt-dlp -J --flat-playlist "ytsearchN:<requête>"` pour mots × gabarits (ou `QUERIES_FILE=` : liste TSV, y compris recherche limitée à une chaîne `https://www.youtube.com/@h/search?query=…`) ; s'arrête au premier bot-check/429, **jamais de boucle de ré-essai** |
| `scripts/lib/word-video-score.mjs` | **fonction de score pure** (spécification §4), à porter telle quelle en `src/core/wordVideos.ts` |
| `scripts/lib/word-video-score.test.mjs` | `node --test scripts/lib/word-video-score.test.mjs` — 8 tests, tous verts |
| `scripts/eval-word-video-ranking.mjs SEARCH_DIR` | rejoue les JSON de recherche en cache dans le score, affiche le top-N par mot et par emplacement |
| `scripts/verify-word-video-channels.sh OUT [MAX]` + `scripts/summarise-word-video-channels.py OUT --json S.json` | liste les vidéos des chaînes candidates (`--flat-playlist`), mesure durée, part de Shorts, couverture du programme |
| `scripts/build-word-video-channels.py S.json` | fusionne la liste éditoriale + les mesures → `content/catalog/word-video-channels.json` |
| banc Electron (hors dépôt) : `…/scratchpad/eval/video/embed-test/{main.js,run-matrix.sh}` | 15 modes d'intégration, inspection des frames, captures d'écran ; le code utile est recopié au §6 |

## 1. Résumé — ce qui est vérifié et ce qui ne l'est pas

| Question | Résultat | Statut |
|---|---|---|
| Existe-t-il des séries « une vidéo par caractère / par mot » ? | **Oui, en nombre** : 43 chaînes vérifiées (`yt-dlp --flat-playlist`, identifiant `UC…` confirmé), dont 5 très grandes séries : Chou Meizai (3 279 vidéos, étymologie ~80 s), trainchinese (3 356, écriture + exemples ~1 min), E's Chinese Class (2 255, mots HSK), alittle一眼眼 (1 000 « 汉字趣谈 »), Mandarin Chinese with Taskpins (723 « Chinese Word of the Day 每日一词 ») | **mesuré** |
| Séries en français | rares et petites, sauf Weilicalligraphie (> 1 500 « un caractère par jour », calligraphie) ; Shuo Han Yu, Chinois 150mots, Chineeze, Tia Gao, Jojo Chinois : 5 à 200 vidéos chacune | mesuré |
| Série CUHK / Yale-China « Understanding Chinese Characters » | le projet existe (10 vidéos, 200 caractères), mais **introuvable** sur la chaîne publique du centre (153 vidéos, 31 playlists) ; la chaîne homonyme « Understanding Chinese Characters » (`user/theforeverastudent`, 165 vidéos) est un projet différent | mesuré |
| Recherche `yt-dlp ytsearch10:` depuis le bac à sable | **répond** : 75 / 75 requêtes au 1ᵉʳ tour (dont 7 réussies au 2ᵉ et unique essai après un 403 isolé), 43 / 43 au 2ᵉ tour ; 2,7 s médiane | mesuré |
| Meilleur résultat par emplacement (15 cibles, recherche) | usage : **15 / 15** centrés sur la cible ; origine : **18 / 21** vraies vidéos d'étymologie, 2 vidéos de calligraphie, 1 repli signalé | jugé sur titre + chaîne (vidéos non regardées) |
| Stratégie « index de chaînes » (sans recherche par mot) | top 300 mots : usage **299 / 300**, origine **237 / 247** caractères ; top 1 000 : **996 / 1 000** et **531 / 569** ; programme entier (3 317) : **76,6 %** et **83,5 %** (borne basse : 9 listes plafonnées à 1 000) ; précision sur échantillon : usage 28 / 30 exacts, origine 27 / 30 | mesuré / jugé |
| Score pur et testable | `scripts/lib/word-video-score.mjs`, 10 tests `node --test` verts | **implémenté** (hors `src/`) |
| Erreur 153 en `file://` | **reproduite** (13 / 13 essais sans `Referer`, y compris `app://` et `origin=`) ; **disparaît** dès qu'un `Referer` https est envoyé pour `/embed/…` (0 / 22) | **mesuré** (captures examinées) |
| Lecture effective d'une vidéo intégrée | **non vérifiable ici** : l'IP du bac à sable est signalée par YouTube (« This content isn't available » ; `yt-dlp -j` → « Sign in to confirm you're not a bot ») ; le témoin `http://127.0.0.1` échoue de la même façon | **à vérifier sur un poste normal** |

**Recommandations**
1. **Contenu** : deux emplacements par mot — « Origine » (un par caractère : Chou Meizai, alittle一眼眼, Edeo & Legoo,
   Mandarin-learning-Lynn, Moomi…) et « Le mot en contexte » (Taskpins « Word of the Day », E's Chinese Class, trainchinese,
   hsk.tips). Construire un **index des chaînes du catalogue** (≈ 24 000 vidéos, ≈ 800 requêtes « flat » une fois, puis
   rafraîchissement hebdomadaire) et ne lancer `ytsearch` qu'en repli. On peut aussi **pré-calculer** la table
   mot → vidéos au build (≈ 127 Ko, 54 Ko gzip pour 3 849 cibles) et la rafraîchir à l'exécution.
2. **Intégration** : garder le renderer en `file://` et une `<iframe>` `youtube-nocookie.com`. Injecter
   `Referer: https://app.operation-mandarin/` (l'identifiant d'application, comme l'exigent les règles YouTube) sur la
   seule requête `/embed/*` via `session.webRequest.onBeforeSendHeaders`, et ajouter
   `frame-src https://www.youtube-nocookie.com https://www.youtube.com` à la CSP. Repli systématique « Ouvrir sur
   YouTube ». Code exact au §6.4.
3. Prévoir la **forme traditionnelle** : ≈ 1 vidéo d'origine sur 6 n'est titrée qu'en traditionnel (覺, 習, 馬, 遠…).
   La correspondance simplifié → traditionnel (CEDICT, déjà dans `data-raw/`) est indispensable à la recherche et utile à
   l'affichage.


## 2. Chaînes candidates (`content/catalog/word-video-channels.json`)

### 2.1 Méthode

1. Candidats : chaînes qui reviennent pour plusieurs cibles avec des titres « un caractère / un mot » dans les
   ≈ 1 180 résultats de recherche (§3), complétées par une recherche web (annuaire UAB « 1001 tools », projet CUHK).
2. Vérification : `yt-dlp --flat-playlist -J --playlist-end 1000 https://www.youtube.com/@<handle>/videos`
   (`scripts/verify-word-video-channels.sh`, 3 s entre chaînes, aucun ré-essai automatique). 45 listes demandées,
   **43 obtenues au premier passage** ; 2 (`chinoisauthentique`, `808CJK`) obtenues au 2ᵉ et dernier essai après un 403
   isolé. Listes complètes (jusqu'à 6 000) pour les 4 plus grosses séries : 9 890 vidéos en **172 s**.
3. Mesures (`summarise-word-video-channels.py`) : durée médiane, part < 60 s, et nombre de caractères parmi les 300 / 1 000
   premiers de `chars.json` (ordre `i`) qui apparaissent **comme jeton isolé** dans un titre (forme simplifiée ou
   traditionnelle CEDICT). C'est un indicateur de couverture, pas de qualité : une chaîne aux titres-phrases
   (Chinese In Minutes) compte des caractères qu'elle n'explique pas.
4. `kind`, `weight`, `language`, `level` et `notes` relèvent d'un jugement éditorial sur les titres et formats observés.
   **Aucune vidéo n'a été regardée**, car l'IP est bloquée pour la lecture.

### 2.2 Catalogue

`content/catalog/word-video-channels.json` : 43 entrées `{name, url, channelId, language, kind, level, weight, notes, verified, stats}`,
toutes `verified: true` (liste obtenue et `channel_id` confirmé le 2026-11-02). Triées par poids :

| Chaîne | Type | Langue | Poids | Vidéos listées | Durée méd. | < 60 s | Car. du top 300 / 1 000 en titre |
|---|---|---|---|---|---|---|---|
| [Chou Meizai](https://www.youtube.com/@choumeizai) | etymology | zh-Hant+en | 0.9 | 3279 | 79 s | 7 % | 161 / 445 |
| [Mandarin Chinese with Taskpins](https://www.youtube.com/@MandarinChinesewithTaskpins) | word | en+zh | 0.9 | 723 | 144 s | 0 % | 156 / 246 |
| [Mandarin-learning-Lynn](https://www.youtube.com/@Chinese-learning) | mixed | en | 0.85 | 426 | 284 s | 0 % | 146 / 239 |
| [Moomi Chinese](https://www.youtube.com/@moomichinese8384) | etymology | en+zh | 0.8 | 130 | 63 s | 49 % | 48 / 68 |
| [trainchinese](https://www.youtube.com/@trainchinese) | word | en | 0.8 | 3356 | 74 s | 2 % | 298 / 985 |
| [E's Chinese Class](https://www.youtube.com/@EsChineseClass) | word | en+zh | 0.75 | 2255 | 82 s | 25 % | 227 / 510 |
| [Shuo Han Yu](https://www.youtube.com/@shuohanyu8377) | etymology | fr+en | 0.75 | 209 | 65 s | 48 % | 26 / 26 |
| [Skritter](https://www.youtube.com/@SkritterHQ) | etymology | en | 0.75 | 279 | 413 s | 0 % | 19 / 21 |
| [alittle一眼眼](https://www.youtube.com/@alittlechineseword) | etymology | zh (CC en) | 0.75 | 1000 | 353 s | 0 % | 145 / 391 |
| [Decode Chinese Characters](https://www.youtube.com/@LinlinTong-k8k) | mixed | en | 0.7 | 79 | 273 s | 0 % | 46 / 69 |
| [Edeo & Legoo Mandarin Publications](https://www.youtube.com/@EDEO_LEGOOMANDARIN) | etymology | en | 0.7 | 1000 (≥, plafonné) | 380 s | 9 % | 39 / 106 |
| [Hanzi Kite](https://www.youtube.com/@hanzikite) | word | en | 0.7 | 29 | 219 s | 14 % | 18 / 18 |
| [Chinois 150mots](https://www.youtube.com/@chinois150mots4) | mixed | fr | 0.65 | 10 | 258 s | 0 % | 12 / 15 |
| [Hanzi Whisper 汉字墨语](https://www.youtube.com/@HanziWhisper) | etymology | zh+en | 0.65 | 39 | 122 s | 3 % | 25 / 35 |
| [Chineeze - Apprendre le chinois](https://www.youtube.com/@Chineeze-Apprendrelechinois) | mixed | fr | 0.6 | 26 | 260 s | 0 % | 4 / 4 |
| [Hotpot Chinese 火锅中文](https://www.youtube.com/channel/UC3x7FnFPBayEmJenwjJmSgg) | etymology | en+zh | 0.6 | 19 | 253 s | 0 % | 12 / 19 |
| [OWAD: Daily Chinese Vocab, History & Culture](https://www.youtube.com/@owadcn) | mixed | en | 0.6 | 1000 (≥, plafonné) | 622 s | 0 % | 86 / 230 |
| [Understanding Chinese Characters](https://www.youtube.com/user/theforeverastudent) | etymology | en | 0.6 | 165 | 222 s | 2 % | 85 / 123 |
| [hsk . tips](https://www.youtube.com/@hsktips) | word | en+zh | 0.6 | 1000 (≥, plafonné) | 35 s | 100 % | 18 / 46 |
| [Learn Chinese with Litao](https://www.youtube.com/@LitaoChinese) | etymology | en | 0.55 | 88 | 267 s | 0 % | 21 / 23 |
| [Apprendre le chinois](https://www.youtube.com/@Apprendrelechinoisenvideo) | word | fr+en | 0.5 | 110 | 354 s | 5 % | 67 / 75 |
| [Chinese oracle bone inscriptions-图说汉字甲骨文](https://www.youtube.com/@keershao318) | etymology | zh+en | 0.5 | 458 | 36 s | 93 % | 96 / 209 |
| [Learn Chinese on Youtube](https://www.youtube.com/@learnchineseonyoutube2685) | word | en | 0.5 | 1000 (≥, plafonné) | 36 s | 99 % | 156 / 261 |
| [Mandarin Chinese 普通话](https://www.youtube.com/@mandarinchinese8159) | etymology | en+zh | 0.5 | 538 | 249 s | 1 % | 17 / 22 |
| [ShaoLan: Chineasy & Lifeasy](https://www.youtube.com/@ShaoLanOfficial) | etymology | en | 0.5 | 243 | 421 s | 3 % | 12 / 15 |
| [一起画汉字HanziKid](https://www.youtube.com/@HanziKid) | etymology | zh | 0.5 | 380 | 72 s | 17 % | 151 / 280 |
| [每日中文课 Free To Learn Chinese](https://www.youtube.com/@DANLIAOFreeToLearnChinese) | word | en+zh | 0.5 | 625 | 530 s | 1 % | 63 / 94 |
| [ Jingle Chinese](https://www.youtube.com/@JingleChinese) | mixed | en+zh | 0.45 | 218 | 219 s | 27 % | 32 / 36 |
| [808CJK](https://www.youtube.com/@808CJK) | etymology | en | 0.45 | 31 | 179 s | 0 % | 16 / 27 |
| [Chinese Characters 3000 ](https://www.youtube.com/@ChineseCharacters3000) | mixed | en | 0.45 | 112 | 288 s | 0 % | 52 / 81 |
| [Chinois Authentique](https://www.youtube.com/@chinoisauthentique) | etymology | fr+en | 0.45 | 108 | 267 s | 0 % | 11 / 16 |
| [Ginkgo Academy](https://www.youtube.com/@ginkgoacademy5871) | etymology | fr | 0.45 | 21 | 117 s | 14 % | 28 / 32 |
| [MrSmile Chinese Characters](https://www.youtube.com/@MrSmile_181) | etymology | en+zh | 0.45 | 9 | 927 s | 11 % | 13 / 17 |
| [Weilicalligraphie](https://www.youtube.com/@weilicalligraphie) | etymology | fr | 0.45 | 1000 (≥, plafonné) | 62 s | 41 % | 86 / 318 |
| [Tia Gao](https://www.youtube.com/@parfumsdubois) | etymology | fr | 0.4 | 100 | 47 s | 62 % | 4 / 9 |
| [Chinese In Minutes](https://www.youtube.com/@ChineseInMinutes) | mixed | en+zh | 0.35 | 456 | 340 s | 0 % | 153 / 282 |
| [Chinese Characters](https://www.youtube.com/@ChineseCharacters) | word | zh/en (narration non vérifiée) | 0.3 | 1000 (≥, plafonné) | 13 s | 98 % | 135 / 542 |
| [HSK Academy](https://www.youtube.com/@HskAcademy) | word | en | 0.3 | 39 | 135 s | 36 % | 3 / 5 |
| [Jojo Chinois](https://www.youtube.com/@jojochinois7095) | etymology | fr | 0.3 | 5 | 82 s | 0 % | 1 / 1 |
| [YOYOTV](https://www.youtube.com/@yoyotvebc) | etymology | zh-Hant | 0.3 | 1000 (≥, plafonné) | 195 s | 33 % | 18 / 25 |
| [FiveADay Kanji](https://www.youtube.com/@FiveADayKanji) | etymology | en (kanji) | 0.2 | 1000 (≥, plafonné) | 26 s | 96 % | 46 / 242 |
| [漢字叔叔講漢字](https://www.youtube.com/@UncleHanzi) | etymology | zh-Hant | 0.2 | 55 | 381 s | 0 % | 1 / 1 |
| [Yale-China Chinese Language Academy, CUHK](https://www.youtube.com/@studyincla) | mixed | en+zh+yue | 0.1 | 153 | 243 s | 3 % | 2 / 3 |

### 2.3 Constats

- **Étymologie** : Chou Meizai est la source la plus complète (3 279 vidéos ; 445 des 1 000 premiers caractères ; ~80 s ;
  animation de l'évolution des formes). Mais elle est **taïwanaise** : 40 des 192 mots couverts ne le sont que via le
  traditionnel (覺, 馬, 遠, 車…). alittle一眼眼 (1 000 épisodes « 汉字趣谈 », ~6 min, narration chinoise, sous-titres
  anglais sur une partie) convient à partir du niveau intermédiaire. Edeo & Legoo (≥ 1 000, numérotées, ~6 min) et
  Mandarin-learning-Lynn (426, « Learn Chinese from the origin: X / sens / phrase ») sont en anglais ; Lynn combine
  origine et phrase en contexte.
- **Mot en contexte** : Mandarin Chinese with Taskpins (« Word of the Day », 2-3 min, aucun Short) couvre 211 des
  300 premiers mots ; E's Chinese Class (2 255 vidéos HSK 1-6, ~80 s) et trainchinese (3 356, 298 des 300 premiers
  caractères) complètent. hsk.tips publie **une vidéo par phrase d'exemple** (~35 s, plusieurs par mot) : idéal pour
  « le mot en contexte » brut.
- **Français** : aucune grande série d'étymologie narrée en français n'a été trouvée. Weilicalligraphie (> 1 500 « un
  caractère par jour ») est la seule série francophone d'envergure, et elle porte sur la calligraphie.
- **À éviter / repli seulement** : Chinese Characters (`@ChineseCharacters`, clips de 9-32 s), FiveADay Kanji (kanji
  japonais), YOYOTV (émission jeunesse générale), 漢字叔叔 (conférences, 1 vidéo pertinente sur 55).
- **CUHK / Yale-China** : la chaîne `@studyincla` (« Yale-China Chinese Language Academy, CUHK ») est vérifiée, mais la
  série du projet *Understanding Chinese Characters through Videos and Online Exercises* (10 vidéos Putonghua,
  200 caractères HSK) n'y figure pas publiquement (vidéos non listées, retirées ou jamais publiées). Poids 0,1, gardée pour
  mémoire.
- **Dépendance** : avec l'index, une seule chaîne fournit 69 % des vidéos « usage » du top 300 (Taskpins, 207 / 299). Il
  faut donc gérer la disparition d'une chaîne (re-classement automatique au rafraîchissement de l'index).


## 3. Prototype de recherche (`yt-dlp ytsearch10:`)

### 3.1 Protocole

15 cibles : 9 caractères (木 — hors programme, présent seulement dans `chars.json` —, 人 好 水 口 日 女 家 马) et
6 mots (朋友 喜欢 觉得 学习 因为 认识) × 5 gabarits : `{w} 汉字 字源`, `{w} Chinese character origin`, `HSK {w}`,
`{w} 怎么用 例句`, `{w} caractère chinois`. 2 s de pause entre requêtes.

**YouTube a répondu** : 68 / 75 requêtes réussies au premier passage (7 × `HTTP Error 403: Forbidden` sur la page
d'API de recherche, réparties au hasard dans le temps, pas de « Sign in to confirm you're not a bot »). Latence
médiane **2,7 s** par requête (max 3,2 s). 680 résultats, 566 vidéos distinctes.
Les 7 requêtes en échec ont **toutes réussi au second et unique essai** (≈ 40 min plus tard), soit 75 / 75. Le 403 de
recherche est donc intermittent (≈ 9 %) : le traiter par « reprendre plus tard », jamais par une boucle.

### 3.2 Champs disponibles dans `--flat-playlist -J` (recherche)

Mesuré sur les 680 entrées :

| Champ | Renseigné | Utilisation |
|---|---|---|
| `id`, `url`, `title` | 680 / 680 | identifiant, titre (signal principal) |
| `channel`, `uploader` | 680 / 680 | nom affiché |
| `channel_id` (`UC…`) | 679 / 680 | **clé de jointure avec le catalogue** (stable, contrairement au nom) |
| `uploader_id` (`@handle`), `channel_url`, `uploader_url` | 678-679 / 680 | lien vers la chaîne |
| `duration` (s) | **680 / 680** | filtre Shorts / compilations |
| `view_count` | 680 / 680 | popularité (poids faible) |
| `description` | 657 / 680 | **extrait** (≈ 1 ligne) seulement, pas la description complète |
| `thumbnails[]` | 680 / 680 | vignette `i.ytimg.com` (autorisée par `img-src https:`) |
| `channel_is_verified` | 85 / 680 | non utilisé |
| `live_status` | 10 / 680 | exclure `is_live` / `is_upcoming` |
| `timestamp`, `release_timestamp`, `availability` | **0 / 680** | pas de date ni de disponibilité en mode « flat » |

Il n'y a ni langue audio, ni sous-titres, ni date : obtenir ces champs demanderait un `yt-dlp -j` par vidéo
(≈ 3-6 s chacun, et plus exposé au bot-check). Le score n'utilise donc que les champs de la recherche « flat ».

### 3.3 Résultats par gabarit

Proportion des résultats dont le titre contient la cible (« dans le titre ») et proportion acceptée par le score final
(≥ 0,35, **sans** catalogue de chaînes ; emplacement « origine » pour les gabarits origine / 字源 / caractère chinois,
« usage » sinon ; 75 requêtes) :

| Gabarit | Cible | Requêtes | Dans le titre | Acceptés | Durée médiane |
|---|---|---|---|---|---|
| `{w} Chinese character origin` | caractère | 9 | 90 % | **46 %** | 137 s |
| `{w} caractère chinois` | caractère | 9 | 93 % | **48 %** | 63 s |
| `{w} 汉字 字源` | caractère | 9 | 59 % | 30 % | 88 s |
| `HSK {w}` | caractère | 9 | 52 % | 13 % | 828 s |
| `{w} 怎么用 例句` | caractère | 9 | 52 % | **0 %** | 657 s |
| `{w} caractère chinois` | mot | 6 | 45 % | **27 %** | 107 s |
| `HSK {w}` | mot | 6 | 68 % | 27 % | 637 s |
| `{w} 怎么用 例句` | mot | 6 | 8 % | 2 % | 654 s |
| `{w} 汉字 字源` | mot | 6 | 3 % | 0 % | 219 s |
| `{w} Chinese character origin` | mot | 6 | 2 % | 2 % | 258 s |

Constats :
- **`{w} 怎么用 例句` est inutilisable** : YouTube le comprend comme « comment utiliser des phrases d'exemple » et renvoie
  des cours d'**anglais pour sinophones** (« 日常生活几乎天天都要用的英语 », « 20個好用手語 »…).
- **`HSK {w}`** renvoie des podcasts et examens blancs de 10-100 min (Chinese Daily Podcast, « HSK 3.0 sample paper »).
- Pour un **mot de plusieurs caractères**, les requêtes « origine » renvoient des vidéos d'étymologie *d'autres* caractères
  (série numérotée Edeo & Legoo, « How Chinese characters evolved »). L'étymologie doit donc être cherchée
  **caractère par caractère** et le mot **en tant que mot** (voir le plan de requêtes §4.5).
- Étonnamment, **`{w} caractère chinois`** est le meilleur gabarit polyvalent : il ramène à la fois les chaînes
  francophones (Shuo Han Yu, Chinois 150mots, Tia Gao, Chineeze, Jojo Chinois) et les séries anglophones par mot
  (trainchinese, E's Chinese Class, « Chinese Word of the Day 每日一词 »).
- 20 % des résultats durent < 60 s ; beaucoup sont des Shorts d'ordre des traits sans explication (« 汉字[木]的笔顺 », 8 s).

**2ᵉ tour (plan de requêtes §4.5), 43 requêtes :**
- `{c} Chinese character origin` et `{c} caractère chinois` pour les 12 caractères des 6 mots composés (12 + 12 requêtes).
  Seuls 17 % et 12 % des résultats sont acceptés **sur l'emplacement** à ≥ 0,5 avec le catalogue, mais chaque caractère
  obtient un candidat (§3.4).
- `{w} {pinyin} Chinese word meaning example` (6 requêtes) : **50 %** des résultats acceptés ; c'est le meilleur gabarit
  « usage » pour les mots.
- Recherche **limitée à une chaîne**, `https://www.youtube.com/@<h>/search?query=<w>` (11 requêtes) : la bonne vidéo
  arrive **en tête dans 9 cas sur 11**. Les 2 échecs sont des caractères absents de la chaîne Moomi.
  `@alittlechineseword` n'a pas d'onglet de recherche (3 refus).


### 3.4 Exemples (meilleur résultat par emplacement, catalogue appliqué)

Avec le catalogue, rounds 1 + 2 (`node scripts/eval-word-video-ranking.mjs <search>,<search2> --top 1`). « (repli) » = `offSlot`.

| Cible | Emplacement | Score | Durée | Chaîne | Titre (lien) |
|---|---|---|---|---|---|
| 人 | usage  | 0.93 | 57 s | trainchinese | [How to write 人 (rén) – person – stroke order, radical, examples and sp](https://www.youtube.com/watch?v=Yhihx--4_-Q) |
| 人 | origine 人 | 0.84 | 41 s | Moomi Chinese | [Chinese Character Evolution and Strokes 汉字演变+笔画 / 人ren / people, perso](https://www.youtube.com/watch?v=Fu2IF5aRHfA) |
| 好 | usage  | 0.94 | 69 s | trainchinese | [How to write 好 (hǎo) – good – stroke order, radical, examples and spok](https://www.youtube.com/watch?v=NVtxHUrcMqA) |
| 好 | origine 好 | 0.85 | 320 s | Skritter | [The Origin and Meaning of the Chinese Character 好](https://www.youtube.com/watch?v=qMtVPPaFPqc) |
| 家 | usage  | 0.94 | 75 s | trainchinese | [How to write 家 (jiā) – family, home – stroke order, radical, examples ](https://www.youtube.com/watch?v=S5nZZ48a0pE) |
| 家 | origine 家 | 0.84 | 41 s | Moomi Chinese | [Chinese Character Evolution and Strokes汉字演变+笔画 /家jia / home, house, fa](https://www.youtube.com/watch?v=1RHpnTe3gJ4) |
| 喜欢 | usage  | 0.94 | 130 s | Mandarin Chinese with Ta | [Xǐhuan 喜欢 Like or Be Interested In Doing Something - Chinese Word of t](https://www.youtube.com/watch?v=AzouAVU5n5Y) |
| 喜欢 | origine 喜 | 0.89 | 386 s | Edeo & Legoo Mandarin Pu | [Origin of Chinese Characters - 0708 喜 xǐ  happy; pleased](https://www.youtube.com/watch?v=FX_aEdwk51g) |
| 喜欢 | origine 欢 | 0.61 | 75 s | Weilicalligraphie | [Calligraphie chinoise un caractère par jour n°433 : 歡 (欢) joyeux, joyo](https://www.youtube.com/watch?v=rN64ee0Fmvk) |
| 觉得 | usage  | 0.94 | 184 s | Mandarin Chinese with Ta | [Juéde 觉得 Think or Feel - Chinese Word of the Day 每日一词](https://www.youtube.com/watch?v=ff-nVNpyCCA) |
| 觉得 | origine 觉 | 0.82 | 81 s | Chou Meizai | [The Story of Chinese Character :覺](https://www.youtube.com/watch?v=OI2xgesf8Qg) |
| 觉得 | origine 得 | 0.61 | 56 s | Weilicalligraphie | [Calligraphie chinoise un caractère par jour n°477 : 得 obtenir, get](https://www.youtube.com/watch?v=jAHIvy_uSak) |
| 朋友 | usage  | 0.94 | 114 s | Mandarin Chinese with Ta | [Péng you 朋友 - Chinese Word of the Day 每日一词](https://www.youtube.com/watch?v=PqrfsI0z6XU) |
| 朋友 | origine 朋 | 0.82 | 142 s | Hanzi Whisper 汉字墨语 | [文字起源（朋）The Origin of Chinese Characters: 'Friend'](https://www.youtube.com/watch?v=dQHbk98Ec-w) |
| 朋友 | origine 友 | 0.83 | 71 s | Chou Meizai | [The Story of Chinese Character :友](https://www.youtube.com/watch?v=dhszApIfvzM) |
| 水 | usage  | 0.93 | 63 s | trainchinese | [How to write 水 (shuǐ) – water – stroke order, radical, examples and sp](https://www.youtube.com/watch?v=3ItQ5xCJWK4) |
| 水 | origine 水 | 0.83 | 71 s | Chou Meizai | [The Story of Chinese Character : 水](https://www.youtube.com/watch?v=49YsdpAOPLo) |
| 女 | usage  | 0.93 | 59 s | trainchinese | [How to write 女 (nǚ) – woman, female – stroke order, radical, examples ](https://www.youtube.com/watch?v=5eZHd2Tz6uU) |
| 女 | origine 女 | 0.86 | 644 s | Edeo & Legoo Mandarin Pu | [Origin of Chinese Characters - 0093 女 nǚ Female; girl - Learn Chinese ](https://www.youtube.com/watch?v=OaUs6QkBX5M) |
| 日 | usage  | 0.93 | 66 s | trainchinese | [How to write 日 (rì) – sun; daytime – stroke order, radical, examples a](https://www.youtube.com/watch?v=DvGtdRrnPw4) |
| 日 | origine 日 | 0.84 | 43 s | Moomi Chinese | [Chinese Character Evolution and Strokes汉字演变+笔画 / 日ri / sun, day, dayti](https://www.youtube.com/watch?v=zbZK3QUYe9w) |
| 认识 | usage  | 0.94 | 130 s | Mandarin Chinese with Ta | [Rènshi 认识 Get To Know - Chinese Word of the Day 每日一词](https://www.youtube.com/watch?v=YV84hBV42hU) |
| 认识 | origine 认 | 0.87 | 604 s | Edeo & Legoo Mandarin Pu | [Origin of Chinese Characters - 0912 认 認 rèn know, recognize - Learn Ch](https://www.youtube.com/watch?v=QVivKX32tyQ) |
| 认识 | origine 识 | 0.89 | 436 s | Edeo & Legoo Mandarin Pu | [Origin of Chinese Characters - 1064 识 識 shí  know, knowledge](https://www.youtube.com/watch?v=jeUwThSAA0c) |
| 口 | usage  | 0.93 | 60 s | trainchinese | [How to write 口 (kǒu) – mouth – stroke order, radical, examples and spo](https://www.youtube.com/watch?v=zvRUmzVuPRc) |
| 口 | origine 口 | 0.83 | 71 s | Chou Meizai | [The Story of Chinese Character : 口](https://www.youtube.com/watch?v=0kZI7ZJH1BY) |
| 学习 | usage  | 0.92 | 170 s | E's Chinese Class | [【NEW HSK1】_#hsk1 _学习/學習/xuexi/(study)How to Pronounce&Write Chinese Vo](https://www.youtube.com/watch?v=G6qzZWtM-o4) |
| 学习 | origine 学 | 0.82 | 143 s | Hanzi Whisper 汉字墨语 | [文字起源（学）The Origin of Chinese Characters: 'Study'](https://www.youtube.com/watch?v=BaiJzJ2Gm0A) |
| 学习 | origine 习 | 0.90 | 260 s | alittle一眼眼 | [[CC] 習 (xi) / 汉字趣谈 (Story of Chinese Characters) 615](https://www.youtube.com/watch?v=ECMsqgn1UKc) |
| 因为 | usage  | 0.94 | 177 s | Mandarin Chinese with Ta | [Yīnwèi 因为 Because - Chinese Word of the Day 每日一词](https://www.youtube.com/watch?v=W7422uhTpeE) |
| 因为 | origine 因 | 0.79 | 78 s | Chou Meizai | [漢字的故事 : 因](https://www.youtube.com/watch?v=zeR-eKILQ5U) |
| 因为 | origine 为 (repli) | 0.52 | 61 s | trainchinese | [How to write 为 (wèi) – for, to – stroke order, radical, examples and s](https://www.youtube.com/watch?v=MvpZCdVbeHc) |
| 马 | usage  | 0.93 | 61 s | trainchinese | [How to write 马 (mǎ) – horse – stroke order, radical, examples and spok](https://www.youtube.com/watch?v=hHKxBC2fKRA) |
| 马 | origine 马 | 0.83 | 39 s | Moomi Chinese | [Chinese Character Evolution and Strokes汉字演变+笔画 / 马ma / horse](https://www.youtube.com/watch?v=WdTgD-a5Eqk) |
| 木 | usage  | 0.93 | 61 s | trainchinese | [How to write 木 (mù) – tree; wood – stroke order, radical, examples and](https://www.youtube.com/watch?v=HmDDylunKpM) |
| 木 | origine 木 | 0.83 | 192 s | Chou Meizai | [The Story of Chinese Character : 木 - special](https://www.youtube.com/watch?v=wUEV03xbePM) |


## 4. Spécification du score (fonction pure)

Implémentation de référence : `scripts/lib/word-video-score.mjs` (sans E/S, sans horloge, sans aléa ; ordre total
par `score` décroissant puis `id`). Port prévu : `src/core/wordVideos.ts` + tests vitest (reprendre
`word-video-score.test.mjs`).

### 4.1 Entrées

```ts
type Slot = 'etymology' | 'usage';             // « origine du caractère » | « le mot en contexte »
interface Target { w: string; py: string; slot: Slot; alt?: string[] }
// py = pinyin accentué (words.json `py`, sinon chars.json `py[0]`) ; alt = graphies traditionnelles CEDICT (马 → ['馬'])
interface Entry {                                // = une entrée yt-dlp --flat-playlist, champs utilisés uniquement
  id: string; title: string; channel?: string | null; channel_id?: string | null;
  duration?: number | null; view_count?: number | null; description?: string | null; live_status?: string | null;
}
interface ChannelInfo { channelId: string; weight: number; kind: 'etymology' | 'word' | 'mixed'; language: string }
scoreCandidate(t: Target, e: Entry, channels: Record<string, ChannelInfo>): { score: number; f?: Features; neg?: boolean; offSlot?: boolean; rejected?: string }
rankCandidates(t, entries, channels, min = 0.35): Ranked[]       // dédoublonné par id, trié
queriesFor(w: string, py: string): { slot; target; query }[]
```

### 4.2 Filtres éliminatoires (`score = 0`, `rejected`)

| Règle | Champ | Motif |
|---|---|---|
| `live_status ∈ {is_live, is_upcoming}` | `live_status` | `live` |
| ni la cible ni l'une de ses graphies traditionnelles (`alt`) n'apparaît dans `title` | `title` | `target-not-in-title` |
| titre japonais (kana, « kanji », « JLPT », on'yomi/kun'yomi) | `title` | `japanese` |
| chaîne du catalogue avec `weight = 0` | `channel_id` | `blocked-channel` |

### 4.3 Caractéristiques ∈ [0, 1] et poids

`score = Σ poids × caractéristique`, puis **× 0,3** si le titre contient un mot-clé négatif, puis **× 0,7** si `offSlot`
(ci-dessous). Seuil d'acceptation : **0,35** pour la recherche, **0,5** pour l'index de chaînes (§4.6). `focus` est le
maximum sur la cible et ses graphies `alt`.

| Caractéristique | Poids | Définition (champs) |
|---|---|---|
| `focus` | 0,30 | la cible est *le sujet* du titre : 1 si ≤ 4 autres caractères Han distincts dans le titre ; sinon décroît linéairement (0 à 20 autres) ; plancher 0,6 si la cible est encadrée par des délimiteurs (`【好】`, `"好"`, `汉字[好]`, `好 (hǎo)`) ; **× 0,4** si la cible n'apparaît qu'à l'intérieur d'une suite Han plus longue (觉 dans 觉得, 学习 dans 笔画学习) ; **× 0,5** si le titre est une liste de ≥ 3 caractères isolés (« 人 从 比 北 众 ») |
| `pinyin` | 0,12 | pinyin sans tons de la cible présent dans `title` comme **mot entier** (« mu » ne correspond pas à « music » ; « peng you » et « pengyou » acceptés ; chiffres de ton ignorés) = 1 ; dans `description` = 0,5 |
| `channel` | 0,22 | `weight` de la chaîne (`channel_id`) dans `word-video-channels.json`, 0 si inconnue |
| `slotKind` | 0,06 | 1 si `kind` de la chaîne = emplacement (`etymology`↔`etymology`, `word`↔`usage`), 0,5 si `mixed`, 0 sinon/inconnue |
| `intent` | 0,12 | mots-clés de l'emplacement dans `title` (1) ou `description` (0,5). Étymologie : 字源 说文/說文 演变 甲骨文 金文 象形 会意 形声 造字 origin etymolog evolution « story of » histoire origine pictogra oracle 汉字趣谈 « 漢字的故事 » primitive (« radical » volontairement exclu). Usage : 例句 用法 怎么用 example sentence « how to use/say » « word of the day » 每日一词 meaning vocabulary vocabulaire signifie phrase exemple pronounce dialogue |
| `duration` | 0,10 | trapèze sur `duration` : 0 sous 12 s, rampe jusqu'à 1 à 40 s, 1 jusqu'à 420 s (7 min), décroît jusqu'à 0 à 1 200 s ; inconnue = 0,3 |
| `language` | 0,04 | 1 si chaîne `fr` ou titre français ; 0,6 si chaîne `en` ou titre latin ; 0,3 si titre uniquement chinois |
| `popularity` | 0,04 | `min(1, log10(view_count + 1) / 6)` (1 M de vues = 1) — volontairement marginal |

**`offSlot`** (drapeau renvoyé, × 0,7) : emplacement « origine » sans mot-clé d'origine (ni dans le titre ni dans l'extrait de description) et chaîne qui n'est
pas de type `etymology` (clip d'écriture, leçon de grammaire…) ; ou emplacement « usage » sans mot-clé d'usage, servi par
une chaîne de type `etymology`. L'interface affiche alors l'étiquette réelle (« Écriture », « Origine ») au lieu de
l'emplacement demandé.

Mots-clés négatifs (× 0,3) : podcast, 英语/英語/英文, 日文/日语, 한국어, vietsub, tiếng, « sample paper/exam », 样卷,
mock test, 汉语水平考试, test, exam, live, 直播, « full course », compilation, 合集, 八卦/娱乐, news/新闻.

Les poids ont été réglés à la main sur les 15 cibles (§4.6) ; ils sont exportés (`W`) pour être ajustables.

### 4.4 Deux emplacements par mot

- **`etymology` — un par caractère distinct** (`朋友` → 朋, 友) : en cache par caractère, réutilisé par tous les mots qui le contiennent.
- **`usage` — un pour le mot entier** : présentation, prononciation, phrases en contexte.
  Pour un mot d'un seul caractère, les deux emplacements sont tirés du même lot de résultats ; on évite d'afficher deux
  fois la même vidéo (prendre le 2ᵉ choix pour `usage` si le 1ᵉʳ est identique à `etymology`).

### 4.5 Plan de requêtes (`queriesFor`)

Par caractère : `{c} Chinese character origin` + `{c} caractère chinois` ; pour le mot : `{w} caractère chinois` +
`{w} {pinyin sans tons collé} Chinese word meaning example`. Coût : 2 + 2 × (nb de caractères nouveaux) requêtes de
≈ 2,7 s ; les caractères déjà vus sont en cache. Gabarits **abandonnés** : `{w} 怎么用 例句`, `HSK {w}`, `{w} 汉字 字源`
(sauf en repli pour un caractère sans résultat).

### 4.6 Évaluation manuelle

Jugement manuel sur **titre + chaîne** (les vidéos n'ont pas pu être regardées) :

| Évaluation | Échantillon | Résultat |
|---|---|---|
| Recherche (rounds 1+2), meilleur candidat « usage » | 15 cibles | **15 / 15** centrés sur la cible ; 14 / 15 annoncent des exemples ou phrases (« Word of the Day », « examples and spoken audio ») |
| Recherche, meilleur candidat « origine » | 21 caractères | **18 / 21** vraies vidéos d'étymologie ; 欢 et 得 → calligraphie (Weilicalligraphie) ; 为 → clip d'écriture, **correctement signalé** `offSlot` |
| Index de chaînes, top 300, « usage » (tirage aléatoire, graine 11) | 30 | **28 / 30** exacts ; 2 mots apparentés (哥 → 哥哥, 话 → 打电话) |
| Index de chaînes, top 300, « origine » (graine 11) | 30 | **27 / 30** vraies vidéos d'origine ; 3 partielles (2 « How to write » d'Understanding Chinese Characters, 1 dessin HanziKid) ; 5 / 30 titrées seulement en traditionnel |

Ces échantillons ont entraîné deux corrections du score, couvertes par les tests :
- « radical » est retiré des mots-clés d'origine (les clips d'écriture trainchinese l'emportaient) ;
- la règle `offSlot` (×0,7 et drapeau) est ajoutée. Un premier tirage sans elle ne donnait que 17 / 25 vidéos d'origine
  (leçons de grammaire de chaînes « mixed » et clips de 30 s).

Limites : 15 cibles et 60 tirages, jugés par une seule personne sur les titres. Le seuil 0,5 de l'index et les poids n'ont
pas été validés sur un jeu de test indépendant.

**Couverture de l'index** (`node scripts/eval-word-video-index.mjs <listes> --n N`, seuil 0,5, sur l'emplacement) :

| Cibles | « Usage » (mot) | « Origine » (caractères distincts) |
|---|---|---|
| 300 premiers mots | 299 / 300 = **99,7 %** | 237 / 247 = **96,0 %** (+10 replis) |
| 1 000 premiers mots | 996 / 1 000 = **99,6 %** | 531 / 569 = **93,3 %** (+38 replis) |
| 3 317 mots | 2 542 / 3 317 = **76,6 %** | 1 095 / 1 312 = **83,5 %** (+212 replis, 5 sans rien) |

Pool : 23 773 vidéos de 43 chaînes (≈ 2,3 Mo en `[id, titre, durée]`, 0,68 Mo gzip) ; calcul en 19 s pour 3 317 mots.
C'est une borne basse : 9 listes sont plafonnées aux 1 000 dernières vidéos (hsk.tips, Weilicalligraphie, OWAD,
Edeo & Legoo…).


## 5. Architecture (implémentée : `src/core/wordVideos.ts`, `src/main/services/wordvideo.ts`, `src/main/ipc/wordvideo.ts`, `WordVideo.tsx`)

1. **Index de chaînes d'abord, recherche ensuite.** Lister une fois (puis toutes les semaines) les vidéos des
   chaînes du catalogue avec `yt-dlp --flat-playlist` (≈ 1 requête / 30 vidéos) et faire correspondre les titres
   hors-ligne avec le même score. La recherche `ytsearch10:` ne sert qu'en repli pour les cibles non couvertes.
   Avantages : beaucoup moins de requêtes par mot, résultats issus de chaînes vérifiées, fonctionne en lot.
2. **Pré-chargement paresseux** : quand `study:introduce` ajoute des mots, mettre en file les cibles (caractères
   nouveaux + mot) ; un worker du processus principal exécute **au plus 1 requête toutes les 5 s**, s'arrête pour
   la session au premier 403/429/bot-check (message FR via `explainYtError`), et reprend à la session suivante.
3. **Cache SQLite** (ajout additif dans `core/db.ts`) :
   `CREATE TABLE IF NOT EXISTS word_videos (target TEXT, slot TEXT, video_id TEXT, title TEXT, channel TEXT, channel_id TEXT, duration INTEGER, score REAL, rank INTEGER, fetched_at TEXT, status TEXT, PRIMARY KEY (target, slot, rank))`
   — `status` ∈ `ok | hidden | broken` : l'utilisateur peut écarter une vidéo (« pas pertinente » → `hidden`,
   prendre la suivante) ; une erreur de lecture la marque `broken`. Rafraîchir après 90 jours.
4. **Canaux IPC** (préfixe `video:`, implémentés) : `video:forTarget(target, slot)`, `video:next(target, slot)`,
   `video:hide(target, slot, id, 'irrelevant'|'broken')` → `{video, alternatives, pending, source, error?}` ;
   `video:prefetch(words[])` → nombre de cibles en file ; `video:resume()` ; évènement `video:updated {target, slot}`.
   (La proposition initiale `media:wordVideos` / `media:hideWordVideo` n'a pas été retenue.)
5. **Écran** : sur la présentation d'un nouveau mot (là où le pinyin est déjà autorisé) et dans `WordPopup` :
   onglets « Origine de 朋 / 友 » et « Le mot en contexte », lecteur intégré (§6) + bouton « Ouvrir sur YouTube »
   (`core:openExternal`) toujours visible comme repli. Les vidéos de chaînes taïwanaises montrent souvent des
   **caractères traditionnels** : afficher la forme traditionnelle à côté quand elle diffère.
6. **Hors-ligne** : sans réseau, l'onglet se masque proprement (principe 5 de l'architecture).

## 6. Intégration du lecteur YouTube dans Electron 45 (renderer en `file://`)

### 6.1 Banc d'essai

Petite app Electron (`node_modules/electron` 45.2.0, `xvfb-run -a … --no-sandbox`), **un processus et un profil
neufs par essai**. La page de test (une `<iframe>` ou une `<webview>` 640×360 vers
`https://www.youtube-nocookie.com/embed/<id>?autoplay=1&mute=1&playsinline=1&rel=0&enablejsapi=1`) est servie selon le
mode depuis `file://`, depuis un schéma privilégié `app://` (`registerSchemesAsPrivileged`, `standard+secure+supportFetchAPI+stream+corsEnabled`)
ou depuis `http://127.0.0.1` (témoin « navigateur normal »). Après 15 s puis 10 s de plus (clic sur le bouton lecture +
`video.play()`), le banc inspecte **chaque frame YouTube** via `webContents.mainFrame.framesInSubtree[i].executeJavaScript`
(texte, `.ytp-error`, `document.referrer`, `<video>.readyState/currentTime`, `movie_player.getPlayerState()`,
`MediaSource.isTypeSupported`) et journalise toutes les requêtes `*.youtube*.com / googlevideo / ytimg` avec
`webRequest` (en-têtes `Referer`/`Origin` envoyés, statut, taille). Captures `capturePage()` examinées une à une.

Classification (dans cet ordre) : `CSP_BLOCKED` (violation CSP, frame `chrome-error://`) ; **`E153`** (texte
« Video player configuration error … Error 153 ») ; `BOT_CHECK` (« Sign in to confirm you're not a bot ») ;
**`UNAVAILABLE(IP)`** (« Video unavailable — This content isn't available. ») ; `PLAYING` (`currentTime > 0,5`) ;
`PLAYER_API_403(IP)` (`/youtubei/v1/player` → 403) ; `PLAYER_OK_NO_FRAMES` (lecteur chargé avec la durée, mais aucune image).

Vidéo principale : `q2hrlAGewvY` (Yoyo Chinese, `starterVideos[0]`) ; contrôle sur une 2ᵉ vidéo `LgM0QMde1vM`
(Chou Meizai, « 漢字的故事 : 木 »).

### 6.2 Résultats

37 essais classés (`run-matrix.sh`, 2-3 répétitions par mode, vidéo `q2hrlAGewvY` ; 6 essais sur `LgM0QMde1vM`) :

| Mode | Page | Intégration | `Referer` de la requête `/embed/…` | Essais | Résultat |
|---|---|---|---|---|---|
| `csp-current` | file:// | iframe, **CSP actuelle** | — (bloquée avant envoi) | 2 | 2× CSP_BLOCKED |
| `plain` (a) | file:// | iframe nocookie | aucun | 3 | **3× E153** |
| `plain-yt` | file:// | iframe youtube.com | aucun | 2 | **2× E153** |
| `plain-origin` | file:// | iframe + `&origin=https://…` | aucun | 2 | **2× E153** |
| `webview-noref` | file:// | `<webview>` sans `httpreferrer` | aucun | 2 | **2× E153** |
| `scheme` (d) | app:// | iframe nocookie | aucun | 2 | **2× E153** |
| `scheme-yt` | app:// | iframe youtube.com | aucun | 2 | **2× E153** |
| `hdr-app` (b) | file:// | `onBeforeSendHeaders`, subFrame seulement | `https://operation-mandarin.app/` | 3 | 2× UNAVAILABLE(IP), 1× PLAYER_OK_NO_FRAMES |
| `hdr-app-yt` (b) | file:// | idem, youtube.com | `https://operation-mandarin.app/` | 2 | 2× UNAVAILABLE(IP) |
| `hdr-nocookie` (b) | file:// | idem | `https://www.youtube-nocookie.com/` | 2 | 2× UNAVAILABLE(IP) |
| `hdr-appid` (b) | file:// | idem + `widget_referrer` | **`https://app.operation-mandarin/`** | 2 | 1× PLAYER_OK_NO_FRAMES, 1× UNAVAILABLE(IP) |
| `scheme-hdr` (d)+(b) | app:// | idem | `https://operation-mandarin.app/` | 3 | 3× UNAVAILABLE(IP) |
| `webview` (c) | file:// | `<webview httpreferrer>` | `https://operation-mandarin.app/` | 3 | 2× UNAVAILABLE(IP), 1× PLAYER_API_403(IP) |
| `webview-appid` (c) | file:// | idem | `https://app.operation-mandarin/` | 2 | 2× UNAVAILABLE(IP) |
| `http-control` | **http://127.0.0.1** | iframe (= navigateur normal) | `http://127.0.0.1:<port>/` (naturel) | 5 | 4× UNAVAILABLE(IP), 1× PLAYER_API_403(IP) |

Bilan : **sans `Referer` : 13 / 13 erreurs 153. Avec un `Referer` : 0 / 22 erreur 153** ; ces 22 essais échouent
ensuite exactement comme le témoin navigateur (5 / 5), sur le blocage d'IP. Essais exploratoires préalables (hors
tableau, même conclusion) : le tout premier `http-control` et le premier `webview` ont obtenu un lecteur complet
(durée affichée, 30 cycles `next` + `videoplayback` 200) mais **aucune image** ; une première version erronée du
mode (b) est décrite au point 3 ci-dessous.

Captures (examinées) : `plain` / `scheme` → écran « Video player configuration error — Error 153 » avec boutons
« Watch video on YouTube » / « Learn more » ; modes avec `Referer` → « Video unavailable — This content isn't
available. » ou lecteur noir avec barre de progression `0:00 / 4:11` et spinner.

Contrôle « décodage » : le même Electron sous xvfb lit un MP4 H.264/AAC local (`<video>`, `currentTime` = 3,97 s
après 4 s, `readyState 4`) → l'absence d'image n'est pas un problème de codec ni de GPU.

### 6.3 Interprétation

1. **L'erreur 153 est déterministe et ne dépend que de l'en-tête HTTP `Referer` de la requête du document
   `/embed/<id>`.** Sans `Referer`, YouTube renvoie directement la page d'erreur ; le lecteur n'appelle même pas
   `/youtubei/v1/player` (0 appel dans tous les essais E153).
   - `file://` n'envoie jamais de `Referer` ; un schéma personnalisé **`app://` non plus**, même déclaré
     `standard + secure` (Chromium ne transmet un référent qu'aux schémas http/https) → l'approche (d) **seule ne suffit pas**.
   - Le paramètre `origin=` de l'URL d'intégration ne remplace pas le `Referer` (mode `plain-origin` : E153).
   - `referrerpolicy="strict-origin-when-cross-origin"` sur l'iframe ne change rien : il n'y a pas d'origine http à transmettre.
2. **Dès qu'un `Referer` https est présent, l'erreur 153 disparaît**, quelle que soit la façon de le fournir :
   - (b) `session.webRequest.onBeforeSendHeaders` qui ajoute `Referer` à la **seule** requête du document `/embed/*`
     (`resourceType === 'subFrame'`) ; `document.referrer` reste vide dans l'iframe et cela suffit → le contrôle est
     **côté serveur** ;
   - (c) `<webview httpreferrer="https://…">` (ici `document.referrer` est renseigné) ;
   - (d)+(b) `app://` + injection d'en-tête ;
   - témoin `http://127.0.0.1` (en-tête naturel).
   Sur ces 22 essais, le premier appel `/youtubei/v1/player` répond **200 (6,8-12,6 Ko, configuration lisible)** dans 19
   cas, 2 fois la configuration est déjà incluse dans la page (aucun appel, lecteur affiché avec sa durée) et 1 essai
   témoin reçoit un 403 d'emblée ; le lecteur demande ensuite les segments `googlevideo.com/videoplayback` (200).
3. **Erreur de conception corrigée pendant l'essai** : la première version du mode (b) réécrivait aussi `Referer` *et*
   `Origin` des XHR internes du lecteur (`/youtubei/v1/*`) → **403** sur `/youtubei/v1/player` et lecteur noir. Il ne
   faut toucher **que** la requête du document d'intégration (et seulement si elle n'a pas déjà de `Referer`).
4. **Aucun essai n'a réellement lu la vidéo**, y compris le témoin `http://127.0.0.1` : après le premier `player` 200,
   le lecteur relance un 2ᵉ appel `player` qui répond ≈ 1,5 Ko → « This content isn't available » (ou 403), ou bien
   boucle en « buffering » sans image (`readyState 0`, alors que H.264/VP9/AV1/AAC/Opus sont tous supportés en MSE).
   Comme le **témoin http — qui est exactement la configuration d'un navigateur ordinaire — échoue de la même façon**,
   et que ces échecs varient d'un essai à l'autre pour une même configuration, ils sont attribués à la **réputation de
   l'IP du bac à sable** (centre de données + proxy TLS), pas à la configuration Electron. Le journal du proxy ne
   contient aucun refus pour `*.youtube.com` / `googlevideo.com` : les 403 viennent bien de YouTube.
   Confirmation indépendante, juste après la matrice : `yt-dlp -j https://www.youtube.com/watch?v=q2hrlAGewvY`
   échoue avec « **Sign in to confirm you're not a bot** » — l'IP est signalée pour la *lecture*, alors que la
   *recherche* (`ytsearch`) répond encore (≈ 90 % de succès).
5. La **CSP actuelle** de `src/renderer/index.html` bloque l'iframe avant même tout échange réseau
   (`default-src 'self' file: data: blob:` sert de repli à `frame-src`) : la frame devient `chrome-error://chromewebdata/`
   et la console affiche « Framing 'https://www.youtube-nocookie.com/' violates the following Content Security Policy directive ».

### 6.4 Recommandation

**Approche (b) : garder `file://`, `<iframe>` ordinaire vers `youtube-nocookie.com`, et injecter un `Referer` d'identité
d'application sur la seule requête `/embed/*` dans le processus principal.** C'est la plus petite modification
(aucun changement de chargement du renderer, pas de `webviewTag`), et c'est conforme aux
[Required Minimum Functionality](https://developers.google.com/youtube/terms/required-minimum-functionality) de
YouTube : un client intégré « must provide identification through the HTTP Referer request header » ; pour une app
de bureau, le `Referer` se fixe comme en-tête HTTP, en **https**, avec pour domaine **l'identifiant d'application**
(nom de domaine inversé). Ici `build.appId` = `app.operation-mandarin` → `Referer: https://app.operation-mandarin/`.
Le mode `hdr-appid` (cette valeur exacte + `widget_referrer`) se comporte comme les autres modes « avec Referer » (§6.2).

À ajouter dans `src/main/main.ts`, dans `app.whenReady()` avant `createWindow()` (non appliqué : hors périmètre de
l'évaluation) :

```ts
// YouTube embeds need an HTTP Referer identifying the app (error 153 otherwise); file:// pages send none.
const YT_EMBEDS = ['https://www.youtube-nocookie.com/embed/*', 'https://www.youtube.com/embed/*'];
session.defaultSession.webRequest.onBeforeSendHeaders({ urls: YT_EMBEDS }, (d, cb) => {
  const h = d.requestHeaders;
  if (d.resourceType === 'subFrame' && !h['Referer']) h['Referer'] = 'https://app.operation-mandarin/';
  cb({ requestHeaders: h });
});
```

(Ne **pas** modifier `Origin`, ni les autres requêtes YouTube.) Un seul `onBeforeSendHeaders` peut être enregistré par
session : si un autre module en ajoute un, il faudra les fusionner.

**CSP** — `src/renderer/index.html`, ajouter une directive `frame-src` (le reste est inchangé ; les vignettes
`i.ytimg.com` passent déjà par `img-src https:`) :

```diff
-<meta http-equiv="Content-Security-Policy" content="default-src 'self' file: data: blob:; img-src 'self' file: data: blob: https:; media-src 'self' file: data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' file: data: blob:" />
+<meta http-equiv="Content-Security-Policy" content="default-src 'self' file: data: blob:; img-src 'self' file: data: blob: https:; media-src 'self' file: data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' file: data: blob:; frame-src https://www.youtube-nocookie.com https://www.youtube.com" />
```

Ne pas charger `https://www.youtube.com/iframe_api` (il faudrait ouvrir `script-src` à YouTube) : piloter le lecteur par
`postMessage` (`enablejsapi=1`, messages `{"event":"command","func":"playVideo"}`, écoute des événements
`onStateChange` / `onError`) suffit, et ne demande aucune directive supplémentaire (la CSP du parent ne s'applique pas
au contenu de l'iframe).

**Balise** :
`<iframe src="https://www.youtube-nocookie.com/embed/ID?enablejsapi=1&rel=0&playsinline=1&cc_load_policy=1&hl=fr&widget_referrer=https%3A%2F%2Fapp.operation-mandarin%2F" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" referrerpolicy="strict-origin-when-cross-origin">`.
Le lien « Regarder sur YouTube » du lecteur ouvre une nouvelle fenêtre → déjà renvoyé vers le navigateur par le
`setWindowOpenHandler` existant ; le garde `will-navigate` ne concerne que la frame principale.

**Repli obligatoire** : sur `onError` (codes 2, 5, 100, 101, 150, **153**) ou si aucun `onStateChange` n'arrive en 15 s,
remplacer le lecteur par la vignette + « Ouvrir sur YouTube » (`core:openExternal`) et marquer la vidéo `broken` pour
proposer la suivante. Avec une IP signalée (VPN, réseau d'entreprise), l'intégration peut échouer comme ici ; l'app
dispose déjà du téléchargement `yt-dlp` (`media:download`) comme second repli pour une vidéo jugée importante.

Alternatives écartées :
- (c) `<webview httpreferrer>` fonctionne aussi, mais impose `webviewTag: true` (surface d'attaque plus large,
  `<webview>` déconseillé par Electron) pour un gain nul.
- (d) `app://` : ne résout pas l'erreur 153 seul (pas de `Referer` émis) ; utile seulement si l'app migre un jour pour
  d'autres raisons (il faudrait alors quand même l'injection (b)).
- Servir le renderer depuis un serveur `http://127.0.0.1:<port>` : fonctionnerait (Referer naturel), mais ouvre un port
  local et change l'origine de toute l'app (stockage, `fileUrl()`), pour le même résultat que (b).


## 7. Ce qui n'a pas pu être vérifié

- **Lecture réelle d'une vidéo intégrée dans Electron** : aucun essai n'a produit d'image, témoin `http://` compris, à cause
  du blocage de l'IP par YouTube. Ce qui est établi : la cause et le remède de l'erreur 153 (déterministes, 37 essais
  classés) et le bon décodage vidéo d'Electron sous xvfb (MP4 local). **À faire sur un poste ordinaire** : lancer le banc
  (`embed-test/run-matrix.sh`, modes `plain` et `hdr-appid`) et vérifier `PLAYING`.
- **Contenu des vidéos** : aucune n'a été regardée. Langue de narration, qualité pédagogique, sous-titres et exactitude
  étymologique sont déduits des titres et formats. Il faut une revue humaine d'un échantillon par chaîne avant de fixer les
  poids définitifs (notamment Chou Meizai en traditionnel, alittle一眼眼 en chinois seul, Weilicalligraphie).
- **Durabilité de l'identifiant d'app comme `Referer`** : conforme au texte actuel des règles YouTube, mais YouTube peut
  exiger d'autres justificatifs pour les gros volumes ; non testable ici.
- **Volumes** : les débits observés (1 requête / 2 s sur 75 requêtes ; 1 liste / 3 s sur 45 listes) n'ont déclenché qu'un
  403 de recherche intermittent (≈ 9 %). En revanche, `yt-dlp -j` (extraction d'une vidéo) était déjà bloqué par le
  bot-check. Le comportement depuis une IP résidentielle n'est pas mesuré.
- **Listes plafonnées** : couverture de l'index sous-estimée pour 9 chaînes (≥ 1 000 vidéos non listées en entier).
- **Série CUHK** : non localisée ; pas de contact avec le centre.
- **Code `src/`** : rien n'est intégré (consigne de l'évaluation) ; les extraits du §6.4 n'ont pas été vérifiés par `tsc`.

