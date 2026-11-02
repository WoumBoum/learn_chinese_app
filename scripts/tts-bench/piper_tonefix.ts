// Re-creates what the app currently plays for short words: Piper output + tone correction (src/main/services/tonefix.ts),
// exactly as PiperTts.render() does it (espeak-ng realised tones, 1-2 Han chars only, PSOLA where a syllable is off).
// Usage (bundled by run.sh): node piper_tonefix.js <piper wav dir> <out dir> <testset.json>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { decodeWav, encodeWav, fixTones, tonesFromEspeak } from '../../src/main/services/tonefix';

const [, , inDir, outDir, testset] = process.argv;
const P = path.join(process.env.TB_REPO ?? process.cwd(), 'resources/bin/piper');
const HAN = /\p{Script=Han}/gu;
const items: { id: string; text: string }[] = JSON.parse(fs.readFileSync(testset, 'utf8'));
fs.mkdirSync(outDir, { recursive: true });
let changed = 0;
let eligible = 0;
for (const it of items) {
  const src = path.join(inDir, it.id + '.wav');
  const dst = path.join(outDir, it.id + '.wav');
  if (!fs.existsSync(src)) continue;
  let buf = fs.readFileSync(src);
  const n = (it.text.match(HAN) ?? []).length;
  if (n >= 1 && n <= 2 && /^[\p{Script=Han}\s，。！？、,.!?…~～]+$/u.test(it.text)) {
    const ph = execFileSync(path.join(P, 'espeak-ng'), [`--path=${P}`, '-v', 'cmn', '-q', '-x', it.text], {
      env: { ...process.env, LD_LIBRARY_PATH: P },
    }).toString();
    const tones = tonesFromEspeak(ph);
    if (tones.length === n && tones.some((t) => t !== 5)) {
      eligible++;
      const { samples, sampleRate } = decodeWav(buf);
      const r = fixTones(samples, sampleRate, tones);
      if (r.changed) {
        buf = encodeWav(r.samples, sampleRate);
        changed++;
      }
    }
  }
  fs.writeFileSync(dst, buf);
}
console.log(`piper+tonefix: ${eligible} eligible short words, ${changed} modified`);
