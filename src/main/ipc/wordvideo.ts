// Canaux video:* — une vidéo YouTube par mot / caractère (index pré-calculé, recherche de repli, choix IA, cache).
//   video:forTarget(target, slot)          → WordVideoResult
//   video:next(target, slot)               → WordVideoResult (la courante est passée, on boucle)
//   video:hide(target, slot, id, reason)   → WordVideoResult (reason : 'irrelevant' | 'broken')
//   video:prefetch(words[])                → nombre de cibles mises en recherche
//   video:resume()                         → lève la pause « hors ligne » (renderer : événement online) ; false si
//                                            les recherches sont arrêtées pour la session (403/429, yt-dlp absent)
// Événement poussé : video:updated {target, slot} (recherche terminée ou abandonnée) → le composant recharge.
import type { Ctx } from '../ctx';
import { handle } from '../ctx';
import { aiService } from './ai';
import { WordVideoService, loadChannels, loadIndex, ytSearch, type Slot } from '../services/wordvideo';

const CURRENT_MISSION_SQL = "SELECT id, preteach FROM missions WHERE status IN ('planned','briefing','ready') ORDER BY planned_date LIMIT 1";
const FIRST_IDLE_MS = 60_000;
const IDLE_EVERY_MS = 30 * 60_000;

let service: WordVideoService | null = null;
export function wordVideoService(ctx: Ctx): WordVideoService {
  if (service) return service;
  const index = loadIndex(ctx.paths.data);
  service = new WordVideoService({
    db: ctx.db,
    index,
    channels: loadChannels(ctx.paths.content),
    pinyin: (t) => ctx.content.gloss(t).py || ctx.content.chars[t]?.py?.[0] || '',
    search: ytSearch(ctx.paths.bin, () => {
      const p = ctx.db.getSetting<{ cookiesBrowser?: string }>('mediaPrefs', {});
      return p.cookiesBrowser || undefined;
    }),
    ai: {
      configured: () => !!ctx.settings().apiKey?.trim(),
      pick: (target, slot, cands) => aiService(ctx).pickWordVideo(target, slot, cands),
    },
    emit: (ch, p) => ctx.emit(ch, p),
    log: (...a) => console.warn(...a),
  });
  return service;
}

/** Mots de demain : prochains mots du programme + vocabulaire à pré-enseigner de la mission en cours. */
function upcomingWords(ctx: Ctx): string[] {
  const n = Math.max(4, Math.min(30, ctx.settings().newWordsPerDay || 12));
  const words = ctx.cur.nextWords(n).map((w) => w.w);
  try {
    const m = ctx.db.get<{ preteach: string }>(CURRENT_MISSION_SQL);
    const pre = m ? (JSON.parse(m.preteach) as { w?: string }[]) : [];
    for (const p of Array.isArray(pre) ? pre : []) if (p && typeof p.w === 'string') words.push(p.w);
  } catch {
    /* préparation illisible : ignorée */
  }
  return [...new Set(words)];
}

const asSlot = (s: unknown): Slot => (s === 'etymology' ? 'etymology' : 'usage');

export function register(ctx: Ctx): void {
  const svc = wordVideoService(ctx);
  handle('video:forTarget', (target: string, slot: Slot) => svc.forTarget(target, asSlot(slot)));
  handle('video:next', (target: string, slot: Slot) => svc.next(target, asSlot(slot)));
  handle('video:hide', (target: string, slot: Slot, id: string, reason: 'irrelevant' | 'broken') =>
    svc.hide(target, asSlot(slot), String(id ?? ''), reason === 'broken' ? 'broken' : 'irrelevant'),
  );
  handle('video:prefetch', (words: string[]) => svc.prefetch(Array.isArray(words) ? words.map(String) : []));
  handle('video:resume', () => svc.resume());

  // Pré-chargement au repos : jamais au démarrage, jamais si une recherche tourne, ni pendant un arrêt / une pause.
  const idle = () => {
    if (svc.blocked() || svc.pendingCount() > 0) return;
    try {
      svc.prefetch(upcomingWords(ctx));
    } catch (e) {
      console.warn('[video] pré-chargement', e);
    }
  };
  setTimeout(idle, FIRST_IDLE_MS).unref?.();
  setInterval(idle, IDLE_EVERY_MS).unref?.();
}
