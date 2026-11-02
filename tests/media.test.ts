import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { explainYtError, jsRuntimeArgs, videoFormat } from '../src/main/services/ytdlp';
import { run } from '../src/main/services/proc';
import { ensureModel, modelPath } from '../src/main/services/whisper';
import {
  briefingDays,
  chooseSubTrack,
  coverageFromCounts,
  coverageScore,
  durationScore,
  isTraditionalTag,
  isYoutubeCollection,
  lineStep,
  looksProperNoun,
  normalizeZhPunct,
  parseDurationStr,
  parseFfmpegDuration,
  parseRss,
  parseWhisperProgress,
  parseYtdlpProgress,
  phaseScore,
  projectCoverageSeries,
  projectedCoverageAt,
  projectStatus,
  readyInDays,
  recommendationScore,
  segmentAt,
  shortHash,
  splitLongCues,
  themeMatches,
  tokenCounts,
  youtubeId,
  type WordSt,
} from '../src/core/media';
import type { Token } from '../src/shared/types';

const tk = (s: string): Token[] => s.split(' ').map((t) => ({ t, han: /\p{Script=Han}/u.test(t) }));

describe('projection de couverture', () => {
  // 10 tokens: 我×3 是×2 学生×2 老师 中国 ，
  const lines = [tk('我 是 学生 ，'), tk('我 是 老师'), tk('我 学生 中国')];
  const counts = tokenCounts(lines);
  const known = new Map<string, WordSt>([['我', 'known']]);
  const base = (w: string) => known.get(w);

  it('compte les occurrences des mots chinois seulement', () => {
    expect(counts.get('我')).toBe(3);
    expect(counts.has('，')).toBe(false);
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(9);
  });

  it('couverture actuelle = connus / total', () => {
    expect(coverageFromCounts(counts, base)).toBeCloseTo(3 / 9);
    expect(coverageFromCounts(counts, base, (w) => w === '中国')).toBeCloseTo(4 / 9);
  });

  it('les N prochains mots du cursus comptent comme « learning »', () => {
    const s = projectStatus(base, ['是']);
    expect(s('是')).toBe('learning');
    expect(s('我')).toBe('known');
    expect(s('老师')).toBeUndefined();
  });

  it('série jour par jour : perDay mots par jour', () => {
    const upcoming = ['是', '学生', '老师', '中国'];
    const series = projectCoverageSeries(counts, base, upcoming, 1, 4);
    expect(series.map((p) => p.days)).toEqual([0, 1, 2, 3, 4]);
    expect(series[0].coverage).toBeCloseTo(3 / 9);
    expect(series[1].coverage).toBeCloseTo(5 / 9); // + 是×2
    expect(series[2].coverage).toBeCloseTo(7 / 9); // + 学生×2
    expect(series[4].coverage).toBeCloseTo(1);
    // monotone
    for (let i = 1; i < series.length; i++) expect(series[i].coverage).toBeGreaterThanOrEqual(series[i - 1].coverage);
    expect(projectedCoverageAt(counts, base, upcoming, 2, 1)).toBeCloseTo(7 / 9);
  });

  it('ignore les doublons et les mots déjà connus dans la liste à venir', () => {
    const s = projectCoverageSeries(counts, base, ['我', '是', '是'], 3, 1);
    expect(s[1].coverage).toBeCloseTo(5 / 9);
  });

  it('transcription vide = couverture 1', () => {
    expect(projectCoverageSeries(new Map(), base, [], 5, 2).every((p) => p.coverage === 1)).toBe(true);
  });

  it('prête dans X jours = premier jour ≥ seuil', () => {
    const series = projectCoverageSeries(counts, base, ['是', '学生', '老师', '中国'], 1, 4);
    expect(readyInDays(series, 0.9)).toBe(4); // J+3 = 8/9 < 90 %
    expect(readyInDays(series, 0.85)).toBe(3);
    expect(readyInDays(series, 0.3)).toBe(0);
    expect(readyInDays(series.slice(0, 2), 0.9)).toBeNull();
  });

  it('jours de briefing : moitié du quota quotidien, au moins une nuit', () => {
    expect(briefingDays(0, 12)).toBe(1);
    expect(briefingDays(12, 12)).toBe(2);
    expect(briefingDays(13, 12)).toBe(3);
    expect(briefingDays(5, 1)).toBe(5); // quota minimal 1/jour
  });
});

describe('score de recommandation', () => {
  it('pic de couverture à 95 %', () => {
    expect(coverageScore(0.95)).toBe(1);
    expect(coverageScore(0.9)).toBeLessThan(1);
    expect(coverageScore(0.75)).toBeCloseTo(0);
    expect(coverageScore(0.6)).toBe(0);
    expect(coverageScore(1)).toBeCloseTo(0.8);
    expect(coverageScore(0.97)).toBeGreaterThan(coverageScore(0.88));
  });

  it('durée courte favorisée en phase 1', () => {
    expect(durationScore(240, 1)).toBe(1);
    expect(durationScore(25 * 60, 1)).toBeLessThan(0.2);
    expect(durationScore(25 * 60, 3)).toBe(1);
    expect(durationScore(null, 1)).toBe(0.5);
  });

  it('phase de la source', () => {
    expect(phaseScore(1, [0, 1])).toBe(1);
    expect(phaseScore(1, [2, 3])).toBe(0.5);
    expect(phaseScore(0, [3])).toBe(0.1);
    expect(phaseScore(1, [])).toBe(0.5);
  });

  it('thèmes et centres d\'intérêt (accents ignorés)', () => {
    expect(themeMatches(['Cuisine', 'vie quotidienne'], ['cuisine'])).toBe(1);
    expect(themeMatches(['dessins animés'], ['dessins animes'])).toBe(1);
    expect(themeMatches(['tons'], ['sport'])).toBe(0);
  });

  it('classement : i+1, court, bonne phase, intérêts > vidéo trop dure et longue', () => {
    const good = recommendationScore({ projected3: 0.95, durationSec: 240, phase: 1, sourcePhases: [1], themes: ['cuisine'], interests: ['cuisine'] });
    const hard = recommendationScore({ projected3: 0.7, durationSec: 1800, phase: 1, sourcePhases: [3], themes: ['histoire'], interests: ['cuisine'] });
    const unknown = recommendationScore({ projected3: null, durationSec: 240, phase: 1, sourcePhases: [1], themes: [], interests: [] });
    expect(good.score).toBeGreaterThan(unknown.score);
    expect(unknown.score).toBeGreaterThan(hard.score);
    expect(good.score).toBeCloseTo(1);
    expect(good.reasons.length).toBeGreaterThan(0);
  });

  it('déjà vue ou déjà en mission → déclassée', () => {
    const base = { projected3: 0.95, durationSec: 240, phase: 1, sourcePhases: [1], themes: [], interests: [] };
    const a = recommendationScore(base).score;
    expect(recommendationScore({ ...base, watched: 1 }).score).toBeLessThan(a * 0.5);
    expect(recommendationScore({ ...base, hasMission: true }).score).toBeLessThan(a);
  });
});

describe('parsing RSS', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
<channel>
  <title><![CDATA[Slow Chinese 慢速中文]]></title>
  <itunes:image href="https://ex.com/cover.jpg"/>
  <item>
    <title>第1集：你好 &amp; 再见</title>
    <guid isPermaLink="false">ep-1</guid>
    <pubDate>Mon, 01 Jan 2024 08:00:00 GMT</pubDate>
    <itunes:duration>12:34</itunes:duration>
    <enclosure url="https://ex.com/ep1.mp3?x=1&amp;y=2" length="123" type="audio/mpeg"/>
    <description><![CDATA[<p>Un épisode <b>lent</b>.</p>]]></description>
  </item>
  <item>
    <title>第2集</title>
    <pubDate>Mon, 08 Jan 2024 08:00:00 GMT</pubDate>
    <itunes:duration>754</itunes:duration>
    <itunes:image href="https://ex.com/ep2.jpg"/>
    <enclosure type="audio/mpeg" url='https://ex.com/ep2.mp3'/>
  </item>
  <item><title>Sans audio</title></item>
</channel></rss>`;
  const feed = parseRss(xml);

  it('titre et image du podcast', () => {
    expect(feed.title).toBe('Slow Chinese 慢速中文');
    expect(feed.image).toBe('https://ex.com/cover.jpg');
  });

  it('épisodes avec enclosure, triés du plus récent au plus ancien', () => {
    expect(feed.episodes).toHaveLength(2);
    expect(feed.episodes[0].title).toBe('第2集');
    expect(feed.episodes[0].url).toBe('https://ex.com/ep2.mp3');
    expect(feed.episodes[0].duration).toBe(754);
    expect(feed.episodes[0].image).toBe('https://ex.com/ep2.jpg');
    expect(feed.episodes[0].guid).toBe('https://ex.com/ep2.mp3'); // pas de guid → url
  });

  it('entités, CDATA et HTML décodés', () => {
    const e = feed.episodes[1];
    expect(e.title).toBe('第1集：你好 & 再见');
    expect(e.url).toBe('https://ex.com/ep1.mp3?x=1&y=2');
    expect(e.duration).toBe(754);
    expect(e.description).toBe('Un épisode lent .');
    expect(e.guid).toBe('ep-1');
    expect(e.image).toBe('https://ex.com/cover.jpg');
    expect(e.pubDate).toBe(Date.parse('Mon, 01 Jan 2024 08:00:00 GMT'));
  });

  it('durées iTunes', () => {
    expect(parseDurationStr('1:02:03')).toBe(3723);
    expect(parseDurationStr('45')).toBe(45);
    expect(parseDurationStr('abc')).toBe(0);
    expect(parseDurationStr(undefined)).toBe(0);
  });
});

describe('sous-titres YouTube', () => {
  it('préfère les sous-titres manuels, simplifiés d\'abord', () => {
    expect(chooseSubTrack({ subtitles: ['en', 'zh-Hant', 'zh-Hans'], auto: ['zh-Hans'] })).toEqual({ lang: 'zh-Hans', source: 'cc' });
    expect(chooseSubTrack({ subtitles: ['zh-TW'], auto: [] })).toEqual({ lang: 'zh-TW', source: 'cc' });
  });

  it('refuse les traductions automatiques d\'une vidéo non chinoise', () => {
    expect(chooseSubTrack({ subtitles: [], auto: ['zh-Hans', 'zh-Hant', 'en-orig', 'en'], language: 'en-US' })).toBeNull();
  });

  it('accepte la reconnaissance vocale chinoise (-orig ou vidéo en chinois)', () => {
    expect(chooseSubTrack({ subtitles: [], auto: ['zh-Hans-orig', 'zh-Hans', 'en'] })).toEqual({ lang: 'zh-Hans-orig', source: 'auto' });
    expect(chooseSubTrack({ subtitles: [], auto: ['zh-Hant', 'zh-Hans'], language: 'zh' })).toEqual({ lang: 'zh-Hans', source: 'auto' });
    expect(chooseSubTrack({ subtitles: [], auto: ['zh-Hans'], language: null })).toBeNull();
  });

  it('variantes traditionnelles', () => {
    expect(isTraditionalTag('zh-TW')).toBe('tw');
    expect(isTraditionalTag('zh-HK')).toBe('hk');
    expect(isTraditionalTag('zh-Hant')).toBe('t');
    expect(isTraditionalTag('zh-Hans')).toBeNull();
    expect(isTraditionalTag('zh')).toBeNull();
  });

  it('identifiants et collections', () => {
    expect(youtubeId('https://www.youtube.com/watch?v=q2hrlAGewvY&t=3')).toBe('q2hrlAGewvY');
    expect(youtubeId('https://youtu.be/q2hrlAGewvY')).toBe('q2hrlAGewvY');
    expect(youtubeId('https://www.youtube.com/shorts/q2hrlAGewvY')).toBe('q2hrlAGewvY');
    expect(isYoutubeCollection('https://www.youtube.com/playlist?list=PLx')).toBe(true);
    expect(isYoutubeCollection('https://www.youtube.com/@yoyochinese/videos')).toBe(true);
    expect(isYoutubeCollection('https://www.youtube.com/watch?v=q2hrlAGewvY&list=PLx')).toBe(false);
  });
});

describe('sorties des outils', () => {
  it('progression yt-dlp, whisper, ffmpeg', () => {
    expect(parseYtdlpProgress('[download]  42.3% of   10.00MiB at  1.00MiB/s ETA 00:05')).toBe(42.3);
    expect(parseYtdlpProgress('[info] foo')).toBeNull();
    expect(parseWhisperProgress('whisper_print_progress_callback: progress =  35%')).toBe(35);
    expect(parseWhisperProgress('whisper_print_progress_callback: progress = 458%')).toBe(100);
    expect(parseFfmpegDuration('  Duration: 00:01:23.45, start: 0.000000')).toBeCloseTo(83.45);
  });

  it('ponctuation chinoise et découpage des longues lignes Whisper', () => {
    expect(normalizeZhPunct('你好,我叫小明.你呢?')).toBe('你好，我叫小明。你呢？');
    expect(normalizeZhPunct('版本 2.0 很好')).toBe('版本 2.0 很好');
    const out = splitLongCues([{ start: 0, end: 10, text: '今天天气很好，我们去公园散步吧。我喜欢喝茶，你呢？他不喜欢喝咖啡。' }], 12);
    expect(out.length).toBeGreaterThan(1);
    expect(out.map((c) => c.text).join('')).toBe('今天天气很好，我们去公园散步吧。我喜欢喝茶，你呢？他不喜欢喝咖啡。');
    expect(out[0].start).toBe(0);
    expect(out[out.length - 1].end).toBeCloseTo(10);
    for (let i = 1; i < out.length; i++) expect(out[i].start).toBeCloseTo(out[i - 1].end);
    expect(splitLongCues([{ start: 1, end: 2, text: '短句。' }])).toEqual([{ start: 1, end: 2, text: '短句。' }]);
  });

  it('noms propres (pinyin en majuscule, définitions)', () => {
    expect(looksProperNoun('北京', 'Bei3 jing1', ['Beijing municipality'])).toBe(true);
    expect(looksProperNoun('乔治', 'Qiao2 zhi4', ['George (name)'])).toBe(true);
    expect(looksProperNoun('猪', 'zhu1', ['hog', 'pig'])).toBe(false);
    expect(looksProperNoun('张', 'Zhang1', ['surname Zhang', 'to open up'])).toBe(false); // caractère courant
    expect(looksProperNoun('欧阳', 'Ou1 yang2', ['surname Ouyang'])).toBe(true);
  });

  it('hash stable', () => {
    expect(shortHash('/a/b.mp4')).toBe(shortHash('/a/b.mp4'));
    expect(shortHash('/a/b.mp4')).not.toBe(shortHash('/a/c.mp4'));
    expect(shortHash('x')).toHaveLength(14);
  });
});

describe('lecteur : pause automatique ligne par ligne', () => {
  /** Simulates the player's rAF loop (~60 fps) and returns the lines it paused after. */
  function simulate(segs: { start: number; end: number }[]) {
    let t = segs[0].start + 0.01;
    let armed: number | null = 0;
    let idx = 0;
    const pauses: number[] = [];
    while (t < segs[segs.length - 1].end + 0.5 && pauses.length < segs.length + 2) {
      const r = lineStep(segs, armed, idx, t);
      armed = r.armed;
      idx = r.idx;
      if (r.pauseAt != null) {
        pauses.push(r.pauseAt);
        expect(r.idx).toBe(r.pauseAt); // the line that just ended stays highlighted (overlapping cues too)
        expect(r.seekTo).toBeLessThan(segs[r.pauseAt].end);
        // resume (toggle): continue with the next line
        if (r.pauseAt + 1 >= segs.length) break;
        idx = r.pauseAt + 1;
        armed = idx;
        t = segs[idx].start + 0.01;
        continue;
      }
      t += 1 / 60;
    }
    return pauses;
  }
  it('pauses after every line with contiguous cues (Whisper / split cues)', () => {
    const segs = [
      { start: 0, end: 4.5 },
      { start: 4.5, end: 7 },
      { start: 7, end: 9.2 },
    ];
    expect(simulate(segs)).toEqual([0, 1, 2]);
  });
  it('pauses after every line with 10 ms gaps (auto-captions) and overlapping cues', () => {
    expect(simulate([{ start: 0, end: 2 }, { start: 2.01, end: 4 }, { start: 4.01, end: 5 }])).toEqual([0, 1, 2]);
    expect(simulate([{ start: 0, end: 2.2 }, { start: 2, end: 4 }, { start: 3.9, end: 5 }])).toEqual([0, 1, 2]);
  });
  it('segmentAt returns the line being played', () => {
    const segs = [{ start: 1, end: 2 }, { start: 2, end: 3 }];
    expect(segmentAt(segs, 0.5)).toBe(-1);
    expect(segmentAt(segs, 1.99)).toBe(0);
    expect(segmentAt(segs, 2)).toBe(1);
  });
});

describe('yt-dlp : formats et runtime JavaScript', () => {
  it('merges DASH video + audio when ffmpeg is available, progressive only otherwise', () => {
    const f = videoFormat(true);
    expect(f.split('/')[0]).toBe('bv[height<=480][vcodec^=avc1]+ba[ext=m4a]');
    expect(f).toContain('b[height<=480][ext=mp4]');
    expect(videoFormat(false)).not.toContain('+');
  });
  it('uses Electron itself as the Node runtime for YouTube challenges', () => {
    expect(jsRuntimeArgs('/opt/app/operation-mandarin', { electron: '45.0.0' } as unknown as NodeJS.ProcessVersions)).toEqual(['--js-runtimes', 'node:/opt/app/operation-mandarin']);
    expect(jsRuntimeArgs('/usr/bin/node', { node: '22.0.0' } as unknown as NodeJS.ProcessVersions)).toEqual(['--js-runtimes', 'node']);
  });
  it('explains format and timeout errors in French', () => {
    expect(explainYtError(new Error('ERROR: [youtube] abc: Requested format is not available. Use --list-formats')).message).toMatch(/aucun format/);
    expect(explainYtError(new Error('yt-dlp : délai dépassé (réseau lent ou bloqué ?)')).message).toMatch(/Connexion/);
  });
});

describe('processus externes', () => {
  it('reports a timeout as a timeout, not as a user cancellation', async () => {
    await expect(run(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 200 })).rejects.toThrow(/délai dépassé/);
  });
});

describe('modèle Whisper', () => {
  it('concurrent ensureModel calls share a single download', async () => {
    const body = Buffer.alloc(300_000, 7);
    let requests = 0;
    const server = http.createServer((_req, res) => {
      requests++;
      res.writeHead(200, { 'content-length': body.length });
      // slow response so that both callers overlap
      res.write(body.subarray(0, 1000));
      setTimeout(() => res.end(body.subarray(1000)), 150);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/ggml-base.bin`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-model-'));
    const prog: number[] = [];
    try {
      const [a, b] = await Promise.all([ensureModel(dir, 'base', undefined, url), ensureModel(dir, 'base', (p) => prog.push(p), url)]);
      expect(a).toBe(modelPath(dir, 'base'));
      expect(b).toBe(a);
      expect(requests).toBe(1);
      expect(fs.readFileSync(a).equals(body)).toBe(true);
      expect(fs.existsSync(a + '.part')).toBe(false);
      expect(prog[prog.length - 1]).toBe(100);
    } finally {
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
