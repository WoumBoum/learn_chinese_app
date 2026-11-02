// Types shared between main process and renderer.

export interface Word {
  w: string; // simplified characters
  py: string; // pinyin with tone marks
  pn: string; // numeric pinyin
  fr: string[]; // French glosses
  en: string[];
  band: number; // HSK 3.0 band (9 = none)
  old: number; // HSK 2.0 level (9 = none)
  freq: number;
  pos: string[];
  cl: string[];
  rank: number; // position in learning order
}

export interface CharInfo {
  c: string;
  i: number; // order of first appearance in curriculum
  py: string[];
  fr: string[];
  en: string;
  dec: string; // ideographic description (decomposition)
  rad: string;
  ety: { type?: string; hint?: string; semantic?: string; phonetic?: string } | null;
  n: number; // stroke count
}

export interface Sentence {
  id: number;
  zh: string;
  fr: string[];
  a: number; // has Tatoeba native audio
}

/** Card kinds and faces.
 *  word:meaning  — 汉字 → sens (pas de pinyin)
 *  word:listen   — audio → sens
 *  word:recall   — français → produire le mot (à l'oral / sur papier)
 *  char:write    — sens + son → écrire le caractère sur papier
 *  grammar:rule  — exercices tirés au hasard d'un point de grammaire
 *  sentence:listen — phrase minée d'une vidéo : audio → compréhension
 */
export type CardKind = 'word' | 'char' | 'grammar' | 'sentence';
export type CardFace = 'meaning' | 'listen' | 'recall' | 'write' | 'rule';

export interface CardRow {
  id: string; // `${kind}:${face}:${ref}`
  kind: CardKind;
  face: CardFace;
  ref: string;
  due: number; // epoch ms
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: number; // 0 new, 1 learning, 2 review, 3 relearning
  last_review: number | null;
  created: number;
  suspended: number;
}

export type Grade = 1 | 2 | 3 | 4; // Again Hard Good Easy

export type DayMode = 'express' | 'standard' | 'marathon';

export interface Availability {
  // minutes per weekday, index 0 = dimanche (JS getDay())
  minutes: [number, number, number, number, number, number, number];
}

export interface Settings {
  onboarded: boolean;
  startDate: string; // YYYY-MM-DD
  availability: Availability;
  newWordsPerDay: number; // cible quotidienne (jour standard)
  grammarDays: number[]; // jours de la semaine avec séance de grammaire
  writingDay: number; // jour de la séance d'écriture longue
  testDay: number; // jour du débriefing hebdo
  interests: string[];
  apiKey: string;
  aiModel: string;
  desiredRetention: number;
  pinyinOnUnknownInPlayer: boolean;
  goalWords: number;
  goalDate: string;
}

export type BlockType =
  | 'reviews'
  | 'briefing'
  | 'new'
  | 'grammar'
  | 'tones'
  | 'mission'
  | 'writing'
  | 'listening'
  | 'test'
  | 'catchup';

export interface PlanBlock {
  type: BlockType;
  title: string;
  detail: string;
  minutes: number;
  count?: number; // nombre d'éléments (cartes, mots…)
  done: boolean;
  optional?: boolean;
  payload?: Record<string, unknown>;
}

export interface DayPlan {
  date: string;
  mode: DayMode;
  budgetMinutes: number;
  phase: number;
  week: number;
  blocks: PlanBlock[];
  recovery: { active: boolean; backlog: number; daysToClear: number };
  newCap: number;
  dueCount: number;
  forecast: number[]; // révisions prévues sur 7 jours
  notes: string[];
}

export interface Progress {
  wordsKnown: number;
  wordsLearning: number;
  wordsIntroduced: number;
  charsKnown: number;
  charsIntroduced: number;
  grammarMastered: number;
  grammarStarted: number;
  grammarTotal: number;
  listeningMinutes: number;
  studyMinutes: number;
  streak: number;
  reviewsTotal: number;
  retention30d: number | null;
  phase: number;
  phaseName: string;
  week: number;
  projectedGoalDate: string | null;
  goalWords: number;
  heatmap: { date: string; minutes: number; reviews: number }[];
  weeklyTests: { week: number; score: number; passed: boolean; date: string }[];
  canDo: { text: string; ok: boolean }[];
}

export interface StudyCard {
  card: CardRow;
  word?: Word;
  char?: CharInfo;
  sentence?: { zh: string; fr: string; videoPath?: string; start?: number; end?: number; audio?: string };
  grammarId?: string;
  intervals?: Record<Grade, string>; // aperçu des prochains intervalles
}

// ---------- Grammar content ----------
export type GrammarExercise =
  | { type: 'order'; tokens: string[]; answer: string; fr: string }
  | { type: 'cloze'; zh: string; options: string[]; answer: string; fr: string }
  | { type: 'transform'; instruction: string; zh: string; answers: string[] }
  | { type: 'error'; zh: string; answers: string[]; explanation: string }
  | { type: 'translate'; fr: string; answers: string[] }
  | { type: 'choice'; question: string; options: string[]; answer: number; explanation?: string }
  | { type: 'listen'; zh: string; question: string; options: string[]; answer: number };

export interface GrammarPoint {
  id: string;
  phase: number;
  title: string;
  pattern: string;
  hsk: number;
  explanation: string;
  examples: { zh: string; fr: string }[];
  exercises: GrammarExercise[];
}

export interface GrammarStatus {
  id: string;
  title: string;
  phase: number;
  pattern: string;
  state: 'locked' | 'available' | 'learning' | 'mastered';
  lessonDone: boolean;
  bestScore: number | null;
  due: boolean;
}

// ---------- Video / missions ----------
export interface Segment {
  idx: number;
  start: number;
  end: number;
  text: string;
  tokens: Token[];
  fr?: string;
}

export interface Token {
  t: string; // surface
  han: boolean; // contient des caractères chinois
  status?: 'known' | 'learning' | 'new' | 'ignored';
}

export interface VideoRow {
  id: string;
  url: string;
  title: string;
  source_id: string | null;
  duration: number;
  path: string | null;
  status: 'listed' | 'subs' | 'downloading' | 'ready' | 'transcribing' | 'error';
  error: string | null;
  added_at: number;
  coverage: number | null; // couverture actuelle
  projected_coverage: number | null;
  themes: string[];
  summary: string | null;
  thumbnail: string | null;
  subs_source: 'cc' | 'auto' | 'whisper' | null;
  watched: number;
}

export interface PreteachWord {
  w: string;
  count: number;
  fr: string[];
  py: string;
  status: 'new' | 'learning';
  contextFr?: string; // sens dans ce contexte (IA)
  key?: boolean; // mot clé pour l'intrigue (IA)
}

export interface CoverageReport {
  totalTokens: number;
  uniqueWords: number;
  knownTokens: number;
  learningTokens: number;
  coverage: number; // known+learning / total
  coverageKnownOnly: number;
  afterPreteach: number;
  preteach: PreteachWord[];
}

export interface Mission {
  id: string;
  video_id: string;
  planned_date: string;
  status: 'planned' | 'briefing' | 'ready' | 'done';
  preteach: PreteachWord[];
  created: number;
  completed_at: number | null;
  comprehension: number | null;
}

export interface CatalogSource {
  id: string;
  name: string;
  kind: string;
  url: string;
  phases: number[];
  levelMin: number;
  levelMax: number;
  type: string;
  themes: string[];
  hasChineseSubs: string;
  notes: string;
  verified: boolean;
}
