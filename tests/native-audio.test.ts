import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NativeAudio, TatoebaAudio, bareWord, looksLikeAudio, syllableKey, tatoebaAudioUrl, normSentence } from '../src/main/services/nativeAudio';

const REAL = path.resolve(__dirname, '../resources/audio');

let dir = '';
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-native-'));
  fs.mkdirSync(path.join(dir, 'words'));
  fs.mkdirSync(path.join(dir, 'syllables'));
  for (const f of ['words/597d.opus', 'words/8fd9.opus', 'words/73a9-513f.opus', 'syllables/hao3.opus', 'syllables/nv3.opus', 'syllables/lve4.opus']) fs.writeFileSync(path.join(dir, f), 'x');
  fs.writeFileSync(
    path.join(dir, 'index.json'),
    JSON.stringify({
      version: 1,
      variants: { 这儿: '这', 玩: '玩儿' },
      excluded: { 长: 'zhǎng (programme : cháng)' },
      words: { 好: 'words/597d.opus', 这: 'words/8fd9.opus', 玩儿: 'words/73a9-513f.opus', 不存在: 'words/ffff.opus' },
      syllables: { hao3: 'syllables/hao3.opus', nü3: 'syllables/nv3.opus', lüe4: 'syllables/lve4.opus' },
    }),
  );
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('NativeAudio (index fictif)', () => {
  it('mot exact, ponctuation ignorée, chemin absolu', () => {
    const n = new NativeAudio(dir);
    expect(n.word('好')).toBe(path.join(dir, 'words/597d.opus'));
    expect(n.word(' 好。')).toBe(path.join(dir, 'words/597d.opus'));
    expect(n.word('好！')).toBe(path.join(dir, 'words/597d.opus'));
  });
  it('variantes érhua de l’index', () => {
    const n = new NativeAudio(dir);
    expect(n.word('这儿')).toBe(path.join(dir, 'words/8fd9.opus'));
    expect(n.word('玩')).toBe(path.join(dir, 'words/73a9-513f.opus'));
    expect(n.hasWord('这儿')).toBe(true);
    // variante : le son n'est pas celui du mot du programme (exclue des exercices de tons)
    expect(n.isVariant('这儿')).toBe(true);
    expect(n.isVariant('这儿。')).toBe(true);
    expect(n.isVariant('好')).toBe(false);
    expect(n.isVariant('银行')).toBe(false);
  });
  it('absent, exclu ou fichier manquant → null', () => {
    const n = new NativeAudio(dir);
    expect(n.word('长')).toBeNull();
    expect(n.word('银行')).toBeNull();
    expect(n.word('不存在')).toBeNull();
    expect(n.word('')).toBeNull();
  });
  it('syllabes : ü / v / u:, majuscules, pas de ton neutre', () => {
    const n = new NativeAudio(dir);
    expect(n.syllable('hao3')).toBe(path.join(dir, 'syllables/hao3.opus'));
    expect(n.syllable('Hao3')).toBe(path.join(dir, 'syllables/hao3.opus'));
    expect(n.syllable('nü3')).toBe(path.join(dir, 'syllables/nv3.opus'));
    expect(n.syllable('nv3')).toBe(path.join(dir, 'syllables/nv3.opus'));
    expect(n.syllable('nu:3')).toBe(path.join(dir, 'syllables/nv3.opus'));
    expect(n.syllable('lve4')).toBe(path.join(dir, 'syllables/lve4.opus'));
    expect(n.syllable('ma5')).toBeNull();
    expect(n.syllable('ma')).toBeNull();
    expect(n.syllable('hao4')).toBeNull();
  });
  it('index absent : désactivé sans planter', () => {
    const n = new NativeAudio(path.join(dir, 'nope'));
    expect(n.available()).toBe(false);
    expect(n.word('好')).toBeNull();
    expect(n.syllable('hao3')).toBeNull();
    expect(n.stats()).toEqual({ words: 0, syllables: 0 });
    expect(n.problem).toMatch(/indisponibles/);
  });
  it('helpers', () => {
    expect(bareWord('「你好」。')).toBe('你好');
    expect(syllableKey('LU:4')).toBe('lü4');
    expect(syllableKey('de5')).toBeNull();
  });
});

describe.runIf(fs.existsSync(path.join(REAL, 'index.json')))('NativeAudio (resources/audio réel)', () => {
  const n = new NativeAudio(REAL);
  it('couvre les mots et syllabes attendus', () => {
    expect(n.stats().words).toBeGreaterThan(2500);
    expect(n.stats().syllables).toBeGreaterThan(1600);
    for (const w of ['好', '银行', '可以', '这', '哪', '玩']) expect(n.word(w), w).toMatch(/\.opus$/);
    // 这儿 « ici » ≠ 这 « ce » : jamais la voix de 这 (repli synthèse), idem 那儿 / 哪儿
    for (const w of ['这儿', '那儿', '哪儿']) expect(n.word(w), w).toBeNull();
    expect(n.word('长')).toBeNull(); // exclu (lecture zhǎng enregistrée)
    for (const s of ['ma1', 'ma3', 'nü3', 'lü4', 'ju4', 'chang2']) expect(n.syllable(s), s).toMatch(/\.opus$/);
    expect(n.syllable('ma5')).toBeNull();
  });
  it('variantes érhua repérées (exclues des exercices de tons)', () => {
    for (const w of ['味儿', '好好', '玩']) expect(n.isVariant(w), w).toBe(true);
    for (const w of ['这', '好', '一点儿', '可以', '这儿', '那儿', '哪儿']) expect(n.isVariant(w), w).toBe(false);
  });
});

// ---------------------------------------------------------------- Tatoeba
const MP3 = new Uint8Array(2048);
MP3.set([0x49, 0x44, 0x33]); // « ID3 »

function fakeFetch(behaviour: 'ok' | 'html' | '404' | '429' | 'offline' | 'hang') {
  const calls: string[] = [];
  const fn = async (url: string, init?: { signal?: AbortSignal }) => {
    calls.push(url);
    if (behaviour === 'offline') throw new TypeError('fetch failed');
    if (behaviour === 'hang')
      return new Promise<never>((_, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))));
    const status = behaviour === '404' ? 404 : behaviour === '429' ? 429 : 200;
    const body = behaviour === 'html' ? new TextEncoder().encode('<html>' + ' '.repeat(2000)) : MP3;
    return { ok: status === 200, status, arrayBuffer: async () => body.buffer.slice(0) as ArrayBuffer };
  };
  return { fn, calls };
}

describe('TatoebaAudio', () => {
  let tdir = '';
  let json = '';
  beforeAll(() => {
    tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-tatoeba-'));
    json = path.join(tdir, 'tatoeba-audio.json');
    fs.writeFileSync(json, JSON.stringify({ sentences: { '410898': { a: 988876, by: 'GlossaMatik', lic: 'CC BY-NC 4.0' } } }));
  });
  afterAll(() => fs.rmSync(tdir, { recursive: true, force: true }));
  const sentences = () => [
    { id: 410898, zh: '我们试试看！' },
    { id: 1, zh: '我该去睡觉了。' },
  ];

  it('URL = id d’audio (pas id de phrase)', () => {
    expect(tatoebaAudioUrl(988876)).toBe('https://tatoeba.org/audio/download/988876');
    expect(normSentence('我们 试试看！')).toBe('我们试试看');
  });

  it('télécharge une fois puis sert le cache', async () => {
    const f = fakeFetch('ok');
    const cache = path.join(tdir, 'c1');
    const t = new TatoebaAudio(json, cache, sentences, f.fn);
    expect(t.count()).toBe(1);
    const p = await t.get('我们试试看');
    expect(p).toBe(path.join(cache, 'tatoeba', '988876.mp3'));
    expect(f.calls).toEqual(['https://tatoeba.org/audio/download/988876']);
    expect(await t.get('我们试试看！')).toBe(p);
    expect(f.calls.length).toBe(1);
  });

  it('phrase sans licence / inconnue → null sans requête', async () => {
    const f = fakeFetch('ok');
    const t = new TatoebaAudio(json, path.join(tdir, 'c2'), sentences, f.fn);
    expect(await t.get('我该去睡觉了。')).toBeNull();
    expect(await t.get('你好')).toBeNull();
    expect(f.calls.length).toBe(0);
  });

  it('hors-ligne : null, puis plus de tentative pendant la pause', async () => {
    const f = fakeFetch('offline');
    let now = 1_000_000;
    const t = new TatoebaAudio(json, path.join(tdir, 'c3'), sentences, f.fn, 5000, () => now);
    expect(await t.get('我们试试看！')).toBeNull();
    expect(await t.get('我们试试看！')).toBeNull();
    expect(f.calls.length).toBe(1);
    now += 6 * 60_000;
    expect(await t.get('我们试试看！')).toBeNull();
    expect(f.calls.length).toBe(2);
  });

  it('délai dépassé → null rapidement', async () => {
    const f = fakeFetch('hang');
    const t = new TatoebaAudio(json, path.join(tdir, 'c4'), sentences, f.fn, 50);
    const t0 = Date.now();
    expect(await t.get('我们试试看！')).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('réponse non audio, 404, 429 → null, rien en cache', async () => {
    for (const b of ['html', '404', '429'] as const) {
      const cache = path.join(tdir, 'c5-' + b);
      const t = new TatoebaAudio(json, cache, sentences, fakeFetch(b).fn);
      expect(await t.get('我们试试看！'), b).toBeNull();
      expect(fs.existsSync(path.join(cache, 'tatoeba', '988876.mp3'))).toBe(false);
    }
  });

  it('fichier de données absent → désactivé', async () => {
    const t = new TatoebaAudio(path.join(tdir, 'absent.json'), tdir, sentences, fakeFetch('ok').fn);
    expect(t.count()).toBe(0);
    expect(await t.get('我们试试看！')).toBeNull();
  });

  it('signature audio', () => {
    expect(looksLikeAudio(MP3)).toBe(true);
    const frame = new Uint8Array(1024);
    frame.set([0xff, 0xfb]);
    expect(looksLikeAudio(frame)).toBe(true);
    expect(looksLikeAudio(new TextEncoder().encode('<!doctype html>' + ' '.repeat(1000)))).toBe(false);
    expect(looksLikeAudio(new Uint8Array(10))).toBe(false);
  });
});
