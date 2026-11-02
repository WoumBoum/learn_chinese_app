// AI service (optional): Claude via @anthropic-ai/sdk. No Electron import → testable with a fake client.
// Every public method throws Error('IA non configurée') when no API key is set.
import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import type { Db } from '../../core/db';
import type { Content } from '../../core/content';
import type { Curriculum } from '../../core/curriculum';
import { analyseCoverage } from '../../core/coverage';
import { isHan, normZh, segment } from '../../core/nlp';
import { DAY_MS } from '../../core/time';
import type { PreteachWord, Settings, Token } from '../../shared/types';
import { validateAiPick } from '../../core/wordVideos';

// ---------------------------------------------------------------- LLM client abstraction
export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}
export interface LlmRequest {
  model: string;
  system: string;
  messages: LlmMessage[];
  maxTokens: number;
  effort?: 'low' | 'medium' | 'high';
}
export interface LlmResponse {
  text: string;
  truncated?: boolean;
}
export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export const AI_MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'] as const;
export const DEFAULT_MODEL = 'claude-sonnet-5-5';

/** Translate SDK errors into actionable French messages. */
export function describeApiError(e: unknown, model: string): Error {
  if (e instanceof Anthropic.AuthenticationError) return new Error('Clé API invalide ou révoquée (401). Vérifie-la dans les Réglages.');
  if (e instanceof Anthropic.PermissionDeniedError) return new Error("Cette clé API n'a pas accès à ce modèle (403).");
  if (e instanceof Anthropic.NotFoundError) return new Error(`Modèle introuvable : « ${model} ». Choisis-en un autre dans les Réglages.`);
  if (e instanceof Anthropic.RateLimitError) return new Error('Limite de requêtes atteinte (429). Réessaie dans une minute.');
  if (e instanceof Anthropic.BadRequestError) return new Error(`Requête refusée par l'API (400) : ${e.message}`);
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new Error("Délai dépassé en contactant l'API Anthropic.");
  if (e instanceof Anthropic.APIConnectionError) return new Error('Impossible de joindre api.anthropic.com (connexion réseau ?).');
  if (e instanceof Anthropic.APIError) {
    if (e.status === 529 || (e.status ?? 0) >= 500) return new Error(`Service IA momentanément indisponible (${e.status}). Réessaie plus tard.`);
    return new Error(`Erreur API ${e.status ?? ''} : ${e.message}`);
  }
  return e instanceof Error ? e : new Error(String(e));
}

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). Haiku has none. */
const FALLBACK_MODELS = /^claude-(opus-5-5|opus-5|sonnet-5-5|fable-5-1)$/;

/** Real client. Uses server-side refusal fallbacks on the models that support them. */
export function anthropicClient(apiKey: string): LlmClient {
  const client = new Anthropic({ apiKey, timeout: 180_000, maxRetries: 2 });
  return {
    async complete(req) {
      try {
        const base = {
          model: req.model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: req.messages,
          output_config: { effort: req.effort ?? 'low' },
        };
        const r = FALLBACK_MODELS.test(req.model)
          ? await client.beta.messages.create({ ...base, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
          : await client.beta.messages.create(base);
        if (r.stop_reason === 'refusal') throw new Error("Le modèle a refusé cette demande. Reformule ou réessaie.");
        const text = r.content
          .map((b) => (b.type === 'text' ? b.text : ''))
          .join('')
          .trim();
        return { text, truncated: r.stop_reason === 'max_tokens' };
      } catch (e) {
        throw describeApiError(e, req.model);
      }
    },
  };
}

// ---------------------------------------------------------------- JSON helpers (pure)
/** Extract the first complete JSON object/array from a model answer (tolerates ``` fences and prose). */
export function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = fence ? [fence[1], text] : [text];
  for (const src of candidates) {
    for (let start = 0; start < src.length; start++) {
      const ch = src[start];
      if (ch !== '{' && ch !== '[') continue;
      const end = matchBracket(src, start);
      if (end < 0) continue;
      try {
        return JSON.parse(src.slice(start, end + 1));
      } catch {
        // try a later opening bracket
      }
    }
  }
  throw new Error('Aucun JSON valide dans la réponse');
}

function matchBracket(s: string, start: number): number {
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

const str = (x: unknown): string => (typeof x === 'string' ? x.trim() : '');
const strArr = (x: unknown): string[] => (Array.isArray(x) ? x.map(str).filter(Boolean) : []);
const obj = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {});

/** Throwing validator helper: validators return the typed value or throw an Error explaining what is wrong. */
function need(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

export function hashKey(parts: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function shuffleWithAnswer(options: string[], answer: number, rnd = Math.random): { options: string[]; answer: number } {
  const idx = options.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return { options: idx.map((i) => options[i]), answer: idx.indexOf(answer) };
}

// ---------------------------------------------------------------- coverage of generated text (pure)
/** True if `w` is known or can be fully decomposed into known words (greedy longest match, ≤ 4 chars). */
export function decomposable(w: string, known: Set<string>): boolean {
  if (known.has(w)) return true;
  let i = 0;
  while (i < w.length) {
    let j = Math.min(w.length, i + 4);
    while (j > i && !known.has(w.slice(i, j))) j--;
    if (j === i) return false;
    i = j;
  }
  return true;
}

export interface TextCoverage {
  total: number;
  covered: number;
  coverage: number;
  unknown: string[]; // unknown words (not known, not targets)
  targetsUsed: string[];
}

/** Coverage of a text. `isLexical(w)` = w is a real dictionary word of the curriculum (e.g. 东西): such a word is
 *  NOT considered known just because its characters are (东 + 西 ≠ « chose »). Free combinations (我们的, 很好) are. */
export function textCoverage(tokens: Token[], known: Set<string>, targets: Set<string>, isLexical: (w: string) => boolean = () => false): TextCoverage {
  let total = 0;
  let covered = 0;
  const unknown = new Set<string>();
  const used = new Set<string>();
  const both = new Set([...known, ...targets]);
  for (const t of tokens) {
    if (!t.han) continue;
    total++;
    if (targets.has(t.t)) {
      used.add(t.t);
      covered++;
    } else if (known.has(t.t) || (!isLexical(t.t) && decomposable(t.t, known))) covered++;
    else if (!isLexical(t.t) && decomposable(t.t, both)) {
      covered++;
      for (const tw of targets) if (t.t.includes(tw)) used.add(tw);
    } else unknown.add(t.t);
  }
  return { total, covered, coverage: total ? covered / total : 1, unknown: [...unknown], targetsUsed: [...used] };
}

// ---------------------------------------------------------------- domain types
export const THEMES = [
  'vie quotidienne',
  'nourriture',
  'voyage',
  'famille',
  'école',
  'travail',
  'culture',
  'histoire',
  'technologie',
  'sport',
  'humour',
  'enfants/dessin animé',
  'nature',
  'santé',
  'sentiments',
  'société',
  'musique',
  'cinéma',
  'jeux vidéo',
  'business',
  'achats',
  'transports',
  'fêtes et traditions',
] as const;

export interface QuizQuestion {
  question: string;
  options: string[];
  answer: number;
  lineIdx: number;
}
export interface Correction {
  correct: boolean;
  corrected: string;
  explanation: string;
}
export interface StoryResult {
  id: string;
  title: string;
  zh: string;
  fr: string;
  theme: string | null;
  targetWords: { w: string; py: string; fr: string[] }[];
  coverage: number;
  unknownWords: string[];
  attempts: number;
}
export interface RoleplayScenario {
  id?: string;
  title: string;
  setting: string; // décor, en français
  character: string; // personnage joué par l'IA
  goal: string; // objectif de l'agent
}
export interface RoleplayTurn {
  role: 'user' | 'assistant';
  zh: string;
}
export interface RoleplayReply {
  reply: string;
  fr: string;
  corrections: { yourText: string; better: string; explanation: string }[];
  tiles: string[];
  goalReached: boolean;
  hint: string;
}
export interface ConfusionReport {
  summary: string;
  pairs: { a: string; b: string; explanation: string }[];
  drills: { type: 'cloze'; zh: string; options: string[]; answer: string; fr: string }[];
  failed: { w: string; count: number; faces: string[] }[];
}

export interface WordVideoCandidate {
  id: string;
  title: string;
  channel?: string;
  duration?: number;
}
export interface WordVideoPick {
  id: string;
  startSec: number | null;
  reason: string;
}

export interface AiDeps {
  db: Db;
  content: Content;
  cur: Curriculum;
  settings: () => Settings;
}

type Validator<T> = (x: unknown) => T;

const CLASSIC_PAIRS: [string, string][] = [
  ['再', '又'],
  ['的', '得'],
  ['的', '地'],
  ['得', '地'],
  ['在', '再'],
  ['买', '卖'],
  ['会', '能'],
  ['能', '可以'],
  ['不', '没'],
  ['二', '两'],
  ['以前', '以后'],
  ['已', '己'],
  ['人', '入'],
  ['大', '太'],
  ['日', '目'],
  ['午', '牛'],
  ['土', '士'],
  ['未', '末'],
  ['休', '体'],
  ['问', '向'],
  ['做', '作'],
  ['他', '她'],
  ['看', '见'],
  ['知道', '认识'],
  ['想', '要'],
  ['还是', '或者'],
  ['次', '遍'],
  ['刚', '刚才'],
];

// ---------------------------------------------------------------- service
export class AiService {
  /** Cached client keyed by API key (rebuilt when the key changes). */
  private client: { key: string; c: LlmClient } | null = null;

  constructor(
    private d: AiDeps,
    private makeClient: (apiKey: string) => LlmClient = anthropicClient,
  ) {}

  // ---------- configuration ----------
  status(): { configured: boolean; model: string } {
    const s = this.d.settings();
    return { configured: !!s.apiKey?.trim(), model: s.aiModel || DEFAULT_MODEL };
  }

  private model(): string {
    return this.d.settings().aiModel || DEFAULT_MODEL;
  }

  private llm(): LlmClient {
    const key = this.d.settings().apiKey?.trim();
    if (!key) throw new Error('IA non configurée');
    if (!this.client || this.client.key !== key) this.client = { key, c: this.makeClient(key) };
    return this.client.c;
  }

  async test(override?: { apiKey?: string; model?: string }): Promise<{ ok: boolean; error?: string; model: string }> {
    const key = override?.apiKey?.trim() || this.d.settings().apiKey?.trim();
    const model = override?.model || this.model();
    if (!key) return { ok: false, error: 'IA non configurée', model };
    try {
      const c = override?.apiKey ? this.makeClient(key) : this.llm();
      await c.complete({
        model,
        system: 'Réponds uniquement par le mot « ok ».',
        messages: [{ role: 'user', content: 'Test de connexion.' }],
        maxTokens: 256,
        effort: 'low',
      });
      return { ok: true, model };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), model };
    }
  }

  // ---------- cache ----------
  private cacheGet<T>(key: string): T | undefined {
    const r = this.d.db.get<{ value: string }>('SELECT value FROM ai_cache WHERE key=?', [key]);
    if (!r) return undefined;
    try {
      return JSON.parse(r.value) as T;
    } catch {
      return undefined;
    }
  }

  private cacheSet(key: string, value: unknown): void {
    this.d.db.run('INSERT INTO ai_cache(key,value,ts) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, ts=excluded.ts', [
      key,
      JSON.stringify(value),
      Date.now(),
    ]);
  }

  /** Ask for JSON, validate, retry once with the validation error. Cached by (model, task, prompts) unless cache=false. */
  private async askJson<T>(o: {
    task: string;
    system: string;
    user: string;
    validate: Validator<T>;
    maxTokens?: number;
    effort?: 'low' | 'medium' | 'high';
    cache?: boolean;
  }): Promise<T> {
    const llm = this.llm();
    const model = this.model();
    const key = hashKey({ v: 1, model, task: o.task, system: o.system, user: o.user });
    if (o.cache !== false) {
      const hit = this.cacheGet<T>(key);
      if (hit !== undefined) return hit;
    }
    const system = o.system + '\n\nFORMAT DE SORTIE : réponds UNIQUEMENT avec un objet JSON valide (pas de texte autour, pas de bloc de code).';
    const messages: LlmMessage[] = [{ role: 'user', content: o.user }];
    let maxTokens = o.maxTokens ?? 8000;
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await llm.complete({ model, system, messages, maxTokens, effort: o.effort ?? 'low' });
      try {
        const value = o.validate(extractJson(r.text));
        if (o.cache !== false) this.cacheSet(key, value);
        return value;
      } catch (e) {
        lastErr = e instanceof Error ? e : new Error(String(e));
        if (r.truncated) {
          maxTokens = Math.min(32000, maxTokens * 2);
          continue; // same request, more room
        }
        messages.push(
          { role: 'assistant', content: r.text || '(vide)' },
          { role: 'user', content: `Ta réponse est inutilisable : ${lastErr.message}. Renvoie la réponse complète corrigée, sous forme d'un unique objet JSON strict respectant exactement le schéma demandé.` },
        );
      }
    }
    throw new Error(`Réponse IA invalide (${lastErr?.message ?? 'inconnue'}). Réessaie.`);
  }

  private async askText(o: { task: string; system: string; user: string; maxTokens?: number; effort?: 'low' | 'medium' | 'high' }): Promise<string> {
    const llm = this.llm();
    const model = this.model();
    const key = hashKey({ v: 1, model, task: o.task, system: o.system, user: o.user });
    const hit = this.cacheGet<string>(key);
    if (hit !== undefined) return hit;
    const r = await llm.complete({ model, system: o.system, messages: [{ role: 'user', content: o.user }], maxTokens: o.maxTokens ?? 6000, effort: o.effort ?? 'low' });
    const text = r.text.trim();
    if (!text) throw new Error('Réponse IA vide. Réessaie.');
    this.cacheSet(key, text);
    return text;
  }

  // ---------- learner profile ----------
  private knownSet(): Set<string> {
    const out = new Set<string>();
    for (const [w, s] of this.d.cur.wordStatus()) if (s !== 'ignored') out.add(w);
    return out;
  }

  /** Short French description of the learner's level, injected in prompts. */
  levelText(): string {
    const phase = this.d.cur.phase();
    const n = this.d.cur.introducedWords().size;
    const desc = [
      'grand débutant (sons et tout premiers mots, aucune grammaire)',
      'débutant (HSK 1 en cours : phrases simples sujet-verbe-objet, 是, 有, 吗, 不, 很 + adjectif)',
      'faux débutant (HSK 2 : 了, 过, 在 + verbe, compléments simples, comparaisons avec 比)',
      'intermédiaire bas (HSK 3 : compléments de résultat et de degré, 把, 被, connecteurs)',
      'intermédiaire (HSK 3-4)',
    ][phase];
    return `Apprenant francophone, niveau ${desc}, environ ${n} mots étudiés. Caractères simplifiés.`;
  }

  private segmentText(text: string): Token[] {
    return segment(text, (w) => !!this.d.content.dict[w]);
  }

  private glossShort(w: string): string {
    const g = this.d.content.gloss(w);
    return (g.fr.length ? g.fr : g.en).slice(0, 2).join(' ; ');
  }

  private segments(videoId: string): { idx: number; text: string; tokens: Token[]; fr: string | null }[] {
    const rows = this.d.db.all<{ idx: number; text: string; tokens: string; fr: string | null }>('SELECT idx, text, tokens, fr FROM segments WHERE video_id=? ORDER BY idx', [videoId]);
    if (!rows.length) throw new Error("Cette vidéo n'a pas encore de sous-titres (segments).");
    return rows.map((r) => {
      let tokens: Token[] = [];
      try {
        tokens = JSON.parse(r.tokens) as Token[];
      } catch {
        tokens = [];
      }
      if (!Array.isArray(tokens) || !tokens.length) tokens = this.segmentText(r.text);
      return { idx: r.idx, text: r.text, tokens, fr: r.fr };
    });
  }

  private videoTitle(videoId: string): string {
    return this.d.db.get<{ title: string }>('SELECT title FROM videos WHERE id=?', [videoId])?.title ?? '';
  }

  /** Transcript limited to ~maxChars, keeping line indices. */
  private transcript(segs: { idx: number; text: string }[], maxChars = 12000): string {
    const out: string[] = [];
    let n = 0;
    for (const s of segs) {
      const line = `[${s.idx}] ${s.text}`;
      if (n + line.length > maxChars) {
        out.push('[…] (suite tronquée)');
        break;
      }
      out.push(line);
      n += line.length + 1;
    }
    return out.join('\n');
  }

  // ================================================================ ai:refinePreteach
  async refinePreteach(videoId: string): Promise<PreteachWord[]> {
    this.llm();
    const segs = this.segments(videoId);
    const st = this.d.cur.wordStatus();
    const report = analyseCoverage(
      segs.map((s) => s.tokens),
      {
        status: (w) => st.get(w),
        gloss: (w) => this.d.content.gloss(w),
        rank: (w) => this.d.content.wordMap.get(w)?.rank ?? 1e9,
        maxWords: 40, // a little wider than the video module, so the AI can choose
      },
    );
    const cands = report.preteach;
    if (!cands.length) return [];
    // A short context line for each candidate (first occurrence)
    const ctxLine = (w: string) => segs.find((s) => s.tokens.some((t) => t.t === w))?.text ?? '';
    const list = cands.map((c) => ({ w: c.w, n: c.count, dico: c.fr.slice(0, 3).join(' ; '), ex: ctxLine(c.w).slice(0, 60) }));
    const system = [
      "Tu es un professeur de chinois qui prépare un « briefing » de vocabulaire avant qu'un apprenant francophone regarde une vidéo.",
      this.levelText(),
      'Objectif : sélectionner les mots inconnus qui comptent vraiment pour COMPRENDRE la vidéo (intrigue, sujet, informations clés), et donner leur sens précis DANS CE CONTEXTE.',
      'Règles :',
      '- exclude=true pour : noms propres (personnes, lieux, marques), onomatopées, interjections et tics de langage (啊, 哎呀, 嗯, 哈哈…), mots mal segmentés ou fragments sans sens, chiffres.',
      "- key=true pour les mots indispensables à la compréhension globale (au plus ~12) ; key=false pour les mots utiles mais secondaires.",
      '- contextFr : traduction française courte (1 à 6 mots) du sens EXACT dans cette vidéo, pas la liste du dictionnaire.',
      '- Ne mets jamais de pinyin.',
      'Schéma : {"words":[{"w":"<mot exactement comme fourni>","exclude":false,"key":true,"contextFr":"…"}]} — un élément par mot fourni.',
    ].join('\n');
    const user = `Titre : ${this.videoTitle(videoId) || '(sans titre)'}\n\nTranscription :\n${this.transcript(segs, 9000)}\n\nMots candidats (w = mot, n = occurrences, dico = gloses du dictionnaire, ex = contexte) :\n${JSON.stringify(list)}`;
    const candSet = new Set(cands.map((c) => c.w));
    const res = await this.askJson({
      task: 'refinePreteach',
      system,
      user,
      effort: 'medium',
      validate: (x) => {
        const words = obj(x).words;
        need(Array.isArray(words), 'champ "words" manquant');
        const out = new Map<string, { exclude: boolean; key: boolean; contextFr: string }>();
        for (const it of words) {
          const o = obj(it);
          const w = str(o.w);
          if (!candSet.has(w)) continue;
          out.set(w, { exclude: o.exclude === true, key: o.key === true, contextFr: str(o.contextFr) });
        }
        need(out.size >= Math.min(cands.length, 3) * 0.5, 'trop peu de mots correspondant à la liste fournie');
        return [...out.entries()];
      },
    });
    const info = new Map(res);
    const out: PreteachWord[] = [];
    for (const c of cands) {
      const i = info.get(c.w);
      if (i?.exclude) continue;
      out.push({ ...c, contextFr: i?.contextFr || undefined, key: !!i?.key });
    }
    out.sort((a, b) => Number(!!b.key) - Number(!!a.key) || b.count - a.count);
    const mission = this.d.db.get<{ id: string }>("SELECT id FROM missions WHERE video_id=? AND status IN ('planned','briefing','ready') ORDER BY planned_date LIMIT 1", [videoId]);
    if (mission) this.d.db.run('UPDATE missions SET preteach=? WHERE id=?', [JSON.stringify(out), mission.id]);
    return out;
  }

  // ================================================================ ai:analyzeVideo
  async analyzeVideo(videoId: string): Promise<{ summary: string; themes: string[] }> {
    this.llm();
    const segs = this.segments(videoId);
    const system = [
      'Tu analyses la transcription chinoise d\'une vidéo pour un apprenant francophone qui choisit quoi regarder.',
      'summary : 2 à 3 phrases en français, qui décrivent le sujet et le ton SANS divulguer la chute ou la fin.',
      `themes : 1 à 4 thèmes choisis UNIQUEMENT dans cette liste fermée : ${THEMES.join(', ')}.`,
      'Schéma : {"summary":"…","themes":["…"]}',
    ].join('\n');
    const user = `Titre : ${this.videoTitle(videoId) || '(sans titre)'}\n\nTranscription :\n${this.transcript(segs, 7000)}`;
    const allowed = new Set<string>(THEMES);
    const r = await this.askJson({
      task: 'analyzeVideo',
      system,
      user,
      validate: (x) => {
        const o = obj(x);
        const summary = str(o.summary);
        need(summary.length > 10, 'résumé manquant');
        const themes = strArr(o.themes)
          .map((t) => t.toLowerCase())
          .filter((t) => allowed.has(t));
        need(themes.length > 0, `thèmes absents ou hors liste (${THEMES.join(', ')})`);
        return { summary, themes: [...new Set(themes)].slice(0, 4) };
      },
    });
    this.d.db.run('UPDATE videos SET summary=?, themes=? WHERE id=?', [r.summary, JSON.stringify(r.themes), videoId]);
    return r;
  }

  // ================================================================ ai:translateLines
  async translateLines(videoId: string, opts: { force?: boolean } = {}): Promise<number> {
    this.llm();
    const segs = this.segments(videoId);
    const todo = segs.filter((s) => opts.force || !s.fr);
    const title = this.videoTitle(videoId);
    const system = [
      'Tu traduis des sous-titres chinois en français naturel et fidèle, pour un apprenant qui vérifie sa compréhension.',
      "Traduis chaque ligne séparément (même si une phrase est coupée sur deux lignes), en gardant le registre (familier, enfantin…). Pas de pinyin, pas de notes.",
      'Schéma : {"lines":[{"i":<index>,"fr":"…"}]} — une entrée pour CHAQUE index fourni.',
    ].join('\n');
    const BATCH = 40;
    let done = 0;
    for (let b = 0; b < todo.length; b += BATCH) {
      const batch = todo.slice(b, b + BATCH);
      const prev = segs.filter((s) => s.idx < batch[0].idx).slice(-3);
      const user =
        (title ? `Vidéo : ${title}\n` : '') +
        (prev.length ? `Contexte précédent (ne pas traduire) :\n${prev.map((s) => s.text).join('\n')}\n\n` : '') +
        `Lignes à traduire :\n${batch.map((s) => `[${s.idx}] ${s.text}`).join('\n')}`;
      const want = new Set(batch.map((s) => s.idx));
      const res = await this.askJson({
        task: 'translateLines',
        system,
        user,
        maxTokens: 8000,
        validate: (x) => {
          const lines = obj(x).lines;
          need(Array.isArray(lines), 'champ "lines" manquant');
          const out: [number, string][] = [];
          for (const l of lines) {
            const o = obj(l);
            const i = Number(o.i);
            const fr = str(o.fr);
            if (want.has(i) && fr) out.push([i, fr]);
          }
          need(out.length >= want.size * 0.8, `seulement ${out.length}/${want.size} lignes traduites`);
          return out;
        },
      });
      this.d.db.tx(() => {
        for (const [i, fr] of res) this.d.db.run('UPDATE segments SET fr=? WHERE video_id=? AND idx=?', [fr, videoId, i]);
      });
      done += res.length;
    }
    return done;
  }

  // ================================================================ ai:explainLine
  async explainLine(zh: string, context?: string): Promise<string> {
    this.llm();
    zh = zh.trim();
    need(zh, 'Phrase vide');
    const st = this.d.cur.wordStatus();
    const toks = this.segmentText(zh).filter((t) => t.han);
    const unknown = [...new Set(toks.filter((t) => !st.has(t.t)).map((t) => t.t))];
    const system = [
      'Tu es un professeur de chinois bienveillant et précis qui explique une phrase à un apprenant francophone.',
      this.levelText(),
      'Réponds en français, en markdown simple (titres ###, listes « - », **gras**), 120 à 250 mots.',
      'Structure : ### Sens (traduction naturelle) · ### Structure (découpage de la phrase, rôle de chaque bloc, schéma grammatical) · ### Points clés (pourquoi tel mot ou telle particule, nuances, registre, ce qui surprend un francophone).',
      "Concentre-toi sur les mots inconnus de l'apprenant et sur les structures de son niveau ; ne détaille pas les mots qu'il connaît déjà.",
      "N'écris PAS de pinyin, sauf éventuellement pour un mot précis dont la prononciation pose problème (ton modifié, caractère polyphonique comme 得/了/行).",
      'Cite les mots chinois entre `backticks`.',
    ].join('\n');
    const user = `Phrase : ${zh}\n${context ? `Contexte (lignes voisines) : ${context}\n` : ''}Mots inconnus de l'apprenant : ${unknown.length ? unknown.map((w) => `${w} (${this.glossShort(w) || '?'})`).join(', ') : 'aucun'}`;
    return this.askText({ task: 'explainLine', system, user, effort: 'medium' });
  }

  // ================================================================ ai:quiz
  async quiz(videoId: string): Promise<QuizQuestion[]> {
    this.llm();
    const segs = this.segments(videoId);
    const idxSet = new Set(segs.map((s) => s.idx));
    const system = [
      "Tu écris un quiz de compréhension (en français) sur une vidéo chinoise qu'un apprenant francophone vient de regarder.",
      this.levelText(),
      '5 questions à choix multiple, 4 options chacune, en français. Elles portent sur le SENS (qui, quoi, pourquoi, que se passe-t-il), réparties sur toute la vidéo, pas sur des détails de vocabulaire isolés.',
      'Distracteurs plausibles (même type de réponse, mêmes personnages) ; une seule bonne réponse. Pas de « toutes les réponses ».',
      'lineIdx = index de la ligne de transcription qui contient la réponse.',
      'Schéma : {"questions":[{"question":"…","options":["…","…","…","…"],"answer":<0-3>,"lineIdx":<index>}]}',
    ].join('\n');
    const user = `Titre : ${this.videoTitle(videoId) || '(sans titre)'}\n\nTranscription :\n${this.transcript(segs, 10000)}`;
    const qs = await this.askJson({
      task: 'quiz',
      system,
      user,
      effort: 'medium',
      validate: (x) => {
        const arr = obj(x).questions;
        need(Array.isArray(arr), 'champ "questions" manquant');
        const out: QuizQuestion[] = [];
        for (const q of arr) {
          const o = obj(q);
          const options = strArr(o.options);
          const answer = Number(o.answer);
          let lineIdx = Number(o.lineIdx);
          if (!str(o.question) || options.length !== 4 || !Number.isInteger(answer) || answer < 0 || answer > 3) continue;
          if (!idxSet.has(lineIdx)) lineIdx = segs[0].idx;
          out.push({ question: str(o.question), options, answer, lineIdx });
        }
        need(out.length >= 3, `seulement ${out.length} questions valides (4 options, answer 0-3)`);
        return out.slice(0, 5);
      },
    });
    // Shuffle options so the right answer is not always at the same position (the model has a position bias).
    return qs.map((q) => ({ ...q, ...shuffleWithAnswer(q.options, q.answer) }));
  }

  // ================================================================ ai:correct
  async correct(o: { fr: string; userZh: string; answers: string[] }): Promise<Correction> {
    this.llm();
    const userZh = (o.userZh ?? '').trim();
    const answers = (o.answers ?? []).filter(Boolean);
    if (!userZh) return { correct: false, corrected: answers[0] ?? '', explanation: 'Aucune réponse saisie.' };
    if (answers.some((a) => normZh(a) === normZh(userZh))) return { correct: true, corrected: userZh, explanation: 'Parfait : c\'est exactement la réponse attendue.' };
    const system = [
      "Tu corriges la traduction en chinois (simplifié) d'une phrase française, écrite par un apprenant francophone.",
      this.levelText(),
      "La réponse est ACCEPTABLE si elle est grammaticale, naturelle pour un locuteur natif et rend le sens de la phrase française — même si elle diffère des réponses de référence (synonymes, ordre différent mais correct, 了 optionnel…). Les fautes de caractère (homophone erroné) ou de grammaire rendent la réponse incorrecte ; une ponctuation absente ne compte pas.",
      'corrected : la version corrigée la plus PROCHE de la phrase de l\'apprenant (pas forcément une réponse de référence) ; si elle est correcte, recopie-la.',
      "explanation : en français, 1 à 3 phrases. Si c'est faux : nomme précisément l'erreur (mot, ordre, particule) et la règle. Si c'est juste mais différent : dis-le et signale une éventuelle nuance. Pas de pinyin.",
      'Schéma : {"correct":true|false,"corrected":"…","explanation":"…"}',
    ].join('\n');
    const user = `Phrase française : ${o.fr}\nRéponses de référence : ${answers.join(' | ') || '(aucune)'}\nRéponse de l'apprenant : ${userZh}`;
    return this.askJson({
      task: 'correct',
      system,
      user,
      maxTokens: 3000,
      validate: (x) => {
        const r = obj(x);
        need(typeof r.correct === 'boolean', 'champ "correct" (booléen) manquant');
        const explanation = str(r.explanation);
        need(explanation, 'explication manquante');
        return { correct: r.correct as boolean, corrected: str(r.corrected) || (r.correct ? userZh : answers[0] ?? ''), explanation };
      },
    });
  }

  // ================================================================ ai:story
  async story(opts: { theme?: string; length?: 'short' | 'medium' | 'long' } = {}): Promise<StoryResult> {
    this.llm();
    const known = this.knownSet();
    if (known.size < 40)
      throw new Error(`Il faut au moins 40 mots connus pour une histoire graduée (tu en as ${known.size}). Continue les « Nouveaux mots » quelques jours.`);
    const length = opts.length ?? 'short';
    const chars = { short: 150, medium: 300, long: 500 }[length];
    const approxTokens = chars / 1.6;
    const nTargets = Math.max(2, Math.min(8, Math.round(approxTokens * 0.03)));
    const targets = this.d.cur.nextWords(nTargets + 4).filter((w) => w.w.length <= 3).slice(0, nTargets);
    const targetSet = new Set(targets.map((t) => t.w));
    const theme = opts.theme?.trim() || this.d.settings().interests[Math.floor(Math.random() * Math.max(1, this.d.settings().interests.length))] || 'vie quotidienne';
    // Most useful known words first (curriculum rank), so a truncated list keeps the core vocabulary.
    const knownList = [...known].sort((a, b) => (this.d.content.wordMap.get(a)?.rank ?? 1e9) - (this.d.content.wordMap.get(b)?.rank ?? 1e9)).slice(0, 2500);
    const system = [
      "Tu écris des histoires graduées (lecture extensive, principe i+1 de Krashen) pour un apprenant de chinois francophone.",
      this.levelText(),
      'CONTRAINTE ABSOLUE : utilise UNIQUEMENT les mots de la liste « mots connus » (et leurs combinaisons évidentes), plus les « mots cibles » imposés. Chaque mot cible doit apparaître au moins 2 fois, dans un contexte qui rend son sens devinable.',
      "Aucun autre mot. Les noms propres sont permis seulement s'ils sont très courts et évidents (王, 小明, 北京). Phrases courtes, grammaire du niveau de l'apprenant, beaucoup de répétitions naturelles, une vraie petite intrigue avec une chute.",
      `Longueur : environ ${chars} caractères chinois, en 3 à 6 paragraphes. Ponctuation chinoise (，。？！「」).`,
      'fr : traduction française fidèle de chaque paragraphe.',
      'Schéma : {"title":"<titre en chinois, mots connus>","paragraphs":[{"zh":"…","fr":"…"}]}',
    ].join('\n');
    const baseUser = `Thème : ${theme}\nMots cibles (à introduire) : ${targets.map((t) => `${t.w} (${t.fr.slice(0, 2).join(' ; ')})`).join(', ')}\n\nMots connus (${knownList.length}) : ${knownList.join(' ')}`;
    const validate: Validator<{ title: string; paragraphs: { zh: string; fr: string }[] }> = (x) => {
      const o = obj(x);
      const title = str(o.title);
      const ps = Array.isArray(o.paragraphs) ? o.paragraphs.map(obj).map((p) => ({ zh: str(p.zh), fr: str(p.fr) })).filter((p) => p.zh && isHan(p.zh)) : [];
      need(title, 'titre manquant');
      need(ps.length > 0, 'aucun paragraphe');
      return { title, paragraphs: ps };
    };
    let best: { story: { title: string; paragraphs: { zh: string; fr: string }[] }; cov: TextCoverage } | null = null;
    let attempts = 0;
    let user = baseUser;
    for (; attempts < 2; ) {
      attempts++;
      const s = await this.askJson({ task: 'story', system, user, validate, maxTokens: 12000, effort: 'medium', cache: false });
      const toks = this.segmentText(s.title + '。' + s.paragraphs.map((p) => p.zh).join(''));
      const cov = textCoverage(toks, known, targetSet, (w) => this.d.content.wordMap.has(w));
      if (!best || cov.coverage > best.cov.coverage) best = { story: s, cov };
      if (cov.coverage >= 0.9) break;
      user = `${baseUser}\n\nTa version précédente contenait trop de mots hors liste (couverture ${(cov.coverage * 100).toFixed(0)} %, il faut ≥ 95 %) : ${cov.unknown.slice(0, 40).join('、')}. Réécris l'histoire en remplaçant ces mots par des mots de la liste.`;
    }
    const { story: s, cov } = best!;
    const id = 'st_' + crypto.randomBytes(6).toString('hex');
    const zh = s.paragraphs.map((p) => p.zh).join('\n\n');
    const fr = s.paragraphs.map((p) => p.fr).join('\n\n');
    this.d.db.run('INSERT INTO stories(id,title,zh,fr,theme,created,read) VALUES(?,?,?,?,?,?,0)', [id, s.title, zh, fr, theme, Date.now()]);
    return {
      id,
      title: s.title,
      zh,
      fr,
      theme,
      targetWords: targets.map((t) => ({ w: t.w, py: t.py, fr: t.fr })),
      coverage: cov.coverage,
      unknownWords: cov.unknown,
      attempts,
    };
  }

  // ================================================================ ai:roleplay
  async roleplay(o: { scenario: RoleplayScenario; messages: RoleplayTurn[] }): Promise<RoleplayReply> {
    this.llm();
    const sc = o.scenario;
    need(sc && sc.title, 'Scénario manquant');
    const turns = (o.messages ?? []).filter((m) => m && m.zh?.trim()).slice(-24);
    const known = this.knownSet();
    const knownList = [...known].sort((a, b) => (this.d.content.wordMap.get(a)?.rank ?? 1e9) - (this.d.content.wordMap.get(b)?.rank ?? 1e9)).slice(0, 1500);
    const phase = this.d.cur.phase();
    const maxLen = [8, 14, 20, 28, 35][phase];
    const lastUser = [...turns].reverse().find((t) => t.role === 'user');
    const system = [
      'Tu joues un personnage dans un jeu de rôle d\'immersion pour un apprenant de chinois francophone (thème : formation d\'agent secret, ton léger et bienveillant).',
      this.levelText(),
      `Scène : ${sc.title}. Décor : ${sc.setting}. Ton personnage : ${sc.character}. Objectif de l'apprenant (agent) : ${sc.goal}.`,
      'Règles pour ta réplique (reply) :',
      `- Reste dans le personnage, en chinois simplifié uniquement, 1 à 2 phrases courtes (≤ ${maxLen} caractères chacune), avec presque uniquement des mots de la liste « mots connus » ; au plus un mot nouveau indispensable.`,
      "- Fais avancer la scène : pose une question à laquelle l'apprenant peut répondre avec ses mots. S'il est bloqué ou écrit en français, reformule plus simplement.",
      "- Ne corrige pas dans la réplique (les corrections vont dans « corrections »).",
      'Autres champs :',
      '- fr : traduction française de ta réplique.',
      "- corrections : pour la DERNIÈRE réplique de l'apprenant seulement : liste des erreurs réelles (grammaire, mot inadapté, caractère erroné, formulation non naturelle) {yourText: extrait fautif, better: version correcte et naturelle, explanation: explication courte en français, sans pinyin}. Liste vide si c'est correct ou s'il n'a encore rien dit. Ne corrige pas la ponctuation.",
      "- tiles : 6 à 10 mots (de la liste des mots connus de préférence) utiles pour RÉPONDRE à ta réplique — les briques d'une bonne réponse, plus 2 ou 3 distracteurs plausibles.",
      "- goalReached : true quand l'objectif de l'apprenant est accompli.",
      "- hint : en français, une piste courte pour répondre (sans donner la phrase toute faite).",
      'Schéma : {"reply":"…","fr":"…","corrections":[{"yourText":"…","better":"…","explanation":"…"}],"tiles":["…"],"goalReached":false,"hint":"…"}',
    ].join('\n');
    const dialogue = turns.length ? turns.map((t) => `${t.role === 'user' ? 'Apprenant' : 'Personnage'} : ${t.zh}`).join('\n') : "(La scène commence : c'est toi qui parles en premier.)";
    const user = `Mots connus : ${knownList.join(' ')}\n\nDialogue jusqu'ici :\n${dialogue}${lastUser ? `\n\nDernière réplique de l'apprenant à corriger : ${lastUser.zh}` : ''}`;
    return this.askJson({
      task: 'roleplay',
      system,
      user,
      maxTokens: 4000,
      effort: 'low',
      cache: false, // a replayed scene should not get the exact same lines
      validate: (x) => {
        const r = obj(x);
        const reply = str(r.reply);
        need(reply && isHan(reply), 'réplique chinoise manquante');
        const corrections = (Array.isArray(r.corrections) ? r.corrections : [])
          .map(obj)
          .map((c) => ({ yourText: str(c.yourText), better: str(c.better), explanation: str(c.explanation) }))
          .filter((c) => c.better && c.explanation && c.better !== c.yourText);
        const tiles = [...new Set(strArr(r.tiles).filter((t) => isHan(t) && t.length <= 6))].slice(0, 12);
        return { reply, fr: str(r.fr), corrections: lastUser ? corrections : [], tiles, goalReached: r.goalReached === true, hint: str(r.hint) };
      },
    });
  }

  // ================================================================ ai:confusions
  /** Deterministic part: failed items over the last 30 days + candidate confusable neighbours. */
  confusionData(now = Date.now()): { failed: ConfusionReport['failed']; neighbours: { w: string; similar: string[] }[] } {
    const rows = this.d.db.all<{ card_id: string; n: number }>(
      `SELECT r.card_id, COUNT(*) n FROM reviews r JOIN cards c ON c.id = r.card_id
       WHERE r.rating = 1 AND r.ts > ? AND c.kind IN ('word','char') GROUP BY r.card_id ORDER BY n DESC LIMIT 200`,
      [now - 30 * DAY_MS],
    );
    const agg = new Map<string, { count: number; faces: Set<string> }>();
    for (const r of rows) {
      const [, face, ...rest] = r.card_id.split(':');
      const ref = rest.join(':');
      const a = agg.get(ref) ?? { count: 0, faces: new Set<string>() };
      a.count += r.n;
      a.faces.add(face);
      agg.set(ref, a);
    }
    const failed = [...agg.entries()]
      .map(([w, a]) => ({ w, count: a.count, faces: [...a.faces] }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 25);
    const known = [...this.knownSet()];
    const toneless = (w: string) => (this.d.content.gloss(w).py || '').normalize('NFD').replace(/[̀-ͯ\s]/g, '').toLowerCase();
    const comps = (c: string) => new Set([...(this.d.content.chars[c]?.dec ?? '')].filter((k) => isHan(k)));
    const neighbours = failed.map(({ w }) => {
      const sim = new Map<string, number>();
      for (const [a, b] of CLASSIC_PAIRS) {
        if (w === a) sim.set(b, 10);
        if (w === b) sim.set(a, 10);
      }
      const py = toneless(w);
      const wc = w.length === 1 ? comps(w) : null;
      for (const k of known) {
        if (k === w) continue;
        let s = 0;
        if (k.length === w.length && [...k].some((c) => w.includes(c))) s += 2; // share a character
        if (py && toneless(k) === py) s += 3; // homophone (tones aside)
        if (wc && k.length === 1) {
          const kc = comps(k);
          const shared = [...wc].filter((x) => kc.has(x)).length;
          const dn = Math.abs((this.d.content.chars[k]?.n ?? 0) - (this.d.content.chars[w]?.n ?? 0));
          if (shared && dn <= 2) s += 2; // visually close
        }
        if (s >= 2) sim.set(k, Math.max(sim.get(k) ?? 0, s));
      }
      return { w, similar: [...sim.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k]) => k) };
    });
    return { failed, neighbours };
  }

  async confusions(): Promise<ConfusionReport> {
    this.llm();
    const { failed, neighbours } = this.confusionData();
    if (failed.length === 0)
      return { summary: "Aucune erreur de révision sur les 30 derniers jours : rien à analyser pour l'instant. Continue tes révisions !", pairs: [], drills: [], failed };
    const FACE: Record<string, string> = { meaning: 'sens à la lecture', listen: "sens à l'écoute", recall: 'production', write: 'écriture' };
    const lines = failed.map((f) => {
      const nb = neighbours.find((n) => n.w === f.w)?.similar ?? [];
      return `- ${f.w} (${this.glossShort(f.w) || '?'}) : ${f.count} échec(s) — ${f.faces.map((x) => FACE[x] ?? x).join(', ')}${nb.length ? ` — proches connus : ${nb.map((k) => `${k} (${this.glossShort(k)})`).join(', ')}` : ''}`;
    });
    const system = [
      "Tu es un professeur de chinois qui analyse les erreurs de révision (cartes FSRS ratées) d'un apprenant francophone pour l'aider à cibler ses confusions.",
      this.levelText(),
      "summary : 3 à 5 phrases en français : quelles familles d'erreurs (sens proche, homophones/tons, caractères visuellement proches, particules), et un conseil concret.",
      'pairs : 2 à 6 paires réellement confondables tirées des données (ex. 再/又, 的/得/地, 买/卖, 已/己) avec une explication courte et un moyen mnémotechnique. Utilise les « proches connus » fournis ; n\'invente pas de paires sans rapport.',
      "drills : 4 à 8 exercices à trou (type \"cloze\") : zh = phrase simple du niveau de l'apprenant contenant ＿＿ à la place du mot, options = 2 à 4 mots confondables (dont la bonne réponse), answer = la bonne option (exactement), fr = traduction française de la phrase complète.",
      'Pas de pinyin.',
      'Schéma : {"summary":"…","pairs":[{"a":"…","b":"…","explanation":"…"}],"drills":[{"type":"cloze","zh":"…＿＿…","options":["…"],"answer":"…","fr":"…"}]}',
    ].join('\n');
    const user = `Mots ratés sur 30 jours :\n${lines.join('\n')}`;
    const r = await this.askJson({
      task: 'confusions',
      system,
      user,
      effort: 'medium',
      validate: (x) => {
        const o = obj(x);
        const summary = str(o.summary);
        need(summary, 'résumé manquant');
        const pairs = (Array.isArray(o.pairs) ? o.pairs : [])
          .map(obj)
          .map((p) => ({ a: str(p.a), b: str(p.b), explanation: str(p.explanation) }))
          .filter((p) => p.a && p.b && p.explanation);
        const drills = (Array.isArray(o.drills) ? o.drills : [])
          .map(obj)
          .map((d) => {
            let zh = str(d.zh).replace(/_{2,}|＿+|（\s*）|\(\s*\)/g, '＿＿');
            const options = [...new Set(strArr(d.options))];
            const answer = str(d.answer);
            if (!zh.includes('＿＿') && answer && zh.includes(answer)) zh = zh.replace(answer, '＿＿');
            return { type: 'cloze' as const, zh, options, answer, fr: str(d.fr) };
          })
          .filter((d) => d.zh.includes('＿＿') && d.options.length >= 2 && d.options.includes(d.answer));
        need(drills.length >= 2 || pairs.length >= 1, 'ni paires ni exercices valides (la réponse doit figurer dans options, et zh contenir ＿＿)');
        return { summary, pairs, drills };
      },
    });
    return { ...r, failed };
  }

  // ================================================================ choix de la vidéo YouTube d'un mot / caractère
  /** Choisit parmi des candidats (titres de vidéos) celle qui convient le mieux ; id validé parmi les candidats. */
  async pickWordVideo(target: string, slot: 'usage' | 'etymology', candidates: WordVideoCandidate[]): Promise<WordVideoPick> {
    this.llm();
    const cands = candidates.filter((c) => c && c.id).slice(0, 10);
    need(cands.length > 0, 'aucun candidat');
    const what =
      slot === 'etymology'
        ? `le caractère ${target} : la vidéo doit EXPLIQUER SON ORIGINE (forme ancienne, pictogramme, composants, évolution), pas seulement l'ordre des traits`
        : `le mot ${target} : la vidéo doit PRÉSENTER CE MOT et l'UTILISER EN CONTEXTE (phrases d'exemple, prononciation, sens)`;
    const system = [
      "Tu choisis une vidéo YouTube pour un apprenant francophone débutant en chinois, d'après les titres, chaînes et durées des candidats (tu ne peux pas voir les vidéos).",
      `Cible : ${what}.`,
      "Critères, dans l'ordre : 1) la vidéo porte sur cette cible précise (pas sur un autre mot qui la contient, pas une liste de nombreux caractères) ; 2) elle correspond à l'objectif ci-dessus ; 3) elle convient à un débutant francophone (explications en français ou en anglais simple, durée courte de 1 à 7 min, pas d'examen ni de podcast).",
      "Un titre en caractères traditionnels peut tout à fait concerner la cible simplifiée (覺 = 觉).",
      "startSec : le moment (en secondes) où commence la partie utile, UNIQUEMENT si le titre ou la durée le justifient clairement (ex. compilation) ; sinon null.",
      'reason : une phrase en français.',
      'Schéma : {"id":"<id exact d\'un candidat>","startSec":<entier>|null,"reason":"…"}',
    ].join('\n');
    const user = cands
      .map((c, i) => `${i + 1}. id=${c.id} · chaîne : ${c.channel || '?'} · durée : ${c.duration ? `${Math.round(c.duration)} s` : '?'} · titre : ${c.title}`)
      .join('\n');
    return this.askJson({ task: 'pickWordVideo', system, user, maxTokens: 1500, validate: (x) => validateAiPick(x, cands) });
  }
}
