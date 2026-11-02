// AI channels (optional module). Every `ai:*` channel except status/test throws Error('IA non configurée') without an API key.
import type { Ctx } from '../ctx';
import { handle } from '../ctx';
import { AiService, type RoleplayScenario, type RoleplayTurn } from '../services/ai';

let service: AiService | null = null;
/** Shared instance (other main modules may call it, e.g. to refine a briefing automatically). */
export function aiService(ctx: Ctx): AiService {
  if (!service) service = new AiService({ db: ctx.db, content: ctx.content, cur: ctx.cur, settings: ctx.settings });
  return service;
}

export function register(ctx: Ctx): void {
  const ai = aiService(ctx);
  handle('ai:status', () => ai.status());
  handle('ai:test', (override?: { apiKey?: string; model?: string }) => ai.test(override));
  handle('ai:refinePreteach', (videoId: string) => ai.refinePreteach(videoId));
  handle('ai:analyzeVideo', (videoId: string) => ai.analyzeVideo(videoId));
  handle('ai:translateLines', (videoId: string, opts?: { force?: boolean }) => ai.translateLines(videoId, opts));
  handle('ai:explainLine', (zh: string, context?: string) => ai.explainLine(zh, context));
  handle('ai:quiz', (videoId: string) => ai.quiz(videoId));
  handle('ai:correct', (o: { fr: string; userZh: string; answers: string[] }) => ai.correct(o));
  handle('ai:story', (o?: { theme?: string; length?: 'short' | 'medium' | 'long' }) => ai.story(o ?? {}));
  handle('ai:roleplay', (o: { scenario: RoleplayScenario; messages: RoleplayTurn[] }) => ai.roleplay(o));
  handle('ai:confusions', () => ai.confusions());
}
