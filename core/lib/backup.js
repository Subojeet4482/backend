// 30-day archive (main -> archive DB, verified before delete), IP-log purge, weekly snapshot to Telegram.
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { getAuth } from 'firebase-admin/auth';
import { db, mainApp } from './fb.js';
const gzip = promisify(zlib.gzip);
const DAY = 864e5;

export async function archiveOld({ days = 30, limit = 800 }) {
  const m = db.main(), a = db.archive();
  const snap = await m.collectionGroup('transactions').where('createdAt', '<', Date.now() - days * DAY).orderBy('createdAt').limit(limit).get();
  const docs = snap.docs.filter((d) => d.get('status') !== 'pending');      // never archive unresolved requests
  let archived = 0;
  for (let i = 0; i < docs.length; i += 200) {
    const chunk = docs.slice(i, i + 200), wb = a.batch(), refs = [];
    for (const d of chunk) {
      const uid = d.ref.parent.parent.id, ar = a.collection('tx_archive').doc(uid).collection('items').doc(d.id);
      wb.set(ar, { ...d.data(), uid, archivedAt: Date.now() }); refs.push(ar);
    }
    await wb.commit();
    if ((await a.getAll(...refs)).some((x) => !x.exists)) throw new Error('archive verify failed — nothing deleted');
    const del = m.batch(); chunk.forEach((d) => del.delete(d.ref)); await del.commit(); archived += chunk.length;
  }
  return { scanned: snap.size, archived };
}

export async function purgeIpLogs(days = 30, limit = 800) {
  const a = db.archive(), s = await a.collection('ip_logs').where('at', '<', Date.now() - days * DAY).limit(limit).get();
  if (s.empty) return 0;
  const b = a.batch(); s.docs.forEach((d) => b.delete(d.ref)); await b.commit(); return s.size;
}

export async function cleanupPending(hours = 24) {
  const m = db.main(), s = await m.collection('pending_profiles').where('at', '<', Date.now() - hours * 3600e3).limit(100).get();
  let removed = 0;
  for (const d of s.docs) {
    try {
      const u = await getAuth(mainApp()).getUser(d.id);
      if (!u.emailVerified) { await getAuth(mainApp()).deleteUser(d.id); await d.ref.delete(); removed++; }
    } catch (e) { if (e.code === 'auth/user-not-found') await d.ref.delete(); }
  }
  return removed;
}

export async function sendSnapshot(tg, ids) {
  const m = db.main(), week = Date.now() - 7 * DAY;
  const users = (await m.collection('users').select('email', 'appName', 'playerId', 'depositBalance', 'withdrawBalance', 'totalDeposited', 'totalWithdrawn', 'isBanned').get()).docs.map((d) => ({ uid: d.id, ...d.data() }));
  const deposits = (await m.collection('deposit_requests').where('createdAt', '>=', week).get()).docs.map((d) => d.data());
  const pendingWithdrawals = (await m.collection('withdraw_queue').where('status', '==', 'pending').get()).docs.map((d) => d.data());
  let audit = []; try { audit = (await db.archive().collection('audit_logs').where('at', '>=', week).get()).docs.map((d) => d.data()); } catch {}
  const buf = await gzip(JSON.stringify({ generatedAt: new Date().toISOString(), users, deposits, pendingWithdrawals, audit }));
  const name = `ff-backup-${new Date().toISOString().slice(0, 10)}.json.gz`;
  if (buf.length > 45e6) throw new Error('snapshot too large for Telegram (50MB)');
  let ok = 0;
  for (const id of ids) { const r = await tg.sendDoc(id, name, buf, `Weekly backup • users ${users.length} • deposits(7d) ${deposits.length}`); if (r.ok) ok++; }
  return ok;
}
