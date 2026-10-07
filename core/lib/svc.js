import { makeCfg } from './cfg.js';
import { makeGuard } from './guard.js';
import { makeLogs } from './logs.js';
import { createService } from './http.js';
import { makeTg, notify } from './tg.js';
import { makeRoles } from './roles.js';
import { makeState } from './state.js';
import * as store from './store.js';
import { db, verifyIdToken } from './fb.js';
import { env } from './base.js';

export const DEFAULTS = {
  allowedOrigins: [], deniedOrigins: [], maintenance: false, stopped: false, globalLimit: 120,
  loginIpMax: 5, loginBlockHours: 24, loginEmailMax: 10, loginEmailLockMin: 30,
  withdrawEnabled: true, depositEnabled: true, joinEnabled: true,
  withdrawMin: 20, withdrawMax: 10000, withdrawFee: 2, depositMin: 10, depositMax: 50000,
};
export const cfg = makeCfg(() => db.main(), DEFAULTS);
export const guard = makeGuard(() => db.main());
export const logs = makeLogs(() => db.archive());
export const tg = makeTg(env('TG_BOT_TOKEN'));
export const roles = makeRoles(() => db.main());
export const state = makeState(() => db.main());
export const notifyAdmins = async (text, kbd) => notify(tg, await roles.recipients(), text, kbd);

// security events (rate-limit hits, blocked-IP hits, unknown-domain requests) -> ip_logs, de-duplicated and capped
async function onEvent(type, info) {
  if (!(await store.once(`ff:ev:${type}:${info.ip}`, 60))) return;
  if ((await store.incr('ff:evcap', 60)) > 40) return;
  await logs.ipLog(type, { ip: info.ip, path: info.path, origin: info.origin });
}
export const svc = createService({ name: 'core', cfg, guard, verifyToken: verifyIdToken, onEvent });
