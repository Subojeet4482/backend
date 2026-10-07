import { makeCfg } from './cfg.js';
import { makeGuard } from './guard.js';
import { makeLogs } from './logs.js';
import { createService } from './http.js';
import { makeTg, notify } from './tg.js';
import { makeRoles } from './roles.js';
import { makeState } from './state.js';
import { db, verifyIdToken } from './fb.js';
import { env } from './base.js';

export const DEFAULTS = { allowedOrigins: [], deniedOrigins: [], stopped: false, maintenance: false, globalLimit: 120, worldEnabled: true, msgMaxLen: 300, blockLinks: true, badWords: [], retentionDays: 7, cooldownSec: 2, mediaOn: true, banner: '' };
export const cfg = makeCfg(() => db.chat(), DEFAULTS);
export const guard = makeGuard(() => db.chat());
export const logs = makeLogs(() => db.chat());
export const tg = makeTg(env('TG_BOT_TOKEN'));
export const roles = makeRoles(() => db.chat());
export const state = makeState(() => db.chat());
export const notifyAdmins = async (text, kbd) => notify(tg, await roles.recipients(), text, kbd);
export const svc = createService({ name: 'chat', cfg, guard, verifyToken: verifyIdToken });
