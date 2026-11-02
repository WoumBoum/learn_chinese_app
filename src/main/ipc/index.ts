// Each feature module exports `register(ctx)` and adds its own IPC channels (prefix = feature name).
import type { Ctx } from '../ctx';
import * as core from './core';
import * as study from './study';
import * as grammar from './grammar';
import * as tests from './tests';
import * as media from './media';
import * as tts from './tts';
import * as ai from './ai';
import * as reading from './reading';

export function registerIpcModules(ctx: Ctx): void {
  for (const m of [core, study, grammar, tests, media, tts, ai, reading]) m.register(ctx);
}
