import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RADICAL_FR, radicalFr } from '../src/core/radicals';

const DATA = path.join(__dirname, '../resources/data');
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));

describe('RADICAL_FR : sens français des clés réduites', () => {
  it('les clés les plus fréquentes ont un sens français (pas « (en) hand »)', () => {
    for (const k of ['扌', '辶', '纟', '阝', '刂', '丷', '⺼', '忄', '钅', '犭', '衤', '饣', '礻'])
      expect(radicalFr(k)?.[0], k).toMatch(/\p{L}/u);
    expect(radicalFr('扌')![0]).toContain('main');
    expect(radicalFr('好')).toBeNull();
    for (const v of Object.values(RADICAL_FR)) expect(v.join(' ')).not.toMatch(/\(en\)|radical|Kangxi/);
  });

  it.runIf(fs.existsSync(path.join(DATA, 'char-stories.json')))(
    'tout composant lié au moins 2 fois sans fiche ni sens français est couvert',
    () => {
      const stories = read('char-stories.json');
      const S: Record<string, { k?: [string, string, string][] }> = stories.stories ?? stories;
      const chars = read('chars.json');
      const dict = read('dict.json');
      const links: Record<string, number> = {};
      for (const [c, st] of Object.entries(S)) for (const [k] of st.k ?? []) if (k !== c) links[k] = (links[k] ?? 0) + 1;
      const missing = Object.entries(links)
        .filter(([k, n]) => n >= 2 && !S[k] && !chars[k]?.fr?.length && !chars[k]?.ety && !chars[k]?.dec && !dict[k]?.f?.length)
        .filter(([k]) => !radicalFr(k))
        .map(([k]) => k);
      expect(missing).toEqual([]);
    },
  );
});
