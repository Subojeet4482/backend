// Router: cheap early rejects (no DB), origin allow-list with "request from unknown domain" capture, IP block,
// global + per-route rate limit, auth (user/admin/internal/cron), stop/maintenance, friendly errors with fake error numbers.
import { env, HttpError, safeEq, clientIp } from './base.js';
import * as store from './store.js';
import { verifyInternal } from './internal.js';
import { isAdminToken, verifyAdminToken } from './adminauth.js';

const originOf = (o) => String(o || '').toLowerCase().replace(/\/+$/, '');
export const ERRNO = { invalid: 1110567, stopped: 1110621, maintenance: 1110642, rate: 1110688, blocked: 1110704 };
const MSG = {
  invalid: 'Sorry, the server cannot reply to your message. Your request reached the server in an invalid format.',
  stopped: 'Sorry, the server is temporarily stopped. Please try again later.',
  maintenance: 'The server is under maintenance. Please try again soon.',
  rate: 'Too many requests. Please slow down and try again.',
  blocked: 'Your connection has been blocked. Please try again later.',
};
const fail = (code, message, extra) => ({ ok: false, error: { code, message, ...(extra || {}) } });
const tagged = (kind, extra = {}) => new HttpError(kind === 'invalid' ? 400 : kind === 'rate' ? 429 : kind === 'blocked' ? 403 : 503, ({ invalid: 'origin_not_allowed', rate: 'rate_limited', blocked: 'ip_blocked', stopped: 'stopped', maintenance: 'maintenance' })[kind], `Error ${ERRNO[kind]}: ${MSG[kind]}`, { errorNo: ERRNO[kind], ...extra });
export const errorPage = (no, msg) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Error ${no}</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1115;color:#e6e8ee;font-family:system-ui,sans-serif}main{max-width:460px;padding:32px;text-align:center}h1{font-size:44px;margin:0 0 8px;color:#ff5d5d}p{line-height:1.5;color:#aab0bd}</style></head><body><main><h1>Error ${no}</h1><p>${msg}</p></main></body></html>`;
const isNav = (req) => req.headers['sec-fetch-mode'] === 'navigate' || (!req.headers.origin && String(req.headers.accept || '').includes('text/html'));

export function createService({ name, cfg, guard, verifyToken, onEvent }) {
  const routes = [];
  const add = (method, path, opts, handler) => {
    if (typeof opts === 'function') { handler = opts; opts = {}; }
    routes.push({ method, path, parts: path.split('/').filter(Boolean), opts: { auth: 'none', ...opts }, handler });
  };
  const match = (method, parts) => {
    for (const r of routes) {
      if (r.method !== method || r.parts.length !== parts.length) continue;
      const params = {}; let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const p = r.parts[i];
        if (p[0] === ':') params[p.slice(1)] = decodeURIComponent(parts[i]); else if (p !== parts[i]) { ok = false; break; }
      }
      if (ok) return { r, params };
    }
    return null;
  };
  const adminEmails = () => env('ADMIN_EMAILS').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const limit = async (key, max, win) => {
    let n = 0;
    try { n = await store.incr(key, win); } catch (e) { console.warn('limiter', e.message); return false; }
    return n > max;
  };
  const event = (type, info) => { try { Promise.resolve(onEvent && onEvent(type, info)).catch(() => {}); } catch {} };

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const method = req.method, ip = clientIp(req), parts = url.pathname.split('/').filter(Boolean);
    const rawOrigin = String(req.headers.origin || '');
    const origin = originOf(rawOrigin);
    let cors = {};
    const send = (status, obj, h = {}) => {
      res.statusCode = status;
      for (const [k, v] of Object.entries({ ...cors, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...h })) res.setHeader(k, v);
      if (status === 204) return res.end();
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj));
    };
    const sendHtml = (status, html) => {
      res.statusCode = status; res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'");
      res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.end(html);
    };
    const sendErr = (e) => {
      const nav = isNav(req);
      if (nav && e.extra?.errorNo) return sendHtml(e.status, errorPage(e.extra.errorNo, MSG[Object.keys(ERRNO).find((k) => ERRNO[k] === e.extra.errorNo)] || MSG.invalid));
      return send(e.status, fail(e.code, e.message, e.extra), e.extra?.retryAfter ? { 'Retry-After': String(e.extra.retryAfter) } : {});
    };

    if (url.pathname === '/health') return send(200, { ok: true, service: name, time: Date.now() });
    const m = match(method === 'OPTIONS' ? 'POST' : method, parts) || (method === 'OPTIONS' ? match('GET', parts) || match('PUT', parts) || match('DELETE', parts) : null);
    if (!m) return isNav(req) ? sendHtml(400, errorPage(ERRNO.invalid, MSG.invalid)) : send(404, fail('not_found', 'Not found'));
    const { r, params } = m, o = r.opts;
    const internalish = ['internal', 'cron'].includes(o.auth) || !!o.skipGuard;
    const needsOrigin = !internalish && o.origin !== false;

    // ---- cheap rejects: no DB / Redis touched ----
    try {
      if (needsOrigin && method !== 'OPTIONS' && isNav(req)) throw tagged('invalid');
      if (needsOrigin && !origin) throw tagged('invalid');
    } catch (e) { return sendErr(e); }

    let c; try { c = await cfg.get(); } catch { c = {}; }
    const allowed = [...(c.allowedOrigins || []), ...env('ALLOWED_ORIGINS').split(',')].map(originOf).filter(Boolean);
    const okOrigin = !!origin && allowed.includes(origin);
    if (okOrigin) cors = { 'Access-Control-Allow-Origin': rawOrigin, Vary: 'Origin', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Max-Age': '600' };

    if (needsOrigin && !okOrigin) {
      const denied = (c.deniedOrigins || []).map(originOf).includes(origin);
      if (!denied && origin.length < 200 && /^https?:\/\//.test(origin)) {          // remember the last 10 unknown domains for the bot
        try { if (cfg.reqPush && (await store.once('ff:dseen:' + origin, 300)) && (await store.incr('ff:dreqcap', 60)) <= 20) await cfg.reqPush({ o: origin, t: Date.now(), ip }); } catch {}
        event('origin_denied', { ip, origin, path: url.pathname });
      }
      return sendErr(tagged('invalid'));
    }
    if (method === 'OPTIONS') return send(204, {});

    try {
      if (!internalish && !o.always) {
        if (c.stopped) throw tagged('stopped');
      }
      if (!internalish) {
        if (await guard.isBlocked(ip)) { event('ip_blocked_hit', { ip, path: url.pathname }); throw tagged('blocked'); }
        if (await limit('ff:g:' + ip, c.globalLimit || 120, 60)) { event('rate_limited', { ip, path: url.pathname }); throw tagged('rate', { retryAfter: 60 }); }
        if (c.maintenance && o.auth !== 'admin' && !o.always) throw tagged('maintenance');
      }
      if (Number(req.headers['content-length'] || 0) > (o.maxBody || 20000)) throw new HttpError(413, 'too_large', 'Request too large');
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
      if (!body || typeof body !== 'object') body = {};

      let user = null;
      if (o.auth === 'user' || o.auth === 'admin') {
        const h = req.headers.authorization || '';
        if (!h.startsWith('Bearer ')) throw new HttpError(401, 'no_token', 'Please login');
        const tok = h.slice(7);
        if (o.auth === 'admin' && isAdminToken(tok)) {          // admin panel session from /admin/login (env email + password + PIN)
          user = verifyAdminToken(tok);
          if (!user) throw new HttpError(401, 'bad_token', 'Session expired. Login again.');
        } else {
          try { user = await verifyToken(tok); } catch { throw new HttpError(401, 'bad_token', 'Session expired. Login again.'); }
          if (o.auth === 'admin' && !(user.admin === true || adminEmails().includes(String(user.email || '').toLowerCase()))) throw new HttpError(403, 'forbidden', 'Admin only');
        }
      } else if (o.auth === 'internal') verifyInternal(req, body);
      else if (o.auth === 'cron') { const s = env('CRON_SECRET'); if (!s || !safeEq(req.headers.authorization || '', 'Bearer ' + s)) throw new HttpError(401, 'bad_cron', 'Unauthorized'); }

      if (o.rl && (await limit(`ff:r:${method}${r.path}:${user ? user.uid : ip}`, o.rl[0], o.rl[1]))) { event('rate_limited', { ip, path: url.pathname }); throw tagged('rate', { retryAfter: o.rl[1] }); }
      const out = await r.handler({ req, res, ip, ua: req.headers['user-agent'] || '', body, query: Object.fromEntries(url.searchParams), params, user, cfg: c });
      if (out && out.__html) return sendHtml(200, out.__html);
      return send(200, { ok: true, ...(out || {}) });
    } catch (e) {
      if (e instanceof HttpError) return sendErr(e);
      console.error(`[${name}] ${method} ${url.pathname}`, e);
      return send(500, fail('server_error', 'Something went wrong'));
    }
  }
  return { add, handle, adminEmails };
}
