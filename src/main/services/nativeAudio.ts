// Enregistrements humains : voix native des mots / syllabes (resources/audio, audio-cmn, CC BY-SA)
// et audio Tatoeba des phrases (téléchargé à la demande, seulement s'il a une licence de réutilisation).
// Pur Node (pas d'Electron) → testable avec vitest.
import fs from 'node:fs';
import path from 'node:path';

export interface NativeIndex {
  words: Record<string, string>;
  syllables: Record<string, string>;
  variants?: Record<string, string>;
  excluded?: Record<string, string>;
}

/** Ponctuation de fin acceptée autour d'un mot isolé (« 好。 » → « 好 »). */
const EDGE_PUNCT = /^[\s，。！？、,.!?…~～「」“”"']+|[\s，。！？、,.!?…~～「」“”"']+$/gu;
export const bareWord = (text: string) => String(text ?? '').replace(EDGE_PUNCT, '');

/** « nü3 », « nv3 », « lu:4 », « Nü3 » → « nü3 » (clé de l'index) ; null si pas de ton 1-4. */
export function syllableKey(pn: string): string | null {
  const s = String(pn ?? '').trim().toLowerCase().replace(/u:|v/g, 'ü');
  return /^[a-zü]+[1-4]$/.test(s) ? s : null;
}

export class NativeAudio {
  private idx: NativeIndex | null = null;
  private loaded = false;
  problem = '';

  constructor(private dir: string) {}

  private index(): NativeIndex | null {
    if (this.loaded) return this.idx;
    this.loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.dir, 'index.json'), 'utf8')) as NativeIndex;
      if (!raw || typeof raw.words !== 'object' || typeof raw.syllables !== 'object') throw new Error('index.json invalide');
      this.idx = raw;
    } catch (e) {
      this.problem = `Enregistrements natifs indisponibles (${e instanceof Error ? e.message : e})`;
      this.idx = null;
    }
    return this.idx;
  }

  private abs(rel: string | undefined): string | null {
    if (!rel) return null;
    const p = path.join(this.dir, rel);
    return fs.existsSync(p) ? p : null;
  }

  available(): boolean {
    return !!this.index();
  }

  stats(): { words: number; syllables: number } {
    const i = this.index();
    return { words: i ? Object.keys(i.words).length : 0, syllables: i ? Object.keys(i.syllables).length : 0 };
  }

  /** Le mot a-t-il un enregistrement (sans vérifier le fichier) ? */
  hasWord(text: string): boolean {
    const i = this.index();
    const w = bareWord(text);
    return !!i && !!(i.words[w] ?? (i.variants?.[w] ? i.words[i.variants[w]] : undefined));
  }

  /**
   * L'enregistrement du mot est-il celui d'une variante (avec/sans 儿 : 这儿 → 这, 好好 → 好好儿) ? Son nombre de
   * syllabes / ses tons ne correspondent alors pas au pinyin du programme : à écarter des exercices de tons.
   */
  isVariant(text: string): boolean {
    return !!this.index()?.variants?.[bareWord(text)];
  }

  /** Chemin absolu de l'enregistrement du mot (clé exacte, puis variante érhua de l'index), sinon null. */
  word(text: string): string | null {
    const i = this.index();
    if (!i) return null;
    const w = bareWord(text);
    if (!w) return null;
    const direct = this.abs(i.words[w]);
    if (direct) return direct;
    const v = i.variants?.[w];
    return v ? this.abs(i.words[v]) : null;
  }

  /** Syllabe isolée en pinyin numérique (ton 1-4 ; pas de ton neutre enregistré). */
  syllable(pn: string): string | null {
    const i = this.index();
    const k = syllableKey(pn);
    if (!i || !k) return null;
    return this.abs(i.syllables[k] ?? i.syllables[k.replace(/ü/g, 'v')]);
  }
}

// ---------------------------------------------------------------- Tatoeba
export interface TatoebaEntry {
  /** id de l'enregistrement (≠ id de la phrase) */
  a: number;
  by: string;
  lic: string;
  url?: string;
}

export interface TatoebaFile {
  sentences: Record<string, TatoebaEntry>;
}

export const tatoebaAudioUrl = (audioId: number) => `https://tatoeba.org/audio/download/${audioId}`;

type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

/** Normalisation pour retrouver une phrase par son texte. */
export const normSentence = (s: string) => String(s ?? '').replace(/[\s，。！？、,.!?…~～「」“”"']/gu, '');

/** Signature d'un fichier audio plausible (MP3 / Ogg / WAV / M4A). */
export function looksLikeAudio(b: Uint8Array): boolean {
  if (b.length < 512) return false;
  const s = String.fromCharCode(...b.subarray(0, 12));
  if (s.startsWith('ID3') || s.startsWith('OggS') || s.startsWith('RIFF') || s.startsWith('fLaC') || s.slice(4, 8) === 'ftyp') return true;
  return b[0] === 0xff && (b[1] & 0xe0) === 0xe0; // trame MPEG
}

/**
 * Audio humain des phrases Tatoeba : uniquement les enregistrements dont la licence permet la réutilisation
 * (resources/data/tatoeba-audio.json, généré par scripts/build-tatoeba-audio.mjs). Téléchargement à la demande
 * (délai court), mis en cache ; toute erreur → null (la chaîne passe à la synthèse). Hors-ligne : on n'insiste pas.
 */
export class TatoebaAudio {
  private data: TatoebaFile | null = null;
  private loaded = false;
  private byText: Map<string, number> | null = null;
  private offlineUntil = 0;
  private failed = new Map<number, number>();
  private inflight = new Map<number, Promise<string | null>>();

  constructor(
    private jsonPath: string,
    private cacheDir: string,
    private sentences: () => { id: number; zh: string }[],
    private fetchFn: FetchLike = (globalThis.fetch as unknown as FetchLike),
    private timeoutMs = 5000,
    private now: () => number = Date.now,
  ) {}

  private file(): TatoebaFile | null {
    if (this.loaded) return this.data;
    this.loaded = true;
    try {
      const d = JSON.parse(fs.readFileSync(this.jsonPath, 'utf8')) as TatoebaFile;
      this.data = d && typeof d.sentences === 'object' ? d : null;
    } catch {
      this.data = null;
    }
    return this.data;
  }

  count(): number {
    return Object.keys(this.file()?.sentences ?? {}).length;
  }

  /** Entrée Tatoeba (avec licence) correspondant exactement au texte, sinon null. */
  lookup(text: string): (TatoebaEntry & { id: number }) | null {
    const f = this.file();
    if (!f || !this.count()) return null;
    if (!this.byText) {
      this.byText = new Map();
      for (const s of this.sentences()) if (f.sentences[String(s.id)]) this.byText.set(normSentence(s.zh), s.id);
    }
    const id = this.byText.get(normSentence(text));
    return id != null ? { ...f.sentences[String(id)], id } : null;
  }

  cachePath(audioId: number): string {
    return path.join(this.cacheDir, 'tatoeba', `${audioId}.mp3`);
  }

  /** Chemin local de l'audio de la phrase (téléchargé si besoin), ou null. Ne lève jamais. */
  async get(text: string): Promise<string | null> {
    const e = this.lookup(text);
    if (!e) return null;
    const out = this.cachePath(e.a);
    try {
      if (fs.existsSync(out) && fs.statSync(out).size > 512) return out;
    } catch {
      /* ignore */
    }
    const t = this.now();
    if (t < this.offlineUntil || (this.failed.get(e.a) ?? 0) > t) return null;
    let p = this.inflight.get(e.a);
    if (!p) {
      p = this.download(e.a, out).finally(() => this.inflight.delete(e.a));
      this.inflight.set(e.a, p);
    }
    return p;
  }

  private async download(audioId: number, out: string): Promise<string | null> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const r = await this.fetchFn(tatoebaAudioUrl(audioId), { signal: ctl.signal, headers: { 'User-Agent': 'OperationMandarin/1.0 (usage personnel)' } });
      if (!r.ok) {
        // 404 / 403 : inutile de réessayer avant longtemps ; 429 / 5xx : pause globale
        if (r.status === 429 || r.status >= 500) this.offlineUntil = this.now() + 10 * 60_000;
        else this.failed.set(audioId, this.now() + 24 * 3600_000);
        return null;
      }
      const buf = new Uint8Array(await r.arrayBuffer());
      if (!looksLikeAudio(buf)) {
        this.failed.set(audioId, this.now() + 24 * 3600_000);
        return null;
      }
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const tmp = `${out}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, out);
      return out;
    } catch {
      // réseau absent / délai dépassé : on ne retente pas pendant 5 min (ne jamais bloquer l'interface)
      this.offlineUntil = this.now() + 5 * 60_000;
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
