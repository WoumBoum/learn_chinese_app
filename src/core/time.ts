// Day boundaries: a "study day" starts at 4:00 local time (like Anki) so late-night sessions count for the same day.
export const DAY_MS = 86_400_000;
const ROLLOVER_H = 4;

export function dayKey(ts: number | Date = Date.now()): string {
  const d = new Date(typeof ts === 'number' ? ts : ts.getTime());
  d.setHours(d.getHours() - ROLLOVER_H);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Epoch ms when the given study day ends (next day 4:00). */
export function dayEnd(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d + 1, ROLLOVER_H, 0, 0, 0).getTime();
}

export function dayStart(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, ROLLOVER_H, 0, 0, 0).getTime();
}

export function addDays(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n, 12);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

export function daysBetween(a: string, b: string): number {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / DAY_MS);
}

export function weekday(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, 12).getDay();
}
