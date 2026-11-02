// Types of the video / mission module shared between main and renderer (additive to shared/types.ts).
import type { CoverageReport, Mission, PreteachWord, Token, VideoRow } from './types';

export type MediaKind = 'youtube' | 'local' | 'rss' | 'other';

/** VideoRow enriched with derived information for the UI. */
export interface VideoInfo extends VideoRow {
  kind: MediaKind;
  segCount: number;
  hasFile: boolean;
  audioOnly: boolean;
  preteachCount: number | null; // mots à pré-enseigner pour atteindre 95 %
  projected3: number | null; // couverture projetée à J+3
  readyInDays: number | null; // jours avant ≥ 90 % de couverture projetée
  mission: { id: string; status: Mission['status']; planned_date: string } | null;
}

export interface SegTok extends Token {
  py?: string; // pinyin (uniquement pour les mots non connus, pour le ruby optionnel)
}

export interface PlayerSegment {
  idx: number;
  start: number;
  end: number;
  text: string;
  tokens: SegTok[];
  fr: string | null;
}

export interface MediaProgress {
  id: string; // video id, or `model:<size>`
  pct: number; // 0-100 (-1 = indéterminé)
  stage: 'meta' | 'subs' | 'download' | 'convert' | 'transcribe' | 'model' | 'export' | 'scan' | 'done' | 'error';
  message?: string;
}

export interface MediaPrefs {
  cookiesBrowser: '' | 'firefox' | 'chrome' | 'chromium' | 'brave' | 'edge' | 'vivaldi' | 'opera';
  whisperModel: 'base' | 'small';
  autoDownload: boolean; // télécharger la vidéo dès la préparation de mission
}

export interface BinStatus {
  ytdlp: string | null; // version, null si absent
  ffmpeg: boolean;
  whisper: boolean;
  models: { base: boolean; small: boolean };
}

/** CoverageReport (contrat `media:coverage`) + projection jour par jour. */
export interface CoverageInfo extends CoverageReport {
  projected: { days: number; coverage: number }[]; // J+0..J+N
  readyInDays: number | null; // jours avant ≥ 90 % (curriculum ou briefing de mission)
}

export interface RecItem {
  key: string; // video id or url
  video: VideoInfo | null; // null = vidéo du catalogue pas encore ajoutée
  url: string;
  title: string;
  sourceId: string | null;
  sourceName: string | null;
  durationSec: number | null;
  thumbnail: string | null;
  themes: string[];
  coverage: number | null;
  projected3: number | null;
  readyInDays: number | null;
  preteachCount: number | null;
  score: number;
  reasons: string[];
}

export interface MissionDetail {
  mission: Mission;
  video: VideoInfo;
  words: (PreteachWord & { introduced: boolean; current: 'known' | 'learning' | 'new' | 'ignored' })[];
  remaining: number; // mots pas encore introduits
  coverageNow: number | null;
}

export interface RssEpisode {
  guid: string;
  title: string;
  url: string; // enclosure
  duration: number; // secondes (0 = inconnu)
  pubDate: number; // epoch ms (0 = inconnu)
  image: string | null;
  description: string;
}

export interface QuizQuestion {
  question: string;
  options: string[];
  answer: number;
  explanation?: string;
  zh?: string; // phrase/mot affiché
  audio?: { path: string; start: number; end: number };
}
