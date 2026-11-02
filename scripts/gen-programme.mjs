// Generates PROGRAMME.md: the 26-week day-by-day programme, from the real curriculum data.
import fs from 'node:fs';

const words = JSON.parse(fs.readFileSync('resources/data/words.json', 'utf8'));
const grammar = [1, 2, 3].flatMap((n) => {
  const f = `content/grammar/phase${n}.json`;
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [];
});
const catalog = JSON.parse(fs.readFileSync('content/catalog/catalog.json', 'utf8'));

const PHASES = [
  { n: 0, name: 'Phase 0 — Phonétique', weeks: [1, 2], words: 100, goal: 'Entendre et reproduire les 4 tons, lire le pinyin, connaître les traits de base et 100 mots de survie.' },
  { n: 1, name: 'Phase 1 — Fondations (≈ HSK 1)', weeks: [3, 8], words: 450, goal: 'Se présenter, compter, demander, acheter, parler de sa famille et de son quotidien au présent.' },
  { n: 2, name: 'Phase 2 — Consolidation (≈ HSK 2)', weeks: [9, 16], words: 1000, goal: 'Raconter au passé (了, 过), comparer, exprimer causes et conditions, suivre des histoires graduées.' },
  { n: 3, name: 'Phase 3 — Autonomie (≈ HSK 3)', weeks: [17, 24], words: 1500, goal: 'Suivre un dessin animé avec sous-titres chinois, un podcast lent, tenir une conversation de 10 minutes.' },
  { n: 4, name: 'Phase 4 — Évaluation', weeks: [25, 26], words: 1500, goal: 'Révision ciblée des points faibles, examen blanc HSK 3, bilan et plan de la suite.' },
];

function weekPhase(w) {
  return PHASES.find((p) => w >= p.weeks[0] && w <= p.weeks[1]);
}

// cumulative word targets per week (linear within each phase)
function targetAt(week) {
  const p = weekPhase(week);
  const prev = p.n === 0 ? 0 : PHASES[p.n - 1].words;
  const span = p.weeks[1] - p.weeks[0] + 1;
  return Math.round(prev + ((p.words - prev) * (week - p.weeks[0] + 1)) / span);
}

const sourcesFor = (phase) =>
  catalog.sources.filter((s) => s.verified && s.phases.includes(phase)).slice(0, 8);

let out = `# Opération Mandarin — Programme de 26 semaines

> Généré depuis les données de l'application (\`npm run programme\`). L'application adapte chaque jour ce programme
> au temps réel dont tu disposes (modes **Express / Standard / Marathon**) : ce document est la **trajectoire cible**.

## La méthode en une page

| Principe | D'où ça vient | Dans l'app |
|---|---|---|
| Volume + régularité | FSI (~2 200 h pour le mandarin) et DLI (64 semaines, ~7 h/jour) | Plan quotidien, série, heures d'écoute |
| Répétition espacée (FSRS) | Recherche sur la mémoire (effet d'espacement, rappel actif) | Mots, caractères, phrases **et règles de grammaire** |
| Input compréhensible (i+1) | Krashen ; couverture lexicale ≥ 95 % (Nation, Hu & Nation) | Couverture calculée pour chaque vidéo |
| Pré-enseignement du vocabulaire | Didactique de l'écoute | Briefing de mission 1-3 jours avant la vidéo |
| Imitation / répétition | « Army Method » (1943), Pimsleur | Shadowing + courbe des tons au micro |
| Tests réguliers | DLPT, HSK | Débriefing hebdo (85 % pour avancer à plein régime), examens blancs |
| Paliers de maîtrise | Mastery learning | Grammaire débloquée point par point (≥ 80 %) |

**Pinyin** : uniquement pour apprendre le son (phase 0, présentation d'un mot, exercices de tons, aide au clic). Jamais sur les cartes « caractère → sens » ni dans les traductions.
**Écriture** : sur papier — l'app donne la consigne de répétition, tu compares au modèle et tu t'auto-évalues (FSRS).

## Semaine type

| Jour | Temps (profil par défaut) | Contenu |
|---|---|---|
| Lundi → vendredi | 40-45 min | Révisions SRS (~15 min) · nouveaux mots (~6-8) · tons/shadowing (5-10 min) · écriture des nouveaux caractères · mission courte ou écoute |
| Mercredi | 45 min | + **séance de grammaire** (cours + exercices + révisions FSRS des règles) |
| Samedi | 2 h | Révisions · 15-20 nouveaux mots · **séance de grammaire** · **mission vidéo complète** (briefing → terrain → débriefing) · lecture |
| Dimanche | 2 h | Révisions · **débriefing hebdo (test)** · **séance d'écriture longue** (caractères, mots, phrases, dictée) · rattrapage |

Jour sans temps → **Express** (15-20 min : seulement les révisions les plus urgentes, zéro nouveauté).
Jour avec beaucoup de temps → **Marathon** (leçons, missions et séances bonus tant que la charge future reste tenable).
Jours manqués → **rattrapage automatique** (arriéré étalé par ordre d'urgence, nouveautés suspendues le temps de résorber).

`;

let gi = 0;
let wi = 0;
for (const ph of PHASES) {
  out += `\n## ${ph.name} — semaines ${ph.weeks[0]} à ${ph.weeks[1]}\n\n**Objectif** : ${ph.goal}\n\n`;
  if (ph.n >= 0 && ph.n <= 3) {
    const src = sourcesFor(Math.max(0, ph.n));
    if (src.length) {
      out += `**Sources d'écoute de la phase** : ${src.map((s) => `[${s.name}](${s.url})`).join(' · ')}\n\n`;
    }
  }
  for (let w = ph.weeks[0]; w <= ph.weeks[1]; w++) {
    const target = targetAt(w);
    const newWords = words.slice(wi, target);
    wi = Math.max(wi, target);
    const perWeek = ph.n === 0 ? 1 : ph.n === 4 ? 0 : 4;
    const pts = [];
    if (ph.n >= 1 && ph.n <= 3) {
      const phasePts = grammar.filter((g) => g.phase === ph.n);
      const startIdx = grammar.indexOf(phasePts[0]);
      const weeksInPhase = ph.weeks[1] - ph.weeks[0] + 1;
      const k = w - ph.weeks[0];
      const per = Math.ceil(phasePts.length / weeksInPhase);
      for (let j = k * per; j < Math.min(phasePts.length, (k + 1) * per); j++) pts.push(grammar[startIdx + j]);
    } else if (ph.n === 0 && w === 2) pts.push(...grammar.slice(0, 2));
    void perWeek;
    gi += pts.length;
    out += `### Semaine ${w} — objectif cumulé : ${target} mots\n\n`;
    if (newWords.length)
      out += `- **Vocabulaire** (${newWords.length} mots, extrait) : ${newWords.slice(0, 18).map((x) => `${x.w} (${x.fr[0]})`).join(', ')}${newWords.length > 18 ? '…' : ''}\n`;
    if (pts.length) out += `- **Grammaire** : ${pts.map((p) => `${p.title} — \`${p.pattern.split('\n')[0]}\``).join(' ; ')}\n`;
    if (ph.n === 0)
      out += `- **Tons & pinyin** : ${w === 1 ? 'les 4 tons + ton neutre, initiales difficiles (zh ch sh r, j q x), finales -n/-ng, ü' : 'paires de tons (20 combinaisons), sandhi du 3e ton, 不 et 一 ; shadowing de phrases simples'}\n- **Écriture** : traits de base (横 竖 撇 捺 点 折), règles d'ordre des traits, premiers caractères\n`;
    if (ph.n >= 1 && ph.n <= 3)
      out += `- **Missions** : ${ph.n === 1 ? '2' : '3'} vidéos/podcasts de la phase (pré-enseignement : 10-25 mots par vidéo), dont 1 longue le samedi\n- **Oral** : shadowing de phrases connues ; ${ph.n >= 2 ? 'jeu de rôle (si IA) 1×/semaine' : 'répétition à voix haute de chaque nouveau mot'}\n`;
    if (ph.n === 4)
      out += w === 25
        ? `- Révision ciblée : l'app propose les mots et règles les plus faibles (taux d'oubli FSRS) ; lecture et écoute extensives\n- Examen blanc HSK 3 (écoute, lecture, grammaire) en fin de semaine\n`
        : `- Rattrapage des points faibles de l'examen blanc · 2e examen blanc · bilan des capacités · plan des 6 mois suivants (HSK 4)\n`;
    out += `- **Dimanche** : test hebdomadaire (≥ 85 % pour garder le rythme plein ; sinon semaine de consolidation)\n\n`;
  }
}

out += `\n## Détail d'une journée Standard (exemple semaine 5, mardi, 45 min)\n
1. **Révisions SRS** (15 min) — audio → sens, caractère → sens, phrases minées ; note honnête 1-4.
2. **Nouveaux mots** (8 min) — 6 mots : présentation (pinyin affiché une fois + audio + composants), répétition à voix haute, vérification sans pinyin.
3. **Écriture papier** (7 min) — chaque nouveau caractère : observer → 8 copies → 3 de mémoire → comparer → auto-évaluation.
4. **Tons** (5 min) — paires de tons sur tes mots ; shadowing de 3 phrases.
5. **Mission courte** (10 min) — vidéo du jour déjà pré-enseignée : écoute globale, puis phrase par phrase, minage de 2 phrases.

## Détail d'une mission vidéo

1. **J-3 à J-1 — Briefing** : l'app a calculé la couverture lexicale de la vidéo et sélectionné les mots à apprendre pour atteindre ~95 %. Ils arrivent dans tes nouveaux mots des jours précédents (avec l'IA : le sens *dans ce contexte* et les mots clés de l'intrigue).
2. **Jour J — Terrain** : passe 1 sans sous-titres (sens global) ; passe 2 intensive phrase par phrase (sous-titres chinois, clic sur un mot pour l'aide, boucle, vitesse 0,75, shadowing avec courbe des tons) ; minage des phrases utiles vers le SRS.
3. **Débriefing** : quiz de compréhension, auto-évaluation ; la vidéo rejoint ta file d'**écoute extensive** (réécoutes en fond, export audio).
`;

fs.writeFileSync('PROGRAMME.md', out);
console.log('PROGRAMME.md written', out.length, 'chars;', gi, 'grammar points scheduled;', wi, 'words');
