// Synthèse vocale locale : Piper (voix zh_CN-huayan-medium) + espeak-ng (phonémisation, tons).
// - cache wav dans ctx.paths.tts (sha1 du texte + voix + options)
// - file d'attente (2 synthèses simultanées au maximum), dédoublonnage des demandes identiques
// - mots de 1-2 syllabes : correction des tons (voir tonefix.ts)
// Pas de dépendance à Electron : testable/utilisable depuis un script Node.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { decodeWav, encodeWav, fixTones, tonesFromEspeak, type Tone } from './tonefix';

export const VOICE = 'zh_CN-huayan-medium';
/** À incrémenter quand le rendu change (invalide le cache). */
const RENDER_VERSION = 6;
const MAX_PARALLEL = 2;
const TIMEOUT_MS = 30_000;
const SLOW_LENGTH_SCALE = 1.9; // ≈ 1,6× plus lent (mesuré : 1,55 ne donnait que ≈ 1,25×)

export interface SpeakOptions {
  slow?: boolean;
  /** Ne pas corriger les tons (comparaison/débogage). */
  raw?: boolean;
}

export interface TtsStatus {
  ok: boolean;
  engine: 'piper';
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
    if (opts.slow) args.push('--length_scale', String(SLOW_LENGTH_SCALE));
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
