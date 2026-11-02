// Parse WebVTT / SRT subtitle files into timed lines, merging YouTube auto-caption fragments.
export interface Cue {
  start: number;
  end: number;
  text: string;
}

export interface ParseOpts {
  /**
   * YouTube auto-captions ("rolling" 2-line captions: each cue repeats the previous line above the new one,
   * with 10 ms transition cues). When true, repeated lines are removed and growing prefixes merged.
   * When false (manual CC, SRT, Whisper), every cue is kept as is — a short reply such as « 对。» after « 不对。»
   * is a real line. Default: auto-detected from YouTube's word-timing tags (`<00:00:01.234><c>…</c>`).
   */
  rolling?: boolean;
}

function ts(s: string): number {
  const m = s.trim().replace(',', '.').match(/(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  return (m[1] ? +m[1] * 3600 : 0) + +m[2] * 60 + +m[3];
}

function clean(l: string): string {
  return l
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** YouTube auto-caption VTT signature: per-word timestamps / <c> spans inside the cue text. */
export function looksRollingVtt(src: string): boolean {
  return /^﻿?WEBVTT/.test(src) && /<\d{2}:\d{2}:\d{2}\.\d{3}>|<c[ .>]/.test(src);
}

interface RawCue extends Cue {
  lines: string[];
}

export function parseSubtitles(src: string, opts: ParseOpts = {}): Cue[] {
  const text = src.replace(/\r/g, '').replace(/^﻿/, '');
  const rolling = opts.rolling ?? looksRollingVtt(text);
  const blocks = text.split(/\n\n+/);
  const cues: RawCue[] = [];
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() !== '');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, z] = lines[ti].split('-->');
    const body = lines
      .slice(ti + 1)
      .map(clean)
      .filter(Boolean);
    if (!body.length) continue;
    cues.push({ start: ts(a), end: ts(z.split(' ').filter(Boolean)[0] ?? z), text: body.join(' '), lines: body });
  }

  const out: Cue[] = [];
  if (rolling) {
    // 1. Drop the 10 ms transition cues, 2. strip the line carried over from the previous cue, so that each
    //    cue only holds the line being spoken, 3. merge exact repeats / growing prefixes of touching cues.
    let prevLines: string[] = [];
    for (const c of cues) {
      const lines = [...c.lines];
      while (lines.length && prevLines.includes(lines[0])) lines.shift();
      prevLines = c.lines;
      if (c.end - c.start < 0.05 || !lines.length) continue;
      const t = lines.join(' ');
      const prev = out[out.length - 1];
      const touching = prev && c.start - prev.end < 0.1;
      if (prev && touching && t === prev.text) {
        prev.end = Math.max(prev.end, c.end);
        continue;
      }
      if (prev && touching && t.startsWith(prev.text) && c.start - prev.start < 8) {
        prev.text = t;
        prev.end = Math.max(prev.end, c.end);
        continue;
      }
      if (prev && touching && prev.text.endsWith(t)) {
        prev.end = Math.max(prev.end, c.end);
        continue;
      }
      out.push({ start: c.start, end: c.end, text: t });
    }
  } else {
    // Manual CC / SRT / Whisper: only collapse a cue duplicated over the same time range (overlapping repeats).
    for (const c of cues) {
      const prev = out[out.length - 1];
      if (prev && c.text === prev.text && c.start < prev.end - 0.01) {
        prev.end = Math.max(prev.end, c.end);
        continue;
      }
      out.push({ start: c.start, end: c.end, text: c.text });
    }
  }
  // Very short cues get merged into a neighbour so that each line is a meaningful chunk.
  const merged: Cue[] = [];
  for (const c of out) {
    const prev = merged[merged.length - 1];
    if (prev && (prev.end - prev.start < 1.2 || prev.text.length < 3) && c.start - prev.end < 0.6 && prev.text.length + c.text.length < 40) {
      prev.text = prev.text + ' ' + c.text;
      prev.end = c.end;
    } else merged.push({ ...c });
  }
  return merged.filter((c) => c.end > c.start);
}
