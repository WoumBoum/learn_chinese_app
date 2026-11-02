// Loads static learning content (dictionary, HSK words, characters, sentences, grammar, catalog).
import fs from 'node:fs';
import path from 'node:path';
import type { CatalogSource, CharInfo, GrammarPoint, Sentence, Word } from '../shared/types';

export interface DictEntry {
  p: string; // numeric pinyin
  f?: string[]; // French
  e?: string[]; // English
}

export interface StarterVideo {
  url: string;
  title: string;
  sourceId: string;
  phase: number;
  durationSec?: number;
  hasChineseCC?: boolean | null;
  themes?: string[];
}

export class Content {
  words: Word[] = [];
  wordMap = new Map<string, Word>();
  chars: Record<string, CharInfo> = {};
  comps: Record<string, { c: string; fr: string[]; en: string }> = {};
  dict: Record<string, DictEntry> = {};
  sentences: Sentence[] = [];
  grammar: GrammarPoint[] = [];
  grammarMap = new Map<string, GrammarPoint>();
  catalog: { sources: CatalogSource[]; starterVideos: StarterVideo[] } = { sources: [], starterVideos: [] };
  private strokes: Record<string, unknown> | null = null;

  constructor(private dataDir: string, private contentDir: string) {}

  load(): this {
    const read = (f: string) => JSON.parse(fs.readFileSync(path.join(this.dataDir, f), 'utf8'));
    this.words = read('words.json');
    this.wordMap = new Map(this.words.map((w) => [w.w, w]));
    const ch = read('chars.json');
    this.chars = ch.chars;
    this.comps = ch.comps;
    this.dict = read('dict.json');
    this.sentences = read('sentences.json');
    this.grammar = [];
    for (const n of [1, 2, 3]) {
      const f = path.join(this.contentDir, 'grammar', `phase${n}.json`);
      if (fs.existsSync(f)) {
        try {
          const pts = JSON.parse(fs.readFileSync(f, 'utf8')) as GrammarPoint[];
          this.grammar.push(...pts.map((p) => ({ ...p, phase: p.phase ?? n })));
        } catch (e) {
          console.error('grammar file invalid', f, e);
        }
      }
    }
    this.grammarMap = new Map(this.grammar.map((g) => [g.id, g]));
    const cat = path.join(this.contentDir, 'catalog', 'catalog.json');
    if (fs.existsSync(cat)) {
      try {
        const c = JSON.parse(fs.readFileSync(cat, 'utf8'));
        this.catalog = { sources: c.sources || [], starterVideos: c.starterVideos || [] };
      } catch (e) {
        console.error('catalog invalid', e);
      }
    }
    return this;
  }

  strokeData(c: string): unknown | null {
    if (!this.strokes) this.strokes = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'strokes.json'), 'utf8'));
    return (this.strokes as Record<string, unknown>)[c] ?? null;
  }

  /** French gloss for any word: curriculum word first, then dictionary (FR, else EN marked). */
  gloss(w: string): { fr: string[]; py: string; en: string[] } {
    const word = this.wordMap.get(w);
    if (word) return { fr: word.fr, py: word.py, en: word.en };
    const d = this.dict[w];
    if (!d) return { fr: [], py: '', en: [] };
    return { fr: d.f || [], py: numericToMarks(d.p), en: d.e || [] };
  }

  /** Example sentences containing `w`, ranked by how few unknown characters they contain. */
  examplesFor(w: string, knownChars: Set<string>, limit = 3): Sentence[] {
    const out: { s: Sentence; score: number }[] = [];
    for (const s of this.sentences) {
      if (!s.zh.includes(w)) continue;
      let unknown = 0;
      for (const c of s.zh) if (/\p{Script=Han}/u.test(c) && !knownChars.has(c) && !w.includes(c)) unknown++;
      out.push({ s, score: unknown * 10 + s.zh.length * 0.2 - s.a * 3 });
      if (out.length > 400) break;
    }
    out.sort((a, b) => a.score - b.score);
    return out.slice(0, limit).map((o) => o.s);
  }
}

const TONE_MARKS: Record<string, string[]> = {
  a: ['ā', 'á', 'ǎ', 'à'],
  e: ['ē', 'é', 'ě', 'è'],
  i: ['ī', 'í', 'ǐ', 'ì'],
  o: ['ō', 'ó', 'ǒ', 'ò'],
  u: ['ū', 'ú', 'ǔ', 'ù'],
  ü: ['ǖ', 'ǘ', 'ǚ', 'ǜ'],
};

export function numericToMarks(p: string): string {
  if (!p) return '';
  return p
    .split(' ')
    .map((syl) => {
      const m = syl.match(/^([a-zA-Zü:]+)([1-5])$/);
      if (!m) return syl.replace(/u:/g, 'ü');
      let s = m[1].replace(/u:/g, 'ü').replace(/v/g, 'ü');
      const tone = +m[2];
      if (tone === 5) return s;
      const lower = s.toLowerCase();
      let idx = -1;
      if (lower.includes('a')) idx = lower.indexOf('a');
      else if (lower.includes('e')) idx = lower.indexOf('e');
      else if (lower.includes('ou')) idx = lower.indexOf('o');
      else {
        for (let i = lower.length - 1; i >= 0; i--) if ('aeiouü'.includes(lower[i])) { idx = i; break; }
      }
      if (idx < 0) return s;
      const v = lower[idx];
      const marked = TONE_MARKS[v]?.[tone - 1] ?? v;
      s = s.slice(0, idx) + (s[idx] === s[idx].toUpperCase() && s[idx] !== s[idx].toLowerCase() ? marked.toUpperCase() : marked) + s.slice(idx + 1);
      return s;
    })
    .join(' ');
}
