// 3 Firebase projects, 3 jobs. Service accounts come base64 from env:
//   KEY64_1 = MAIN    (Auth, users, balance, matches, deposits, withdrawals)
//   KEY64_2 = CHAT    (world chat, profiles, usernames)
//   KEY64_3 = ARCHIVE (old history, IP logs, audit logs)
// (Key64_1 spelling also works; the old FIREBASE_*_B64 names are still accepted as a fallback.)
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { env } from './base.js';

const KEYS = { main: ['KEY64_1', 'Key64_1', 'FIREBASE_MAIN_B64'], chat: ['KEY64_2', 'Key64_2', 'FIREBASE_CHAT_B64'], archive: ['KEY64_3', 'Key64_3', 'FIREBASE_ARCHIVE_B64'] };
export const keyRaw = (k) => { for (const n of KEYS[k]) if (env(n)) return env(n); return ''; };
function named(name) {
  const ex = getApps().find((a) => a.name === name);
  if (ex) return ex;
  const raw = keyRaw(name);
  if (!raw) throw new Error(`Missing env ${KEYS[name][0]}`);
  let json; try { json = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); } catch { throw new Error(`${KEYS[name][0]} is not valid base64 of a service-account JSON`); }
  return initializeApp({ credential: cert(json) }, name);
}
export const mainApp = () => named('main');
export const db = {
  main: () => getFirestore(mainApp()),
  chat: () => getFirestore(named('chat')),
  archive: () => getFirestore(named('archive')),
};
export const authMain = () => getAuth(mainApp());
// Token verification needs only the project id (public keys), so the chat service needs no main credentials.
export function verifyIdToken(token) {
  let app = getApps().find((a) => a.name === 'auth');
  if (!app) app = keyRaw('main') ? mainApp() : initializeApp({ projectId: env('FIREBASE_MAIN_PROJECT_ID') }, 'auth');
  return getAuth(app).verifyIdToken(token);
}
