# Format des leçons de grammaire (content/grammar/phaseN.json)

Fichier = tableau JSON de points de grammaire, triés par ordre d'enseignement.

```jsonc
{
  "id": "p1-01",                 // "p<phase>-<nn>"
  "phase": 1,                    // 1, 2 ou 3
  "title": "La phrase de base avec 是",   // titre court en français
  "pattern": "A + 是 + B",        // structure (peut contenir plusieurs lignes séparées par \n)
  "hsk": 1,                      // niveau HSK indicatif
  "explanation": "...",          // cours en français, markdown simple (paragraphes, **gras**, listes "- ").
                                 // 150-400 mots. Clair, pédagogique, pièges courants pour un francophone.
                                 // PAS de pinyin dans l'explication (sauf si le point concerne la prononciation, ex: 一/不 tonal sandhi).
  "examples": [                  // 4 à 6 exemples
    { "zh": "我是学生。", "fr": "Je suis étudiant." }
  ],
  "exercises": [                 // 14 à 20 exercices, mélange de TOUS les types ci-dessous (au moins 2 de chaque type sauf "listen" ≥1)
    { "type": "order", "tokens": ["我", "是", "学生"], "answer": "我是学生", "fr": "Je suis étudiant." },
       // tokens = mots dans l'ordre CORRECT (l'app mélange). answer = concaténation sans ponctuation.
    { "type": "cloze", "zh": "我___学生。", "options": ["是", "在", "有", "很"], "answer": "是", "fr": "Je suis étudiant." },
       // exactement un "___" ; 3-4 options ; answer ∈ options
    { "type": "transform", "instruction": "Mets la phrase à la forme négative.", "zh": "我是老师。", "answers": ["我不是老师。"] },
       // answers = toutes les réponses acceptées (avec ponctuation finale chinoise)
    { "type": "error", "zh": "我不有书。", "answers": ["我没有书。"], "explanation": "On nie 有 avec 没, jamais avec 不." },
       // phrase fautive à corriger
    { "type": "translate", "fr": "Il n'est pas chinois.", "answers": ["他不是中国人。"] },
       // FR -> ZH ; lister plusieurs variantes acceptables
    { "type": "choice", "question": "Quelle phrase est correcte ?", "options": ["我是很高。", "我很高。", "我高是。"], "answer": 1, "explanation": "..." },
       // answer = index (0-based)
    { "type": "listen", "zh": "他是我的老师。", "question": "Qui est-il ?", "options": ["Mon professeur", "Mon frère", "Mon élève"], "answer": 0 }
       // l'app lit zh en audio (TTS) sans l'afficher
  ]
}
```

Règles :
- Caractères **simplifiés** uniquement. Ponctuation chinoise pleine chasse (。，？！).
- **Aucun pinyin** nulle part (sauf exception phonétique justifiée).
- Vocabulaire : uniquement des mots du niveau HSK correspondant à la phase ou inférieur (phase 1 ≈ HSK1, phase 2 ≈ HSK1-2, phase 3 ≈ HSK1-3), pour que l'apprenant connaisse les mots.
- Traductions françaises naturelles.
- Chaque exercice doit tester LE point de grammaire de la leçon (pas du vocabulaire au hasard).
- Phrases variées entre exercices (l'app les fait tourner en révision espacée : il faut beaucoup de phrases différentes).
- JSON strictement valide (pas de commentaires, pas de virgule finale).
