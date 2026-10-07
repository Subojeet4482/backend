// Panel logins managed from the Telegram bot (owner only). Stored in main Firestore: config/panel_admins { list: [...] }.
// Only scrypt hashes are stored. Max 10 (MAX_PANEL_LOGINS), on top of the env accounts.
import crypto from 'node:crypto';
import { db } from './fb.js';
import { HttpError } from './base.js';
import { envAccounts, setStoredAccounts, storedAccounts, MAX_PANEL_LOGINS } from './adminauth.js';

const ref = () => db.main().collection('config').doc('panel_admins');
export async function load() {
  try { const s = await ref().get(); setStoredAccounts(s.exists ? s.data().list || [] : []); }
  catch (e) { console.warn('[panel-admins] load failed (keeping old list):', e.message); }
  return storedAccounts();
}
let timer = null;
export function startRefresh(ms = 15000) { if (!timer) timer = setInterval(() => { load(); }, ms).unref(); }
export const list = () => storedAccounts();

// rec = { email, salt, pw, pinSalt, pin }  (hashes). Enforces: unique email (env + db), max 10.
export async function add(rec, by) {
  const email = String(rec.email).trim().toLowerCase();
  const out = await db.main().runTransaction(async (tx) => {
    const s = await tx.get(ref()), cur = s.exists ? s.data().list || [] : [];
    if (cur.length >= MAX_PANEL_LOGINS) throw new HttpError(400, 'limit', `Limit reached: ${MAX_PANEL_LOGINS} panel logins. Delete one first.`);
    if (cur.some((a) => a.email === email) || envAccounts().some((a) => a.email === email)) throw new HttpError(409, 'exists', 'This email already has a panel login.');
    const item = { sid: crypto.randomBytes(4).toString('hex'), email, salt: rec.salt, pw: rec.pw, pinSalt: rec.pinSalt, pin: rec.pin, at: Date.now(), by: String(by) };
    tx.set(ref(), { list: [...cur, item] }); return [...cur, item];
  });
  setStoredAccounts(out); return out.length;
}
export async function remove(sid) {
  let gone = null;
  const out = await db.main().runTransaction(async (tx) => {
    const s = await tx.get(ref()), cur = s.exists ? s.data().list || [] : [];
    gone = cur.find((a) => a.sid === sid); if (!gone) throw new HttpError(404, 'nf', 'Login not found (already deleted?)');
    const next = cur.filter((a) => a.sid !== sid); tx.set(ref(), { list: next }); return next;
  });
  setStoredAccounts(out); return gone.email;
}
