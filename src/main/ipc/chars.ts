// Canaux chars:* — fiche caractère : origine, composants, mnémotechnique, illustration, formes anciennes.
//   chars:card(c)    → CharCardData (données locales : char-stories.json + Make Me a Hanzi en repli)
//   chars:ancient(c) → { forms, status: 'ok'|'none'|'offline'|'pending' } (Wikimedia Commons, cache userData/ancient)
import fs from 'node:fs';
import path from 'node:path';
import { net } from 'electron';
import { handle, type Ctx } from '../ctx';
import { numericToMarks } from '../../core/content';
import { AncientService, ancientCandidates, type AncientResult, type FetchLike } from '../services/ancient';
import type { Word } from '../../shared/types';

export type CompRole = 'sens' | 'son' | 'forme';
export interface CharCardData {
  c: string;
  py: string[];
  fr: string[];
  story?: {
    type: string;
    origin: string;
    components: { c: string; role: CompRole; fr: string; py?: string }[];
    mnemonic: string;
    scene: string;
    svg: string;
    /** 'curated' = fiche rédigée (FR) ; 'mmah' = repli Make Me a Hanzi (indice en anglais) */
    source: 'curated' | 'mmah';
  };
  dec: string;
  rad: string;
  strokes: number;
  words: { w: string; py: string; fr: string }[];
  inCurriculum: boolean;
}

interface StoryRow {
  t: string;
  o: string;
  k: [string, CompRole, string][];
  m?: string;
  s?: string;
  a?: string;
}

const MMAH_TYPE: Record<string, string> = { pictographic: 'pictogramme', ideographic: 'idéogramme composé', pictophonetic: 'idéo-phonétique' };
const ANCIENT_WAIT_MS = 6000;

/** char-stories.json : { "<car>": StoryRow, …, "_ancient": { "<car>": "<graphies candidates sur Commons>" } } */
type StoriesFile = Record<string, StoryRow> & { _ancient?: Record<string, string> };

export function register(ctx: Ctx): void {
  let stories: StoriesFile | null = null;
  const loadStories = (): StoriesFile => {
    if (stories) return stories;
    try {
      stories = JSON.parse(fs.readFileSync(path.join(ctx.paths.data, 'char-stories.json'), 'utf8'));
    } catch (e) {
      console.warn('[chars] char-stories.json illisible', e);
    }
    if (!stories || typeof stories !== 'object') stories = {} as StoriesFile;
    return stories;
  };

  // index caractère → mots du programme (ordre du programme)
  let byChar: Map<string, Word[]> | null = null;
  const wordsWith = (c: string): Word[] => {
    if (!byChar) {
      byChar = new Map();
      for (const w of ctx.content.words)
        for (const ch of new Set(w.w)) {
          const l = byChar.get(ch);
          if (l) l.push(w);
          else byChar.set(ch, [w]);
        }
    }
    return byChar.get(c) ?? [];
  };

  const pinyinOf = (c: string): string[] => {
    const ci = ctx.content.chars[c];
    if (ci?.py?.length) return ci.py;
    const d = ctx.content.dict[c];
    return d?.p ? [numericToMarks(d.p)] : [];
  };
  const meaningOf = (c: string): string[] => {
    const ci = ctx.content.chars[c];
    if (ci?.fr?.length) return ci.fr;
    const comp = ctx.content.comps[c];
    if (comp?.fr?.length) return comp.fr;
    const d = ctx.content.dict[c];
    if (d?.f?.length) return d.f;
    const en = ci?.en || comp?.en || d?.e?.join('; ') || '';
    return en ? [`(en) ${en.split(/[;,]/)[0].trim()}`] : [];
  };

  const card = (input: string): CharCardData => {
    const c = [...String(input || '')][0] ?? '';
    if (!c) throw new Error('Caractère manquant');
    const ci = ctx.content.chars[c];
    const st = c.startsWith('_') ? undefined : loadStories()[c];
    const out: CharCardData = {
      c,
      py: pinyinOf(c),
      fr: meaningOf(c),
      dec: ci?.dec ?? '',
      rad: ci?.rad ?? '',
      strokes: ci?.n ?? 0,
      words: [],
      inCurriculum: !!ci,
    };
    if (!out.strokes) {
      const s = ctx.content.strokeData(c) as { strokes?: unknown[] } | null;
      out.strokes = s?.strokes?.length ?? 0;
    }
    if (st) {
      out.story = {
        type: st.t,
        origin: st.o,
        components: st.k.map(([k, role, fr]) => ({ c: k, role, fr, py: pinyinOf(k)[0] })),
        mnemonic: st.m ?? '',
        scene: st.s ?? '',
        svg: st.a ?? '',
        source: 'curated',
      };
    } else if (ci?.ety || ci?.dec) {
      // Repli Make Me a Hanzi : type, indice (anglais), composants issus de la décomposition.
      const parts = [...new Set([...(ci.dec || '')].filter((k) => !/[⿰-⿻？]/.test(k) && k !== c))];
      out.story = {
        type: MMAH_TYPE[ci.ety?.type ?? ''] ?? '',
        origin: ci.ety?.hint ?? '',
        components: parts.map((k) => ({
          c: k,
          role: ci.ety?.semantic === k ? 'sens' : ci.ety?.phonetic === k ? 'son' : 'forme',
          fr: meaningOf(k)[0] ?? '',
          py: pinyinOf(k)[0],
        })),
        mnemonic: '',
        scene: '',
        svg: '',
        source: 'mmah',
      };
    }
    // jusqu'à 4 mots du programme contenant c : déjà introduits d'abord
    const intro = ctx.cur.introducedWords();
    const ws = wordsWith(c).filter((w) => w.w !== c);
    const ordered = [...ws.filter((w) => intro.has(w.w)), ...ws.filter((w) => !intro.has(w.w))].slice(0, 4);
    out.words = ordered.map((w) => ({ w: w.w, py: w.py, fr: w.fr[0] ?? w.en[0] ?? '' }));
    return out;
  };

  const netFetch: FetchLike = (url, init) => net.fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>;
  let svc: AncientService | null = null;
  const ancient = (): AncientService =>
    (svc ??= new AncientService({
      cacheDir: path.join(ctx.paths.user, 'ancient'),
      fetch: netFetch,
      // graphies précalculées au build (simplifié → traditionnel, ordre adapté à la fiche) : pas d'OpenCC à l'exécution
      candidates: (c) => ancientCandidates(c, loadStories()._ancient?.[c]),
    }));

  handle('chars:card', (c: string) => card(c));

  handle('chars:ancient', async (input: string): Promise<AncientResult> => {
    const c = [...String(input || '')][0] ?? '';
    const s = ancient();
    const hit = s.cached(c);
    if (hit) return hit;
    // Ne jamais bloquer l'interface : au-delà de quelques secondes, « pending » (la recherche continue, l'UI redemande).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Promise<AncientResult>((r) => (timer = setTimeout(() => r({ status: 'pending', forms: [] }), ANCIENT_WAIT_MS)));
    try {
      return await Promise.race([s.get(c).catch((): AncientResult => ({ status: 'offline', forms: [] })), pending]);
    } finally {
      clearTimeout(timer);
    }
  });
}
