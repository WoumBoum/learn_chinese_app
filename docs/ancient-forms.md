# Formes anciennes des caractères (甲骨文 / 金文 / 篆) — évaluation

Évaluation du 2026-11-02. Source principale étudiée : Wikimedia Commons, *Ancient Chinese characters project*
(ACC, fichiers `File:<car>-oracle.svg`, `-bronze.svg`, `-bigseal.svg`, `-seal.svg`, `-silk.svg`, `-slip.svg`).
Scripts : `scripts/fetch-ancient.mjs` (requête API, sélection, téléchargement, assainissement, `ancient.json`),
`scripts/lib/ancient-svg.mjs` (assainisseur SVG), `scripts/render-ancient-sheet.cjs` (rendu Electron + mesure de fidélité).

## 1. Résumé — ce qui est vérifié et ce qui ne l'est pas

| | Résultat | Statut |
|---|---|---|
| Couverture ACC, 60 caractères les plus fréquents (`i` 0-59) | **45 / 60 = 75 %** ont ≥ 1 forme ancienne (oracle/bronze/grand sceau/petit sceau) ; oracle 26, bronze 31, grand sceau 33, petit sceau 44 ; ≥ 1 forme pré-Qin (oracle ou bronze) 33 | **mesuré** (API Commons, 486 titres) |
| Couverture ACC, 300 / 600 / 1 312 caractères | **non mesurée** (voir §6) ; estimation par une source témoin : ≈ 82 % / 83 % / 83 % avec ≥ 1 forme | **estimation** |
| Licences ACC | 181 / 183 fichiers trouvés **domaine public** (`Copyrighted=False`), 2 **CC0** ; aucun CC BY / BY-SA rencontré | mesuré sur l'échantillon |
| Taille des fichiers bruts | 576 o – 10,9 Ko, médiane 4,4 Ko ; 177 / 183 sur canevas 300×300 | mesuré sur l'échantillon |
| Assainisseur SVG | fidélité IoU ≥ **0,993** (médiane 0,997) sur 35 SVG réels rendus par Chromium ; 0 balise/attribut interdit en sortie | **mesuré** |
| `resources/data/ancient.json` | **non généré** : téléchargement des SVG bloqué (§6) | **à exécuter hors bac à sable** |
| Taille estimée de `ancient.json` | ≈ 2 900 SVG, **≈ 4-7 Mo** (non compressé) | estimation |

Recommandation : la source ACC est **juridiquement saine** (domaine public, voir §4) et couvre l'essentiel des
caractères qui *ont* une forme ancienne ; la limite de couverture vient surtout des caractères modernes
(你, 他, 她, 们, 这, 吗, 吧…, créés après les Qin). Lancer `node scripts/fetch-ancient.mjs` depuis une machine
normale (≈ 220 requêtes API + ≈ 2 900 SVG, ~20-30 min en respectant les limites), puis vérifier la planche
de rendu (§5). **Correspondance simplifié → traditionnel indispensable** : 12 des 45 caractères couverts du
top 60 ne le sont que via la forme traditionnelle (說, 會, 對, 來, 還, 沒, 給, 點, 過, 麼, 從, 箇).

## 2. Méthode

1. **Caractères** : clés de `resources/data/chars.json` (1 312), ordonnées par `i` (rang d'introduction).
2. **Candidats** : les fichiers ACC sont nommés avec le caractère **traditionnel** (`馬-oracle.svg`, pas `马`).
   Pour chaque caractère : formes traditionnelles d'OpenCC `STCharacters.txt` (tag `ver.1.1.9`, ordre = plus
   fréquente d'abord : 发 → 發, 髮 ; 后 → 後, 后 ; 干 → 幹, 乾, 干, 榦), puis le caractère lui-même.
3. **API** : `action=query&prop=imageinfo&iiprop=url|size|extmetadata|sha1`, 50 titres par requête, ≥ 1,5 s
   entre requêtes, `maxlag=5`, User-Agent identifiant le projet, respect de `Retry-After` sur 429/5xx.
   Formes sondées : oracle, bronze, bigseal, seal, silk, slip (seuls les noms canoniques ; les variantes
   `-oracle-2`, `-bronze-shang`, `-bronze-warring`… existent mais ne sont pas utilisées).
4. **Sélection** par forme : premier candidat qui possède le fichier **et** une licence acceptable
   (`/^(public domain|pd|cc0|cc by(-sa)?…)$/i`, sinon listé dans `rejectedLicense`).
   Le glyphe simplifié lui-même n'est retenu que s'il est aussi traditionnel ou s'il figure dans la courte liste
   `SELF_OK` (云 从 众 网 采 气 : formes simplifiées = graphie archaïque d'origine). Ailleurs, il est rejeté
   et listé (`rejectedSimplifiedOnly`) : 厂 *hǎn* « falaise » n'est pas l'ancêtre de 廠, 广 *yǎn* ≠ 廣, 叶 *xié* ≠ 葉.
   Sur le top 60, seul 两 a été rejeté ainsi (fichiers `两-*.svg` présents, `兩-*` absents).
5. **Sortie** (`ancient.json`) : formes regroupées `oracle`, `bronze`, `bigseal`, `seal` (soie/lattes : mesurées
   mais non intégrées, ce sont des écritures Qin-Han proches du clérical, peu parlantes pédagogiquement).

```jsonc
{
  "_meta": { "source": "…Ancient Chinese characters project…", "licenses": {…}, "forms": {…}, "fileUrl": "https://commons.wikimedia.org/wiki/File:<file>" },
  "马": {
    "oracle": "<svg xmlns=… viewBox=\"0 0 300 300\" fill=\"currentColor\"><path d=\"…\"/></svg>",
    "seal": "…",
    "src": { "oracle": "馬", "seal": "馬" },          // présent seulement si le fichier vient d'un autre glyphe
    "credit": { "oracle": { "file": "馬-oracle.svg", "author": "…", "license": "Public domain" }, … }
  }
}
```

## 3. Couverture

### 3.1 ACC, mesuré (60 premiers caractères)

| Forme | Caractères | % |
|---|---|---|
| 甲骨文 oracle | 26 | 43 % |
| 金文 bronze | 31 | 52 % |
| 大篆 bigseal | 33 | 55 % |
| 小篆 seal | 44 | 73 % |
| 帛书 silk | 23 | 38 % |
| 简牍 slip | 18 | 30 % |
| **≥ 1 parmi oracle/bronze/bigseal/seal** | **45** | **75 %** |
| ≥ 1 forme pré-Qin (oracle/bronze) | 33 | 55 % |
| dont obtenus seulement via le traditionnel | 12 | 20 % |

Sans forme (15) : 你 他 这 们 很 她 着 想 做 吧 现 两 等 吗 太 — majoritairement des caractères tardifs ou
des emprunts phonétiques ; 這/們/現/嗎 n'ont pas non plus de fichier ACC.

Extrait (o = oracle, b = bronze, b = bigseal, s = seal, s = silk, s = slip) : 我 obbss· · 是 obbsss · 人 obbsss ·
来→來 obbs · 会→會 obbs · 说→說 ···s · 的 ··bs·· · 了 ···s··.

### 3.2 Toutes tranches — estimation (non mesurée sur ACC)

Le téléchargement de métadonnées pour les 1 252 caractères restants a été bloqué (§6). Comme témoin, j'ai mesuré
la couverture d'une autre base vectorielle publique, `zhouyongh/hanzi-glyphs-svg` (index CSV, GitHub ; mêmes règles
de candidats traditionnels), dont les chiffres sur le top 60 sont très proches de ceux d'ACC (≥ 1 forme : 45 vs 45 ;
oracle 24 vs 26 ; bronze 35 vs 31 ; sceau 38 vs 44) :

| Tranche (`i`) | n | oracle | bronze | sceau | ≥ 1 forme | pré-Qin |
|---|---|---|---|---|---|---|
| 0-299 | 300 | 135 (45 %) | 181 (60 %) | 209 (70 %) | **246 (82 %)** | 192 (64 %) |
| 0-599 | 600 | 258 (43 %) | 351 (59 %) | 419 (70 %) | **500 (83 %)** | 379 (63 %) |
| tous | 1 312 | 476 (36 %) | 702 (54 %) | 931 (71 %) | **1 088 (83 %)** | 762 (58 %) |

Attendu pour ACC : du même ordre, avec un « petit sceau » un peu plus fourni (le projet a numérisé le *Shuowen*
de façon systématique) et un grand sceau en plus. **À confirmer par l'exécution complète** — le script imprime
exactement ce tableau (`coverage` 300/600/1312 dans `--report`).

## 4. Licences et attribution

**ACC (Wikimedia Commons)** — sur les 183 fichiers trouvés : 181 « Public domain » (`Copyrighted: False`,
`AttributionRequired: false` ; contributeurs : « voir l'historique du fichier »), 2 CC0 (utilisateur
*AggregatibacterActinomycetemcomitans*). Commons justifie le domaine public par le fait que ce sont des
redessins fidèles de graphies vieilles de 2 000 à 3 300 ans (pas d'originalité nouvelle). Pour une app distribuée
publiquement (AppImage) :

- **Domaine public / CC0** : aucune obligation légale ; on crédite quand même (bonne pratique, et exigence
  morale en droit français). Le script conserve par forme `file`, `author`, `license`.
- **CC BY / CC BY-SA** (aucun rencontré, mais acceptés par le filtre) : afficher auteur + titre + licence + lien,
  indiquer « modifié (SVG simplifié) » ; pour BY-SA, les **SVG** dérivés restent sous BY-SA (le code de l'app
  n'est pas contaminé : simple agrégation). Garder `credit` dans `ancient.json` et l'afficher dans « À propos ».
- **Exclus** : NC, ND, GFDL seule, licence inconnue (listés dans `rejectedLicense`).
- Risque résiduel (faible) : les métadonnées citent comme base « hanziyuan.net's data » (R. Sears) et les
  recueils *Jiaguwen bian* / *Jinwen bian* ; Commons considère les redessins non protégeables. En UE, l'art. 14
  de la directive 2019/790 exclut la protection des reproductions fidèles d'œuvres du domaine public.

Texte d'attribution proposé (Réglages › Voix › « Crédits et licences » ; auteur et licence de chaque fichier sous la frise de la fiche) :

> Formes anciennes des caractères (甲骨文, 金文, 大篆, 小篆) : Wikimedia Commons, *Ancient Chinese characters
> project* — https://commons.wikimedia.org/wiki/Commons:Ancient_Chinese_characters_project. Fichiers dans le
> domaine public ou sous CC0 (sauf mention contraire par fichier), simplifiés pour l'application. Sources
> savantes indiquées sur chaque page de fichier (Sinica *Chinese Etymology*, *Shuowen jiezi*, *Jiaguwen bian*,
> *Jinwen bian*, *Liushutong*).

**Source témoin `hanzi-glyphs-svg` — non recommandée pour l'intégration** : le dépôt annonce CC0 pour des
tracés d'汉典 et de 小學堂 (Academia Sinica) en invoquant leurs conditions d'utilisation, et reconnaît lui-même que
cela « ne fait pas disparaître le droit d'auteur des ouvrages sources » (甲骨文合集, 金文編…). Seule sa couche JGW
(Li & Bian, Zenodo 10.5281/zenodo.22467946, CC BY 4.0, 1 203 glyphes) a une provenance nette. Dépôt récent,
6 étoiles. Utilisée ici **uniquement** pour l'estimation de couverture et comme jeu de test de l'assainisseur.

## 5. Assainissement et validation du rendu

`scripts/lib/ancient-svg.mjs` reconstruit le SVG au lieu de le filtrer : seules les géométries survivent.

- éléments conservés : `path`, `rect`, `circle`, `ellipse`, `polygon`, `polyline`, `line` → tous convertis en `<path>` ;
  `g`/`a`/`switch` traversés ; `<use href="#id">` interne résolu (externe : supprimé) ;
- supprimés : `metadata`, `sodipodi:*`, `inkscape:*`, `rdf:*`, `script`, `style` (après lecture des règles
  `.classe{fill:…}`), `image`, `text`, `foreignObject`, `clipPath`, `mask`, dégradés, filtres, tout `id`,
  attribut `on*` ou `href` ;
- transformations (`matrix/translate/scale/rotate/skew`) **appliquées aux coordonnées** ; arcs et quadratiques
  convertis en cubiques ; `H/V/S/T` normalisés ;
- nombres arrondis à ≤ 1/2000 du canevas (1 décimale pour 300×300) avec **compensation d'erreur** (les
  commandes relatives ne dérivent pas) ; `fill="currentColor"` sur la racine (thème clair/sombre) ; `viewBox`
  d'origine (ou `0 0 width height`), sans `width/height` ;
- cas particuliers : formes blanches de « découpe » → `style="fill:var(--bg,#fff)"` ; tracés en `stroke`
  conservés avec `stroke-width` mis à l'échelle et `linecap/linejoin` ; opacités et couleurs ignorées.

Validation (`scripts/render-ancient-sheet.cjs --pairs`, Chromium d'Electron 45, masques d'encre 256×256) :

| Jeu | n | IoU min | IoU médiane | Octets avant → après |
|---|---|---|---|---|
| `人-oracle.svg` (ACC, Inkscape) | 1 | 0,9937 | — | 1 438 → 414 (−71 %) |
| Témoin (汉典/JGW : oracle à traits, bronze, sceau ; 12 caractères) | 34 | 0,9931 | 0,997 | 78 568 → 61 330 (−22 %, fichiers déjà minifiés) |
| SVG synthétique hostile (`<script>`, `onload`, `<image>` externe, `<use>` externe, `<text>`, classes CSS, arcs, `rotate`) | 1 | — (couleurs volontairement perdues) | — | 1 545 → 790, **0 jeton interdit** |

Les planches ont été inspectées visuellement (original | assaini | différence) ; les écarts résiduels sont de
l'anticrénelage de bord. Un premier passage avait révélé deux défauts corrigés depuis : `stroke-linecap/linejoin`
perdus (IoU 0,89 sur les oracles à traits) et arrondi trop grossier sur un canevas de 29×22 (d'où l'arrondi
relatif au canevas). Grille 12 caractères × 4 formes en thème clair (`<img>`) et sombre (SVG en ligne,
`currentColor` blanc) : rendu correct.

Commande de contrôle après génération réelle :

```bash
xvfb-run -a npx electron scripts/render-ancient-sheet.cjs --no-sandbox \
  --json resources/data/ancient.json --chars 人马日月水火山女子车鱼鸟 --out /tmp/ancient-sheet.png
```

## 6. Ce qui n'a pas pu être fait dans le bac à sable

- **Limitation de débit Wikimedia** : depuis l'IP partagée du bac à sable, `upload.wikimedia.org` répond 429 avec
  `Retry-After: 600` à ~75 % des requêtes (y compris la toute première), l'API Commons de façon intermittente.
  Les métadonnées des 60 premiers caractères (486 titres, 10 requêtes) ont été obtenues ; ensuite j'ai arrêté
  plutôt que contourner la limitation. **Aucun SVG ACC n'a été téléchargé** (hors `人-oracle.svg`, lu une fois
  pour le test) ; `resources/data/ancient.json` **n'existe donc pas encore**.
- Couverture ACC pour les tranches 300 / 600 / 1 312 : non mesurée (estimation §3.2).
- Taille réelle de `ancient.json` : non mesurée. Estimation : ≈ 2,2 formes par caractère (moyenne mesurée sur le top 60 : 134 / 60)
  × 1 312 ≈ 2 900 SVG ; ACC brut médian 4,4 Ko, gain mesuré −71 % sur 人 (tracé simple) et attendu −50 à −65 % sur
  des tracés plus longs ⇒ **≈ 1,5-2,2 Ko/SVG, 4-7 Mo**. Leviers si trop gros : `--precision 0`
  (entiers sur 300 unités, erreur ≤ 0,17 %), `--forms oracle,bronze,seal` (sans grand sceau, −25 % env.),
  chargement paresseux (le fichier n'est utile que sur l'écran caractère).

Exécution complète (machine normale, cache réutilisable, relance hors ligne avec `--offline`) :

```bash
node scripts/fetch-ancient.mjs --report /tmp/ancient-report.json
# options : --cache DIR  --out FILE  --limit N  --no-download  --forms oracle,bronze,bigseal,seal  --precision 1  --offline
```

## 7. Mises en garde savantes

- **Attributions contestées** : le rattachement d'une graphie oracle/bronze à un caractère moderne est une
  *interprétation*. Les fichiers ACC suivent les identifications de leurs recueils sources (Sears, *Jiaguwen bian*, *Shuowen*),
  que la paléographie récente révise parfois (ex. classique : l'analyse de 東 par le *Shuowen*, « soleil dans un
  arbre », est aujourd'hui abandonnée au profit d'un sac lié ; les formes elles-mêmes n'ont pas été auditées ici). Présenter la forme comme « forme ancienne
  attestée de 馬 », pas comme une étymologie certaine ; ne pas en dériver d'explication mnémotechnique
  automatique.
- **Simplifié ≠ traditionnel** : quand `src` existe (马 → 馬), la forme est celle du traditionnel ; l'UI doit
  l'afficher (« forme ancienne de 馬 »). Pour les fusions de caractères (后/後, 干/幹/乾, 发/發/髮, 里/裏, 只/隻,
  台/臺/颱), la sélection prend, forme par forme, le premier candidat qui a un fichier (traditionnel le plus fréquent
  d'abord) : une entrée peut donc mélanger deux graphies et **ne pas correspondre au sens enseigné** (干 *gàn*
  « faire » = 幹, dont il n'existe guère que le sceau, alors que l'oracle trouvé sera celui de 干, un bouclier ;
  `src` le signale). Une revue manuelle des **113** caractères du programme qui ont plusieurs candidats dans
  `STCharacters.txt` est conseillée (538 / 1 312 ont une graphie traditionnelle différente ou supplémentaire).
- **Grand sceau (bigseal)** : chez ACC il provient en grande partie du *Liushutong* (Ming), recueil tardif peu
  fiable ; à présenter avec prudence ou à omettre (`--forms oracle,bronze,seal`).
- **Petit sceau** : issu du *Shuowen* (éditions Song), forme normalisée Han, pas une graphie Qin attestée sur
  support.
- **Un seul exemplaire par forme** : les graphies oracle/bronze varient énormément ; le fichier canonique
  (`-oracle.svg`) n'en montre qu'une. Des variantes existent (`-oracle-2…5`, `-bronze-shang/-spring/-warring`).
- **Échelle et cadrage** : canevas 300×300 dans 97 % des cas, mais quelques fichiers ont d'autres dimensions
  (109², 400², 512², 585², 405×506) ; le `viewBox` d'origine est conservé, le cadrage peut donc varier.
- **Couleur** : certains fichiers ACC utilisent du rouge/gris pour distinguer des composants ; l'assainisseur
  les ramène tous à `currentColor`.
