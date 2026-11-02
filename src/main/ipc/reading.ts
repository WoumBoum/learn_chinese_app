// Reading channels (no AI needed): extensive-reading sentences and stored graded stories.
import type { Ctx } from '../ctx';
import { handle } from '../ctx';
import { ReadingService } from '../services/reading';

export function register(ctx: Ctx): void {
  const r = new ReadingService({ db: ctx.db, content: ctx.content, cur: ctx.cur });
  handle('reading:sentences', (o?: { n?: number; mode?: 'known' | 'i+1'; exclude?: number[] }) => r.sentences(o ?? {}));
  handle('reading:tokenize', (text: string) => r.tokenize(text));
  handle('reading:stories', () => r.stories());
  handle('reading:story', (id: string) => r.story(id));
  handle('reading:markRead', (id: string) => r.markRead(id));
  handle('reading:deleteStory', (id: string) => r.deleteStory(id));
}
