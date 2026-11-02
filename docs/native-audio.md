# Enregistrements natifs (mots + syllabes) — évaluation et intégration

Évaluation réalisée le 2026-11-02 sur `hugolpz/audio-cmn` @ `f759a0f` (commit du 2026-10-26).
Scripts : `scripts/fetch-audio.sh` (téléchargement + conversion, **exécuté**), `scripts/check-audio-tones.mjs`
(contrôle des tons, réutilise `pitch.ts` / `tonefix.ts`), `scripts/eval-native-audio.py` (couverture, lectures).

## 1. Résumé

| | Résultat |
|---|---|
| Mots du programme (`words.json`, 3 317) avec voix native | **2 841 = 85,6 %** (2 843 exacts + 7 variantes érhua − 9 exclus pour lecture différente) |
| … dont rang < 1 700 | **1 479 / 1 700 = 87,0 %** |
| Syllabes toniques (tons 1-4) | **1 688 / 1 688 = 100 %** des syllabes de la source ; **744 / 744** de celles du programme |
| Ton neutre (5) | 0 utilisable (les 19 fichiers `*5` ne sont pas des syllabes isolées, cf. §5.5) |
| Sortie (`resources/audio/`) | 4 521 fichiers Opus : 2 841 mots (10,0 Mo) + 1 680 syllabes (5,0 Mo) = **15,06 Mo** (21 Mo sur disque, blocs de 4 Ko) |
| Licence | CC BY-SA (mots : 3.0) → **attribution + partage à l'identique des fichiers audio** (cf. §3) |
| Qualité | voix de studio, 22 kHz, aucune saturation ; tons des syllabes **conformes à 98,7 %** (kNN) et 20/20 sur l'échantillon ; 9 mots monosyllabiques enregistrés dans une **autre lecture** que celle du programme (exclus) |

Recommandation : utiliser ces enregistrements en priorité (mots + syllabes), Piper (`tts:speak`) en repli
pour les 473 mots restants, les phrases et le ton neutre. Les sources complémentaires évaluées n'apportent
que peu (Lingua Libre : +94 mots, non téléchargeable depuis le bac à sable) ou sont **non redistribuables**
(Tatoeba : 2 064 / 2 093 audios sans licence).

## 2. Source principale : audio-cmn

Dépôt : <https://github.com/hugolpz/audio-cmn>. L'API GitHub étant refusée dans ce bac à sable (403), la taille a été
mesurée par un clone « blobless » (`--filter=blob:none --depth 1`, 4,9 Mo d'arbres) puis matérialisation dossier par dossier.

| Dossier | Fichiers | Taille | Format |
|---|---|---|---|
| `96k/hsk/` | 8 596 | 151 Mo | MP3 CBR 96 kb/s, mono, 22,05 kHz |
| `64k/hsk/` | 8 596 | 103 Mo | MP3 CBR 64 kb/s, mono, 22,05 kHz ← **utilisé** |
| `64k/syllabs/` | 1 707 | 21 Mo | MP3 CBR 64 kb/s, mono, **48 kHz** (tags ID3 `artist = Chen Wang 王琛`, `title = hao3 (cmn)`) ← **utilisé** |
| `24k-abr/{hsk,syllabs}` | 8 596 + 1 707 | 59 + 13 Mo | MP3 ABR 24 (≈ 28 kb/s), 22,05 kHz |
| `18k-abr/{hsk,syllabs}` | 8 596 + 1 707 | 36 + 6,8 Mo | MP3 ABR 18 / 12 kb/s, 22,05 kHz |
| `64k/temp/` | 51 | 0,6 Mo | WAV de travail (bu3, bu4…) |
| `lists/` | 25 | — | listes HSK 2012 (niveaux 1-6), mots enregistrés, syllabes |
| total | 39 586 | ≈ 390 Mo (arbre) / 293 Mo (`.git`) | |

`fetch-audio.sh` ne télécharge que `64k/hsk` + `64k/syllabs` + `lists` + README (≈ 125 Mo, ~10 s).
Le niveau 64k a été préféré au 96k (gain inaudible selon l'auteur) et aux ABR (re-compression d'une source déjà dégradée).

**Nommage.** Mots : `cmn-{hanzi}.mp3` en caractères simplifiés (ex. `cmn-银行.mp3`), **sans pinyin** ; 27 fichiers
de structures grammaticales avec `_` (`cmn-一_就_.mp3`, `cmn-越来越_.mp3`). Syllabes : `cmn-{pinyin}{ton}.mp3`,
ü noté `v` (`lv4`, `nve3`), interjections préfixées `_` (`_hm1`, `_hng2`, `_m3`, `_n4`, `_ng1`, plus `_lvan*`, `_nia*` non standard).
**Erreur de nommage** : `ju4` est livré sous `cmn-jv4.mp3` (seul cas ; renommé par le script).

**Listes.** Le corpus de mots suit la liste officielle **HSK 2000** (« HSK_2000 list (words, zi) ») ; le README annonce
5 596 entrées dans un paragraphe et « +8000 » dans un autre — il y a 8 596 fichiers. `lists/` compare à **HSK 2012** :
582 des 5 006 mots HSK 2012 manquent (7 en HSK 1 : 下雨 不客气 中国 出租车 北京 哪儿 打电话). Syllabes : 422 syllabes × 4 tons
= 1 688 + 19 fichiers « ton 5 » = 1 707 ; la liste de référence du dépôt (`pin1yin1-syllables-all-by-tones.txt`) compte
1 825 entrées (1 688 + 137 tons neutres).

**Origine Shtooka.** Les mots proviennent de la collection Shtooka **`cmn-caen-tan`** (FLAC, logiciel d'enregistrement
SWAC Recorder de Nicolas Vion), locutrice **Yue Tan**. `compress-raw.bash` reconstruit les noms à partir du tag
`SWAC_TEXT` des FLAC et encode avec `lame`. Les syllabes sont un enregistrement original (« syllabs v.2 », Chen Wang,
débruitage `sox noisered` + lame 64k). shtooka.net est inaccessible d'ici (Cloudflare 403, DNS de packs.shtooka.net
absent, web.archive.org saturé) : le `readme.txt` de la collection **n'a pas pu être lu**. Recoupement via Wikimedia
Commons (fichier `Zh-shěn.ogg`, même collection, source `packs.shtooka.net/cmn-caen-tan/ogg/…`) : « Female voice.
Speaker from Liaoning, China », auteur Yue Tan, 2009, licence `{{cc-by-sa-3.0-us}}`.

## 3. Licence et attribution

Texte exact du README (section *License*) : « **CC-by-sa. See table upper for authors.** » ; tableau *Voices* :
`syllabs v.2 | Chen Wang, CC-by-sa` et `HSK_2000 list (words,zi) | Yue Tan, CC-by-sa` (lien vers le readme Shtooka).
*Credits* : « Speakers — see table upper ; Hugo Lopez, PLIDAM, INALCO — Project management, repository, audio compression,
file renaming ; Nicolas Vion — recording software & technical support ». Pas de fichier LICENSE dans le dépôt ;
la version de CC BY-SA n'est pas précisée pour les syllabes (3.0 pour les mots d'après Commons).

Conséquences pour l'app (licence MIT) : redistribuer les fichiers dans l'AppImage est permis à condition
(1) de créditer les auteurs avec la licence et un lien, (2) d'indiquer les modifications, (3) de distribuer les fichiers
audio **modifiés** sous CC BY-SA (cela ne contamine pas le code MIT : agrégat). Texte à reprendre dans le README et
le bloc « Crédits et licences » de Réglages › Voix (généré aussi dans `resources/audio/CREDITS.md`) :

> **Enregistrements audio natifs** — Mots : Yue Tan, projet Shtooka (collection « cmn-caen-tan »), licence
> CC BY-SA 3.0 (https://creativecommons.org/licenses/by-sa/3.0/). Syllabes : Chen Wang (王琛), licence CC BY-SA.
> Sélection et compression d'origine : Hugo Lopez (PLIDAM, INALCO), dépôt audio-cmn (https://github.com/hugolpz/audio-cmn) ;
> logiciel d'enregistrement : Nicolas Vion. Modifications par Opération Mandarin : coupe des silences, normalisation du
> volume, conversion en Opus, renommage. Ces fichiers modifiés sont distribués sous la même licence CC BY-SA.

## 4. Couverture (correspondance par caractères simplifiés)

| Sous-ensemble | Mots | Exacts | + érhua | Couverture brute | Après exclusions (§5.3) |
|---|---|---|---|---|---|
| Tous | 3 317 | 2 843 | 7 | 85,9 % | **2 841 = 85,6 %** |
| Rang < 1 700 | 1 700 | 1 479 | 4 | 87,2 % | **1 479 = 87,0 %** |
| Bande 1 / 2 / 3 / 4 | 506 / 750 / 953 / 972 | 433 / 626 / 849 / 815 | 0 / 2 / 1 / 2 | 85,6 / 83,7 / 89,2 / 84,1 % | |
| Bandes 5-7 / 9 | 112 / 24 | 107 / 13 | 0 / 2 | 95,5 / 62,5 % | |

Variantes érhua acceptées (même mot, avec/sans 儿) : 味儿→味, 名牌儿→名牌, 笑话儿→笑话, 玩→玩儿, 好好→好好儿,
面条→面条儿, 药水→药水儿 (listées dans `index.json › variants`). **Refusées** : 这儿, 那儿, 哪儿 — sans 儿 c'est un
autre mot du programme (这 « ce » ≠ 这儿 « ici ») ; l'enregistrement de 这 ferait entendre « zhè » à la question d'écoute
« ici » → synthèse Matcha/Piper (`ERHUA_DISTINCT` dans `fetch-audio.sh`).

Manquants (464 hors exclusions) : 357 mots de 2 caractères, 88 de 3, 8 de 4, 11 caractères seuls (妈 爸 哥 姐 弟 妹 使 厂
村 轮 泪 — HSK 2000 n'a que 妈妈, 爸爸…). 356 sont compositionnels (tous leurs caractères sont enregistrés) : 看到, 回家,
吃饭, 手机, 中国… Les plus fréquents (rang < 300) : 还有 看到 找到 身上 妈 第二 回家 真的 中国 手机 听到 说话 来到 回到 家里
早上 哥 爸 打开 打电话 吃饭. Concaténer des caractères isolés n'est pas recommandé (pas de sandhi, intonation de citation).

**Syllabes** (pinyin numérique de `words.json`, ü normalisé) : 744 syllabes distinctes tons 1-4 dans le programme,
**744 couvertes** (dont `ju4` grâce au renommage de `jv4`) ; 89 syllabes au ton neutre, 6 « couvertes » par des fichiers
`*5` inutilisables. Sur les 6 082 syllabes-occurrences du programme, 95,0 % sont aux tons 1-4 donc couvertes ; le ton
neutre (5 %) reste à Piper. Ne **pas** substituer le ton 1 au ton neutre (le README dit avoir supprimé les `*5` « copies
des *1 », mais un ton neutre isolé n'est pas un ton 1).

## 5. Contrôle qualité (« écoute » instrumentée)

### 5.1 Échantillon de 30 fichiers (graine fixe ; 20 mots + 10 syllabes), sources 64k

| Mesure | Mots (Yue Tan) min / médiane / max | Syllabes (Chen Wang) |
|---|---|---|
| Durée | 0,85 / 1,25 / 1,70 s | 0,94 / 1,13 / 1,34 s |
| Silence en tête (trame > max − 35 dB) | 0,01 / 0,25 / 0,30 s | 0,04 / 0,28 / 0,35 s |
| Silence en queue | 0,01 / 0,24 / 0,30 s | 0,01 / 0,29 / 0,39 s |
| Parole utile | 0,41 / 0,80 / 1,44 s | 0,32 / 0,65 / 0,91 s |
| Bruit de fond (10ᵉ centile) | −57,7 / −54,1 / −46,1 dBFS | −63,9 / −55,0 / −50,5 dBFS |
| Loudness intégrée (loudnorm) | −21,2 / −16,5 / −11,0 LUFS | −20,7 / −16,1 / −13,3 LUFS |
| Crête vraie | −6,2 / −1,5 / −0,7 dBTP | −1,5 / −1,3 / −0,6 dBTP |
| volumedetect moyenne / max | −25,6 / −9,4 dB (moyenne quasi constante : sources normalisées en RMS, silences compris) | −25,9 / −9,0 dB |

→ ~0,5 s de silence par fichier (40 % de la durée) et 10 LU d'écart de loudness : d'où la coupe et la normalisation.
Sur les **8 596 + 1 707** fichiers : aucune saturation côté mots, 1 crête > 0 dBFS côté syllabes (`yin1`, 1,05) ;
219 mots et 0 syllabe ont < 20 ms avant la première trame forte (attaque potentiellement rognée **ou** clic en tête,
ex. `组合` : clic à −47 dB ; non vérifiable sans écoute humaine) ; 189 mots / 116 syllabes < 20 ms en queue.

### 5.2 Tons de 20 syllabes (5 par ton, graine 42)

`check-audio-tones.mjs` (YIN de `pitch.ts`, contour en demi-tons) avec trois classifieurs : `guessTone` de l'app,
gabarits de Chao centrés (`tonefix.ts`), gabarits en hauteur absolue (réf. = médiane du locuteur = 249 Hz), et
un kNN adapté au locuteur (k = 9, leave-one-out sur les 1 660 syllabes toniques du même locuteur, `eval-native-audio.py`).

| Classifieur | 20 échantillons | 1 660 syllabes |
|---|---|---|
| `guessTone` (app) | 18/20 (zai3, ru3 → 4) | 80,1 % |
| gabarit centré | 18/20 | 78,1 % |
| gabarit absolu | 16/20 | 83,0 % |
| vote des 3 | 19/20 | 83,7 % |
| **kNN locuteur** | **20/20 (9/9 voisins pour chacun)** | **98,7 %** |

Les erreurs des classifieurs génériques sont des artefacts connus (3ᵉ ton isolé réalisé 21 sans remontée → « 4 » ;
fin du 4ᵉ ton en voix craquée non voisée → « 1 »), pas des erreurs d'enregistrement : le kNN, qui apprend la voix,
les résout. 16 syllabes restent en désaccord net (≥ 7/9) : cha3 chan4 chen4 gun2 keng4 la4 lia4 miu4 pou4 qia3 ran4
reng4 ri3 shu4 yai1 za3 — dont plusieurs explicables par le pistage (chan4 et gun2 à 133 Hz = octave basse ; shu4 :
50 ms voisées). **≤ 1 % de suspects, aucun confirmé** ; à écouter en priorité si on veut un contrôle humain (la4, ran4).

### 5.3 Lectures des caractères polyphoniques (mots d'un caractère)

Les noms de fichiers ne portent pas de pinyin : le même kNN (voix de Yue Tan, 702 mots d'un caractère, exactitude
LOO 96,7 %) compare le ton enregistré au ton de `words.json`. Désaccords nets dont le ton prédit correspond à une
**autre lecture** du caractère (CEDICT) → exclus de l'index (`index.json › excluded`, repli Piper) :

| Mot | Programme | Enregistrement (ton prédit, voix) |
|---|---|---|
| 喂 (rang 512) | wéi | wèi (4, 9/9) |
| 长 (563) | cháng | zhǎng (3, 7/9) |
| 转 (1318) | zhuǎn | zhuàn (4, 9/9) |
| 血 (1373) | xuè | xiě (3, 9/9) |
| 处 (2282) | chǔ | chù (4, 9/9) |
| 卷 (2465) | juàn | juǎn (3, 9/9) |
| 量 (2475) | liàng | liáng (2, 9/9) |
| 挑 (2495) | tiǎo | tiāo (1, 9/9) |
| 散 (2581) | sǎn | sàn (4, 9/9) |

Conservés mais signalés : **胖** — `words.json` donne `pan2` (lecture rare) alors que l'enregistrement est pàng (4, 8/9) :
c'est le **programme** qui est faux (à corriger dans `build-data.mjs`). 那 (na4 → « 1 », 8/9), 你, 几, 二, 带, 哭, 板, 项 :
désaccords sans autre lecture plausible = probables artefacts de pistage (même motif 4 → 1 / 3 → 2 qu'au §5.2).
**Non vérifié** : les mots de 2+ caractères contenant un polyphone (行, 还, 得, 都, 了…) — la segmentation par syllabe
n'a pas été évaluée ; un faible taux d'erreur résiduel est possible.

### 5.4 Contrôle ASR (proxy de contenu), Whisper sur les 20 mots de l'échantillon

Whisper `base` sans contexte : 12/20 transcriptions exactes ; les échecs sont des homophones / quasi-homophones
(伟大 → 为大, 东 → 中, 路 → 啰, 组合 → 祝贺, 最初 → 水猪) ou des monosyllabes romanisés (富 → « Fu », 批 → « P »).
Whisper `small` (466 Mo) : **15/20** sur les MP3 sources (富, 批, 路, 东 : aucune sortie ; 最初 → 祟初), **13/20** sur les
Opus produits (口 → 咖喱, 组合 → 绸合 en plus). Contre-test sur 口 / 组合 : la coupe seule (WAV) ou l'Opus seul (sans coupe)
suffisent à faire basculer la transcription (口 → 考 dans les deux cas ; 组合 correct en Opus non coupé, faux en WAV coupé) :
Whisper est instable sur des mots isolés de < 1 s et l'écart 15 → 13 n'est pas interprétable (n = 20). Conclusion : aucun
fichier au contenu manifestement erroné ; l'ASR reste un proxy faible, la mesure des tons (§5.2, inchangée après
conversion) est plus fiable. Une légère perte d'intelligibilité due au traitement n'est pas exclue formellement.

### 5.5 Anomalies de la source

- Les 19 fichiers « ton 5 » (`a5`…`bing5`) durent 1,7 à 5,1 s d'énergie continue (ba5 = 4,99 s) : ce ne sont **pas** des
  syllabes isolées (prises multiples ou parole) → exclus.
- `jv4` = `ju4` (renommé). `_lvan1-4` et `_nia1-4` : noms hors pinyin standard → exclus.

## 6. Sources complémentaires évaluées

| Source | Résultat | Verdict |
|---|---|---|
| **Lingua Libre** (Commons, `Category:Lingua Libre pronunciation-cmn`) | 4 108 fichiers (6 locuteurs principaux : Fake estate 1 148, CanonNi 845, Luilui6666 805, Jouketou 549, Levi Highway 243, 雲角 146), 3 242 transcriptions distinctes ; 1 260 mots du programme dont **94 absents de l'index** (41 de rang < 1 700 : 中国, 北京, 手机, 吃饭, 打电话, 不客气, 出租车…), + 5 des 9 exclus (喂 长 转 血 卷, lecture à vérifier) → couverture potentielle ≈ 88,6 % | Licences CC BY-SA 4.0 (souvent + CC0) par fichier ; voix multiples. **Téléchargement impossible ici** (upload.wikimedia.org et api.php : HTTP 429 persistant) → non intégré, non contrôlé |
| **Commons « Zh-*.ogg » / Shtooka** | `Category:Audio files from Shtooka Project (Mandarin)` : 3 fichiers ; `Mandarin pronunciation` : 45 fichiers | Négligeable |
| **Wikidata lexèmes** (P443) | 25 formes mandarin avec audio | Négligeable |
| **Tatoeba** (phrases) | Les 2 093 phrases `a=1` de `sentences.json` ont un audio ; l'URL `https://tatoeba.org/audio/download/<id>` attend l'**id d'audio**, pas l'id de phrase : avec l'id de phrase on obtient **un autre enregistrement** (vérifié : phrase 1 我们试试看 → audio 1 = « 不要再把我当成正常人 » ; audio 1276691 = 我们试试看). Table phrase→audio : `data-raw/cmn_sentences_with_audio.tsv` (col. 2) | **Non redistribuable** : 2 064/2 093 sans licence (fucongcong 1 323, LeviHighway 741) — « If the license field is empty, you may not reuse the audio outside the Tatoeba project » ; 29 en CC BY-NC 4.0 (GlossaMatik). Au mieux lecture en ligne avec lien vers Tatoeba |

## 7. `scripts/fetch-audio.sh`

```
bash scripts/fetch-audio.sh          # programme + syllabes (exécuté : 5-7 min sur 4 cœurs, ré-exécution 23 s)
bash scripts/fetch-audio.sh --all    # + les ~5 700 autres mots HSK 2000 (non exécuté ; ≈ +20 Mo estimés à 3,5 Ko/fichier)
```

1. Clone partiel épinglé (`data-raw/audio-cmn`, ignoré par git) : `64k/hsk`, `64k/syllabs`, `lists`, README.
2. Sélection : mots de `words.json` (exact, sinon variante érhua), moins les 9 exclusions ; syllabes tons 1-4
   (+ interjections hm, hng, m, n, ng) ; `jv4 → ju4`.
3. Par fichier, 2 passes ffmpeg (binaire embarqué) : coupe `silenceremove` à −45 dB (RMS, 20 ms) aux deux bouts en
   gardant 60 ms ; mesure EBU R128 sur le clip coupé répété 4× (sinon −inf pour les clips < 0,4 s) ; gain linéaire vers
   −18 LUFS plafonné à −2 dBTP ; Opus mono 24 kHz 32 kb/s VBR (`-application audio`), métadonnées retirées.
4. `index.json` + `CREDITS.md` ; suppression des fichiers orphelins. Idempotent.

**Résultat de l'exécution** : 2 841 mots + 1 680 syllabes = 4 521 fichiers, **15 060 678 octets** (mots 10,03 Mo,
moyenne 3,5 Ko ; syllabes 5,04 Mo, 3,0 Ko), débit moyen mesuré 34 kb/s. Durées après coupe : mots p5/p50/p95 =
0,50/0,84/1,09 s, syllabes 0,38/0,70/1,09 s. Loudness : p50 −18,4 LUFS (mots) / −18,1 (syllabes), 80 % / 88 % à ±1 LU de
−18 (les autres sont plus bas car limités par la crête — pas de compresseur), crête max −1,5 dBTP après décodage.
Validation de la coupe (300 fichiers tirés au hasard) : énergie retirée médiane 0,011 %, max 0,081 % (bruit de fond
avant les attaques fricatives 歇, 细 — profil vérifié : la partie retirée est à −48/−55 dB, l'attaque est conservée).
Validation des tons après conversion : kNN 98,6 % (contre 98,7 % sur les MP3 sources), `guessTone` 79,6 % (80,1 %).

### Schéma de `resources/audio/index.json`

```jsonc
{
  "version": 1, "generated": "2026-11-02", "format": "…", "naming": {…}, "sources": {…}, "stats": {…},
  "variants": { "这儿": "这", … },              // mot du programme → mot effectivement prononcé
  "excluded": { "长": "zhǎng (programme : cháng)", … },
  "words":     { "好": "words/597d.opus", "银行": "words/94f6-884c.opus", … },   // 2 841 entrées
  "syllables": { "hao3": "syllables/hao3.opus", "nü3": "syllables/nv3.opus", "ju4": "syllables/ju4.opus", … } // 1 680
}
```

- Mots : `words/<points de code hexadécimaux en minuscules, séparés par « - »>.opus` (noms ASCII, sûrs dans l'AppImage).
  Clé = mot simplifié exactement comme dans `words.json`.
- Syllabes : fichier `syllables/<pinyin numérique ASCII, ü → v>.opus`, clé = pinyin numérique de `words.json`
  (minuscule, `ü` conservé : `nü3`, `lü4`, `lüe4`). Les majuscules des noms propres de `pn` (`Bei3 jing1`) doivent être
  mises en minuscule avant recherche. Pas de clé pour le ton 5.

## 8. Intégration suggérée (non faite : `src/` non modifié)

- `package.json › build.extraResources` : ajouter `{ "from": "resources/audio", "to": "audio" }` ; décider si
  `resources/audio/` est versionné (15 Mo) ou généré en CI par `fetch-audio.sh` comme `resources/bin`.
- `tts:speak(text)` : si `index.words[text]` existe → renvoyer ce fichier (Electron lit l'Opus/Ogg nativement) ; sinon Piper.
  Le mode lent (`{slow:true}`) peut rester sur Piper ou utiliser `playbackRate` côté renderer.
- Écran Tons : syllabes natives pour `toneDrill`/`minimalPairs` (contrastes 1-4 sur toutes les syllabes) et comme
  référence `PitchCompare` (`refPath`) — plus fiable que Piper corrigé par PSOLA.
- Corriger `胖` (`pan2` → `pang4`) dans les données ; afficher les crédits (§3).
- Lingua Libre : relancer plus tard depuis un réseau non limité (lister la catégorie via `index.php`, télécharger
  `Special:FilePath`, conserver locuteur + licence par fichier) pour +94 mots.

## 9. Non vérifié / limites

- Aucune écoute humaine : la conformité est instrumentée (YIN, kNN, ASR). Les 16 syllabes et ~10 mots signalés
  comme « suspects » devraient être écoutés.
- `readme.txt` Shtooka (texte de licence d'origine) inaccessible ; version CC BY-SA des syllabes non précisée par la source.
- Lectures des polyphones dans les mots de 2+ caractères non contrôlées.
- Téléchargement Lingua Libre / Commons non testé (HTTP 429) ; couverture Lingua Libre calculée sur les seuls titres.
- Taille du mode `--all` estimée, non mesurée.
