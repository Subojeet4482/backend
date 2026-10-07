// ONE Render service = core + chat. Core is served at "/", chat is served under "/chat/*".
// Also: /health for UptimeRobot, self keep-alive ping, built-in crons (replaces vercel.json crons).
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

const core = await import('./core/lib/svc.js');
const coreRoutes = await import('./core/lib/routes.js');
if (process.env.CHAT_TG_BOT_TOKEN) process.env.TG_BOT_TOKEN = process.env.CHAT_TG_BOT_TOKEN;
const chat = await import('./chat/lib/svc.js');
const chatRoutes = await import('./chat/lib/routes.js');
if (mainToken !== undefined) process.env.TG_BOT_TOKEN = mainToken;
coreRoutes.registerAll(); chatRoutes.registerAll();

// ---- crons (UTC, same times as the old vercel.json files) ----
const JOBS = [
  { path: '/cron/daily', h: 21, m: 30 },              // core
  { path: '/cron/weekly', h: 22, m: 0, dow: 0 },      // core
  { path: '/chat/cron/daily', h: 22, m: 0 },          // chat
];
const fired = new Map();
async function runJob(j) {
  const t0 = Date.now();
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}${j.path}`, { headers: { Authorization: 'Bearer ' + process.env.CRON_SECRET }, signal: AbortSignal.timeout(5 * 60000) });
    log('cron', j.path, r.status, Date.now() - t0 + 'ms');
  } catch (e) { console.error('[server] cron failed', j.path, e.message); }
}
setInterval(() => {
  const n = new Date(), stamp = n.toISOString().slice(0, 16);
  for (const j of JOBS) {
    if (n.getUTCHours() !== j.h || n.getUTCMinutes() !== j.m) continue;
    if (j.dow !== undefined && n.getUTCDay() !== j.dow) continue;
    if (fired.get(j.path) === stamp) continue;
    fired.set(j.path, stamp); runJob(j);
  }
}, 20000).unref();

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
    if ((req.method === 'HEAD' || req.method === 'GET') && (path === '/health' || path === '/chat/health' || path === '/')) {
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
  core: [['start', 'Open control panel + all commands'], ['menu', 'Control panel'], ['help', 'All commands'], ['logs', 'Server logs link + key'], ['find', 'Find a user'], ['user', 'User card by UID'], ['addbal', 'Add balance'], ['cutbal', 'Cut balance'], ['block', 'Block an IP'], ['unblock', 'Unblock an IP'], ['stop', 'Stop the server'], ['startserver', 'Start the server'], ['cancel', 'Cancel current step']],
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
  log('env check ->', ['KEY64_1', 'KEY64_2', 'KEY64_3', 'TG_BOT_TOKEN', 'CHAT_TG_BOT_TOKEN', 'TG_WEBHOOK_SECRET', 'OWNER_TG_IDS', 'ADMIN_TG_IDS', 'INTERNAL_SECRET', 'ALLOWED_ORIGINS'].map((k) => `${k}=${set(k)}`).join(' '));
});

process.on('unhandledRejection', (e) => console.error('[server] unhandledRejection', e));
process.on('uncaughtException', (e) => console.error('[server] uncaughtException', e));
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { log('shutting down'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 10000).unref(); });
