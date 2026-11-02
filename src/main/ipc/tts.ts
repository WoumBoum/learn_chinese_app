// Canaux tts:* — voix (natif > Tatoeba > Matcha > Piper, cf. services/tts.ts), extraits audio,
// sélection d'exercices de tons et de shadowing.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { app } from 'electron';
import type { Ctx } from '../ctx';
import { handle } from '../ctx';
import { MatchaVoice, PiperTts, SherpaWorker, VoiceChain, describeVoices, nativeStep, pruneCache, tatoebaStep, type SpeakOptions, type SpeakResult } from '../services/tts';
import { NativeAudio, TatoebaAudio, bareWord } from '../services/nativeAudio';
import { applySandhi, parseTones, splitSyllable, type Tone } from '../services/tonefix';
import type { Word } from '../../shared/types';

export interface DrillWord {
  w: string;
  py: string;
  /** pinyin numérique (minuscules) : référence syllabe native pour les mots d'un caractère */
  pn: string;
  tones: number[]; // tons du dictionnaire (5 = neutre)
  heard: number[]; // tons réellement prononcés (sandhi)
  fr: string;
  introduced: boolean;
}

export interface MinimalPair {
  kind: 'ton' | 'initiale' | 'finale';
  contrast: string; // ex. « zh / z », « 2e / 4e ton », « -n / -ng »
  a: { w: string; py: string; fr: string };
  b: { w: string; py: string; fr: string };
}

export interface ShadowItem {
  id: number;
  zh: string;
  fr: string;
  unknown: string[]; // caractères pas encore rencontrés
}

const HAN_ONLY = /^\p{Script=Han}+$/u;
const AUDIO_EXT = /\.(wav|mp3|m4a|mp4|webm|ogg|opus|mkv|aac|flac|mov)$/i;

export function register(ctx: Ctx): void {
  const tts = new PiperTts(ctx.paths.bin, ctx.paths.tts, ctx.paths.user);
  const pinyinOf = (w: string): string | undefined => ctx.content.wordMap.get(w)?.pn ?? ctx.content.dict[w]?.p;
  const native = new NativeAudio(ctx.paths.audio);
  const tatoeba = new TatoebaAudio(path.join(ctx.paths.data, 'tatoeba-audio.json'), ctx.paths.tts, () => ctx.content.sentences);
  const modelDir = path.join(ctx.paths.ttsModels, 'matcha-icefall-zh-baker');
  const worker = new SherpaWorker({
    workerPath: path.join(__dirname, 'tts-worker.js'),
    modelDir,
    vocoder: path.join(ctx.paths.ttsModels, 'vocos-22khz-univ.onnx'),
    // 2 fils si la machine a de la marge (synthèse ≈ 2× plus rapide), 1 sinon pour ne pas gêner l'interface
    numThreads: (os.availableParallelism?.() ?? os.cpus().length) >= 4 ? 2 : 1,
  });
  const matcha = new MatchaVoice(worker, modelDir, ctx.paths.tts, pinyinOf);
  const chain = new VoiceChain([
    nativeStep(native, pinyinOf),
    tatoebaStep(tatoeba),
    { source: 'matcha', speak: (text, o) => matcha.speak(text, o) },
    { source: 'piper', speak: async (text, o) => (await tts.speak(text, { raw: o.raw }))?.path ?? null },
  ]);
  app.on('will-quit', () => worker.dispose());
  const status = () =>
    describeVoices({
      native: native.available() ? native.stats() : null,
      tatoeba: tatoeba.count(),
      matcha: { usable: worker.usable(), running: worker.running, problem: worker.problem },
      piper: tts.status(),
    });
  /** Tons réellement prononcés : ceux du programme + sandhi (voix native / Matcha), sinon espeak (Piper).
   *  Variante érhua enregistrée (味儿 → 味) : syllabes différentes du mot, tons inconnus → null. */
  const heardTones = async (w: string): Promise<Tone[] | null> => {
    if (native.isVariant(w)) return null;
    const pn = ctx.content.wordMap.get(w)?.pn;
    const t = pn ? parseTones(pn) : null;
    if (t && t.length === [...w].length && (native.hasWord(w) || worker.usable())) return applySandhi([...w], t);
    return tts.tones(w);
  };

  // entretien du cache audio, puis préchargement du modèle Matcha (≈ 3 s) en tâche de fond après le démarrage
  setTimeout(() => {
    try {
      pruneCache(ctx.paths.tts);
    } catch (e) {
      console.warn('[tts] purge du cache :', e);
    }
    if (worker.usable()) worker.warmUp().catch(() => {});
  }, 12_000).unref?.();

  handle('tts:speak', (text: string, opts?: SpeakOptions): Promise<SpeakResult | null> => chain.speak(text, opts ?? {}));
  handle('tts:status', () => status());
  handle('tts:selfTest', async () => {
    const r = await chain.speak('你好。', { engine: 'synth' });
    const s = status();
    if (!r) return { ...s, ok: false, detail: `Échec de la synthèse — ${s.detail}` };
    return { ...s, ok: true, detail: `${s.detail} (test : ${r.source === 'matcha' ? 'Matcha' : 'Piper'} ✔)` };
  });
  handle('tts:tones', (text: string) => heardTones(bareWord(text)));
  /** Enregistrement natif d'une syllabe (« ma3 ») ou null (ton neutre, syllabe absente). */
  handle('tts:syllable', (pn: string) => {
    const p = native.syllable(pn);
    return p ? { path: p, source: 'native' as const } : null;
  });

  /** Lit un fichier audio/vidéo local (pour l'analyse de hauteur côté renderer). */
  handle('tts:readAudio', (p: string) => {
    if (!p || !AUDIO_EXT.test(p) || !fs.existsSync(p)) throw new Error('Fichier audio introuvable');
    if (fs.statSync(p).size > 400 * 1024 * 1024) throw new Error('Fichier trop volumineux pour être analysé');
    return new Uint8Array(fs.readFileSync(p));
  });

  /** Extrait [start, end] d'un média en wav mono 16 kHz (ffmpeg) ; null si ffmpeg est indisponible. */
  handle('tts:clip', async (p: string, start: number, end: number) => {
    if (!p || !fs.existsSync(p)) throw new Error('Fichier introuvable');
    const s = Math.max(0, Number(start) || 0);
    const e = Math.max(s + 0.2, Number(end) || s + 5);
    const dir = path.join(ctx.paths.tts, 'clips');
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, crypto.createHash('sha1').update(`${p}|${s.toFixed(3)}|${e.toFixed(3)}`).digest('hex') + '.wav');
    if (fs.existsSync(out) && fs.statSync(out).size > 44) return { path: out };
    for (const ff of ffmpegCandidates(ctx.paths.bin)) {
      const ok = await new Promise<boolean>((resolve) => {
        const pr = spawn(ff, ['-v', 'error', '-y', '-ss', s.toFixed(3), '-t', (e - s).toFixed(3), '-i', p, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', out], { stdio: 'ignore' });
        pr.on('error', () => resolve(false));
        pr.on('close', (code) => resolve(code === 0));
      });
      if (ok && fs.existsSync(out) && fs.statSync(out).size > 44) return { path: out };
    }
    return null;
  });

  /** Exercices de tons : pas d'érhua (儿 en « r5 » : une seule syllabe à l'oral, zhèr) ni de mot dont
   *  l'enregistrement est une variante (味儿 → 味, 好好 → 好好儿) — la réponse attendue ne correspondrait pas au son. */
  const toneSafe = (w: Word) => !/(^|\s)r5(\s|$)/i.test(w.pn) && !native.isVariant(w.w);

  /** Mots de 1 ou 2 syllabes pour l'entraînement aux tons, mots déjà introduits en priorité,
   *  combinaisons de tons équilibrées, et tons vérifiés contre la prononciation réelle (espeak). */
  handle('tts:toneDrill', async (n: number = 20, opts: { syllables?: 1 | 2 } = {}): Promise<DrillWord[]> => {
    const syl = opts.syllables ?? 2;
    const intro = ctx.cur.introducedWords();
    const cands = ctx.content.words.filter((w) => {
      if ([...w.w].length !== syl || !HAN_ONLY.test(w.w) || !toneSafe(w)) return false;
      const t = parseTones(w.pn);
      if (!t || t.length !== syl) return false;
      if (syl === 1) return t[0] !== 5 && !/[A-Z]/.test(w.pn); // majuscule = lecture « nom propre » probable
      // 2 syllabes : 1re syllabe tonique ; on évite 一/不 (sandhi traité à part dans la leçon)
      return t[0] !== 5 && w.w[0] !== '一' && w.w[0] !== '不';
    });
    const key = (w: Word) => parseTones(w.pn)!.join('');
    // ordre de priorité : introduits (mélangés) puis ordre du programme
    const pri = [...shuffle(cands.filter((w) => intro.has(w.w))), ...cands.filter((w) => !intro.has(w.w)).slice(0, 900)];
    const buckets = new Map<string, Word[]>();
    for (const w of pri) {
      const k = key(w);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k)!.push(w);
    }
    // tourniquet sur les combinaisons pour les couvrir toutes
    const order = shuffle([...buckets.keys()]);
    const out: DrillWord[] = [];
    const seen = new Set<string>();
    let guard = 0;
    while (out.length < n && guard++ < n * 12) {
      let progressed = false;
      for (const k of order) {
        if (out.length >= n) break;
        const b = buckets.get(k)!;
        // dans chaque combinaison : les introduits d'abord, puis un peu de hasard parmi les plus fréquents
        const w = b.length ? b.splice(intro.has(b[0].w) ? 0 : Math.floor(Math.random() * Math.min(4, b.length)), 1)[0] : undefined;
        if (!w || seen.has(w.w)) continue;
        progressed = true;
        seen.add(w.w);
        const dictTones = parseTones(w.pn)!;
        const expected = applySandhi([...w.w], dictTones);
        const heard = await heardTones(w.w);
        // repli Piper : on exige l'accord dictionnaire ↔ prononciation espeak (élimine les lectures douteuses)
        if (heard && !sameTones(heard, expected)) continue;
        out.push({ w: w.w, py: w.py, pn: w.pn.toLowerCase(), tones: dictTones, heard: heard ?? expected, fr: w.fr[0] ?? '', introduced: intro.has(w.w) });
      }
      if (!progressed) break;
    }
    return shuffle(out);
  });

  /** Paires minimales : mots qui ne diffèrent que par le ton, l'initiale ou la finale (pièges des francophones). */
  handle('tts:minimalPairs', async (n: number = 12): Promise<MinimalPair[]> => {
    const intro = ctx.cur.introducedWords();
    const pool = ctx.content.words.filter((w) => HAN_ONLY.test(w.w) && w.w.length <= 2 && w.rank < 2500 && toneSafe(w) && !/[A-Z]/.test(w.pn) && parseTones(w.pn)?.length === w.w.length);
    const pairs: (MinimalPair & { score: number })[] = [];
    const info = (w: Word) => ({ w: w.w, py: w.py, fr: w.fr[0] ?? '' });
    const score = (a: Word, b: Word) => (intro.has(a.w) ? 0 : 1000) + (intro.has(b.w) ? 0 : 1000) + a.rank + b.rank + Math.random() * 300;
    // 1) ton : même pinyin sans tons, tons différents
    const byBase = new Map<string, Word[]>();
    for (const w of pool) {
      const k = w.pn.toLowerCase().replace(/\d/g, '');
      if (!byBase.has(k)) byBase.set(k, []);
      byBase.get(k)!.push(w);
    }
    for (const g of byBase.values())
      for (let i = 0; i < g.length; i++)
        for (let j = i + 1; j < g.length; j++) {
          const ta = parseTones(g[i].pn)!.join('');
          const tb = parseTones(g[j].pn)!.join('');
          if (ta === tb || ta.includes('5') !== tb.includes('5')) continue;
          pairs.push({ kind: 'ton', contrast: `${ta.split('').join('-')} / ${tb.split('').join('-')}`, a: info(g[i]), b: info(g[j]), score: score(g[i], g[j]) });
        }
    // 2) initiale / finale (mots d'une syllabe)
    const mono = pool.filter((w) => w.w.length === 1).map((w) => ({ w, s: splitSyllable(w.pn) })).filter((x) => x.s);
    const idx = new Map<string, typeof mono>();
    for (const x of mono) {
      for (const k of [`I|${x.s!.final}|${x.s!.tone}`, `F|${x.s!.initial}|${x.s!.tone}`]) {
        if (!idx.has(k)) idx.set(k, []);
        idx.get(k)!.push(x);
      }
    }
    for (const [k, g] of idx) {
      const isInit = k.startsWith('I|');
      for (let i = 0; i < g.length; i++)
        for (let j = i + 1; j < g.length; j++) {
          const a = g[i].s!;
          const b = g[j].s!;
          const c = isInit ? confusable(INITIAL_PAIRS, a.initial, b.initial) : confusable(FINAL_PAIRS, a.final, b.final);
          if (!c) continue;
          pairs.push({ kind: isInit ? 'initiale' : 'finale', contrast: c, a: info(g[i].w), b: info(g[j].w), score: score(g[i].w, g[j].w) });
        }
    }
    pairs.sort((x, y) => x.score - y.score);
    // variété : au plus 2 paires par contraste, mélange des trois types
    const per = new Map<string, number>();
    const used = new Set<string>();
    const chosen: MinimalPair[] = [];
    for (const p of pairs) {
      if (chosen.length >= n * 2) break;
      if ((per.get(p.contrast) ?? 0) >= 2 || used.has(p.a.w) || used.has(p.b.w)) continue;
      per.set(p.contrast, (per.get(p.contrast) ?? 0) + 1);
      used.add(p.a.w);
      used.add(p.b.w);
      chosen.push({ kind: p.kind, contrast: p.contrast, a: p.a, b: p.b });
    }
    // vérification de la prononciation réelle (tons) pour les paires de tons
    const out: MinimalPair[] = [];
    for (const p of interleave(chosen)) {
      if (out.length >= n) break;
      if (p.kind === 'ton') {
        const ok = await Promise.all([p.a, p.b].map(async (x) => {
          const heard = await heardTones(x.w);
          const w = ctx.content.wordMap.get(x.w)!;
          return !heard || sameTones(heard, applySandhi([...x.w], parseTones(w.pn)!));
        }));
        if (!ok.every(Boolean)) continue;
      }
      out.push(Math.random() < 0.5 ? p : { ...p, a: p.b, b: p.a });
    }
    return out;
  });

  /** Phrases courtes composées de caractères connus (ou les plus simples à défaut) pour le shadowing. */
  handle('tts:shadowSet', (n: number = 8): ShadowItem[] => {
    const known = ctx.cur.knownChars();
    for (const c of ctx.cur.introducedChars()) known.add(c);
    // Début de parcours : on autorise les caractères des 150 premiers mots du programme (mots de survie)
    const allowed = new Set(known);
    if (known.size < 40) for (const w of ctx.content.words.slice(0, 150)) for (const c of w.w) allowed.add(c);
    const rank = (c: string) => ctx.content.chars[c]?.i ?? 9999;
    const scored: (ShadowItem & { len: number; hard: number; outside: number })[] = [];
    for (const s of ctx.content.sentences) {
      if (!/^[\p{Script=Han}，。！？、]+$/u.test(s.zh)) continue;
      const han = [...s.zh].filter((c) => /\p{Script=Han}/u.test(c));
      if (han.length < 4 || han.length > 12) continue;
      const distinct = new Set(han);
      if (distinct.size < 3 || han.length - distinct.size > han.length / 3) continue; // évite « 爱爱爱 », « 等等等 »
      const unknown = [...new Set(han.filter((c) => !known.has(c)))];
      const outside = new Set(han.filter((c) => !allowed.has(c))).size;
      scored.push({ id: s.id, zh: s.zh, fr: s.fr[0] ?? '', unknown, len: han.length, hard: Math.max(...han.map(rank)), outside });
    }
    const allKnown = scored.filter((s) => s.outside === 0);
    let pick: typeof scored;
    if (allKnown.length >= n) {
      // les plus courtes d'abord, avec un peu de variété
      allKnown.sort((a, b) => a.len - b.len);
      pick = shuffle(allKnown.slice(0, Math.max(n * 4, 40))).slice(0, n);
    } else {
      const rest = scored.filter((s) => s.outside > 0).sort((a, b) => a.outside - b.outside || a.hard - b.hard || a.len - b.len);
      pick = [...shuffle(allKnown), ...shuffle(rest.slice(0, n * 4)).sort((a, b) => a.outside - b.outside || a.len - b.len)].slice(0, n);
    }
    return pick.sort((a, b) => a.len - b.len).map(({ id, zh, fr, unknown }) => ({ id, zh, fr, unknown }));
  });
}

function sameTones(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function interleave(p: MinimalPair[]): MinimalPair[] {
  const groups = (['ton', 'initiale', 'finale'] as const).map((k) => p.filter((x) => x.kind === k));
  const out: MinimalPair[] = [];
  for (let i = 0; out.length < p.length; i++) for (const g of groups) if (g[i]) out.push(g[i]);
  return out;
}

// ---------- pinyin ----------
const INITIAL_PAIRS: [string, string, string][] = [
  ['zh', 'z', 'zh / z'],
  ['ch', 'c', 'ch / c'],
  ['sh', 's', 'sh / s'],
  ['zh', 'j', 'zh / j'],
  ['ch', 'q', 'ch / q'],
  ['sh', 'x', 'sh / x'],
  ['b', 'p', 'b / p (aspiration)'],
  ['d', 't', 'd / t (aspiration)'],
  ['g', 'k', 'g / k (aspiration)'],
  ['z', 'c', 'z / c (aspiration)'],
  ['zh', 'ch', 'zh / ch (aspiration)'],
  ['j', 'q', 'j / q (aspiration)'],
  ['r', 'l', 'r / l'],
  ['n', 'l', 'n / l'],
  ['h', 'f', 'h / f'],
];
const FINAL_PAIRS: [string, string, string][] = [
  ['an', 'ang', '-an / -ang'],
  ['en', 'eng', '-en / -eng'],
  ['in', 'ing', '-in / -ing'],
  ['ian', 'iang', '-ian / -iang'],
  ['uan', 'uang', '-uan / -uang'],
  ['u', 'ü', 'u / ü'],
  ['ü', 'i', 'ü / i'],
  ['e', 'ei', 'e / ei'],
  ['ou', 'uo', 'ou / uo'],
  ['ie', 'ei', 'ie / ei'],
];

function confusable(table: [string, string, string][], a: string, b: string): string | null {
  for (const [x, y, label] of table) if ((a === x && b === y) || (a === y && b === x)) return label;
  return null;
}

function ffmpegCandidates(bin: string): string[] {
  return [path.join(bin, 'ffmpeg'), path.join(bin, 'ffmpeg', 'ffmpeg'), 'ffmpeg'].filter((p) => p === 'ffmpeg' || fs.existsSync(p));
}
