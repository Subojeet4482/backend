// ONE Render service = core + chat. Core is served at "/", chat is served under "/chat/*".
// Also: /health for UptimeRobot, self keep-alive ping, built-in crons with catch-up (replaces vercel.json crons).
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 10000);
const SELF = String(process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const MAX_BODY = 1024 * 1024;
const log = (...a) => console.log('[server]', ...a);

if (!process.env.CRON_SECRET) process.env.CRON_SECRET = crypto.randomBytes(24).toString('hex');
// Single process = core + chat, so they talk to each other over localhost. No URL env vars needed (URLs on Render can change).
if (!process.env.INTERNAL_SECRET) process.env.INTERNAL_SECRET = crypto.randomBytes(24).toString('hex');
process.env.CORE_BASE_URL = `http://127.0.0.1:${PORT}`;
process.env.CHAT_BASE_URL = `http://127.0.0.1:${PORT}/chat`;
if (process.env.RENDER_EXTERNAL_URL) process.env.PUBLIC_BASE_URL = process.env.RENDER_EXTERNAL_URL;
// Telegram allows ONE webhook per bot, so chat needs its own bot token (CHAT_TG_BOT_TOKEN). Core reads TG_BOT_TOKEN.
const mainToken = process.env.TG_BOT_TOKEN;

const { adminLoginWarnings } = await import('./core/lib/adminauth.js');
const { showIdToStrangers } = await import('./core/lib/tg.js');
const core = await import('./core/lib/svc.js');
const coreRoutes = await import('./core/lib/routes.js');
if (process.env.CHAT_TG_BOT_TOKEN) process.env.TG_BOT_TOKEN = process.env.CHAT_TG_BOT_TOKEN;
const chat = await import('./chat/lib/svc.js');
const chatRoutes = await import('./chat/lib/routes.js');
if (mainToken !== undefined) process.env.TG_BOT_TOKEN = mainToken;
coreRoutes.registerAll(); chatRoutes.registerAll();
// panel logins added from the Telegram bot live in Firestore; load them now (and refresh every 15 s) so tokens/logins work on core AND chat
{ const PA = await import('./core/lib/paneladmins.js'); await PA.load(); PA.startRefresh(); }

// ---- crons (UTC) with CATCH-UP + exactly-once ----
// Not tied to one exact minute: every minute we compute the most recent scheduled slot of each job and run it if
// it was missed (service asleep / restarting at that minute), as long as it is inside the job's grace window.
// A claim doc in Firestore (main DB, collection cron_runs) makes sure a slot runs once, even across restarts / 2 instances.
const { db: fbdb } = await import('./core/lib/fb.js');
const JOBS = [
  { path: '/cron/daily', h: 21, m: 30, grace: 36 * 3600e3 },                 // core: archive + cleanup
  { path: '/cron/weekly', h: 22, m: 0, dow: 0, grace: 6 * 86400e3 },         // core: weekly Telegram backup (Sunday)
  { path: '/chat/cron/daily', h: 22, m: 0, grace: 36 * 3600e3 },             // chat
];
const slotOf = (j, now = new Date()) => {
  const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), j.h, j.m));
  if (j.dow !== undefined) t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() - j.dow + 7) % 7));
  if (t > now) t.setUTCDate(t.getUTCDate() - (j.dow !== undefined ? 7 : 1));
  return t;
};
const doneMem = new Set(), checked = new Map(), attempts = new Map(), running = new Set();
const cronRef = (id) => fbdb.main().collection('cron_runs').doc(id);
async function claim(id, slot) {
  return fbdb.main().runTransaction(async (tx) => {
    const ref = cronRef(id), s = await tx.get(ref);
    if (s.exists) { const d = s.data(); if (d.state === 'done' || Date.now() - d.at < 10 * 60000) return false; }   // done, or another run is in progress
    tx.set(ref, { at: Date.now(), slot: slot.getTime(), state: 'running', exp: slot.getTime() + 40 * 86400e3 });
    return true;
  });
}
async function runJob(j, id) {
  const t0 = Date.now();
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}${j.path}`, { headers: { Authorization: 'Bearer ' + process.env.CRON_SECRET }, signal: AbortSignal.timeout(5 * 60000) });
    log('cron', j.path, r.status, Date.now() - t0 + 'ms');
    if (!r.ok) throw new Error('status ' + r.status);
    await cronRef(id).set({ state: 'done', doneAt: Date.now() }, { merge: true }); doneMem.add(id);
  } catch (e) {
    console.error('[server] cron failed', j.path, e.message, '(will retry)');
    await cronRef(id).delete().catch(() => {});                                  // release claim so the next tick can retry
  }
}
async function cronTick() {
  for (const j of JOBS) {
    const slot = slotOf(j), id = j.path.replace(/\//g, '_') + '_' + slot.toISOString().slice(0, 16).replace(/\D/g, '');
    if (Date.now() - slot.getTime() > j.grace || doneMem.has(id) || running.has(id)) continue;
    if (Date.now() - (checked.get(id) || 0) < 5 * 60000) continue;               // don't hit Firestore every minute for the same slot
    if ((attempts.get(id) || 0) >= 4) continue;                                  // a broken job must not loop forever
    checked.set(id, Date.now());
    try {
      if (!(await claim(id, slot))) { checked.set(id, Date.now() + 10 * 60000); continue; }
    } catch (e) { console.error('[server] cron claim failed (Firestore?)', e.message); continue; }
    attempts.set(id, (attempts.get(id) || 0) + 1); running.add(id);
    log('cron due', j.path, 'slot', slot.toISOString(), Date.now() - slot.getTime() > 3 * 60000 ? '(CATCH-UP)' : '');
    runJob(j, id).finally(() => running.delete(id));
  }
}
setInterval(() => { cronTick().catch((e) => console.error('[server] cron tick', e.message)); }, 60000).unref();
setTimeout(() => cronTick().catch((e) => console.error('[server] cron tick', e.message)), 20000).unref();   // right after boot/wake: catch up missed jobs

// ---- keep-alive (Render free sleeps after ~15 min without inbound traffic) ----
if (SELF) setInterval(() => fetch(SELF + '/health', { signal: AbortSignal.timeout(15000) }).catch(() => {}), 8 * 60000).unref();

function readBody(req) {
  return new Promise((resolve) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return resolve({});
    const chunks = []; let size = 0, dead = false;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { dead = true; req.destroy(); resolve(null); } else chunks.push(c); });
    req.on('end', () => { if (dead) return; const s = Buffer.concat(chunks).toString('utf8'); try { resolve(s ? JSON.parse(s) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve(null));
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const path = req.url.split('?')[0];
    if ((req.method === 'HEAD' || req.method === 'GET') && (path === '/health' || path === '/chat/health' || path === '/chat' || path === '/')) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ ok: true, services: ['core', 'chat'], uptime: Math.round(process.uptime()), time: Date.now() }));
    }
    // behind Cloudflare: never trust client-sent x-real-ip / x-vercel-* (used for rate-limit + IP block)
    const h = req.headers;
    h['x-real-ip'] = String(h['cf-connecting-ip'] || (h['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || '0.0.0.0').trim();
    delete h['x-vercel-forwarded-for'];
    req.body = await readBody(req);
    if (req.body === null) { res.writeHead(413, { 'Content-Type': 'application/json' }); return res.end('{"ok":false,"error":{"code":"too_large","message":"Request too large"}}'); }
    if (path === '/chat' || path.startsWith('/chat/')) { req.url = req.url.slice(5) || '/'; return await chat.svc.handle(req, res); }
    return await core.svc.handle(req, res);
  } catch (e) {
    console.error('[server] request error', e);
    if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":{"code":"server_error","message":"Something went wrong"}}'); }
  }
});

// ---- Telegram polling (default): bot khud Telegram se updates leta hai, webhook/URL/secret ki zaroorat nahi.
// Set TG_MODE=webhook in Render env only if you want the old webhook mode.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CMDS = {
  core: [['start', 'Open control panel + all commands'], ['menu', 'Control panel'], ['help', 'All commands'], ['logs', 'Server logs link + key'], ['find', 'Find a user'], ['user', 'User card by UID'], ['addbal', 'Add balance'], ['cutbal', 'Cut balance'], ['block', 'Block an IP'], ['unblock', 'Unblock an IP'], ['unlockadmin', 'Unlock an admin panel login (owner)'], ['stop', 'Stop the server'], ['startserver', 'Start the server'], ['cancel', 'Cancel current step']],
  chat: [['start', 'Open chat control panel'], ['menu', 'Control panel'], ['help', 'All commands'], ['cban', 'Mute a user'], ['cunban', 'Unmute a user'], ['delmsg', 'Delete a message'], ['addword', 'Block a word'], ['rmword', 'Unblock a word'], ['unblock', 'Unblock an IP'], ['stop', 'Stop chat server'], ['startserver', 'Start chat server'], ['cancel', 'Cancel current step']],
};
async function poll(name, token, getHandler) {
  if (!token) { log(`[tg:${name}] no bot token -> bot off`); return; }
  const api = (m, body, ms = 15000) => fetch(`https://api.telegram.org/bot${token}/${m}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(ms) }).then((r) => r.json());
  const handler = await getHandler();
  try {
    const me = await api('getMe');
    if (!me.ok) { console.error(`[tg:${name}] TOKEN INVALID:`, me.description, '-> bot off'); return; }
    await api('deleteWebhook', { drop_pending_updates: false });
    await api('setMyCommands', { commands: CMDS[name].map(([command, description]) => ({ command, description })) }).catch(() => {});
    log(`[tg:${name}] polling started as @${me.result.username}`);
  } catch (e) { console.error(`[tg:${name}] start check failed (will keep trying):`, e.message); }
  let offset = 0;
  for (;;) {
    try {
      const r = await api('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, 40000);
      if (!r.ok) { console.error(`[tg:${name}] getUpdates:`, r.error_code, r.description); await sleep(r.error_code === 409 ? 6000 : 4000); continue; }
      for (const u of r.result) { offset = u.update_id + 1; Promise.resolve(handler(u)).catch((e) => console.error(`[tg:${name}] handler error`, e)); }
    } catch (e) { await sleep(3000); }
  }
}
if ((process.env.TG_MODE || 'polling') !== 'webhook') {
  poll('core', mainToken, async () => (await import('./core/lib/bot.js')).handleUpdate);
  if (process.env.CHAT_TG_BOT_TOKEN && process.env.CHAT_TG_BOT_TOKEN !== mainToken) poll('chat', process.env.CHAT_TG_BOT_TOKEN, async () => (await import('./chat/lib/bot.js')).handleUpdate);
} else log('TG_MODE=webhook -> use setWebhook');

server.keepAliveTimeout = 65000; server.headersTimeout = 66000;
server.listen(PORT, '0.0.0.0', () => {
  log(`listening on :${PORT}`, SELF);
  const set = (k) => (process.env[k] ? 'set' : 'MISSING');
  log('env check ->', ['KEY64_1', 'KEY64_2', 'KEY64_3', 'TG_BOT_TOKEN', 'CHAT_TG_BOT_TOKEN', 'TG_WEBHOOK_SECRET', 'OWNER_TG_IDS', 'ADMIN_TG_IDS', 'INTERNAL_SECRET', 'ALLOWED_ORIGINS', 'ADMIN_PANEL_KEY', 'ADMIN_LOGIN_EMAIL', 'ADMIN_LOGIN_PASSWORD', 'ADMIN_LOGIN_PIN', 'ADMIN_LOGIN_EMAIL_2'].map((k) => `${k}=${set(k)}`).join(' '));
});

for (const w of adminLoginWarnings()) console.warn('[server] ' + w);
log('bot strangers reply:', showIdToStrangers() ? 'ON (setup mode: set OWNER_TG_IDS and remove SETUP_SHOW_ID to turn off)' : 'OFF (silent)');

process.on('unhandledRejection', (e) => console.error('[server] unhandledRejection', e));
process.on('uncaughtException', (e) => console.error('[server] uncaughtException', e));
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { log('shutting down'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 10000).unref(); });
