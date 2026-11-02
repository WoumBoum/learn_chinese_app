# 特工中文 — Opération Mandarin

Centre de formation au mandarin pour francophones, sous forme d'application de bureau Linux (**AppImage**).
Objectif du programme : **HSK 3 (~1 500 mots, ~650 caractères, ~97 points de grammaire) en 26 semaines**, avec une vraie capacité à **comprendre le chinois à l'oral**.

Le programme jour par jour est dans [PROGRAMME.md](PROGRAMME.md).

## Installation

```bash
chmod +x Operation-Mandarin-0.1.0-x86_64.AppImage
./Operation-Mandarin-0.1.0-x86_64.AppImage
```

- Aucune installation ni compte. Tes données restent sur ta machine dans `~/.config/Operation Mandarin/` (base `user.db`, vidéos téléchargées, audio).
- Si l'AppImage refuse de démarrer avec une erreur FUSE : `sudo apt install libfuse2` (Ubuntu/Debian), ou lance-la avec `--appimage-extract-and-run`.
- Micro (shadowing) : autorise l'accès quand le système le demande.
- YouTube : si une vidéo demande une connexion (« confirm you're not a bot »), active l'option *cookies du navigateur* dans l'écran Missions vidéo.

## Ce que fait l'application

| Module | Contenu |
|---|---|
| **QG** | Plan du jour adaptatif : modes **Express** (15-20 min, aucune nouveauté), **Standard** (ton temps prévu), **Marathon** (séances bonus à volonté). Rattrapage automatique après des jours manqués. Charge de révisions prévue sur 7 jours. |
| **Révisions** | Répétition espacée **FSRS** : caractère → sens (sans pinyin), audio → sens, français → mot (production), phrases minées des vidéos. |
| **Nouveaux mots** | 3 317 mots HSK ordonnés (HSK 3.0 + fréquence), présentation avec audio, pinyin affiché **une seule fois**, décomposition des caractères, ordre des traits animé, phrases d'exemple, vérification sans pinyin. |
| **Missions vidéo** | Ajoute une vidéo YouTube, un podcast ou un fichier local → sous-titres (ou transcription Whisper locale) → **couverture lexicale** → **pré-enseignement** des mots manquants quelques jours avant → lecteur interactif (mots cliquables, boucle, vitesse, shadowing, minage de phrases) → débriefing. Catalogue de ~60 sources vérifiées par niveau. |
| **Tons & oral** | Les 4 tons, pinyin, exercices d'écoute (tons, paires de tons, paires minimales), **shadowing avec courbe de hauteur** de ta voix comparée à la référence. |
| **Grammaire** | **97 points** (A1 → B1) en séances complètes : cours en français + ~17 exercices interactifs par point (tuiles, trous, transformation, correction, traduction, écoute). Chaque règle devient une carte **FSRS**. Déblocage par palier (≥ 80 %). |
| **Écriture** | Sur **papier** : observer l'ordre des traits → copier N fois → écrire de mémoire → comparer au modèle numéroté → auto-évaluation (FSRS). Séance longue : mots, phrases à recopier, phrases de mémoire, dictée. |
| **Lecture** | Phrases 100 % connues ou i+1 (un seul mot inconnu) ; histoires graduées écrites avec *tes* mots (IA). |
| **Jeu de rôle** | Missions d'agent (café, gare, poste-frontière…) avec un personnage qui parle à ton niveau et corrige tes phrases (IA). |
| **Examens** | Test hebdomadaire (écoute, lecture, grammaire, 85 % pour garder le rythme plein) et examens blancs de fin de phase. |
| **Dictionnaire** | CFDICT (chinois-français) + CC-CEDICT, recherche en caractères, pinyin ou français. |

### IA (optionnelle)
Avec une clé API Anthropic (Réglages), l'IA sert là où elle apporte vraiment quelque chose :
- choisir les **mots clés** d'une vidéo à pré-enseigner et leur **sens dans ce contexte** ;
- résumer et classer les vidéos par **thème** selon tes centres d'intérêt ;
- **corriger tes traductions** et phrases libres en expliquant l'erreur ;
- écrire des **histoires graduées** avec uniquement tes mots + quelques mots cibles ;
- analyser tes **confusions** (再/又, 的/得/地…) et générer des exercices ciblés ;
- expliquer une phrase précise d'une vidéo ; traduire les sous-titres ; **jeu de rôle**.

Sans clé, tout le reste fonctionne (algorithmes de couverture, quiz, correction par réponses attendues).

## Les termes clés de la méthode

| Terme | Signification |
|---|---|
| **SRS / FSRS** | *Spaced Repetition System* : chaque élément revient juste avant que tu l'oublies. FSRS est l'algorithme moderne (celui d'Anki), qui modélise ta mémoire carte par carte. |
| **Rappel actif** | Chercher la réponse dans sa mémoire avant de la voir (bien plus efficace que relire). |
| **Input compréhensible (i+1)** | Écouter/lire un contenu que tu comprends presque entièrement, avec un petit « +1 » de nouveauté (Krashen). |
| **Couverture lexicale** | Pourcentage des mots d'un contenu que tu connais. Vers 95-98 %, on comprend et on apprend en contexte ; en dessous de 90 %, c'est du bruit. |
| **Pré-enseignement** | Apprendre les mots-clés d'un contenu *avant* de l'écouter pour atteindre ~95 % de couverture. |
| **Écoute intensive / extensive** | Intensive : phrase par phrase, en détail. Extensive : beaucoup d'écoute en continu, sans s'arrêter. |
| **Shadowing** | Répéter l'audio en même temps (ou juste après) en imitant intonation et tons. |
| **Minage de phrases** | Extraire une phrase utile d'une vidéo et la transformer en carte de révision (avec l'audio d'origine). |
| **Paires minimales** | Deux mots qui ne diffèrent que par un son ou un ton (mǎi 买 « acheter » / mài 卖 « vendre »). |
| **Sandhi tonal** | Changement de ton au contact d'un autre (3e + 3e → 2e + 3e ; 不 et 一). |
| **Composants / radicaux** | Les briques qui forment les caractères (氵 l'eau, 口 la bouche…). Les connaître rend les caractères mémorisables. |
| **田字格** | Grille d'écriture chinoise (carré divisé en 4), pour placer les traits. |
| **HSK / ILR / CECR** | Échelles de niveau : HSK (examen chinois, 1-9), ILR (échelle du gouvernement US utilisée par la FSI/DLI), CECR (A1-C2). HSK 3 ≈ A2/B1. |
| **Palier de maîtrise** | On ne passe à la suite qu'après avoir prouvé la maîtrise (score ≥ seuil). |
| **FSI / DLI / DLPT** | Foreign Service Institute (diplomates), Defense Language Institute (militaires, renseignement), Defense Language Proficiency Test (test écoute + lecture). Il n'existe pas de « méthode CIA » secrète documentée : ce programme reprend les principes publics de ces écoles. |

## Sources des données (licences libres)
- **CFDICT** (chine.in, CC BY-SA) — dictionnaire chinois-français ; **CC-CEDICT** (CC BY-SA).
- **complete-hsk-vocabulary** (MIT) — listes HSK 2.0 et 3.0, fréquences.
- **Make Me a Hanzi** (Arphic Public License / LGPL) — tracés et décomposition des caractères ; animation via **Hanzi Writer** (MIT).
- **Tatoeba** (CC BY 2.0 FR) — phrases chinois-français.
- **Piper** (MIT) + voix zh_CN huayan — synthèse vocale locale ; **whisper.cpp** (MIT) — transcription locale ; **yt-dlp** (Unlicense) ; **ffmpeg** (GPL).
- Leçons de grammaire et catalogue de sources : rédigés pour ce projet.

## Développement

```bash
npm install
npm run fetch:bin      # télécharge yt-dlp, ffmpeg, whisper.cpp, piper + voix dans resources/bin
npm run build:data     # (re)construit resources/data depuis data-raw/
npm test               # tests (FSRS, planificateur sur 26 semaines simulées, couverture, IA simulée…)
npm start              # lance l'app en développement
npm run dist           # construit release/Operation-Mandarin-x.y.z-x86_64.AppImage
npm run programme      # régénère PROGRAMME.md
```
Architecture : voir [ARCHITECTURE.md](ARCHITECTURE.md).
