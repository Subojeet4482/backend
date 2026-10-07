// Temporary key for the web logs page: 10 characters, valid 10 minutes, one active key at a time.
import crypto from 'node:crypto';
import { db } from './fb.js';
import { safeEq } from './base.js';
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const hash = (k) => crypto.createHash('sha256').update(String(k)).digest('hex');
const ref = () => db.main().collection('config').doc('logkey');
export async function newKey(by) {
  let key = ''; for (let i = 0; i < 10; i++) key += ALPHA[crypto.randomInt(ALPHA.length)];
  const exp = Date.now() + 10 * 60000; await ref().set({ hash: hash(key), exp, by: String(by) }); return { key, exp };
}
export const revokeKey = () => ref().delete();
export async function checkKey(key) {
  const s = await ref().get(); if (!s.exists) return null;
  const d = s.data(); if (d.exp < Date.now()) return null;
  return safeEq(hash(key), d.hash) ? d : null;
}
