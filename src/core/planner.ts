// Adaptive daily planner: fills the time available with activities in priority order,
// throttles new material from the FSRS review forecast, and switches to catch-up mode after missed days.
import type { BlockType, DayMode, DayPlan, PlanBlock } from '../shared/types';

export interface PlannerInput {
  date: string;
  mode: DayMode;
  weekdayMinutes: number; // temps prévu ce jour-là dans le profil
  avgDailyMinutes: number; // moyenne du profil sur la semaine
  dueMain: number; // révisions dues (mots + phrases)
  freshMain?: number; // cartes nouvelles jamais révisées (mots juste introduits, cartes de production) — mots + phrases
  freshIntroducedToday?: number; // parmi elles, cartes des mots introduits aujourd'hui (défaut : 2 × introducedToday)
  overdueMain: number; // en retard de plus d'un jour
  dueGrammar: number;
  dueWriting: number;
  forecastMain: number[]; // révisions prévues pour les 7 prochains jours (0 = aujourd'hui)
  secPerReview: number;
  newTarget: number; // mots nouveaux visés un jour standard
  phase: number;
  week: number;
  isGrammarDay: boolean;
  isWritingDay: boolean;
  isTestDay: boolean;
  testDoneThisWeek: boolean;
  testable?: number; // mots introduits (un test hebdo n'a de sens qu'à partir de MIN_TESTABLE_WORDS)
  consolidation: boolean;
  missionReady: boolean; // une mission dont le briefing est terminé
  missionTitle?: string;
  missionId?: string; // mission concernée par le briefing / le terrain
  briefingPending: number; // mots de la prochaine mission pas encore introduits
  nextGrammarTitle?: string;
  introducedToday: number;
  newCharsToday: number;
  done: BlockType[];
}

/** Each new word generates on average ~0.35 min/day of extra reviews over the following weeks (2 cards). */
const REVIEW_MIN_PER_NEW_WORD_PER_DAY = 0.35;
const MIN_PER_NEW_WORD = 1.2; // présentation + première vérification
const MIN_PER_GRAMMAR_REVIEW = 1.5;
const MIN_PER_WRITING_CARD = 1.0;
/** Below this many introduced words, a weekly test has nothing meaningful to test. */
export const MIN_TESTABLE_WORDS = 20;

export function planDay(i: PlannerInput): DayPlan {
  const notes: string[] = [];
  const reviewMin = (n: number) => Math.ceil((n * i.secPerReview) / 60);

  let budget: number;
  if (i.mode === 'express') budget = Math.min(20, Math.max(10, i.weekdayMinutes));
  else if (i.mode === 'marathon') budget = Math.max(120, i.weekdayMinutes * 2);
  else budget = Math.max(15, i.weekdayMinutes);

  // ---- Catch-up (recovery) detection ----
  const typicalDaily = Math.max(10, Math.round(i.forecastMain.slice(1).reduce((a, b) => a + b, 0) / Math.max(1, i.forecastMain.length - 1)));
  const reviewShare = i.mode === 'express' ? 0.75 : 0.6;
  const reviewCapacity = Math.floor((budget * reviewShare * 60) / i.secPerReview);
  const recoveryActive = i.overdueMain > typicalDaily * 0.5 && i.dueMain > reviewCapacity;
  let reviewsToday = Math.min(i.dueMain, reviewCapacity);
  let daysToClear = 0;
  const backlog = Math.max(0, i.dueMain - reviewsToday);
  if (recoveryActive) {
    const avgCapacity = Math.floor((i.avgDailyMinutes * 0.6 * 60) / i.secPerReview);
    const spare = Math.max(5, avgCapacity - typicalDaily);
    daysToClear = Math.ceil(backlog / spare);
    notes.push(
      `Mode rattrapage : ${i.dueMain} révisions en attente. On en fait ${reviewsToday} aujourd'hui (les plus à risque d'oubli d'abord), le reste est étalé sur ~${daysToClear} jour(s). Pas de nouveaux mots tant que le retard n'est pas résorbé.`,
    );
  }

  // ---- New-word cap from the load forecast ----
  let newCap = 0;
  if (i.mode !== 'express' && !recoveryActive) {
    const forecastAvgMin = reviewMin(typicalDaily);
    const comfortable = i.avgDailyMinutes * 0.45; // part du temps quotidien qu'on accepte pour les révisions
    const headroom = comfortable - forecastAvgMin;
    // nouveaux mots soutenables durablement avec cette marge
    const sustainable = Math.max(0, Math.floor(headroom / REVIEW_MIN_PER_NEW_WORD_PER_DAY / 3));
    let base = Math.min(i.newTarget, Math.max(Math.ceil(i.newTarget * 0.3), sustainable));
    if (headroom <= 0) {
      base = Math.ceil(i.newTarget * 0.3);
      notes.push('Charge de révisions élevée : nouveaux mots réduits pour garder un rythme tenable.');
    }
    // Les jours où l'on a plus de temps absorbent plus de nouveautés (et inversement).
    const ratio = i.weekdayMinutes / Math.max(15, i.avgDailyMinutes);
    newCap = Math.round(base * Math.min(1.6, Math.max(0.5, ratio)));
    if (i.mode === 'marathon') newCap = Math.round(newCap * 1.5);
    if (i.consolidation) {
      newCap = Math.ceil(newCap / 2);
      notes.push('Semaine de consolidation : le dernier test hebdo est sous 85 %, on ralentit les nouveautés et on refait le test.');
    }
    if (i.phase === 0) newCap = Math.min(newCap, 8);
  }
  newCap = Math.max(0, newCap - i.introducedToday);

  // ---- New (never reviewed) cards served by the review block ----
  // Words introduced today (meaning + listen) always get their first review today; other waiting new
  // cards (e.g. production cards) fill the spare review capacity. Express days take only today's.
  // study:queue reserves the same cards (Curriculum.freshIntroducedToday), so the session matches this count.
  const todaysFresh = Math.min(i.freshMain ?? 0, i.freshIntroducedToday ?? 2 * i.introducedToday);
  const freshRoom = i.mode === 'express' ? todaysFresh : Math.max(0, reviewCapacity - reviewsToday) + todaysFresh;
  const freshToday = Math.min(i.freshMain ?? 0, freshRoom);
  const reviewBlockCount = reviewsToday + freshToday;

  // ---- Weekly test: only when there is something to test ----
  const testDue = i.isTestDay && !i.testDoneThisWeek && i.week >= 1 && (i.testable ?? Infinity) >= MIN_TESTABLE_WORDS;

  // ---- Build blocks by priority ----
  const blocks: PlanBlock[] = [];
  let left = budget;
  const add = (b: Omit<PlanBlock, 'done'>, force = false) => {
    const done = i.done.includes(b.type);
    if (!force && !done && b.minutes > left && !b.optional) {
      blocks.push({ ...b, optional: true, done });
      return;
    }
    blocks.push({ ...b, done });
    if (!done) left -= b.minutes;
  };

  if (reviewBlockCount > 0 || i.done.includes('reviews')) {
    const freshNote = freshToday > 0 ? ` + ${freshToday} nouvelle(s) carte(s) à voir pour la première fois.` : '';
    add(
      {
        type: 'reviews',
        title: i.mode === 'express' ? 'Révisions critiques' : 'Révisions SRS',
        detail: (i.mode === 'express' ? 'Les cartes les plus proches de l\'oubli, rien d\'autre.' : 'Mots et phrases dus aujourd\'hui (audio → sens, caractères → sens).') + freshNote,
        minutes: Math.max(2, reviewMin(reviewBlockCount)),
        count: reviewBlockCount,
      },
      true,
    );
  }
  if (recoveryActive) {
    blocks.push({ type: 'catchup', title: 'Rattrapage', detail: notes[0], minutes: 0, done: false, count: backlog });
  }

  if (i.mode === 'express') {
    add({ type: 'listening', title: 'Écoute rapide', detail: 'Réécoute 5 min d\'un audio déjà travaillé (shadowing si possible).', minutes: 5 });
    if (i.dueGrammar > 0)
      add({ type: 'grammar', title: 'Grammaire (révision)', detail: `${i.dueGrammar} point(s) à réviser`, minutes: Math.min(6, i.dueGrammar * MIN_PER_GRAMMAR_REVIEW), count: i.dueGrammar, optional: true, payload: { reviewsOnly: true } });
    notes.push('Jour Express : aucune nouveauté, le système reste stable. Les nouveautés se rattrapent les jours où tu as plus de temps.');
  } else {
    if (testDue) {
      add({ type: 'test', title: 'Débriefing hebdo — test', detail: 'Écoute, lecture et grammaire de la semaine. 85 % requis pour avancer à plein régime.', minutes: 20 });
    }
    const briefingCount = Math.min(i.briefingPending, newCap);
    if (briefingCount > 0) {
      add({
        type: 'briefing',
        title: 'Briefing de mission',
        detail: `${briefingCount} mot(s) de la prochaine vidéo à apprendre avant de la regarder.`,
        minutes: Math.ceil(briefingCount * MIN_PER_NEW_WORD),
        count: briefingCount,
        payload: i.missionId ? { missionId: i.missionId } : undefined,
      });
    }
    const curriculumNew = Math.max(0, newCap - briefingCount);
    if (curriculumNew > 0 && !testDue) {
      add({
        type: 'new',
        title: 'Nouveaux mots',
        detail: `${curriculumNew} mot(s) du cursus (ordre HSK + fréquence), avec leurs caractères.`,
        minutes: Math.ceil(curriculumNew * MIN_PER_NEW_WORD),
        count: curriculumNew,
      });
    }
    if (i.isGrammarDay || i.mode === 'marathon') {
      add({
        type: 'grammar',
        title: 'Séance de grammaire',
        detail: (i.nextGrammarTitle ? `Nouveau point : ${i.nextGrammarTitle}. ` : '') + (i.dueGrammar ? `${i.dueGrammar} point(s) à réviser.` : ''),
        minutes: (i.nextGrammarTitle ? 25 : 0) + Math.ceil(i.dueGrammar * MIN_PER_GRAMMAR_REVIEW) || 10,
        count: i.dueGrammar,
      });
    } else if (i.dueGrammar > 0) {
      add({ type: 'grammar', title: 'Grammaire (révision)', detail: `${i.dueGrammar} point(s) à réviser`, minutes: Math.ceil(i.dueGrammar * MIN_PER_GRAMMAR_REVIEW), count: i.dueGrammar, payload: { reviewsOnly: true } });
    }
    if (i.phase <= 1) add({ type: 'tones', title: 'Tons et prononciation', detail: 'Paires de tons, paires minimales, shadowing avec courbe de hauteur.', minutes: 10 });
    else add({ type: 'tones', title: 'Shadowing', detail: 'Répète des phrases connues et compare ta courbe de tons.', minutes: 5, optional: i.mode !== 'marathon', payload: { tab: 'shadow' } });
    if (i.missionReady)
      add({ type: 'mission', title: 'Mission terrain', detail: `${i.missionTitle ?? 'Vidéo du jour'} : écoute globale, puis phrase par phrase, puis débriefing.`, minutes: 25, payload: i.missionId ? { missionId: i.missionId } : undefined });
    const writeCards = i.dueWriting + i.newCharsToday;
    if (i.isWritingDay)
      add({ type: 'writing', title: 'Séance d\'écriture (papier)', detail: `Caractères dus + phrases à recopier et à écrire de mémoire, dictée.`, minutes: 25, count: writeCards });
    else if (writeCards > 0)
      add({ type: 'writing', title: 'Écriture (papier)', detail: `${writeCards} caractère(s) : copier, écrire de mémoire, comparer.`, minutes: Math.min(15, Math.ceil(writeCards * MIN_PER_WRITING_CARD)), count: writeCards });
    add({ type: 'listening', title: 'Écoute extensive', detail: 'Audio déjà travaillé en fond (trajets, ménage…).', minutes: 10, optional: true });
  }

  if (left > 0 && i.mode === 'marathon') {
    notes.push('Mode Marathon : une fois le plan terminé, le bouton « Continuer » propose des leçons, missions et séances supplémentaires tant que la charge future reste tenable.');
  }

  return {
    date: i.date,
    mode: i.mode,
    budgetMinutes: budget,
    phase: i.phase,
    week: i.week,
    blocks,
    recovery: { active: recoveryActive, backlog, daysToClear },
    newCap,
    dueCount: i.dueMain,
    forecast: i.forecastMain,
    notes,
  };
}

/** How many extra new words a marathon "continue" can add without making future days unsustainable. */
export function extraNewAllowance(i: Pick<PlannerInput, 'forecastMain' | 'avgDailyMinutes' | 'secPerReview'>): number {
  const typical = i.forecastMain.slice(1).reduce((a, b) => a + b, 0) / Math.max(1, i.forecastMain.length - 1);
  const forecastMin = (typical * i.secPerReview) / 60;
  const headroom = i.avgDailyMinutes * 0.55 - forecastMin;
  return Math.max(0, Math.floor(headroom / REVIEW_MIN_PER_NEW_WORD_PER_DAY / 2));
}
