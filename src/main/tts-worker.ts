// Processus de synthèse sherpa-onnx (Matcha zh-baker + vocos), lancé par services/tts.ts avec ELECTRON_RUN_AS_NODE=1
// (l'addon N-API ne se charge pas dans le processus principal d'Electron).
// Protocole : une requête JSON par ligne sur stdin, une réponse JSON par ligne sur stdout (traitées une par une).
//   {id, op:'init', modelDir, vocoder, numThreads?}      → {id, ok, sampleRate, loadMs}
//   {id, op:'gen', text?, tokens?, out, speed?}          → {id, ok, durationMs}   (WAV PCM 16 bits mono écrit dans `out`)
//   {id, op:'ping'}                                      → {id, ok}
//   erreur                                               → {id, ok:false, error}
// Le processus s'arrête quand stdin se ferme (fin ou plantage du processus principal).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

interface Req {
  id: number;
  op: 'init' | 'gen' | 'ping';
  modelDir?: string;
  vocoder?: string;
  numThreads?: number;
  text?: string;
  tokens?: string[];
  out?: string;
  speed?: number;
}

interface SherpaTts {
  sampleRate: number;
  generate(o: unknown): { samples: Float32Array; sampleRate: number };
}

let tts: SherpaTts | null = null;
let loadedKey = '';
/** caractères seuls du lexique : un texte sans aucun d'eux (ni chiffre ASCII) ferait planter sherpa-onnx (SIGSEGV) */
let spoken: Set<string> | null = null;

export function lexiconChars(lexiconTxt: string): Set<string> {
  const s = new Set<string>();
  for (const l of lexiconTxt.split('\n')) {
    const w = l.trim().split(/\s+/)[0];
    if (w && [...w].length === 1) s.add(w);
  }
  return s;
}

/** Même règle que matchaSpeakable (services/tts.ts), dupliquée ici par sécurité : le plantage est natif, non rattrapable. */
export function speakable(text: string, chars: Set<string> | null): boolean {
  if (!chars || /[0-9]/.test(text)) return true;
  for (const c of text) if (chars.has(c)) return true;
  return false;
}

function send(o: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(o) + '\n');
}

function init(r: Req): { sampleRate: number; loadMs: number } {
  const M = r.modelDir!;
  const key = `${M}|${r.vocoder}|${r.numThreads ?? 1}`;
  if (tts && key === loadedKey) return { sampleRate: tts.sampleRate, loadMs: 0 };
  for (const f of ['model-steps-3.onnx', 'lexicon.txt', 'tokens.txt']) if (!fs.existsSync(path.join(M, f))) throw new Error(`fichier manquant : ${path.join(M, f)}`);
  if (!r.vocoder || !fs.existsSync(r.vocoder)) throw new Error(`vocodeur manquant : ${r.vocoder}`);
  const t0 = Date.now();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sherpa = require('sherpa-onnx-node');
  const fsts = ['date.fst', 'phone.fst', 'number.fst'].map((f) => path.join(M, f)).filter((f) => fs.existsSync(f));
  tts = new sherpa.OfflineTts({
    model: {
      matcha: { acousticModel: path.join(M, 'model-steps-3.onnx'), vocoder: r.vocoder, lexicon: path.join(M, 'lexicon.txt'), tokens: path.join(M, 'tokens.txt') },
      numThreads: r.numThreads ?? 1,
      provider: 'cpu',
      debug: 0,
    },
    maxNumSentences: 1,
    ruleFsts: fsts.join(','),
  }) as SherpaTts;
  spoken = lexiconChars(fs.readFileSync(path.join(M, 'lexicon.txt'), 'utf8'));
  loadedKey = key;
  return { sampleRate: tts.sampleRate, loadMs: Date.now() - t0 };
}

export function encodeWav16(x: Float32Array, sr: number): Buffer {
  const b = Buffer.alloc(44 + x.length * 2);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + x.length * 2, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24);
  b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), 44 + i * 2);
  return b;
}

function gen(r: Req): { durationMs: number } {
  if (!tts) throw new Error('moteur non initialisé');
  if (!r.out) throw new Error('chemin de sortie manquant');
  const text = String(r.text ?? '').trim();
  const tokens = Array.isArray(r.tokens) && r.tokens.length ? r.tokens.map(String) : null;
  if (!text && !tokens) throw new Error('texte vide');
  if (!tokens && !speakable(text, spoken)) throw new Error('texte sans caractère prononçable par le modèle');
  const req: Record<string, unknown> = { text: text || '。', sid: 0, speed: r.speed ?? 1.0, enableExternalBuffer: false };
  if (tokens) req.generationConfig = { tokens: [tokens], sid: 0, speed: r.speed ?? 1.0 };
  const audio = tts.generate(req);
  if (!audio || !audio.samples || audio.samples.length === 0) throw new Error('aucun échantillon produit');
  fs.mkdirSync(path.dirname(r.out), { recursive: true });
  const tmp = `${r.out}.${process.pid}.w.tmp`;
  fs.writeFileSync(tmp, encodeWav16(audio.samples, audio.sampleRate));
  fs.renameSync(tmp, r.out);
  return { durationMs: Math.round((audio.samples.length / audio.sampleRate) * 1000) };
}

function handleLine(line: string) {
  let r: Req;
  try {
    r = JSON.parse(line);
  } catch {
    return;
  }
  try {
    if (r.op === 'init') send({ id: r.id, ok: true, ...init(r) });
    else if (r.op === 'gen') send({ id: r.id, ok: true, ...gen(r) });
    else if (r.op === 'ping') send({ id: r.id, ok: true });
    else send({ id: r.id, ok: false, error: `opération inconnue : ${r.op}` });
  } catch (e) {
    send({ id: r.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

if (typeof require !== 'undefined' && require.main === module) {
  // Synthèse synchrone : les lignes sont naturellement traitées une par une, dans l'ordre.
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', handleLine);
  rl.on('close', () => process.exit(0));
  process.on('uncaughtException', (e) => {
    process.stderr.write(`[tts-worker] ${e instanceof Error ? e.stack : e}\n`);
    process.exit(1);
  });
  send({ id: 0, ok: true, ready: true, pid: process.pid });
}
