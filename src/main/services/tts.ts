// Voix de l'application — chaîne de priorité (cf. docs/tts-bench.md, docs/native-audio.md) :
//   1. enregistrement natif du mot / de la syllabe (resources/audio, voix humaines)
//   2. audio Tatoeba de la phrase (si licence de réutilisation ; téléchargé à la demande)
//   3. Matcha zh-baker (sherpa-onnx) dans un processus séparé (tts-worker.ts) ; mots : jetons pinyin + sandhi ;
//      textes longs : par morceaux de ≤ 50 caractères (les demandes courtes passent entre deux) ; texte que le modèle
//      ne sait pas lire (latin seul, symboles…) : écarté avant envoi (il ferait planter sherpa-onnx)
//   4. Piper (voix zh_CN-huayan-medium) + espeak-ng ; mots de 1-2 syllabes : correction des tons (tonefix.ts)
// - cache wav dans ctx.paths.tts (sha1 du texte + voix + version de rendu)
// - mode lent : jamais de synthèse ralentie, la lecture est ralentie côté interface (playbackRate)
// Pas de dépendance à Electron : testable/utilisable depuis un script Node.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { applySandhi, decodeWav, encodeWav, fixTones, parseTones, tonesFromEspeak, type Tone } from './tonefix';
import { bareWord, type NativeAudio, type TatoebaAudio } from './nativeAudio';

export const VOICE = 'zh_CN-huayan-medium';
/** À incrémenter quand le rendu change (invalide le cache). v7 : Matcha + lecture lente côté interface. */
export const RENDER_VERSION = 7;
const MAX_PARALLEL = 2;
const TIMEOUT_MS = 30_000;
/** Débit de lecture conseillé en mode lent (la synthèse reste à vitesse normale). */
export const SLOW_RATE = 0.75;
/** PiperTts.speak({slow}) utilisé directement (hors chaîne) : synthèse ralentie, ≈ 1,6× plus lent. */
const SLOW_LENGTH_SCALE = 1.9;

export interface SpeakOptions {
  /** Mode lent : le résultat porte `rate` (vitesse de lecture conseillée) ; l'audio n'est pas ralenti. */
  slow?: boolean;
  /** Ne pas corriger les tons (Piper : comparaison/débogage). */
  raw?: boolean;
  /** 'synth' : ignorer les enregistrements humains (comparaison, test de la voix). */
  engine?: 'auto' | 'synth';
  /** Pinyin numérique voulu pour `text` (sinon celui du programme / du dictionnaire). */
  pn?: string;
  /** Caractère seul : préférer l'enregistrement de la syllabe isolée (exercices de tons). */
  syllable?: boolean;
}

export type VoiceSource = 'native' | 'tatoeba' | 'matcha' | 'piper';

export interface SpeakResult {
  path: string;
  source: VoiceSource;
  /** Vitesse de lecture conseillée (mode lent). */
  rate?: number;
}

export interface TtsStatus {
  ok: boolean;
  engine: string;
  detail: string;
}

const HAN = /\p{Script=Han}/u;
const hanCount = (s: string) => [...s].filter((c) => HAN.test(c)).length;

export class PiperTts {
  private dir: string | null = null; // dossier exécutable de piper (éventuellement copié dans userData)
  private problem = '';
  private queue: (() => void)[] = [];
  private running = 0;
  private inflight = new Map<string, Promise<string | null>>();
  private toneCache = new Map<string, Tone[] | null>();

  constructor(
    private binDir: string,
    private cacheDir: string,
    private userDir: string,
  ) {}

  get srcDir() {
    return path.join(this.binDir, 'piper');
  }
  get modelPath() {
    return path.join(this.srcDir, 'voices', `${VOICE}.onnx`);
  }

  /** Prépare le binaire (droits d'exécution ; copie dans userData si le support est en lecture seule). */
  private ensure(): string | null {
    if (this.dir) return this.dir;
    const src = this.srcDir;
    const exe = path.join(src, 'piper');
    if (!fs.existsSync(exe)) {
      this.problem = `Piper introuvable (${exe}). Lancez « bash scripts/fetch-piper.sh ».`;
      return null;
    }
    if (!fs.existsSync(this.modelPath)) {
      this.problem = `Voix ${VOICE} introuvable (${this.modelPath}).`;
      return null;
    }
    if (isExecutable(exe) && isExecutable(path.join(src, 'espeak-ng'))) return (this.dir = src);
    try {
      fs.chmodSync(exe, 0o755);
      fs.chmodSync(path.join(src, 'espeak-ng'), 0o755);
      if (isExecutable(exe)) return (this.dir = src);
    } catch {
      /* système de fichiers en lecture seule (AppImage) : on copie */
    }
    try {
      const dst = path.join(this.userDir, 'piper-bin');
      const stamp = path.join(dst, '.version');
      const want = String(fs.statSync(exe).size);
      if (!fs.existsSync(stamp) || fs.readFileSync(stamp, 'utf8') !== want) {
        fs.rmSync(dst, { recursive: true, force: true });
        fs.mkdirSync(dst, { recursive: true });
        for (const e of fs.readdirSync(src)) if (e !== 'voices') fs.cpSync(path.join(src, e), path.join(dst, e), { recursive: true, dereference: true });
        fs.writeFileSync(stamp, want);
      }
      for (const f of ['piper', 'espeak-ng', 'piper_phonemize']) if (fs.existsSync(path.join(dst, f))) fs.chmodSync(path.join(dst, f), 0o755);
      return (this.dir = dst);
    } catch (e) {
      this.problem = `Impossible de rendre Piper exécutable : ${e instanceof Error ? e.message : e}`;
      return null;
    }
  }

  private env(dir: string): NodeJS.ProcessEnv {
    return { ...process.env, LD_LIBRARY_PATH: [dir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') };
  }

  status(): TtsStatus {
    const dir = this.ensure();
    if (!dir) return { ok: false, engine: 'piper', detail: this.problem };
    if (this.problem) return { ok: false, engine: 'piper', detail: this.problem };
    return { ok: true, engine: 'piper', detail: `Piper (voix ${VOICE}, hors-ligne)` };
  }

  /** Vérifie réellement la synthèse (utile au premier lancement). */
  async selfTest(): Promise<TtsStatus> {
    const r = await this.speak('你好。');
    if (r) this.problem = '';
    return r ? this.status() : { ok: false, engine: 'piper', detail: this.problem || 'Échec de la synthèse' };
  }

  cachePath(text: string, opts: SpeakOptions = {}): string {
    const key = `${VOICE}|v${RENDER_VERSION}|${opts.slow ? 'slow' : 'normal'}|${opts.raw ? 'raw' : 'fix'}|${text}`;
    return path.join(this.cacheDir, crypto.createHash('sha1').update(key).digest('hex') + '.wav');
  }

  /** Synthétise `text` → chemin du wav (cache), ou null si Piper est indisponible. */
  async speak(rawText: string, opts: SpeakOptions = {}): Promise<{ path: string } | null> {
    const text = normalize(rawText);
    if (!text) return null;
    const out = this.cachePath(text, opts);
    if (fs.existsSync(out) && fs.statSync(out).size > 44) return { path: out };
    if (!this.ensure()) return null;
    let p = this.inflight.get(out);
    if (!p) {
      p = this.enqueue(() => this.render(text, out, opts)).finally(() => this.inflight.delete(out));
      this.inflight.set(out, p);
    }
    const r = await p;
    return r ? { path: r } : null;
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        this.running++;
        job()
          .then(resolve, reject)
          .finally(() => {
            this.running--;
            this.queue.shift()?.();
          });
      };
      if (this.running < MAX_PARALLEL) run();
      else this.queue.push(run);
    });
  }

  private async render(text: string, out: string, opts: SpeakOptions): Promise<string | null> {
    const dir = this.ensure();
    if (!dir) return null;
    fs.mkdirSync(this.cacheDir, { recursive: true });
    const tmp = `${out}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    const args = ['--model', this.modelPath, '--espeak_data', path.join(dir, 'espeak-ng-data'), '--output_file', tmp, '-q', '--sentence_silence', '0.25'];
    if (opts.slow) args.push('--length_scale', String(SLOW_LENGTH_SCALE)); // la chaîne ne le demande jamais (lecture ralentie)
    try {
      await run(path.join(dir, 'piper'), args, text, this.env(dir));
      if (!fs.existsSync(tmp) || fs.statSync(tmp).size <= 44) throw new Error('Piper n’a produit aucun audio');
      // Mots courts : correction des tons d'après la phonémisation espeak (ce que Piper prononce réellement)
      const n = hanCount(text);
      if (!opts.raw && n >= 1 && n <= 2 && /^[\p{Script=Han}\s，。！？、,.!?…~～]+$/u.test(text)) {
        const tones = await this.tones(text);
        if (tones && tones.length === n && tones.some((t) => t !== 5)) {
          try {
            const { samples, sampleRate } = decodeWav(fs.readFileSync(tmp));
            const r = fixTones(samples, sampleRate, tones);
            if (r.changed) fs.writeFileSync(tmp, encodeWav(r.samples, sampleRate));
          } catch (e) {
            console.warn('[tts] correction des tons ignorée :', e);
          }
        }
      }
      fs.renameSync(tmp, out);
      this.problem = '';
      return out;
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      this.problem = `Synthèse Piper en échec : ${e instanceof Error ? e.message : e}`;
      console.error('[tts]', this.problem);
      return null;
    }
  }

  /** Tons réalisés (sandhi compris) selon espeak-ng ; un ton par caractère chinois. */
  async tones(text: string): Promise<Tone[] | null> {
    const t = normalize(text);
    if (this.toneCache.has(t)) return this.toneCache.get(t)!;
    const dir = this.ensure();
    if (!dir) return null;
    try {
      const outp = await run(path.join(dir, 'espeak-ng'), [`--path=${dir}`, '-v', 'cmn', '-q', '-x', t], null, this.env(dir));
      const r = tonesFromEspeak(outp);
      this.toneCache.set(t, r);
      return r;
    } catch (e) {
      console.warn('[tts] espeak-ng :', e);
      this.toneCache.set(t, null);
      return null;
    }
  }
}

/** Purge le cache audio au-delà de `maxBytes` (les fichiers les moins récemment utilisés partent d'abord). */
export function pruneCache(dir: string, maxBytes = 400 * 1024 * 1024): number {
  if (!fs.existsSync(dir)) return 0;
  const files: { p: string; size: number; t: number }[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.wav')) {
        const st = fs.statSync(p);
        files.push({ p, size: st.size, t: Math.max(st.atimeMs, st.mtimeMs) });
      }
    }
  };
  walk(dir);
  let total = files.reduce((s, f) => s + f.size, 0);
  let removed = 0;
  if (total <= maxBytes) return 0;
  for (const f of files.sort((a, b) => a.t - b.t)) {
    if (total <= maxBytes * 0.8) break;
    fs.rmSync(f.p, { force: true });
    total -= f.size;
    removed++;
  }
  return removed;
}

function isExecutable(f: string): boolean {
  try {
    fs.accessSync(f, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Nettoyage : une seule ligne (Piper synthétise une phrase par ligne), longueur bornée. */
export function normalize(text: string): string {
  return String(text ?? '')
    .trim()
    .replace(/[\r\n]+/g, '，')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

/** Lance un processus, écrit `input` sur stdin, renvoie stdout. */
function run(cmd: string, args: string[], input: string | null, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error(`délai dépassé (${cmd})`));
    }, TIMEOUT_MS);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${path.basename(cmd)} code ${code} : ${err.trim().slice(-300)}`));
    });
    p.stdin.on('error', () => {});
    if (input != null) p.stdin.end(input + '\n');
    else p.stdin.end();
  });
}

// =====================================================================================================
// Matcha zh-baker (sherpa-onnx) : jetons pinyin pour les mots
// =====================================================================================================

export interface MatchaLexicon {
  /** jetons connus du modèle (tokens.txt) */
  tokens: Set<string>;
  /** lecture d'un caractère seul (première entrée de lexicon.txt) */
  chars: Map<string, string>;
  /** tous les caractères seuls du lexique (ce que le modèle sait convertir en jetons) */
  spoken: Set<string>;
}

export function parseMatchaLexicon(tokensTxt: string, lexiconTxt: string): MatchaLexicon {
  const tokens = new Set<string>();
  for (const l of tokensTxt.split('\n')) {
    const t = l.trim().split(/\s+/)[0];
    if (t) tokens.add(t);
  }
  const chars = new Map<string, string>();
  const spoken = new Set<string>();
  for (const l of lexiconTxt.split('\n')) {
    const p = l.trim().split(/\s+/);
    if (p.length < 2 || [...p[0]].length !== 1) continue;
    spoken.add(p[0]);
    if (p.length === 2 && !chars.has(p[0])) chars.set(p[0], p[1]);
  }
  return { tokens, chars, spoken };
}

/**
 * Le modèle saura-t-il tirer au moins un jeton de `text` ? Sinon sherpa-onnx plante (SIGSEGV, « Failed to convert
 * '…' to token IDs ») : latin seul, « —— », « ♪ », emoji, chiffres pleine chasse, caractère absent du lexique (𠮷, 〇)…
 * Il suffit d'un caractère du lexique ou d'un chiffre ASCII (number.fst les écrit en caractères).
 */
export function matchaSpeakable(text: string, lex: MatchaLexicon | null): boolean {
  if (/[0-9]/.test(text)) return true;
  for (const c of text) if (lex ? lex.spoken.has(c) : HAN.test(c)) return true;
  return false;
}

/** Mots plus longs : texte brut (le lexique du modèle gère mieux l'enchaînement). */
export const MAX_TOKEN_SYLLABLES = 4;
const HAN_WORD = /^\p{Script=Han}+$/u;

/**
 * Jetons Matcha d'un mot à partir de son pinyin numérique : sandhi appliqué (3-3, 不, 一), ü → v ; syllabe au
 * ton neutre ou jeton inconnu du modèle → lecture du caractère dans le lexique du modèle. null si impossible.
 * Érhua (儿 en « r5 ») : le modèle n'a pas de jeton -r ; on omet 儿 (快点儿 → kuai4 dian3, plus proche de
 * « kuài diǎnr » qu'un « ér » détaché).
 *   matchaTokens('不对', 'bu4 dui4', lex) → ['bu2', 'dui4', '.']
 */
export function matchaTokens(word: string, pn: string | undefined, lex: MatchaLexicon): string[] | null {
  const all = [...word];
  if (!pn || !all.length || all.length > MAX_TOKEN_SYLLABLES || !HAN_WORD.test(word)) return null;
  const allSyl = pn.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (allSyl.length !== all.length) return null;
  const keep = all.map((c, i) => !(i > 0 && c === '儿' && allSyl[i] === 'r5'));
  const chars = all.filter((_, i) => keep[i]);
  const syl = allSyl.filter((_, i) => keep[i]);
  const tones = parseTones(syl.join(' '));
  if (!tones) return null;
  const heard = applySandhi(chars, tones);
  const out: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    const base = syl[i].replace(/[1-5]$/, '').replace(/u:|ü/g, 'v');
    if (!/^[a-z]+$/.test(base)) return null;
    let tok = `${base}${heard[i]}`;
    if (heard[i] === 5 || !lex.tokens.has(tok)) {
      const r = lex.chars.get(chars[i]);
      if (!r || !lex.tokens.has(r)) return null;
      tok = r;
    }
    out.push(tok);
  }
  return [...out, '.'];
}

export interface MatchaRequest {
  text: string;
  tokens?: string[];
}

/** Ce qu'on envoie au modèle : mot court → jetons (sinon mot + « 。 », jamais un mot nu) ; phrase → texte brut. */
export function matchaRequest(text: string, pn: string | undefined, lex: MatchaLexicon | null): MatchaRequest {
  const t = normalize(text);
  const w = bareWord(t);
  if (w && HAN_WORD.test(w) && [...w].length <= MAX_TOKEN_SYLLABLES) {
    const tokens = lex ? matchaTokens(w, pn, lex) : null;
    return tokens ? { text: w, tokens } : { text: `${w}。` };
  }
  return { text: t };
}

/** Texte long : synthèse par morceaux d'au plus CHUNK_CHARS caractères (le moteur ne reste jamais bloqué longtemps). */
export const CHUNK_CHARS = 50;
const CLOSE = '”」』"\'）)';
const SENTENCE_END = new RegExp(`(?<=[。！？!?；;…][${CLOSE}]*)(?![${CLOSE}。！？!?；;…])`, 'u');
const CLAUSE_END = new RegExp(`(?<=[，、,：:][${CLOSE}]*)(?![${CLOSE}，、,：:])`, 'u');

/**
 * Découpe un texte en morceaux à synthétiser séparément : phrases (。！？；…), puis propositions (，、：) si une phrase
 * dépasse `max`, puis coupe franche ; les morceaux courts consécutifs sont regroupés jusqu'à `max`.
 */
export function splitForSynthesis(text: string, max = CHUNK_CHARS): string[] {
  const t = normalize(text);
  if (!t) return [];
  if ([...t].length <= max) return [t];
  const len = (s: string) => [...s].length;
  const pieces: string[] = [];
  for (const sent of t.split(SENTENCE_END)) {
    if (len(sent) <= max) {
      pieces.push(sent);
      continue;
    }
    for (const cl of sent.split(CLAUSE_END)) {
      const cp = [...cl];
      for (let i = 0; i < cp.length; i += max) pieces.push(cp.slice(i, i + max).join(''));
    }
  }
  const out: string[] = [];
  for (const p of pieces) {
    const last = out[out.length - 1];
    if (last !== undefined && len(last) + len(p) <= max) out[out.length - 1] = last + p;
    else out.push(p);
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

// =====================================================================================================
// Processus de synthèse (tts-worker.ts)
// =====================================================================================================

export interface SynthOptions {
  /** Passe devant les requêtes ordinaires en attente (mot cliqué pendant la lecture d'un paragraphe). */
  urgent?: boolean;
}

export interface SynthWorker {
  /** Écrit le wav de `req` dans `out`. Lève en cas d'échec. */
  synth(req: MatchaRequest, out: string, opts?: SynthOptions): Promise<{ durationMs: number }>;
  usable(): boolean;
  problem: string;
}

export interface SherpaWorkerOptions {
  workerPath: string;
  modelDir: string;
  vocoder: string;
  /** Exécutable : Electron (process.execPath) lancé en mode Node. */
  execPath?: string;
  numThreads?: number;
  initTimeoutMs?: number;
  /** Délai de base d'une génération (défaut 15 s), auquel s'ajoute `genMsPerChar` par caractère du texte. */
  genTimeoutMs?: number;
  genMsPerChar?: number;
  /** Plantages / délais dépassés consécutifs tolérés avant abandon (repli Piper). */
  maxRestarts?: number;
  backoffMs?: number;
}

interface Pending {
  resolve: (r: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

interface QueuedJob {
  urgent: boolean;
  run: () => Promise<void>;
}

const requestKey = (req: MatchaRequest) => `${req.tokens?.join(' ') ?? ''}|${req.text}`;

/**
 * Pilote du processus sherpa-onnx : démarrage à la première demande, maintenu en vie, redémarré après un plantage
 * (attente croissante, au plus `maxRestarts` fois de suite), requêtes sérialisées (les urgentes passent devant),
 * délais bornés et proportionnels à la longueur du texte. Pendant une attente de redémarrage, les demandes échouent
 * immédiatement (la chaîne passe à Piper). Un texte qui a fait planter (ou dépasser le délai) n'est plus jamais
 * renvoyé au moteur : il ne peut donc pas épuiser à lui seul les redémarrages.
 */
export class SherpaWorker implements SynthWorker {
  problem = '';
  private proc: ChildProcess | null = null;
  private ready = false;
  private starting: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private queue: QueuedJob[] = [];
  private busy = false;
  private poisoned = new Set<string>();
  private failures = 0;
  private notBefore = 0;
  private disabled = false;
  private closed = false;
  private stderrTail = '';
  loadMs = 0;

  constructor(private o: SherpaWorkerOptions) {}

  private get maxRestarts() {
    return this.o.maxRestarts ?? 3;
  }

  /** Fichiers présents et pas abandonné. */
  usable(): boolean {
    if (this.disabled || this.closed) return false;
    for (const f of [this.o.workerPath, path.join(this.o.modelDir, 'model-steps-3.onnx'), path.join(this.o.modelDir, 'tokens.txt'), path.join(this.o.modelDir, 'lexicon.txt'), this.o.vocoder])
      if (!fs.existsSync(f)) {
        this.problem = `Modèle Matcha incomplet (${path.basename(f)} absent). Lancez « bash scripts/fetch-tts.sh ».`;
        return false;
      }
    return true;
  }

  get running(): boolean {
    return this.ready && !!this.proc;
  }

  synth(req: MatchaRequest, out: string, opts: SynthOptions = {}): Promise<{ durationMs: number }> {
    return this.enqueue(() => this.doSynth(req, out), !!opts.urgent);
  }

  /** Démarre le processus et charge le modèle (préchauffage). */
  warmUp(): Promise<void> {
    return this.enqueue(() => this.ensure(), false);
  }

  /** File d'attente : une requête à la fois ; les urgentes passent devant les ordinaires (ordre conservé entre elles). */
  private enqueue<T>(job: () => Promise<T>, urgent: boolean): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const item: QueuedJob = { urgent, run: () => job().then(resolve, reject) };
      const i = urgent ? this.queue.findIndex((q) => !q.urgent) : -1;
      if (i >= 0) this.queue.splice(i, 0, item);
      else this.queue.push(item);
      this.pump();
    });
  }

  private pump() {
    if (this.busy) return;
    const next = this.queue.shift();
    if (!next) return;
    this.busy = true;
    void next.run().finally(() => {
      this.busy = false;
      this.pump();
    });
  }

  /** Délai d'une génération : base + temps par caractère (un morceau de 50 caractères ≈ 1-2 s sur un CPU courant). */
  genTimeout(req: MatchaRequest): number {
    return (this.o.genTimeoutMs ?? 15_000) + (this.o.genMsPerChar ?? 60) * [...req.text].length;
  }

  private async doSynth(req: MatchaRequest, out: string): Promise<{ durationMs: number }> {
    const key = requestKey(req);
    if (this.poisoned.has(key)) throw new Error('texte écarté (il a déjà fait échouer la voix Matcha)');
    await this.ensure();
    let r: Record<string, unknown>;
    try {
      r = await this.request({ op: 'gen', text: req.text, tokens: req.tokens, out }, this.genTimeout(req));
    } catch (e) {
      this.poisoned.add(key);
      this.crashed(e instanceof Error ? e.message : String(e));
      throw e;
    }
    if (!r.ok) throw new Error(String(r.error ?? 'échec de la synthèse'));
    this.failures = 0;
    return { durationMs: Number(r.durationMs) || 0 };
  }

  private ensure(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('voix arrêtée'));
    if (this.disabled) return Promise.reject(new Error(this.problem || 'voix Matcha désactivée'));
    if (this.ready && this.proc) return Promise.resolve();
    if (Date.now() < this.notBefore) return Promise.reject(new Error('redémarrage de la voix Matcha en attente'));
    if (!this.starting) this.starting = this.start().finally(() => (this.starting = null));
    return this.starting;
  }

  private async start(): Promise<void> {
    if (!this.usable()) throw new Error(this.problem);
    this.stderrTail = '';
    let p: ChildProcess;
    try {
      p = spawn(this.o.execPath ?? process.execPath, [this.o.workerPath], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      this.crashed(`lancement impossible : ${e instanceof Error ? e.message : e}`);
      throw e;
    }
    this.proc = p;
    let buf = '';
    p.stdout!.setEncoding('utf8');
    p.stdout!.on('data', (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('{')) continue; // journaux de sherpa-onnx
        let m: Record<string, unknown>;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        const pend = this.pending.get(Number(m.id));
        if (pend) {
          clearTimeout(pend.timer);
          this.pending.delete(Number(m.id));
          pend.resolve(m);
        }
      }
    });
    p.stderr!.setEncoding('utf8');
    p.stderr!.on('data', (d: string) => (this.stderrTail = (this.stderrTail + d).slice(-2000)));
    p.stdin!.on('error', () => {});
    p.on('error', (e) => this.onExit(p, `erreur du processus : ${e.message}`));
    p.on('exit', (code, sig) => this.onExit(p, `processus de synthèse arrêté (${sig ?? code})`));
    const t0 = Date.now();
    let r: Record<string, unknown>;
    try {
      r = await this.request({ op: 'init', modelDir: this.o.modelDir, vocoder: this.o.vocoder, numThreads: this.o.numThreads ?? 1 }, this.o.initTimeoutMs ?? 45_000);
    } catch (e) {
      const why = `${e instanceof Error ? e.message : e}${this.stderrTail ? ` — ${lastLine(this.stderrTail)}` : ''}`;
      this.crashed(`chargement de Matcha en échec : ${why}`);
      throw new Error(this.problem);
    }
    if (!r.ok) {
      // erreur déterministe (addon introuvable, glibc trop ancienne, fichier manquant) : inutile d'insister
      this.disabled = true;
      this.problem = `Voix Matcha indisponible : ${lastLine(String(r.error ?? ''))}`;
      this.kill();
      throw new Error(this.problem);
    }
    this.loadMs = Date.now() - t0;
    this.ready = true;
    this.problem = '';
  }

  private request(msg: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    const p = this.proc;
    if (!p || !p.stdin || p.exitCode != null) return Promise.reject(new Error('processus de synthèse absent'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`délai dépassé (${Math.round(timeoutMs / 1000)} s)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      p.stdin!.write(JSON.stringify({ id, ...msg }) + '\n');
    });
  }

  private onExit(p: ChildProcess, why: string) {
    if (this.proc !== p) return;
    this.proc = null;
    this.ready = false;
    const err = new Error(`${why}${this.stderrTail ? ` — ${lastLine(this.stderrTail)}` : ''}`);
    for (const [id, pend] of this.pending) {
      clearTimeout(pend.timer);
      pend.reject(err);
      this.pending.delete(id);
    }
  }

  /** Plantage / délai dépassé : on tue le processus, on attend avant de relancer, on abandonne après N échecs. */
  private crashed(why: string) {
    this.kill();
    this.failures++;
    this.problem = why;
    if (this.failures > this.maxRestarts) {
      this.disabled = true;
      this.problem = `Voix Matcha abandonnée après ${this.failures} échecs : ${why}`;
      console.error('[tts]', this.problem);
    } else {
      this.notBefore = Date.now() + (this.o.backoffMs ?? 1000) * 2 ** (this.failures - 1);
      console.warn('[tts] Matcha :', why);
    }
  }

  private kill() {
    const p = this.proc;
    this.proc = null;
    this.ready = false;
    if (p) {
      for (const [id, pend] of this.pending) {
        clearTimeout(pend.timer);
        pend.reject(new Error('processus de synthèse arrêté'));
        this.pending.delete(id);
      }
      try {
        p.stdin?.end();
        p.kill('SIGKILL');
      } catch {
        /* déjà terminé */
      }
    }
  }

  /** Arrêt définitif (fermeture de l'application). */
  dispose() {
    this.closed = true;
    this.kill();
  }
}

function lastLine(s: string): string {
  const l = s.trim().split('\n').map((x) => x.trim()).filter(Boolean);
  return (l[l.length - 1] ?? '').slice(0, 300);
}

/** Texte court (≤ URGENT_CHARS) : requête urgente, servie avant les morceaux de paragraphe en attente. */
const URGENT_CHARS = 12;
/** Silence inséré entre deux morceaux d'un texte long. */
const CHUNK_GAP_S = 0.12;

const validWav = (f: string) => {
  try {
    return fs.statSync(f).size > 44;
  } catch {
    return false;
  }
};

/**
 * Voix Matcha : construit la requête (jetons pour les mots), écarte ce que le modèle ne sait pas lire (il planterait),
 * découpe les textes longs en morceaux synthétisés un à un puis assemblés, met le wav en cache, dédoublonne.
 */
export class MatchaVoice {
  private lex: MatchaLexicon | null | undefined;
  private inflight = new Map<string, Promise<string | null>>();

  constructor(
    readonly worker: SynthWorker,
    private modelDir: string,
    private cacheDir: string,
    /** pinyin numérique d'un mot (programme puis dictionnaire) */
    private pinyinOf: (w: string) => string | undefined,
  ) {}

  lexicon(): MatchaLexicon | null {
    if (this.lex !== undefined) return this.lex;
    try {
      this.lex = parseMatchaLexicon(fs.readFileSync(path.join(this.modelDir, 'tokens.txt'), 'utf8'), fs.readFileSync(path.join(this.modelDir, 'lexicon.txt'), 'utf8'));
    } catch {
      this.lex = null;
    }
    return this.lex;
  }

  request(text: string, opts: SpeakOptions = {}): MatchaRequest {
    const w = bareWord(normalize(text));
    return matchaRequest(text, opts.pn ?? this.pinyinOf(w), this.lexicon());
  }

  cachePath(req: MatchaRequest): string {
    const key = `matcha-zh-baker|v${RENDER_VERSION}|${req.tokens?.join(' ') ?? ''}|${req.text}`;
    return path.join(this.cacheDir, crypto.createHash('sha1').update(key).digest('hex') + '.wav');
  }

  async speak(text: string, opts: SpeakOptions = {}): Promise<string | null> {
    if (!normalize(text)) return null;
    const req = this.request(text, opts);
    if (!req.tokens && !matchaSpeakable(req.text, this.lexicon())) return null; // → Piper
    const out = this.cachePath(req);
    if (validWav(out)) return out;
    if (!this.worker.usable()) return null;
    let p = this.inflight.get(out);
    if (!p) {
      p = this.render(req, out).finally(() => this.inflight.delete(out));
      this.inflight.set(out, p);
    }
    return p;
  }

  private async render(req: MatchaRequest, out: string): Promise<string | null> {
    const chunks = req.tokens ? [] : splitForSynthesis(req.text);
    if (chunks.length <= 1) {
      await this.worker.synth(req, out, { urgent: !!req.tokens || [...req.text].length <= URGENT_CHARS });
      return validWav(out) ? out : null;
    }
    // Texte long : une requête par morceau (chacun en cache, réutilisable), envoyées l'une après l'autre pour
    // que les demandes courtes puissent passer entre deux ; puis assemblage avec un court silence.
    const lex = this.lexicon();
    const parts: Float32Array[] = [];
    let sr = 0;
    for (const c of chunks) {
      if (!matchaSpeakable(c, lex)) continue;
      const creq: MatchaRequest = { text: c };
      const cp = this.cachePath(creq);
      if (!validWav(cp)) await this.worker.synth(creq, cp);
      const w = decodeWav(fs.readFileSync(cp));
      if (sr && w.sampleRate !== sr) throw new Error('morceaux à des fréquences différentes');
      sr = w.sampleRate;
      parts.push(w.samples);
    }
    if (!parts.length) return null;
    const gap = Math.round(sr * CHUNK_GAP_S);
    const all = new Float32Array(parts.reduce((n, x) => n + x.length, 0) + gap * (parts.length - 1));
    let o = 0;
    for (const [i, x] of parts.entries()) {
      all.set(x, o);
      o += x.length + (i < parts.length - 1 ? gap : 0);
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const tmp = `${out}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, encodeWav(all, sr));
    fs.renameSync(tmp, out);
    return out;
  }
}

// =====================================================================================================
// Chaîne de priorité
// =====================================================================================================

export interface VoiceStep {
  source: VoiceSource;
  /** chemin d'un fichier audio, ou null pour passer à l'étape suivante (peut aussi lever) */
  speak(text: string, opts: SpeakOptions): Promise<string | null>;
}

export class VoiceChain {
  constructor(readonly steps: VoiceStep[]) {}

  async speak(text: string, opts: SpeakOptions = {}): Promise<SpeakResult | null> {
    if (!normalize(text)) return null;
    for (const s of this.steps) {
      if (opts.engine === 'synth' && (s.source === 'native' || s.source === 'tatoeba')) continue;
      try {
        const p = await s.speak(text, opts);
        if (p) return opts.slow ? { path: p, source: s.source, rate: SLOW_RATE } : { path: p, source: s.source };
      } catch (e) {
        console.warn(`[tts] ${s.source} :`, e instanceof Error ? e.message : e);
      }
    }
    return null;
  }
}

/** Étape « enregistrement natif » : mot entier, sinon syllabe isolée pour un caractère seul (tons 1-4). */
export function nativeStep(native: NativeAudio, pinyinOf: (w: string) => string | undefined): VoiceStep {
  return {
    source: 'native',
    async speak(text, opts) {
      const w = bareWord(normalize(text));
      if (!w) return null;
      const own = pinyinOf(w);
      const pn = opts.pn ?? own;
      const single = [...w].length === 1;
      const sameReading = !opts.pn || !own || squash(opts.pn) === squash(own);
      if (single && opts.syllable && pn) {
        const s = native.syllable(pn);
        if (s) return s;
      }
      if (sameReading) {
        const p = native.word(w);
        if (p) return p;
      }
      return single && pn ? native.syllable(pn) : null;
    },
  };
}

export function tatoebaStep(t: TatoebaAudio): VoiceStep {
  return { source: 'tatoeba', speak: (text) => t.get(text) };
}

const squash = (pn: string) => pn.toLowerCase().replace(/\s+/g, '').replace(/u:|v/g, 'ü');

const nf = (n: number) => n.toLocaleString('fr-FR');

/** Statut lisible de la chaîne (écran Réglages / Tons). */
export function describeVoices(s: {
  native: { words: number; syllables: number } | null;
  tatoeba: number;
  matcha: { usable: boolean; running: boolean; problem: string };
  piper: TtsStatus;
}): TtsStatus {
  const parts: string[] = [];
  const engines: string[] = [];
  if (s.native && s.native.words + s.native.syllables > 0) {
    parts.push(`Voix native (${nf(s.native.words)} mots, ${nf(s.native.syllables)} syllabes)`);
    engines.push('native');
  }
  if (s.tatoeba > 0) parts.push(`phrases Tatoeba (${nf(s.tatoeba)}, en ligne)`);
  if (s.matcha.usable) {
    parts.push(`Matcha (sherpa-onnx)${s.matcha.running ? '' : ' — se charge à la première écoute'}`);
    engines.push('matcha');
  }
  if (s.piper.ok) {
    parts.push(s.matcha.usable ? 'Piper en secours' : s.piper.detail);
    if (!s.matcha.usable) engines.push('piper');
  }
  const ok = s.matcha.usable || s.piper.ok;
  let detail = parts.join(' + ');
  if (!s.matcha.usable && s.matcha.problem) detail += `${detail ? ' — ' : ''}${s.matcha.problem}`;
  if (!ok) detail = [detail, s.piper.detail].filter(Boolean).join(' — ') || 'Aucune voix de synthèse disponible';
  return { ok, engine: engines.join(' + ') || 'aucune', detail };
}
