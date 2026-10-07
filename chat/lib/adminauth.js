// Admin panel login: email + password + PIN. Two sources of accounts:
//  1) Render env (permanent, up to 5):  ADMIN_LOGIN_EMAIL / _PASSWORD / _PIN, then the same keys with _2 ... _5.
//  2) Telegram bot (owner adds/removes, up to 10): stored in Firestore config/panel_admins as scrypt HASHES (never plain text).
// Optional: ADMIN_SESSION_SECRET (extra signing secret), ADMIN_SESSION_HOURS (default 12).
// Login returns a signed token ("ffa1.<payload>.<sig>"). Each account's signing key is derived from ITS OWN credentials, so
// changing a password/PIN logs out only that admin, and deleting an account kills its sessions at once.
// Stateless tokens: any number of admins can be logged in at the same time; sessions survive restarts.
// Core and chat share one process, so the db-account list lives in a global cache that both module copies read.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { env } from './base.js';

const scrypt = promisify(crypto.scrypt);
export const MAX_ENV_ADMINS = 5;
export const MAX_PANEL_LOGINS = 10;
const PREFIX = 'ffa1';
const h = (s) => crypto.createHash('sha256').update(String(s)).digest();
const eq = (a, b) => crypto.timingSafeEqual(h(a), h(b));          // equal-length digests -> constant time
const b64u = (b) => Buffer.from(b).toString('base64url');
const ttlMs = () => Math.min(Math.max(Number(env('ADMIN_SESSION_HOURS', '12')) || 12, 1), 72) * 3600e3;

// ---- hashed secrets (for accounts added from Telegram) ----
export async function hashSecret(secret) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: (await scrypt(String(secret), salt, 32)).toString('hex') };
}
const verifySecret = async (secret, salt, hash) => {
  const d = await scrypt(String(secret), salt, 32), want = Buffer.from(hash, 'hex');
  return d.length === want.length && crypto.timingSafeEqual(d, want);
};
const DUMMY = { salt: '00'.repeat(16), hash: '00'.repeat(32) };

// ---- shared cache of Telegram-added accounts: [{ sid, email, salt, pw, pinSalt, pin, at, by }] ----
const G = (globalThis.__ffPanelAdmins ||= { list: [] });
export const setStoredAccounts = (list) => { G.list = Array.isArray(list) ? list : []; };
export const storedAccounts = () => G.list;

export function envAccounts() {
  const out = [], seen = new Set();
  for (let i = 1; i <= MAX_ENV_ADMINS; i++) {
    const sfx = i === 1 ? '' : '_' + i;
    const email = env('ADMIN_LOGIN_EMAIL' + sfx).trim().toLowerCase(), password = env('ADMIN_LOGIN_PASSWORD' + sfx), pin = env('ADMIN_LOGIN_PIN' + sfx).trim();
    if (!email || !password || !pin || seen.has(email)) continue;
    seen.add(email); out.push({ type: 'env', n: i, email, password, pin });
  }
  return out;
}
export function adminAccounts() {
  const e = envAccounts(), seen = new Set(e.map((a) => a.email));
  const d = storedAccounts().filter((a) => a && a.email && !seen.has(a.email)).map((a) => ({ type: 'db', ...a }));
  return [...e, ...d];
}
export const adminLoginEnabled = () => adminAccounts().length > 0;
export const isAdminEmail = (email) => { const e = String(email || '').trim().toLowerCase(); return adminAccounts().some((a) => a.email === e); };

const keyFor = (a) => crypto.createHmac('sha256', 'ff-admin-session-v1').update(
  (a.type === 'db' ? ['db', a.email, a.pw, a.pin, a.salt, a.pinSalt] : [a.email, a.password, a.pin]).concat(env('ADMIN_SESSION_SECRET')).join('\u0000')).digest();
const sig = (a, payload) => crypto.createHmac('sha256', keyFor(a)).update(payload).digest('base64url');

export function adminLoginWarnings() {
  const list = envAccounts();
  if (!adminLoginEnabled()) return ['admin login OFF (set ADMIN_LOGIN_EMAIL, ADMIN_LOGIN_PASSWORD, ADMIN_LOGIN_PIN, or add a panel login from the Telegram bot)'];
  const w = [];
  for (const a of list) {
    if (a.password.length < 10) w.push(`admin #${a.n}: password is short (use 12+ characters)`);
    if (a.pin.length < 6) w.push(`admin #${a.n}: PIN is short (use 6+ digits)`);
  }
  return w;
}

// returns the matching account or null. Env accounts: all compared, no early exit. DB accounts: scrypt (a dummy hash is run
// for unknown emails so the response time does not reveal whether an email exists).
export async function checkAdminCreds({ email, password, pin }) {
  const e = String(email || '').trim().toLowerCase(), p = String(password || ''), n = String(pin || '').trim();
  let hit = null;
  for (const a of envAccounts()) { const ok = eq(e, a.email) & eq(p, a.password) & eq(n, a.pin); if (ok) hit = a; }
  const d = storedAccounts().find((a) => a.email === e && !envAccounts().some((x) => x.email === e));
  const [pwOk, pinOk] = await Promise.all([verifySecret(p, (d || DUMMY).salt || DUMMY.salt, (d || DUMMY).pw || DUMMY.hash), verifySecret(n, (d || DUMMY).pinSalt || DUMMY.salt, (d || DUMMY).pin || DUMMY.hash)]);
  if (d && pwOk && pinOk) hit = { type: 'db', ...d };
  return hit;
}

export function issueAdminToken(a) {
  const now = Date.now(), exp = now + ttlMs(), payload = b64u(JSON.stringify({ e: a.email, iat: now, exp }));
  return { token: `${PREFIX}.${payload}.${sig(a, payload)}`, expiresAt: exp };
}

// returns { uid, email, admin:true } or null. Uses the in-memory list only (fast, sync).
export function verifyAdminToken(token) {
  const [p, payload, s] = String(token || '').split('.');
  if (p !== PREFIX || !payload || !s) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const a = adminAccounts().find((x) => x.email === d.e);        // payload only picks WHICH key to check; the signature decides
    if (!a || !d.exp || d.exp < Date.now()) return null;
    const good = sig(a, payload);
    if (s.length !== good.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(good))) return null;
    return { uid: a.type === 'db' ? 'db-admin-' + a.sid : 'env-admin-' + a.n, email: a.email, admin: true, via: a.type, exp: d.exp };
  } catch { return null; }
}
export const isAdminToken = (t) => String(t || '').startsWith(PREFIX + '.');
