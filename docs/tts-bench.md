# Banc d'essai TTS chinois local (remplacer / compléter Piper huayan)

Date : 2026-11-02 · Scripts : [`scripts/tts-bench/`](../scripts/tts-bench/README.md) · Données brutes : [`docs/tts-bench-results.json`](tts-bench-results.json)

## TL;DR — recommandation

**Remplacer Piper `zh_CN-huayan-medium` par sherpa-onnx + `matcha-icefall-zh-baker` (vocodeur `vocos-22khz-univ`), voix unique (sid 0), vitesse 1.0, modèle chargé une seule fois dans le processus principal.**

- **Mots de 1-2 syllabes : synthèse à partir des jetons pinyin** (`GenerationConfig.tokens = [["bu2","dui4","."]]`) construits depuis le pinyin du programme (`words.json` `pn`) **avec sandhi appliqué** (`applySandhi` de `tonefix.ts`) ; pour les syllabes au ton neutre et les jetons absents de `tokens.txt` (ex. `shei2`), reprendre la lecture du caractère dans `lexicon.txt` du modèle. À défaut (CLI), envoyer le texte **suivi de « 。 »** (jamais le mot nu).
- **Phrases : texte brut** (le lexique du modèle applique déjà 一/不 et les mots polyphoniques courants).
- **Mode lent : ne pas ralentir le modèle** (length scale > 1 dégrade nettement l'intelligibilité, cf. §4) — garder la synthèse à 1.0 et ralentir à la lecture (`audio.playbackRate`, `preservesPitch` est actif par défaut dans Chromium).
- **Ne plus appliquer la correction PSOLA (`tonefix`)** à cette voix : elle n'améliore pas l'intelligibilité mesurée (90,8 % vs 92,5 %).

| | Piper huayan + tonefix (actuel) | **Matcha zh-baker, jetons pinyin** |
|---|---|---|
| Mots : pinyin **avec tons** reconnu par Whisper (120 mots) | 63,3 % [IC95 54-71] | **95,0 %** [90-98] |
| Monosyllabes isolés (40) : idem | 35 % [22-51] | **97,5 %** [87-100] |
| Phrases : CER Whisper / erreurs de pinyin tonal | 5,7 % / 3,6 % | **3,8 % / 2,0 %** |
| Phrases : tons reconnus par le classifieur entraîné sur voix humaines | 65,0 % | **73,7 %** (meilleur score) |
| Latence d'un mot (modèle chaud, 1 thread) | 434 ms (1 processus par appel) | **89 ms** (chargement unique 2-3 s) |
| Taille sur disque | 136 Mo (`resources/bin/piper`) | **131 Mo** de modèles (+ moteur, cf. §6) |
| Écrêtage | 180/180 fichiers touchent ±1,0 | aucun (crête max 0,73) |

Fichiers gardés pour l'implémentation : `/tmp/claude-0/-home-user-learn-chinese-app/dc3db374-7a47-5cae-8813-8ddf16b0676c/scratchpad/eval/tts/models/` (détails §6).

---

## 1. Ce qui a été comparé

Moteur : **sherpa-onnx 2.0.1** (k2-fsa). Modèles chinois de la liste officielle (pages `tts/pretrained_models` et `tts/all/Chinese*`), tous téléchargés depuis la release GitHub `tts-models` :

| système | modèle | voix testées |
|---|---|---|
| `piper_huayan` | binaire Piper de l'app, invoqué comme `tts.ts` (`--sentence_silence 0.25`, `LD_LIBRARY_PATH`, `--espeak_data`) | huayan |
| `piper_huayan_fix` | idem + correction PSOLA de `tonefix.ts` (= ce que l'app joue aujourd'hui pour les mots) | |
| `matcha_baker` | matcha-icefall-zh-baker + vocos-22khz-univ | 1 (femme, corpus Baker) |
| `matcha_zh_en` | matcha-icefall-zh-en + vocos-16khz-univ | 1 |
| `kokoro11_*` | kokoro-multi-lang-v1_1 (et int8) | zf_001-005, 017, 039, 088, zm_009, 010, 014, 052 |
| `kokoro10_*` | kokoro-multi-lang-v1_0 | zf_xiaobei/xiaoni/xiaoxiao/xiaoyi, zm_yunjian/yunxi/yunxia/yunyang |
| `melo_zh_en` | vits-melo-tts-zh_en | 1 |
| `piper_xiao_ya`, `piper_chaowen` | vits-piper-zh_CN-xiao_ya / chaowen-medium (nouvelles voix Piper à lexique pinyin) | 1 + 1 |
| `vits_zh_ll_*` | sherpa-onnx-vits-zh-ll | sid 0-4 |
| `aishell3_*` | vits-icefall-zh-aishell3 | sid 10, 33, 99 |
| `zipvoice_news-female` | sherpa-onnx-zipvoice-distill-int8-zh-en-emilia (clonage, réf. `news-female.wav`) | 1 |

Variantes : `+p` = mot suivi de « 。 » ; `+t` = jetons pinyin explicites (Matcha) ; `@0.85`/`@0.7` = vitesse ; `_fix` = + PSOLA `tonefix`.

## 2. Jeu de test et métriques

**120 mots** de `words.json` (48 monosyllabes équilibrés tons 1-4 dont 不/一/长/行/还/只 isolés ; 10 paires 3-3 (可以, 水果…) ; 6 cas de 不, 7 de 一 ; 8 mots à ton neutre ; 16 polyphones (长/长大, 行/银行, 还/还是, 得到, 觉得, 睡觉, 音乐, 快乐, 重要, 重新, 只, 教室, 头发) ; 33 mots couvrant toutes les autres paires de tons) + **60 phrases Tatoeba** de `sentences.json` (6-16 caractères, vocabulaire du programme, sans erhua). Tons attendus = pinyin du programme (pypinyin en secours pour les phrases) + sandhi (3-3 dans le mot ; 3-3 entre deux mots → 2 ou 3 acceptés ; 不/一). Syllabes neutres non notées.

1. **Tons (F0)** : YIN de l'app (`pitch.ts`), découpage en syllabes (`tonefix.syllableSegments` pour les mots ; alignement forcé CTC d'un modèle WeNet à caractères pour les phrases — le pic CTC tombe en fin de syllabe, vérifié sur les courbes), contour de la rime (20 % initiaux / 10 % finaux retirés), classement 1-4 par distance DTW aux gabarits de Chao de `tonefix.ts` avec normalisation registre/étendue ajustée **sans regarder les tons attendus** ; contour < 1,8 demi-ton ⇒ ton plat (seuil de `guessTone`).
2. **Tons (classifieur appris, phrases)** : gradient boosting entraîné sur 3 795 syllabes de **parole humaine lue** (FLEURS cmn, split test), validé sur d'autres phrases/locuteurs humains (FLEURS dev) : **60,9 %** = plafond humain de référence (les gabarits seuls n'atteignent que 40,7 % sur l'humain : ils sont valables pour les formes de citation, pas pour la parole continue).
3. **Intelligibilité** : `whisper-cli` + `ggml-small`, prompt `以下是普通话的词语。/句子。` ; CER (caractères simplifiés), **TER = erreurs de pinyin avec tons** (un homophone n'est pas une faute, un ton faux oui), verdict par mot par alignement de Levenshtein. Second ASR sans modèle de langue : CTC glouton WeNet (`cer_ctc`).
4. **Vitesse** : latence médiane (3 répétitions, modèle chaud), RTF, temps de chargement, 1 et 2 threads. **Taille** : fichiers réellement nécessaires.
5. **Signal** : écrêtage (|x| ≥ 0,999), crête, silences initial/final, plus longue pause interne, sorties muettes (aucune).

## 3. Résultats — mots isolés (le point faible de Piper)

| système | tons F0 (183 syll.) | Whisper : mots corrects avec tons | monosyllabes corrects | CER Whisper | TER | CER CTC | durée moy. |
|---|---|---|---|---|---|---|---|
| piper_huayan | 47,0 | 53,3 | 17,5 | 33,8 | 32,8 | 36,4 | 0,85 s |
| piper_huayan_fix (actuel) | 83,1* | 63,3 | 35,0 | 27,7 | 26,2 | 29,7 | 0,85 s |
| piper_huayan+p | 48,6 | 60,0 | 30,0 | 30,8 | 28,2 | 34,4 | 0,86 s |
| matcha_baker | 57,9 | 90,8 | 82,5 | 8,2 | 5,6 | 19,0 | 0,47 s |
| matcha_baker+p | 69,9 | 92,5 | 92,5 | 8,7 | 5,6 | 11,8 | 0,58 s |
| **matcha_baker+t** | 69,4 | **95,0** | **97,5** | **6,7** | 5,6 | 12,8 | 0,58 s |
| matcha_baker+p_fix | 86,3* | 90,8 | 90,0 | 9,2 | 6,7 | 12,8 | 0,58 s |
| matcha_baker@0.85+t | 70,5 | 87,5 | 85,0 | 13,3 | – | 20,0 | 0,68 s |
| matcha_baker@0.7+t | 64,5 | 86,7 | 80,0 | 27,7 | – | 48,2 | 0,83 s |
| kokoro11_zf_002 | 61,7 | 79,2 | 77,5 | 21,5 | 17,4 | 36,9 | 0,64 s |
| kokoro11_zf_002+p | 68,9 | 85,0 | 72,5 | 12,3 | 10,3 | 25,1 | 0,67 s |
| kokoro11_zf_002+p_fix | 90,7* | 90,8 | 90,0 | 9,2 | 6,2 | 22,1 | 0,67 s |
| kokoro11_zf_003 | 57,4 | 68,3 | 60,0 | 27,2 | 24,1 | 32,8 | 0,63 s |
| matcha_zh_en | 50,0 | 60,0 | 30,0 | 31,8 | 29,2 | 20,0 | 0,63 s |
| matcha_zh_en+p | 55,5 | 90,8 | 82,5 | 6,2 | 5,6 | 12,8 | 0,68 s |
| piper_xiao_ya | 45,9 | 60,0 | 7,5 | 30,3 | 27,7 | 32,3 | 0,61 s |
| zipvoice_news-female | 43,0 | 90,8 | 80,0 | 7,7 | 6,2 | 10,3 | 0,47 s |
| melo_zh_en | 22,9 | 28,3 | 0,0 | 59,5 | 57,9 | 73,3 | 0,41 s |

\* biaisé par construction : `tonefix` impose par PSOLA les mêmes gabarits de Chao que ceux qui servent à noter. À juger sur les colonnes Whisper.

Écran des voix (tons F0 sur les mots seuls, sans Whisper) : kokoro v1.1 zf_002 61,7 > zf_003 57,4 > zf_017 54,4 > zf_004 51,1 > zf_001 49,7 > zf_005 44,3 > zm_* 36-42 ; kokoro v1.0 21-48 (yunxi meilleur) ; vits-zh-ll 27-32 ; aishell3 27-34 ; chaowen 30,6. Ces voix produisent des mots isolés presque plats (ton 1 reconnu à 70-90 %, tons 2/3 < 20 %).

Constats :
- **Le défaut signalé de Piper est confirmé et quantifié** : sur ses 51 syllabes au 4ᵉ ton, 32 sont mesurées plates (en ton 1) ; Whisper ne reconnaît que 7 monosyllabes isolés sur 40 (是→事/十, 在→嗯…). La correction PSOLA de l'app aide (17,5 → 35 %) mais Piper reste segmentalement flou sur les mots isolés (pinyin sans tons correct seulement à 65 %).
- **Ne jamais synthétiser un mot nu** : « 。 » final améliore tous les modèles (Matcha F0 57,9 → 69,9 %, CER CTC 19 → 11,8 %). Les jetons pinyin font mieux encore sur les polyphones isolés (长 lu *zhǎng* par le lexique → *cháng* avec `chang2`) et les monosyllabes (97,5 %).
- Ralentir via `speed` < 1 dégrade (CER 6,7 → 13,3 % à 0,85, 27,7 % à 0,7).
- Les deux mesures de ton divergent au niveau du mot (accord 52 %, κ = 0,13 sur 1 440 mots ; Whisper « répare » souvent un ton faux grâce à son modèle de langue, ex. un 要 mesuré plat est transcrit 要). Elles concordent pour le classement des systèmes : Piper est dernier des candidats sérieux et Matcha premier sur les deux.

## 4. Résultats — phrases (60 phrases, 411 syllabes notées)

| système | tons classifieur appris (plafond humain 60,9) | tons gabarits | CER Whisper | TER Whisper | CER CTC | pause max | syll. non voisées |
|---|---|---|---|---|---|---|---|
| piper_huayan | 65,0 | 51,3 | 5,7 | 3,6 | 7,5 | 330 ms | 2 |
| **matcha_baker** | **73,7** | 56,6 | 3,8 | 2,0 | 3,6 | 170 ms | 8 |
| kokoro11_zf_003 | 73,0 | 67,4 | **3,4** | 1,0 | 3,4 | 180 ms | 0 |
| kokoro11_zf_002 | 71,8 | 65,7 | 3,8 | 1,4 | 5,5 | 170 ms | 0 |
| piper_xiao_ya | 71,2 | 53,9 | 4,0 | **0,4** | **2,6** | 120 ms | 5 |
| matcha_zh_en | 64,9 | 51,5 | 3,8 | 1,6 | 4,4 | 260 ms | 7 |
| zipvoice_news-female | 61,8 | 56,3 | 4,2 | 1,4 | 3,4 | 330 ms | 24 |
| melo_zh_en | 53,6 | 48,7 | 8,3 | 5,9 | 7,7 | 100 ms | 23 |

Toutes les voix sauf Melo sont très intelligibles en phrase (CER 3-6 %) ; Piper y est correct (c'est le mot isolé qui pose problème). Matcha a les tons de phrase les plus reconnaissables.

## 5. Vitesse et taille (VM 4 cœurs partagée, ±30 %)

| système | chargement | latence mot (1 thr / 2 thr) | latence phrase (1 / 2) | RTF phrase (1 thr) | taille |
|---|---|---|---|---|---|
| piper_huayan (1 processus/appel, chargement inclus) | – | 434 ms | 631 ms | 0,31 | 136 Mo |
| **matcha_baker** | 2,2-3,0 s | **89 / 78 ms** | 249 / 200 ms | 0,14 | **131 Mo** |
| matcha_zh_en | 2,2-3,0 s | 115 / 95 ms | 194 / 128 ms | 0,12 | 131 Mo |
| piper_xiao_ya | 1,7 s | 97 / 73 ms | 336 / 213 ms | 0,17 | 65 Mo |
| kokoro11 (fp32) | 2,7 s | 797 / 506 ms | 2 625 / 1 420 ms | 1,24 | 387 Mo |
| kokoro11 int8 | 2,6 s | 1 511 / 1 145 ms | 4 554 / 4 163 ms | 2,22 | 207 Mo (plus lent que fp32 sur ce CPU) |
| melo_zh_en | 5,8 s | 451 / 280 ms | 1 519 / 905 ms | 1,08 | 177 Mo |
| zipvoice (4 étapes) | 2,1-2,7 s | 4 487 / 2 880 ms | 6 333 / 4 013 ms | 3,06 | 186 Mo |

Avec un chargement unique, Matcha est ~5× plus rapide que Piper par appel. **Avec la CLI (un processus par appel), le chargement de 2-3 s s'ajouterait à chaque mot** → utiliser le module Node.

Signal : Piper produit des échantillons à ±1,0 dans 180/180 fichiers (Piper normalise au maximum ; 0,005 % des échantillons, discret mais réel) ; ZipVoice écrête 15 fichiers ; les autres n'écrêtent jamais. Aucun fichier muet. Matcha laisse ~57 ms de silence avant et ~39 ms après un mot (Piper : 0 / 290 ms).

## 6. Mise en œuvre recommandée

**Fichiers (131 Mo)** — copiés dans `/tmp/claude-0/-home-user-learn-chinese-app/dc3db374-7a47-5cae-8813-8ddf16b0676c/scratchpad/eval/tts/models/` :
```
matcha-icefall-zh-baker/model-steps-3.onnx   75,6 Mo  sha256 78a9fd17…62ddfd
matcha-icefall-zh-baker/lexicon.txt           1,4 Mo
matcha-icefall-zh-baker/tokens.txt, date.fst, number.fst, phone.fst, README.md
vocos-22khz-univ.onnx                        53,9 Mo  sha256 0574a135…0c0081
sherpa-onnx-v2.0.1-linux-x64-static/sherpa-onnx-offline-tts   35 Mo (CLI statique, glibc ≥ 2.17, non exécutée ici)
SHA256SUMS
```
URLs exactes :
- https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/matcha-icefall-zh-baker.tar.bz2 (75,5 Mo ; le dossier `dict/` n'est plus utilisé depuis la v2.0)
- https://github.com/k2-fsa/sherpa-onnx/releases/download/vocoder-models/vocos-22khz-univ.onnx (53,9 Mo)
- Moteur, au choix :
  - **recommandé** : npm `sherpa-onnx-node@2.0.1` (+ dépendance optionnelle `sherpa-onnx-linux-x64@2.0.1`, addon N-API précompilé, 33 Mo décompressé). `GenerationConfig.tokens` y est documenté (`types.js` : « Pre-tokenized input, e.g. Chinese pinyin like "zhong1" »). Publié le 2026-10-26 (2.0.0 : 2026-10-23).
  - CLI : https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/sherpa-onnx-v2.0.1-linux-x64-static.tar.bz2 (archive de 407 Mo ; seul `bin/sherpa-onnx-offline-tts` (35 Mo) est utile). La CLI ne prend que du texte : utiliser alors « mot + 。 ».

Esquisse (processus principal, modèle chargé une fois) :
```ts
import sherpa from 'sherpa-onnx-node';
const tts = new sherpa.OfflineTts({
  model: { matcha: { acousticModel: `${M}/model-steps-3.onnx`, vocoder: `${M}/../vocos-22khz-univ.onnx`,
                     lexicon: `${M}/lexicon.txt`, tokens: `${M}/tokens.txt` },
           numThreads: 1, provider: 'cpu' },
  ruleFsts: `${M}/date.fst,${M}/phone.fst,${M}/number.fst`, maxNumSentences: 1,
});
// mot court : pinyin du programme + sandhi (applySandhi), ü→v, ton neutre / jeton inconnu → lecture du lexique
const audio = tts.generate({ text: '不对', sid: 0, speed: 1.0,
  generationConfig: { tokens: [['bu2', 'dui4', '.']] } });
// phrase : tts.generate({ text: '我明天需要知道。', sid: 0, speed: 1.0 })
// audio.samples (Float32Array, 22 050 Hz) → WAV 16 bits (encodeWav de tonefix.ts) → cache existant
```
CLI équivalente (vérifiée via le module Python de la même version, pas via le binaire) :
```
sherpa-onnx-offline-tts --matcha-acoustic-model=$M/model-steps-3.onnx --matcha-vocoder=vocos-22khz-univ.onnx \
  --matcha-lexicon=$M/lexicon.txt --matcha-tokens=$M/tokens.txt --num-threads=1 --output-filename=out.wav "不对。"
```
(normalisation des nombres : `--tts-rule-fsts=$M/date.fst,$M/phone.fst,$M/number.fst`, non testé).

Points à traiter lors de l'intégration :
- Électron : addon N-API → à sortir de l'asar (`asarUnpack`) ; non testé dans Electron 45 ici.
- Garder Piper en repli tant que le module n'est pas validé dans l'AppImage.
- Sortie 22 050 Hz mono (même fréquence que Piper) ; incrémenter `RENDER_VERSION` (le cache change de voix).
- Licence : le corpus Baker (matcha-zh-baker, xiao_ya) est « usage non commercial ». Alternative sous Apache-2.0 : kokoro v1.1 `zf_002` + « 。 » (85 % des mots corrects, phrases au niveau de Matcha) mais 3× plus lourd et ~6× plus lent.

## 7. Ce qui n'a pas pu être vérifié (honnêtement)

- **La CLI statique n'a pas été exécutée** : le bac à sable a refusé l'exécution d'un binaire téléchargé. Toute la synthèse sherpa a utilisé la roue PyPI `sherpa-onnx==2.0.1` (même cœur C++, même version). Les options CLI ci-dessus viennent de `--help` lu avant le refus.
- **Whisper par groupes, pas fichier par fichier** : sur la VM partagée (charge 4-11), whisper-cli small prenait jusqu'à 90 s par fichier. Les sorties sont donc concaténées (≤ 12 mots ou ≤ 25 s, 1 s de silence entre mots) ; le contexte de liste diffère d'un mot vraiment isolé, et le modèle de langue de Whisper masque des erreurs de ton (κ = 0,13 avec la mesure F0).
- **Pas de calibrage humain pour les mots isolés** : Wikimedia Commons a répondu 429 à toutes les requêtes. Le calibrage humain (FLEURS) ne couvre que les phrases.
- **Aucune écoute humaine** : la qualité perçue (naturel, timbre, artefacts) n'est jugée que par des mesures indirectes.
- Les durées sont mesurées sur une VM 4 cœurs partagée avec d'autres tâches (±30 %).
- Les intervalles de confiance sont larges (120 mots, 40 monosyllabes) : `+t` vs `+p` (95,0 vs 92,5 %) n'est pas une différence significative ; Matcha vs Piper l'est très largement.
- Les jetons pinyin n'ont été testés que pour les mots (pas pour les phrases) ; la variante `+t` de base (tons neutres en jetons sans chiffre) était mauvaise (84 %) : les jetons toneless du modèle sont mal appris, d'où le repli sur le lexique.
- ZipVoice n'a été essayé qu'avec une seule voix de référence ; erhua et chiffres exclus du jeu de test.
