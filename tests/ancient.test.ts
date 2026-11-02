import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AncientService,
  ancientCandidates,
  buildQueryUrl,
  isSafeAncientSvg,
  parseCommonsResponse,
  pathToAbs,
  sanitizeSvg,
  selectForms,
  titleOf,
  type FetchLike,
  type FileMeta,
  type ResponseLike,
} from '../src/main/services/ancient';
// @ts-expect-error — module ESM sans types (script de build)
import { ancientOrder, parseST, storyDescribesTrad } from '../scripts/build-chars.mjs';

const FIX = path.join(__dirname, 'fixtures/ancient');
const read = (f: string) => fs.readFileSync(path.join(FIX, f), 'utf8');
const commons = JSON.parse(read('commons-imageinfo.json'));
const MA_TITLES = ['馬', '马'].flatMap((k) => (['oracle', 'bronze', 'bigseal', 'seal'] as const).map((f) => titleOf(k, f)));

describe('sanitizeSvg', () => {
  it('neutralises a hostile SVG (script, on*, external href, image, style, text, foreignObject)', () => {
    const r = sanitizeSvg(read('hostile.svg'));
    expect(r.svg).not.toMatch(/script|onload|onclick|onmouse|href|image|<style|url\(|foreignObject|<text|javascript|evil|alert|#c00|red/i);
    expect(r.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" fill="currentColor">')).toBe(true);
    // only <path> children survive: a's path, the rotated rect, the white circle, the stroked arc, the internal <use>
    expect(r.nPaths).toBe(5);
    expect(r.svg.match(/<path /g)?.length).toBe(5);
    expect(r.svg).toContain('style="fill:var(--bg,#fff)"'); // white knock-out circle
    expect(r.svg).toMatch(/fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/);
    expect(r.stats.dropped.image).toBe(1);
    expect(r.stats.dropped.use).toBe(1); // external <use> dropped; internal one resolved
    expect(isSafeAncientSvg(r.svg)).toBe(true);
  });

  it('bakes transforms into coordinates (rotate about a centre)', () => {
    const r = sanitizeSvg('<svg viewBox="0 0 300 300"><g transform="rotate(90 150 150)"><rect x="20" y="20" width="40" height="10"/></g></svg>');
    // (20,20) rotated 90° around (150,150) → (280,20)
    expect(r.svg).toMatch(/<path d="m280 20/);
    expect(r.svg).not.toContain('transform');
  });

  it('keeps an Inkscape oracle-bone file faithful and smaller', () => {
    const raw = read('ren-oracle.svg');
    const r = sanitizeSvg(raw);
    expect(r.nPaths).toBe(2);
    expect(r.svg.length).toBeLessThan(raw.length / 2);
    expect(r.svg).not.toMatch(/inkscape|sodipodi|metadata|id=/);
    // layer translate(0,-752.36) baked: first point 160.5,790.1 → 160.5,37.7
    expect(r.svg).toMatch(/<path d="m160\.5 37\.7/);
    expect(isSafeAncientSvg(r.svg)).toBe(true);
  });

  it('rounds relative commands without drift', () => {
    const d = 'M0 0' + ' l0.33 0.33'.repeat(30);
    const r = sanitizeSvg(`<svg viewBox="0 0 300 300"><path d="${d}"/></svg>`);
    const segs = pathToAbs(r.svg.match(/d="([^"]+)"/)![1]);
    const end = segs[segs.length - 1];
    expect(Math.abs((end[1] as number) - 9.9)).toBeLessThan(0.051);
  });

  it('rejects documents without <svg>', () => {
    expect(() => sanitizeSvg('<html><body>nope</body></html>')).toThrow();
  });
});

describe('isSafeAncientSvg', () => {
  it('refuses anything that is not exactly the sanitizer output shape', () => {
    expect(isSafeAncientSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" fill="currentColor"><path d="m1 1h2z"/></svg>')).toBe(true);
    expect(isSafeAncientSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" fill="currentColor"><path d="m1 1" onload="x()"/></svg>')).toBe(false);
    expect(isSafeAncientSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" fill="currentColor"><script>x()</script></svg>')).toBe(false);
    expect(isSafeAncientSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" fill="currentColor"><path d="m1 1" style="fill:url(http://x)"/></svg>')).toBe(false);
    expect(isSafeAncientSvg('<svg onload="x()"><path d="m1 1"/></svg>')).toBe(false);
  });
});

describe('Commons lookup', () => {
  it('uses the build-time candidate table (no runtime converter)', () => {
    expect(ancientCandidates('马', '馬')).toEqual(['馬']);
    expect(ancientCandidates('人', undefined)).toEqual(['人']);
    expect(ancientCandidates('干', '干幹乾')).toEqual(['干', '幹', '乾']);
    expect(ancientCandidates('台', '台臺檯颱a<臺')).toEqual(['台', '臺', '檯', '颱']); // non-Han / doublons ignorés, ≤ 4
    expect(ancientCandidates('人', 42)).toEqual(['人']);
  });

  it('builds a single batched imageinfo query', () => {
    const u = buildQueryUrl(MA_TITLES);
    expect(u).toContain('prop=imageinfo');
    expect(u).toContain('iiprop=url%7Csize%7Cextmetadata');
    expect(decodeURIComponent(u)).toContain('File:馬-oracle.svg|File:馬-bronze.svg');
  });

  it('parses the response: licence, author, missing files', () => {
    const m = parseCommonsResponse(commons, MA_TITLES);
    expect(m['File:馬-oracle.svg']).toMatchObject({ license: 'Public domain', author: 'Ancient Chinese characters project' });
    expect(m['File:馬-oracle.svg']!.url).toBe('https://upload.wikimedia.org/wikipedia/commons/a/ab/%E9%A6%AC-oracle.svg');
    expect(m['File:馬-oracle.svg']!.page).toContain('commons.wikimedia.org/wiki/File:');
    expect(m['File:馬-bronze.svg']).toMatchObject({ license: 'CC0', author: 'AggregatibacterActinomycetemcomitans' });
    expect(m['File:马-oracle.svg']).toBeNull();
    expect(() => parseCommonsResponse({ error: { code: 'maxlag', info: 'lag' } }, [])).toThrow(/maxlag/);
  });

  it('never trusts descriptionurl unless it is a Commons file page', () => {
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'https://evil.example/wiki/File:x', 'https://commons.wikimedia.org.evil.example/wiki/x', 'ms-settings:']) {
      const j = { query: { pages: [{ title: 'File:人-seal.svg', imageinfo: [{ url: 'https://upload.wikimedia.org/a/b.svg', descriptionurl: bad, size: 10, extmetadata: { LicenseShortName: { value: 'Public domain' } } }] }] } };
      expect(parseCommonsResponse(j, ['File:人-seal.svg'])['File:人-seal.svg']!.page).toBe('https://commons.wikimedia.org/wiki/File%3A%E4%BA%BA-seal.svg');
    }
  });

  const pd = (t: string): FileMeta => ({ url: `https://upload.wikimedia.org/${t}`, page: 'https://commons.wikimedia.org/wiki/' + t, size: 1, license: 'Public domain', author: 'a' });
  const metaOf = (...titles: string[]) => Object.fromEntries(titles.map((t) => [`File:${t}.svg`, pd(t)]));

  it('selects one glyph only, with the licence filter and big seal as fallback', () => {
    const m = parseCommonsResponse(commons, MA_TITLES);
    const sel = selectForms(['馬'], m); // 马 n'est pas candidat : simplifié seulement
    // seal: 馬-seal is CC BY-NC (rejected)
    expect(sel.map((s) => s.form)).toEqual(['oracle', 'bronze']);
    expect(sel.every((s) => s.src === '馬')).toBe(true);
    // no oracle/bronze → big seal kept
    expect(selectForms(['人'], metaOf('人-bigseal')).map((s) => s.form)).toEqual(['bigseal']);
    expect(selectForms(['人'], { ...metaOf('人-bigseal', '人-bronze') }).map((s) => s.form)).toEqual(['bronze']);
  });

  it('merged characters keep their own glyph (no 干-oracle + 幹-seal mix)', () => {
    const m = metaOf('干-oracle', '干-bronze', '干-seal', '幹-seal');
    expect(selectForms(['干', '幹', '乾'], m).map((s) => `${s.src}-${s.form}`)).toEqual(['干-oracle', '干-bronze', '干-seal']);
    expect(selectForms(['里', '裏'], metaOf('里-bronze', '里-seal', '裏-seal')).map((s) => `${s.src}-${s.form}`)).toEqual(['里-bronze', '里-seal']);
    // regional standard form accepted after the traditional one (群/羣)
    expect(selectForms(['羣', '群'], metaOf('群-seal', '群-bronze')).map((s) => `${s.src}-${s.form}`)).toEqual(['群-bronze', '群-seal']);
    expect(selectForms(['吃', '喫'], metaOf('吃-seal')).map((s) => s.form)).toEqual(['seal']);
    // next candidate only if the first has nothing usable (bad licence = nothing)
    const nc = { ...metaOf('幹-seal'), 'File:干-seal.svg': { ...pd('干-seal'), license: 'CC BY-NC 4.0' } };
    expect(selectForms(['干', '幹'], nc).map((s) => s.title)).toEqual(['File:幹-seal.svg']);
  });
});

describe('build-chars: candidate order', () => {
  const st = parseST('干\t幹 乾 干\n里\t裏 里\n马\t馬\n后\t後 后\n确\t確 确\n万\t萬 万\n云\t雲 云\n从\t從\n群\t羣\n');
  const story = (o: string) => ({ o });
  it('merged character → its own glyph first, unless the story describes the traditional form', () => {
    expect(ancientOrder('干', st, story('干 dessine à l’origine une arme fourchue…'))).toBe('干幹乾');
    expect(ancientOrder('后', st, story('后 désignait à l’origine le souverain. Il sert aussi de forme simplifiée à 後.'))).toBe('后後');
    expect(ancientOrder('确', st, story('Forme simplifiée de 確 : la pierre 石…'))).toBe('確确');
    expect(ancientOrder('万', st, story('万 sert de forme simplifiée à 萬, pictogramme d’un scorpion.'))).toBe('萬万');
    expect(ancientOrder('里', st, undefined)).toBe('里裏');
  });
  it('simplified-only glyph → traditional only (SELF_OK and regional standard forms appended)', () => {
    expect(ancientOrder('马', st, undefined)).toBe('馬');
    expect(ancientOrder('从', st, undefined)).toBe('從从');
    expect(ancientOrder('群', st, undefined, new Map([['羣', ['群']]]))).toBe('羣群');
    expect(ancientOrder('群', st, undefined)).toBe('羣');
    expect(ancientOrder('人', st, undefined)).toBeNull();
  });
  it('detects stories about the traditional form', () => {
    expect(storyDescribesTrad('价', 'Le traditionnel 價 est idéo-phonétique', ['價'])).toBe(true);
    expect(storyDescribesTrad('胜', 'Le caractère traditionnel est 勝 : la force…', ['勝'])).toBe(true);
    expect(storyDescribesTrad('丰', '丰 est à l’origine le pictogramme d’une plante. Il sert aussi de forme simplifiée à 豐', ['豐'])).toBe(false);
  });
  it('ships the table in char-stories.json', () => {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, '../resources/data/char-stories.json'), 'utf8'));
    expect(j._ancient['马']).toBe('馬');
    expect(j._ancient['干'][0]).toBe('干');
    expect(j._ancient['确'][0]).toBe('確');
    expect(j._ancient['群']).toBe('羣群');
    expect(j._ancient['人']).toBeUndefined();
  });
});

// ---------- service with a fake network & clock ----------
function res(status: number, body: unknown, headers: Record<string, string> = {}): ResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function setup(handler: (url: string) => ResponseLike | Promise<ResponseLike>, opts: Partial<ConstructorParameters<typeof AncientService>[0]> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ancient-'));
  let t = 1_000_000;
  const calls: { url: string; at: number; ua: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, at: t, ua: init.headers['User-Agent'] });
    return handler(url);
  };
  const svc = new AncientService({
    cacheDir: dir,
    fetch,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    candidates: (c) => (c === '马' ? ['馬'] : [c]),
    ...opts,
  });
  return { svc, dir, calls, advance: (ms: number) => (t += ms) };
}

describe('AncientService', () => {
  it('fetches once, sanitises, records attribution and caches', async () => {
    const svg = read('ren-oracle.svg');
    const { svc, dir, calls } = setup((u) => (u.includes('api.php') ? res(200, commons) : res(200, svg)));
    const r = await svc.get('马');
    expect(r.status).toBe('ok');
    expect(r.forms.map((f) => f.form)).toEqual(['oracle', 'bronze']);
    expect(r.forms[0]).toMatchObject({ license: 'Public domain', src: '馬', author: 'Ancient Chinese characters project' });
    expect(r.forms[0].url).toContain('commons.wikimedia.org/wiki/File:');
    expect(isSafeAncientSvg(r.forms[0].svg)).toBe(true);
    expect(calls.filter((c) => c.url.includes('api.php'))).toHaveLength(1); // one API request per character
    expect(calls.every((c) => c.ua.startsWith('OperationMandarin/'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '9a6c.json'))).toBe(true); // U+9A6C
    const again = await svc.get('马');
    expect(again.forms).toHaveLength(2);
    expect(calls).toHaveLength(3); // served from cache
  });

  it('spaces API requests by ≥ 1.5 s', async () => {
    const { svc, calls } = setup((u) => (u.includes('api.php') ? res(200, { query: { pages: [] } }) : res(404, '')));
    await Promise.all([svc.get('人'), svc.get('大'), svc.get('天')]);
    const at = calls.map((c) => c.at);
    expect(at).toHaveLength(3);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(1500);
    expect(at[2] - at[1]).toBeGreaterThanOrEqual(1500);
  });

  it('caches "none" results and re-checks them after 30 days', async () => {
    const { svc, calls, advance } = setup(() => res(200, { query: { pages: [] } }));
    expect((await svc.get('你')).status).toBe('none');
    expect((await svc.get('你')).status).toBe('none');
    expect(calls).toHaveLength(1);
    advance(31 * 24 * 3600 * 1000);
    await svc.get('你');
    expect(calls).toHaveLength(2);
  });

  it('stops for the session on HTTP 429', async () => {
    const { svc, calls } = setup(() => res(429, 'too many', { 'retry-after': '600' }));
    expect((await svc.get('人')).status).toBe('offline');
    expect(svc.blocked).toBe(true);
    expect((await svc.get('大')).status).toBe('offline');
    expect(calls).toHaveLength(1);
  });

  it('degrades to "offline" when the network is down, without caching', async () => {
    const { svc, dir, calls, advance } = setup(() => {
      throw new Error('getaddrinfo ENOTFOUND');
    });
    expect((await svc.get('人')).status).toBe('offline');
    expect(fs.readdirSync(dir)).toHaveLength(0);
    expect((await svc.get('人')).status).toBe('offline'); // back-off: no new request
    expect(calls).toHaveLength(1);
    advance(61_000);
    await svc.get('人');
    expect(calls).toHaveLength(2);
  });

  it('honours Retry-After on 5xx', async () => {
    const { svc, calls, advance } = setup(() => res(503, 'busy', { 'retry-after': '120' }));
    expect((await svc.get('人')).status).toBe('offline');
    advance(60_000);
    expect((await svc.get('人')).status).toBe('offline');
    expect(calls).toHaveLength(1);
    advance(61_000);
    await svc.get('人');
    expect(calls).toHaveLength(2);
  });

  it('ignores tampered cache entries', async () => {
    const { svc, dir } = setup(() => res(200, { query: { pages: [] } }));
    fs.writeFileSync(path.join(dir, '4eba.json'), JSON.stringify({ v: 2, c: '人', checked: Date.now(), status: 'ok', forms: [{ form: 'oracle', svg: '<svg onload="x()"></svg>', license: 'Public domain', author: '', url: '' }] }));
    expect(svc.cached('人')).toBeNull();
  });

  it('re-validates attribution fields read back from the cache (url scheme, licence, author, src)', async () => {
    const { svc, dir } = setup(() => res(200, { query: { pages: [] } }));
    const svg = sanitizeSvg(read('ren-oracle.svg')).svg;
    const form = (o: object) => ({ form: 'oracle', svg, license: 'Public domain', author: 'ACC', url: 'https://commons.wikimedia.org/wiki/File:%E4%BA%BA-oracle.svg', ...o });
    fs.writeFileSync(
      path.join(dir, '4eba.json'),
      JSON.stringify({
        v: 2, c: '人', checked: Date.now(), status: 'ok',
        forms: [
          form({ url: 'file:///etc/passwd', author: 'x'.repeat(5000), src: '<b>' }),
          form({ form: 'bronze', license: 'CC BY-NC 4.0' }), // licence refusée → forme retirée
          form({ form: 'seal', url: 'javascript:alert(1)', license: { evil: 1 } }), // licence non textuelle → retirée
        ],
      }),
    );
    const r = svc.cached('人')!;
    expect(r.forms).toHaveLength(1);
    expect(r.forms[0].url).toBe('https://commons.wikimedia.org/wiki/File%3A%E4%BA%BA-oracle.svg');
    expect(r.forms[0].author.length).toBe(200);
    expect(r.forms[0].src).toBeUndefined();
  });

  it('ignores caches written by the previous selection logic (v1)', async () => {
    const { svc, dir } = setup(() => res(200, { query: { pages: [] } }));
    fs.writeFileSync(path.join(dir, '5e72.json'), JSON.stringify({ v: 1, c: '干', checked: Date.now(), status: 'none', forms: [] }));
    expect(svc.cached('干')).toBeNull();
  });

  it('times out a stalled response BODY and does not block the next characters', async () => {
    let n = 0;
    const stalled: ResponseLike = { ok: true, status: 200, headers: { get: () => null }, text: () => new Promise<string>(() => undefined) };
    const { svc, calls } = setup(() => (++n === 1 ? stalled : res(200, { query: { pages: [] } })), { timeoutMs: 50 });
    const t0 = Date.now();
    const [a, b] = await Promise.all([svc.get('马'), svc.get('木')]);
    expect(a.status).toBe('offline'); // délai dépassé → hors ligne, rien en cache
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(b.status).toBe('offline'); // back-off d'une minute après un délai dépassé : pas de rafale
    expect(svc.isPending('马')).toBe(false);
    expect(svc.isPending('木')).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('times out a stalled SVG download without caching a partial result', async () => {
    const stalled: ResponseLike = { ok: true, status: 200, headers: { get: () => null }, text: () => new Promise<string>(() => undefined) };
    const { svc, dir } = setup((u) => (u.includes('api.php') ? res(200, commons) : stalled), { timeoutMs: 50 });
    expect((await svc.get('马')).status).toBe('offline');
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });

  it('bounds a whole lookup with a global deadline so the queue keeps moving', async () => {
    let n = 0;
    // fetch itself never settles (ignores the abort signal)
    const { svc, calls } = setup(() => (++n === 1 ? new Promise<ResponseLike>(() => undefined) : res(200, { query: { pages: [] } })), { timeoutMs: 10_000, lookupDeadlineMs: 50 });
    const a = svc.get('马');
    const b = svc.get('木');
    expect((await a).status).toBe('offline');
    expect((await b).status).toBe('none');
    expect(calls).toHaveLength(2);
  });

  it('returns "none" for non-Han input without any request', async () => {
    const { svc, calls } = setup(() => res(200, {}));
    expect((await svc.get('a')).status).toBe('none');
    expect(calls).toHaveLength(0);
  });
});
