import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MatchaVoice,
  SherpaWorker,
  VoiceChain,
  describeVoices,
  matchaRequest,
  matchaSpeakable,
  matchaTokens,
  splitForSynthesis,
  CHUNK_CHARS,
  nativeStep,
  parseMatchaLexicon,
  SLOW_RATE,
  type MatchaLexicon,
  type MatchaRequest,
  type SynthOptions,
  type SynthWorker,
  type VoiceStep,
} from '../src/main/services/tts';
import { decodeWav, encodeWav } from '../src/main/services/tonefix';
import { lexiconChars, speakable } from '../src/main/tts-worker';
import type { NativeAudio } from '../src/main/services/nativeAudio';

// lexique miniature au format du modèle (tokens.txt : « jeton id » ; lexicon.txt : « mot jetons… »)
const TOKENS = ['_', ',', '.', 'bu2', 'bu4', 'dui4', 'ke2', 'ke3', 'yi1', 'yi2', 'yi3', 'yi4', 'yang4', 'ge4', 'de', 'de2', 'chang2', 'zhang3', 'nv3', 'er2', 'lv4', 'lve4', 'ni2', 'ni3', 'hao3', 'zhan2', 'lan2', 'lan3', 'guan3', 'shui2', 'xing2', 'na3', 'zi', 'zi3', 'peng2', 'you3', 'you', 'wo3']
  .map((t, i) => `${t} ${i}`)
  .join('\n');
const LEXICON = ['一 yi1', '不 bu4', '对 dui4', '的 de', '得 de2', '长 zhang3', '长 chang2', '谁 shui2', '儿 er2', '子 zi3', '友 you3', '可以 ke2 yi3', '长大 zhang3 da4', '我 wo3', '兛 qian1 ke4'].join('\n');
const lex: MatchaLexicon = parseMatchaLexicon(TOKENS, LEXICON);

describe('parseMatchaLexicon', () => {
  it('jetons + première lecture des caractères seuls', () => {
    expect(lex.tokens.has('bu2')).toBe(true);
    expect(lex.chars.get('长')).toBe('zhang3'); // première entrée
    expect(lex.chars.has('可以')).toBe(false); // mots : non retenus
    expect(lex.chars.has('兛')).toBe(false); // deux syllabes : pas une lecture simple…
    expect(lex.spoken.has('兛')).toBe(true); // …mais le modèle sait le lire
  });
});

describe('matchaTokens : pinyin du programme + sandhi', () => {
  it('不 + 4e ton → bu2', () => expect(matchaTokens('不对', 'bu4 dui4', lex)).toEqual(['bu2', 'dui4', '.']));
  it('3-3 → 2-3', () => expect(matchaTokens('可以', 'ke3 yi3', lex)).toEqual(['ke2', 'yi3', '.']));
  it('3-3-3 → 2-2-3', () => expect(matchaTokens('展览馆', 'zhan3 lan3 guan3', lex)).toEqual(['zhan2', 'lan2', 'guan3', '.']));
  it('一 + 4e ton → yi2 ; 一个 → yi2 ; 一 seul → yi1', () => {
    expect(matchaTokens('一样', 'yi1 yang4', lex)).toEqual(['yi2', 'yang4', '.']);
    expect(matchaTokens('一个', 'yi1 ge4', lex)).toEqual(['yi2', 'ge4', '.']);
    expect(matchaTokens('一', 'yi1', lex)).toEqual(['yi1', '.']);
  });
  it('polyphone isolé : lecture du programme (长 cháng, pas zhǎng du lexique)', () => expect(matchaTokens('长', 'chang2', lex)).toEqual(['chang2', '.']));
  it('ton neutre → lecture du caractère dans le lexique', () => {
    expect(matchaTokens('的', 'de5', lex)).toEqual(['de', '.']);
    expect(matchaTokens('儿子', 'er2 zi5', lex)).toEqual(['er2', 'zi3', '.']);
    expect(matchaTokens('朋友', 'peng2 you5', lex)).toEqual(['peng2', 'you3', '.']);
  });
  it('érhua sur 2 caractères (这儿, 哪儿) : jamais les jetons du mot sans 儿 (这 « ce » ≠ 这儿 « ici »)', () => {
    const l = { ...lex, tokens: new Set([...lex.tokens, 'zhe4', 'na3']) };
    expect(matchaTokens('这儿', 'zhe4 r5', l)).toBeNull();
    expect(matchaTokens('哪儿', 'na3 r5', l)).toBeNull();
    expect(matchaTokens('这儿', 'zhe4 r5', l)).not.toEqual(matchaTokens('这', 'zhe4', l));
    expect(matchaRequest('这儿', 'zhe4 r5', l)).toEqual({ text: '这儿。' });
    expect(matchaRequest('这', 'zhe4', l)).toEqual({ text: '这', tokens: ['zhe4', '.'] });
  });
  it('érhua (r5) : 儿 omis, pas de « ér » détaché', () => {
    expect(matchaTokens('快点儿', 'kuai4 dian3 r5', { ...lex, tokens: new Set([...lex.tokens, 'kuai4', 'dian3']) })).toEqual(['kuai4', 'dian3', '.']);
    expect(matchaTokens('一点儿', 'yi1 dian3 r5', { ...lex, tokens: new Set([...lex.tokens, 'dian3']) })).toEqual(['yi4', 'dian3', '.']);
    expect(matchaTokens('儿', 'r5', lex)).toEqual(['er2', '.']); // 儿 seul : lu tel quel
    expect(matchaTokens('儿子', 'er2 zi5', lex)).toEqual(['er2', 'zi3', '.']); // 儿 plein : conservé
  });
  it('ü → v (ü, u:, majuscules)', () => {
    expect(matchaTokens('女儿', 'nü3 er2', lex)).toEqual(['nv3', 'er2', '.']);
    expect(matchaTokens('绿', 'lu:4', lex)).toEqual(['lv4', '.']);
    expect(matchaTokens('略', 'LÜE4', lex)).toEqual(['lve4', '.']);
  });
  it('jeton absent du modèle → lecture du lexique (谁 shei2 → shui2)', () => expect(matchaTokens('谁', 'shei2', lex)).toEqual(['shui2', '.']));
  it('impossible → null', () => {
    expect(matchaTokens('谁', undefined, lex)).toBeNull(); // pas de pinyin
    expect(matchaTokens('能不能', 'neng2 bùnéng', lex)).toBeNull(); // pinyin mal formé
    expect(matchaTokens('眼里', 'yǎnli', lex)).toBeNull();
    expect(matchaTokens('鬼', 'gui3', lex)).toBeNull(); // jeton et caractère inconnus
    expect(matchaTokens('啊', 'a5', lex)).toBeNull(); // ton neutre, caractère absent du lexique
    expect(matchaTokens('一二三四五', 'yi1 er4 san1 si4 wu3', lex)).toBeNull(); // > 4 syllabes
    expect(matchaTokens('ok', 'ok1', lex)).toBeNull();
  });
});

describe('matchaSpeakable : ce qui ferait planter sherpa-onnx est écarté', () => {
  it('rien de lisible → false', () => {
    for (const t of ['A', 'OK', 'Jack', 'ＯＫ', 'é', '♪♪', '——', '“——”', '🙂', '𠮷', '〇', '１２３', '。', '，'])
      expect(matchaSpeakable(t, lex), t).toBe(false);
  });
  it('au moins un caractère du lexique ou un chiffre ASCII → true', () => {
    for (const t of ['我叫Jack。', '♪我♪', '一——', '123', '50%', '对🙂', '兛']) expect(matchaSpeakable(t, lex), t).toBe(true);
  });
  it('même règle dans le processus de synthèse', () => {
    const chars = lexiconChars(LEXICON);
    for (const t of ['——', 'OK', '𠮷', '我叫Jack。', '123']) expect(speakable(t, chars), t).toBe(matchaSpeakable(t, lex));
  });
});

describe('splitForSynthesis', () => {
  const para = '我明天需要知道。他说：“好的！”你呢？' + '我们一起去吧，'.repeat(12) + '好不好？';
  it('texte court : un seul morceau', () => expect(splitForSynthesis('  我明天需要知道。\n')).toEqual(['我明天需要知道。']));
  it('morceaux ≤ max, rien de perdu, coupe aux fins de phrase (guillemets fermants compris)', () => {
    const c = splitForSynthesis(para);
    expect(c.length).toBeGreaterThan(1);
    for (const x of c) expect([...x].length).toBeLessThanOrEqual(CHUNK_CHARS);
    expect(c.join('')).toBe(para);
    for (const x of c.slice(0, -1)) expect(x, x).toMatch(/[。！？，]$/u); // jamais au milieu d'une proposition
    for (const x of c) expect(x, x).not.toMatch(/^[”，。！？]/u); // ni entre « ！ » et « ” »
  });
  it('phrase trop longue sans ponctuation : coupe franche', () => {
    const c = splitForSynthesis('好'.repeat(120), 50);
    expect(c.map((x) => x.length)).toEqual([50, 50, 20]);
  });
  it('vide → []', () => expect(splitForSynthesis('  ')).toEqual([]));
});

describe('matchaRequest', () => {
  it('mot court avec pinyin → jetons, sans ponctuation', () => expect(matchaRequest('不对。', 'bu4 dui4', lex)).toEqual({ text: '不对', tokens: ['bu2', 'dui4', '.'] }));
  it('mot court sans jetons → mot + 。 (jamais nu)', () => {
    expect(matchaRequest('鬼', 'gui3', lex)).toEqual({ text: '鬼。' });
    expect(matchaRequest('鬼', undefined, null)).toEqual({ text: '鬼。' });
  });
  it('phrase → texte brut', () => expect(matchaRequest(' 我明天需要知道。\n', undefined, lex)).toEqual({ text: '我明天需要知道。' }));
});

// ---------------------------------------------------------------- chaîne
function step(source: VoiceStep['source'], result: string | null | 'throw', log: string[]): VoiceStep {
  return {
    source,
    async speak() {
      log.push(source);
      if (result === 'throw') throw new Error('boom');
      return result;
    },
  };
}

describe('VoiceChain : natif > Tatoeba > Matcha > Piper', () => {
  it('premier résultat gagnant, ordre respecté', async () => {
    const log: string[] = [];
    const c = new VoiceChain([step('native', null, log), step('tatoeba', null, log), step('matcha', '/m.wav', log), step('piper', '/p.wav', log)]);
    expect(await c.speak('你好')).toEqual({ path: '/m.wav', source: 'matcha' });
    expect(log).toEqual(['native', 'tatoeba', 'matcha']);
  });
  it('natif en premier', async () => {
    const log: string[] = [];
    const c = new VoiceChain([step('native', '/n.opus', log), step('tatoeba', '/t.mp3', log), step('matcha', '/m.wav', log), step('piper', '/p.wav', log)]);
    expect(await c.speak('好')).toEqual({ path: '/n.opus', source: 'native' });
    expect(log).toEqual(['native']);
  });
  it('erreur d’une étape → étape suivante ; Piper en dernier recours', async () => {
    const log: string[] = [];
    const c = new VoiceChain([step('native', null, log), step('tatoeba', 'throw', log), step('matcha', 'throw', log), step('piper', '/p.wav', log)]);
    expect(await c.speak('我们试试看！')).toEqual({ path: '/p.wav', source: 'piper' });
    expect(log).toEqual(['native', 'tatoeba', 'matcha', 'piper']);
  });
  it('engine:synth saute les enregistrements humains', async () => {
    const log: string[] = [];
    const c = new VoiceChain([step('native', '/n.opus', log), step('tatoeba', '/t.mp3', log), step('matcha', '/m.wav', log)]);
    expect(await c.speak('好', { engine: 'synth' })).toEqual({ path: '/m.wav', source: 'matcha' });
    expect(log).toEqual(['matcha']);
  });
  it('mode lent : vitesse de lecture conseillée, pas de rendu ralenti', async () => {
    const c = new VoiceChain([step('matcha', '/m.wav', [])]);
    expect(await c.speak('好', { slow: true })).toEqual({ path: '/m.wav', source: 'matcha', rate: SLOW_RATE });
  });
  it('rien → null ; texte vide → null sans appel', async () => {
    const log: string[] = [];
    const c = new VoiceChain([step('native', null, log), step('piper', null, log)]);
    expect(await c.speak('好')).toBeNull();
    expect(await c.speak('  ')).toBeNull();
    expect(log).toEqual(['native', 'piper']);
  });
});

describe('nativeStep', () => {
  const fake = {
    word: (w: string) => ({ 好: '/w/好.opus', 行: '/w/行.opus' })[w] ?? null,
    syllable: (pn: string) => ({ hao3: '/s/hao3.opus', chang2: '/s/chang2.opus', hang2: '/s/hang2.opus', xing2: '/s/xing2.opus' })[pn.toLowerCase()] ?? null,
  } as unknown as NativeAudio;
  const pn: Record<string, string> = { 好: 'hao3', 长: 'chang2', 行: 'xing2', 的: 'de5' };
  const s = nativeStep(fake, (w) => pn[w]);
  it('mot enregistré', async () => expect(await s.speak('好。', {})).toBe('/w/好.opus'));
  it('syllabe préférée pour les exercices de tons', async () => expect(await s.speak('好', { syllable: true })).toBe('/s/hao3.opus'));
  it('caractère sans mot enregistré → syllabe de sa lecture', async () => expect(await s.speak('长', {})).toBe('/s/chang2.opus'));
  it('autre lecture demandée → pas l’enregistrement du mot', async () => expect(await s.speak('行', { pn: 'hang2' })).toBe('/s/hang2.opus'));
  it('ton neutre / mot inconnu → null', async () => {
    expect(await s.speak('的', {})).toBeNull();
    expect(await s.speak('银行', {})).toBeNull();
  });
});

describe('describeVoices', () => {
  const piperOk = { ok: true, engine: 'piper', detail: 'Piper (voix zh_CN-huayan-medium, hors-ligne)' };
  it('natif + Matcha', () => {
    const r = describeVoices({ native: { words: 2844, syllables: 1680 }, tatoeba: 0, matcha: { usable: true, running: true, problem: '' }, piper: piperOk });
    expect(r.ok).toBe(true);
    expect(r.engine).toBe('native + matcha');
    expect(r.detail).toMatch(/^Voix native \(2.844 mots, 1.680 syllabes\) \+ Matcha \(sherpa-onnx\) \+ Piper en secours$/);
  });
  it('Matcha indisponible → Piper, raison donnée', () => {
    const r = describeVoices({ native: null, tatoeba: 0, matcha: { usable: false, running: false, problem: 'Voix Matcha indisponible : GLIBC_2.32 not found' }, piper: piperOk });
    expect(r).toMatchObject({ ok: true, engine: 'piper' });
    expect(r.detail).toMatch(/GLIBC/);
  });
  it('aucune synthèse', () => {
    const r = describeVoices({ native: { words: 1, syllables: 1 }, tatoeba: 0, matcha: { usable: false, running: false, problem: '' }, piper: { ok: false, engine: 'piper', detail: 'Piper introuvable' } });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/Piper introuvable/);
  });
});

// ---------------------------------------------------------------- MatchaVoice (moteur simulé)
class FakeWorker implements SynthWorker {
  problem = '';
  calls: MatchaRequest[] = [];
  urgent: boolean[] = [];
  ok = true;
  /** écrit un vrai wav (100 échantillons à la valeur 0,5) au lieu d'octets nuls */
  wav = false;
  usable() {
    return this.ok;
  }
  async synth(req: MatchaRequest, out: string, opts: SynthOptions = {}) {
    this.calls.push(req);
    this.urgent.push(!!opts.urgent);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, this.wav ? encodeWav(new Float32Array(100).fill(0.5), 1000) : Buffer.alloc(100));
    return { durationMs: 500 };
  }
}

describe('MatchaVoice', () => {
  let d = '';
  beforeAll(() => {
    d = fs.mkdtempSync(path.join(os.tmpdir(), 'om-matcha-'));
    fs.mkdirSync(path.join(d, 'model'));
    fs.writeFileSync(path.join(d, 'model/tokens.txt'), TOKENS);
    fs.writeFileSync(path.join(d, 'model/lexicon.txt'), LEXICON);
  });
  afterAll(() => fs.rmSync(d, { recursive: true, force: true }));

  it('jetons depuis le pinyin du programme, cache et dédoublonnage', async () => {
    const w = new FakeWorker();
    const v = new MatchaVoice(w, path.join(d, 'model'), path.join(d, 'cache'), (x) => ({ 不对: 'bu4 dui4' })[x]);
    const [a, b] = await Promise.all([v.speak('不对'), v.speak('不对。')]);
    expect(a).toBe(b);
    expect(w.calls).toEqual([{ text: '不对', tokens: ['bu2', 'dui4', '.'] }]);
    expect(await v.speak('不对')).toBe(a);
    expect(w.calls.length).toBe(1);
  });
  it('pinyin explicite prioritaire ; phrase brute', async () => {
    const w = new FakeWorker();
    const v = new MatchaVoice(w, path.join(d, 'model'), path.join(d, 'cache2'), () => 'zhang3');
    await v.speak('长', { pn: 'chang2' });
    await v.speak('我们走吧。');
    expect(w.calls).toEqual([{ text: '长', tokens: ['chang2', '.'] }, { text: '我们走吧。' }]);
  });
  it('texte illisible par le modèle → null sans appel (sinon plantage natif)', async () => {
    const w = new FakeWorker();
    const v = new MatchaVoice(w, path.join(d, 'model'), path.join(d, 'cache4'), () => undefined);
    for (const t of ['——', '♪♪', 'OK', '𠮷', '🙂']) expect(await v.speak(t), t).toBeNull();
    expect(w.calls).toEqual([]);
  });
  it('mots et textes courts : requête urgente ; texte long : morceaux ordinaires assemblés', async () => {
    const w = new FakeWorker();
    w.wav = true;
    const v = new MatchaVoice(w, path.join(d, 'model'), path.join(d, 'cache5'), (x) => ({ 不对: 'bu4 dui4' })[x]);
    await v.speak('不对');
    await v.speak('我们走吧。');
    expect(w.urgent).toEqual([true, true]);
    const long = '我们走吧。'.repeat(14) + '——。'; // 73 caractères : 2 morceaux
    const out = await v.speak(long);
    expect(w.calls.slice(2).map((c) => [...c.text].length)).toEqual([50, 23]);
    expect(w.calls.slice(2).every((c) => !c.tokens)).toBe(true);
    expect(w.urgent.slice(2)).toEqual([false, false]);
    const { samples, sampleRate } = decodeWav(fs.readFileSync(out!));
    expect(sampleRate).toBe(1000);
    expect(samples.length).toBe(100 + 120 + 100); // 2 morceaux + 0,12 s de silence
    expect(samples[150]).toBe(0);
    // morceaux en cache : le même paragraphe ou une de ses phrases ne relance rien
    const n = w.calls.length;
    expect(await v.speak(long)).toBe(out);
    expect(w.calls.length).toBe(n);
  });
  it('moteur inutilisable → null (la chaîne passe à Piper)', async () => {
    const w = new FakeWorker();
    w.ok = false;
    const v = new MatchaVoice(w, path.join(d, 'model'), path.join(d, 'cache3'), () => undefined);
    expect(await v.speak('你好')).toBeNull();
  });
});

// ---------------------------------------------------------------- SherpaWorker (faux processus Node)
const FAKE_WORKER = `
const fs = require('fs');
const rl = require('readline').createInterface({ input: process.stdin });
const mode = process.env.FAKE_TTS_MODE || 'ok';
console.log('journal de sherpa (ignoré)');
rl.on('line', (l) => {
  const r = JSON.parse(l);
  const send = (o) => process.stdout.write(JSON.stringify({ id: r.id, ...o }) + '\\n');
  if (r.op === 'init') {
    if (mode === 'badinit') return send({ ok: false, error: 'Could not find sherpa-onnx-node' });
    if (process.env.ELECTRON_RUN_AS_NODE !== '1') return send({ ok: false, error: 'ELECTRON_RUN_AS_NODE absent' });
    return send({ ok: true, sampleRate: 22050, loadMs: 1 });
  }
  if (r.op === 'gen') {
    if (r.text === 'CRASH') process.exit(3);
    if (r.text.startsWith('HANG')) return;
    if (r.text === 'FAIL') return send({ ok: false, error: 'aucun échantillon produit' });
    if (r.text.startsWith('SLOW')) {
      const t = Date.now();
      while (Date.now() - t < 150) {}
    }
    fs.writeFileSync(r.out, r.text + '|' + (r.tokens || []).join(' ') + '|' + process.pid);
    return send({ ok: true, durationMs: 100 });
  }
});
`;

describe('SherpaWorker', () => {
  let d = '';
  const mk = (o: Partial<ConstructorParameters<typeof SherpaWorker>[0]> = {}) =>
    new SherpaWorker({ workerPath: path.join(d, 'fake-worker.js'), modelDir: path.join(d, 'm'), vocoder: path.join(d, 'voc.onnx'), execPath: process.execPath, genTimeoutMs: 1500, initTimeoutMs: 5000, backoffMs: 10, ...o });
  const read = (f: string) => fs.readFileSync(f, 'utf8').split('|');
  beforeAll(() => {
    d = fs.mkdtempSync(path.join(os.tmpdir(), 'om-worker-'));
    fs.writeFileSync(path.join(d, 'fake-worker.js'), FAKE_WORKER);
    fs.mkdirSync(path.join(d, 'm'));
    for (const f of ['model-steps-3.onnx', 'tokens.txt', 'lexicon.txt']) fs.writeFileSync(path.join(d, 'm', f), 'x');
    fs.writeFileSync(path.join(d, 'voc.onnx'), 'x');
  });
  afterAll(() => fs.rmSync(d, { recursive: true, force: true }));

  it('démarrage paresseux, requêtes sérialisées, processus réutilisé', async () => {
    const w = mk();
    expect(w.running).toBe(false);
    const outs = [0, 1, 2].map((i) => path.join(d, `o${i}.wav`));
    await Promise.all(outs.map((o, i) => w.synth({ text: `t${i}`, tokens: i === 0 ? ['bu2', '.'] : undefined }, o)));
    expect(w.running).toBe(true);
    expect(read(outs[0]).slice(0, 2)).toEqual(['t0', 'bu2 .']);
    expect(new Set(outs.map((o) => read(o)[2])).size).toBe(1); // un seul processus
    w.dispose();
    expect(w.running).toBe(false);
    expect(w.usable()).toBe(false);
  });

  it('plantage → erreur, puis redémarrage après attente', async () => {
    const w = mk();
    await w.synth({ text: 'a' }, path.join(d, 'c1.wav'));
    const pid1 = read(path.join(d, 'c1.wav'))[2];
    await expect(w.synth({ text: 'CRASH' }, path.join(d, 'c2.wav'))).rejects.toThrow(/arrêté/);
    await new Promise((r) => setTimeout(r, 30));
    await w.synth({ text: 'b' }, path.join(d, 'c3.wav'));
    expect(read(path.join(d, 'c3.wav'))[2]).not.toBe(pid1);
    w.dispose();
  });

  it('pendant l’attente de redémarrage : échec immédiat (pas de blocage)', async () => {
    const w = mk({ backoffMs: 60_000 });
    await expect(w.synth({ text: 'CRASH' }, path.join(d, 'x.wav'))).rejects.toThrow();
    const t0 = Date.now();
    await expect(w.synth({ text: 'a' }, path.join(d, 'x.wav'))).rejects.toThrow(/attente/);
    expect(Date.now() - t0).toBeLessThan(500);
    w.dispose();
  });

  it('délai dépassé → processus tué ; abandon après N échecs', async () => {
    const w = mk({ genTimeoutMs: 200, maxRestarts: 1 });
    await expect(w.synth({ text: 'HANG1' }, path.join(d, 'h.wav'))).rejects.toThrow(/délai/);
    await new Promise((r) => setTimeout(r, 30));
    await expect(w.synth({ text: 'HANG2' }, path.join(d, 'h.wav'))).rejects.toThrow(/délai/);
    expect(w.usable()).toBe(false);
    expect(w.problem).toMatch(/abandonnée/);
    await expect(w.synth({ text: 'a' }, path.join(d, 'h.wav'))).rejects.toThrow();
    w.dispose();
  });

  it('les requêtes urgentes passent devant les ordinaires en attente', async () => {
    const w = mk();
    await w.warmUp();
    const done: string[] = [];
    const go = (t: string, urgent = false) => w.synth({ text: t }, path.join(d, `q-${t}.wav`), { urgent }).then(() => done.push(t));
    const first = go('SLOW1');
    await new Promise((r) => setTimeout(r, 40)); // SLOW1 en cours ; les suivantes attendent
    await Promise.all([first, go('SLOW2'), go('SLOW3'), go('mot', true)]);
    expect(done).toEqual(['SLOW1', 'mot', 'SLOW2', 'SLOW3']);
    w.dispose();
  });

  it('délai proportionnel à la longueur du texte', () => {
    const w = mk({ genTimeoutMs: 1000, genMsPerChar: 10 });
    expect(w.genTimeout({ text: '好' })).toBe(1010);
    expect(w.genTimeout({ text: '好'.repeat(50) })).toBe(1500);
  });

  it('un texte qui a fait planter n’est plus envoyé (ne consomme pas les redémarrages)', async () => {
    const w = mk({ maxRestarts: 1 });
    await expect(w.synth({ text: 'CRASH' }, path.join(d, 'p.wav'))).rejects.toThrow(/arrêté/);
    await new Promise((r) => setTimeout(r, 30));
    for (let i = 0; i < 3; i++) await expect(w.synth({ text: 'CRASH' }, path.join(d, 'p.wav'))).rejects.toThrow(/écarté/);
    expect(w.usable()).toBe(true);
    await w.synth({ text: 'ok' }, path.join(d, 'p.wav'));
    w.dispose();
  });

  it('erreur de synthèse (réponse ok:false) : pas un plantage', async () => {
    const w = mk({ maxRestarts: 0 });
    await expect(w.synth({ text: 'FAIL' }, path.join(d, 'f.wav'))).rejects.toThrow(/aucun échantillon/);
    expect(w.usable()).toBe(true);
    await w.synth({ text: 'ok' }, path.join(d, 'f.wav'));
    w.dispose();
  });

  it('échec de chargement déterministe (addon introuvable) → désactivé immédiatement', async () => {
    process.env.FAKE_TTS_MODE = 'badinit';
    try {
      const w = mk();
      await expect(w.synth({ text: 'a' }, path.join(d, 'b.wav'))).rejects.toThrow(/sherpa-onnx-node/);
      expect(w.usable()).toBe(false);
      expect(w.problem).toMatch(/Matcha indisponible/);
      w.dispose();
    } finally {
      delete process.env.FAKE_TTS_MODE;
    }
  });

  it('modèle absent → inutilisable, sans lancer de processus', async () => {
    const w = mk({ vocoder: path.join(d, 'absent.onnx') });
    expect(w.usable()).toBe(false);
    expect(w.problem).toMatch(/fetch-tts/);
    await expect(w.synth({ text: 'a' }, path.join(d, 'z.wav'))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------- vrai lexique du modèle
const MODEL = path.resolve(__dirname, '../resources/tts/matcha-icefall-zh-baker');
describe.runIf(fs.existsSync(path.join(MODEL, 'lexicon.txt')))('lexique réel matcha-icefall-zh-baker', () => {
  const real = parseMatchaLexicon(fs.readFileSync(path.join(MODEL, 'tokens.txt'), 'utf8'), fs.readFileSync(path.join(MODEL, 'lexicon.txt'), 'utf8'));
  it('mots du banc d’essai', () => {
    expect(matchaTokens('不对', 'bu4 dui4', real)).toEqual(['bu2', 'dui4', '.']);
    expect(matchaTokens('长', 'chang2', real)).toEqual(['chang2', '.']);
    expect(matchaTokens('可以', 'ke3 yi3', real)).toEqual(['ke2', 'yi3', '.']);
    expect(matchaTokens('一样', 'yi1 yang4', real)).toEqual(['yi2', 'yang4', '.']);
    expect(matchaTokens('女儿', 'nü3 er2', real)).toEqual(['nv3', 'er2', '.']);
    expect(matchaTokens('谁', 'shei2', real)?.[0]).toBe('shui2');
    expect(matchaTokens('的', 'de5', real)).toEqual(['de', '.']);
  });
  it('couvre presque tous les mots du programme (≤ 4 syllabes)', () => {
    const words = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../resources/data/words.json'), 'utf8')) as { w: string; pn: string }[];
    const short = words.filter((w) => [...w.w].length <= 4);
    const ok = short.filter((w) => matchaTokens(w.w, w.pn, real)).length;
    expect(ok / short.length).toBeGreaterThan(0.97);
  });
});
