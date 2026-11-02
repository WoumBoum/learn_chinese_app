// Lexical coverage of a transcript and selection of the words to pre-teach before watching.
import type { CoverageReport, PreteachWord, Token } from '../shared/types';

export interface CoverageOptions {
  target?: number; // couverture visée après pré-enseignement (0.95 = 95 %)
  maxWords?: number;
  status: (w: string) => 'known' | 'learning' | 'ignored' | undefined;
  gloss: (w: string) => { fr: string[]; py: string; en: string[] };
  isProperNoun?: (w: string) => boolean;
  rank?: (w: string) => number; // rang dans le cursus (plus petit = plus utile)
}

type Status = 'known' | 'learning' | 'ignored' | undefined;

/** A compound the segmenter merged (很大, 看书…) counts as known if it splits into known parts. */
export function composedStatus(w: string, status: (w: string) => Status, depth = 0): Status {
  const st = status(w);
  if (st) return st;
  if (w.length < 2 || depth > 2) return undefined;
  let best: Status;
  for (let i = 1; i < w.length; i++) {
    const a = composedStatus(w.slice(0, i), status, depth + 1);
    const b = composedStatus(w.slice(i), status, depth + 1);
    if (a && b && a !== 'ignored' && b !== 'ignored') {
      if (a === 'known' && b === 'known') return 'known';
      best = 'learning';
    }
  }
  return best;
}

export function analyseCoverage(lines: Token[][], o: CoverageOptions): CoverageReport {
  const baseStatus = o.status;
  o = { ...o, status: (w) => composedStatus(w, baseStatus) };
  const target = o.target ?? 0.95;
  const maxWords = o.maxWords ?? 25;
  const counts = new Map<string, number>();
  let total = 0;
  let known = 0;
  let learning = 0;
  for (const line of lines)
    for (const tk of line) {
      if (!tk.han) continue;
      total++;
      const st = o.status(tk.t);
      if (st === 'known' || st === 'ignored') known++;
      else if (st === 'learning') learning++;
      else if (o.isProperNoun?.(tk.t)) known++; // les noms propres ne comptent pas comme inconnus
      else counts.set(tk.t, (counts.get(tk.t) ?? 0) + 1);
    }
  const uniqueWords = new Set(lines.flat().filter((t) => t.han).map((t) => t.t)).size;
  const cov = total ? (known + learning) / total : 1;

  // Also count "learning" words so they can be reinforced in the briefing (they are already in SRS).
  const learningCounts = new Map<string, number>();
  for (const line of lines) for (const tk of line) if (tk.han && o.status(tk.t) === 'learning') learningCounts.set(tk.t, (learningCounts.get(tk.t) ?? 0) + 1);

  const candidates = [...counts.entries()]
    .filter(([w]) => o.gloss(w).fr.length + o.gloss(w).en.length > 0)
    .sort((a, b) => b[1] - a[1] || (o.rank?.(a[0]) ?? 1e9) - (o.rank?.(b[0]) ?? 1e9));
  const preteach: PreteachWord[] = [];
  let covered = known + learning;
  for (const [w, n] of candidates) {
    if (total && covered / total >= target) break;
    if (preteach.length >= maxWords) break;
    // Skip hapaxes once 90 % is reached: low value for the effort.
    if (n === 1 && total && covered / total >= 0.9 && (o.rank?.(w) ?? 1e9) > 3000) continue;
    const g = o.gloss(w);
    preteach.push({ w, count: n, fr: g.fr.length ? g.fr : g.en, py: g.py, status: 'new' });
    covered += n;
  }
  return {
    totalTokens: total,
    uniqueWords,
    knownTokens: known,
    learningTokens: learning,
    coverage: cov,
    coverageKnownOnly: total ? known / total : 1,
    afterPreteach: total ? covered / total : 1,
    preteach,
  };
}
