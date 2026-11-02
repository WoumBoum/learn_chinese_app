// Reading without AI: extensive-reading sentences (Tatoeba) within the learner's vocabulary, and stored graded stories.
import type { Db } from '../../core/db';
import type { Content } from '../../core/content';
import type { Curriculum } from '../../core/curriculum';
import { isHan, segment } from '../../core/nlp';
import type { Token } from '../../shared/types';
import { decomposable } from './ai';

export interface ReadToken extends Token {
  py?: string; // pinyin, only for words that are not known (for the optional ruby display)
}

export interface ReadingSentence {
  id: number;
  zh: string;
  fr: string[];
  audio: boolean;
  tokens: ReadToken[];
  unknown: { w: string; py: string; fr: string[] }[];
}

export interface StoryRow {
  id: string;
  title: string;
  theme: string | null;
  created: number;
  read: number;
  chars: number;
}

export interface StoryFull extends StoryRow {
  paragraphs: { zh: string; fr: string; tokens: ReadToken[] }[];
  titleTokens: ReadToken[];
  newWords: { w: string; py: string; fr: string[]; status: 'new' | 'learning' }[];
  coverage: number;
}

export interface ReadingDeps {
  db: Db;
  content: Content;
  cur: Curriculum;
}

export class ReadingService {
  constructor(private d: ReadingDeps) {}

  private statusMap() {
    return this.d.cur.wordStatus();
  }

  private knownSet(st = this.statusMap()): Set<string> {
    const s = new Set<string>();
    for (const [w, v] of st) if (v !== 'ignored') s.add(w);
    return s;
  }

  tokenize(text: string, st = this.statusMap(), known = this.knownSet(st)): ReadToken[] {
    return segment(text, (w) => !!this.d.content.dict[w]).map((t) => {
      if (!t.han) return t;
      const s = st.get(t.t);
      let status: Token['status'] = s ?? 'new';
      // A free combination of known words (我们的, 很好) is treated as known — but not a lexical curriculum word (东西).
      if (!s && !this.d.content.wordMap.has(t.t) && decomposable(t.t, known)) status = 'known';
      const tok: ReadToken = { ...t, status };
      if (status !== 'known' && status !== 'ignored') tok.py = this.d.content.gloss(t.t).py || undefined;
      return tok;
    });
  }

  /** Sentences for extensive reading. mode 'known': only known words; 'i+1': exactly one unknown word. */
  sentences(o: { n?: number; mode?: 'known' | 'i+1'; exclude?: number[] } = {}): ReadingSentence[] {
    const n = Math.min(50, o.n ?? 10);
    const mode = o.mode ?? 'known';
    const exclude = new Set(o.exclude ?? []);
    const st = this.statusMap();
    const known = this.knownSet(st);
    const chars = new Set<string>();
    for (const w of known) for (const c of w) chars.add(c);
    const pool = this.d.content.sentences;
    if (!pool.length || !known.size) return [];
    const out: ReadingSentence[] = [];
    const start = Math.floor(Math.random() * pool.length);
    let scanned = 0;
    for (let k = 0; k < pool.length && out.length < n && scanned < 8000; k++) {
      const s = pool[(start + k) % pool.length];
      if (exclude.has(s.id)) continue;
      const han = [...s.zh].filter(isHan);
      if (han.length < 4 || han.length > 22) continue;
      const unknownChars = han.filter((c) => !chars.has(c)).length;
      if (mode === 'known' ? unknownChars > 0 : unknownChars > 3) continue;
      scanned++;
      const tokens = this.tokenize(s.zh, st, known);
      const unk = [...new Set(tokens.filter((t) => t.han && t.status !== 'known' && t.status !== 'ignored' && t.status !== 'learning').map((t) => t.t))];
      if (mode === 'known' ? unk.length !== 0 : unk.length !== 1) continue;
      if (mode === 'i+1') {
        const g = this.d.content.gloss(unk[0]);
        if (!g.fr.length && !g.en.length) continue; // we must be able to explain the new word
      }
      out.push({
        id: s.id,
        zh: s.zh,
        fr: s.fr,
        audio: !!s.a,
        tokens,
        unknown: unk.map((w) => {
          const g = this.d.content.gloss(w);
          return { w, py: g.py, fr: g.fr.length ? g.fr : g.en };
        }),
      });
    }
    return out;
  }

  // ---------- stories ----------
  stories(): StoryRow[] {
    return this.d.db.all<StoryRow>('SELECT id, title, theme, created, read, LENGTH(zh) chars FROM stories ORDER BY created DESC');
  }

  story(id: string): StoryFull {
    const r = this.d.db.get<{ id: string; title: string; zh: string; fr: string | null; theme: string | null; created: number; read: number }>('SELECT * FROM stories WHERE id=?', [id]);
    if (!r) throw new Error('Histoire introuvable');
    const st = this.statusMap();
    const known = this.knownSet(st);
    const zhP = r.zh.split(/\n{2,}/).filter((p) => p.trim());
    const frP = (r.fr ?? '').split(/\n{2,}/);
    const paragraphs = zhP.map((zh, i) => ({ zh, fr: frP[i] ?? '', tokens: this.tokenize(zh, st, known) }));
    const titleTokens = this.tokenize(r.title, st, known);
    const all = [...titleTokens, ...paragraphs.flatMap((p) => p.tokens)].filter((t) => t.han);
    const covered = all.filter((t) => t.status === 'known' || t.status === 'learning' || t.status === 'ignored').length;
    const seen = new Set<string>();
    const newWords: StoryFull['newWords'] = [];
    for (const t of all) {
      if ((t.status === 'new' || t.status === 'learning') && !seen.has(t.t)) {
        seen.add(t.t);
        const g = this.d.content.gloss(t.t);
        newWords.push({ w: t.t, py: g.py, fr: g.fr.length ? g.fr : g.en, status: t.status });
      }
    }
    return { id: r.id, title: r.title, theme: r.theme, created: r.created, read: r.read, chars: r.zh.length, paragraphs, titleTokens, newWords, coverage: all.length ? covered / all.length : 1 };
  }

  markRead(id: string): boolean {
    this.d.db.run('UPDATE stories SET read = read + 1 WHERE id=?', [id]);
    return true;
  }

  deleteStory(id: string): boolean {
    this.d.db.run('DELETE FROM stories WHERE id=?', [id]);
    return true;
  }
}
