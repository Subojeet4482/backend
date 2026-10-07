// Backup / delete / restore engine for the Telegram panel. Everything is scoped: 'A' (all users) or one uid.
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { db, mainApp } from './fb.js';
import { HttpError, env } from './base.js';
import { callInternal } from './internal.js';
const gzip = promisify(zlib.gzip), gunzip = promisify(zlib.gunzip);

// Firestore Timestamp <-> JSON
const enc = (v) => (v instanceof Timestamp ? { __t: v.toMillis() } : Array.isArray(v) ? v.map(enc) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) : v);
const dec = (v) => (Array.isArray(v) ? v.map(dec) : v && typeof v === 'object' ? (Object.keys(v).length === 1 && typeof v.__t === 'number' ? Timestamp.fromMillis(v.__t) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dec(x)]))) : v);

const M = () => db.main();
const usersCol = () => M().collection('users');
const userSub = (uid, sub) => usersCol().doc(uid).collection(sub);
const cg = (n) => M().collectionGroup(n);
async function* pages(q, size = 400) {
  let last;
  for (;;) {
    let qq = q.limit(size); if (last) qq = qq.startAfter(last);
    const s = await qq.get(); if (!s.docs.length) return;
    yield s.docs; last = s.docs[s.docs.length - 1]; if (s.size < size) return;
  }
}
const TXPATH = /^users\/[^/]+\/transactions\/[^/]+$/;
const txSrc = (field, val, keep) => ({ all: () => cg('transactions').where(field, '==', val), scan: () => cg('transactions'), one: (u) => userSub(u, 'transactions').where(field, '==', val), keep, allow: TXPATH, check: keep });
const FF = ['gameName', 'gameUid', 'isUidVerified', 'playerId', 'appName', 'email', 'phone'];
const BAL = ['depositBalance', 'withdrawBalance', 'balance', 'totalDeposited', 'totalWithdrawn'];

export const CATS = {
  dp: { title: 'Deposit history', icon: '📥', kind: 'docs', sources: [
    txSrc('type', 'deposit', (d) => d.type === 'deposit' && d.method !== 'ADMIN'),
    { all: () => M().collection('deposit_requests'), one: (u) => M().collection('deposit_requests').where('uid', '==', u), keep: () => true, allow: /^deposit_requests\/[^/]+$/, check: () => true }] },
  wd: { title: 'Withdrawal history', icon: '📤', kind: 'docs', sources: [
    txSrc('type', 'withdraw', (d) => d.type === 'withdraw' && d.method !== 'ADMIN'),
    { all: () => M().collection('withdraw_queue'), one: (u) => M().collection('withdraw_queue').where('uid', '==', u), keep: () => true, allow: /^withdraw_queue\/[^/]+$/, check: () => true }] },
  bl: { title: 'Balance', icon: '💰', kind: 'fields', fields: BAL, restore: BAL, reset: { depositBalance: 0, withdrawBalance: 0, balance: 0 }, validate: (f, v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 },
  bh: { title: 'Balance history', icon: '🧾', kind: 'docs', sources: [txSrc('type', 'game', (d) => d.type === 'game'), txSrc('method', 'ADMIN', (d) => d.method === 'ADMIN')] },
  mh: { title: 'Match history', icon: '🏆', kind: 'docs', sources: [{ all: () => cg('matchHistory'), one: (u) => userSub(u, 'matchHistory'), keep: () => true, allow: /^users\/[^/]+\/matchHistory\/[^/]+$/, check: () => true }] },
  mj: { title: 'Match join', icon: '🎯', kind: 'mj' },
  ff: { title: 'FF ID / number / name / gmail', icon: '🎮', kind: 'fields', fields: FF, restore: ['gameName', 'gameUid', 'isUidVerified', 'playerId', 'appName', 'phone'], reset: { gameName: '', gameUid: '', isUidVerified: false }, validate: (f, v) => (f === 'isUidVerified' ? typeof v === 'boolean' : typeof v === 'string' && v.length <= 80) },
  ua: { title: 'User name & all (no photo)', icon: '👤', kind: 'users' },
};
export const NOTES = {
  bl: { d: 'Sets deposit / withdraw / balance to 0 (lifetime totals stay).' },
  ff: { d: 'Clears FF name, FF UID and the verified flag. Gmail / phone stay (login depends on them).' },
  mj: { d: 'Only COMPLETED matches are cleared. Upcoming/live joins are never touched.' },
  ua: { d: 'ONE USER ONLY: deletes the user, all their history, their login account and chat profile.' },
  dp: { d: 'Deletes deposit records (transactions + deposit requests).' },
  wd: { d: 'Deletes withdrawal records (transactions + queue).' },
  bh: { d: 'Deletes entry-fee and admin credit/debit records.' },
  mh: { d: 'Deletes users\' match history records.' },
};

async function* iterSource(src, scope) {
  const mk = scope === 'A' ? src.all : src.one; let started = false;
  try { for await (const docs of pages(mk(scope))) { started = true; for (const d of docs) if (src.keep(d.data())) yield d; } }
  catch (e) {                                                       // missing collection-group index -> scan instead
    if (started || e.code !== 9 || !src.scan || scope !== 'A') throw e;
    for await (const docs of pages(src.scan())) for (const d of docs) if (src.keep(d.data())) yield d;
  }
}
const strip = (x) => { const o = { ...x }; delete o.photoUrl; delete o.photoURL; delete o.coverURL; return o; };
const pickDoc = (fields) => (d) => { const x = d.data(), o = {}; fields.forEach((f) => { if (x[f] !== undefined) o[f] = enc(x[f]); }); return { path: d.ref.path, data: o }; };

async function collect(cat, scope) {
  const C = CATS[cat], out = [];
  if (C.kind === 'docs') { for (const src of C.sources) for await (const d of iterSource(src, scope)) out.push({ path: d.ref.path, data: enc(d.data()) }); }
  else if (C.kind === 'fields') {
    const pick = pickDoc(C.fields);
    if (scope === 'A') { for await (const docs of pages(usersCol().select(...C.fields))) docs.forEach((d) => out.push(pick(d))); }
    else { const s = await usersCol().doc(scope).get(); if (!s.exists) throw new HttpError(404, 'no_user', 'User not found'); out.push(pick(s)); }
  } else if (C.kind === 'users') {
    if (scope === 'A') { for await (const docs of pages(usersCol())) docs.forEach((d) => out.push({ path: d.ref.path, data: enc(strip(d.data())) })); }
    else {
      const s = await usersCol().doc(scope).get(); if (!s.exists) throw new HttpError(404, 'no_user', 'User not found');
      out.push({ path: s.ref.path, data: enc(strip(s.data())) });
      for (const sub of ['transactions', 'notifications', 'matchHistory']) for await (const docs of pages(userSub(scope, sub))) docs.forEach((d) => out.push({ path: d.ref.path, data: enc(d.data()) }));
    }
  } else if (C.kind === 'mj') {
    const upick = pickDoc(['joined_matches', 'matchesPlayed']), mpick = pickDoc(['joined', 'participants', 'takenSlots', 'status', 'title']);
    if (scope === 'A') {
      for await (const docs of pages(usersCol().select('joined_matches', 'matchesPlayed'))) docs.forEach((d) => out.push(upick(d)));
      for await (const docs of pages(M().collection('matches').select('joined', 'participants', 'takenSlots', 'status', 'title'))) docs.forEach((d) => out.push(mpick(d)));
    } else {
      const s = await usersCol().doc(scope).get(); if (!s.exists) throw new HttpError(404, 'no_user', 'User not found');
      out.push(upick(s));
      const ids = (s.data().joined_matches || []).slice(0, 300);
      if (ids.length) (await M().getAll(...ids.map((i) => M().collection('matches').doc(i)))).forEach((d) => { if (d.exists) out.push(mpick(d)); });
    }
  }
  return out;
}

export async function countData(cat, scope) {
  const C = CATS[cat];
  try {
    if (C.kind === 'docs') { let n = 0; for (const src of C.sources) n += (await (scope === 'A' ? src.all : src.one)(scope).count().get()).data().count; return n; }
    if (scope !== 'A') return 1;
    return (await usersCol().count().get()).data().count;
  } catch { return '?'; }
}

export async function sendBackup(tg, chatId, cat, scope, label = 'backup') {
  const docs = await collect(cat, scope), parts = []; let cur = [], size = 0;
  for (const it of docs) { const n = JSON.stringify(it).length; if (size + n > 30e6 && cur.length) { parts.push(cur); cur = []; size = 0; } cur.push(it); size += n; }
  if (cur.length || !parts.length) parts.push(cur);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  for (let i = 0; i < parts.length; i++) {
    const buf = await gzip(JSON.stringify({ v: 1, cat, scope, createdAt: Date.now(), part: i + 1, parts: parts.length, count: parts[i].length, docs: parts[i] }));
    const r = await tg.sendDoc(chatId, `ff-${cat}-${scope === 'A' ? 'all' : scope.slice(0, 8)}-${stamp}${parts.length > 1 ? `-p${i + 1}` : ''}.json.gz`, buf, `${CATS[cat].title} • ${label} • ${parts[i].length} records`);
    if (!r.ok) throw new Error('Telegram did not accept the backup file (' + (r.description || 'error') + ')');
  }
  return { count: docs.length, parts: parts.length };
}

async function clearMatchJoin(scope, deadline) {
  const done = new Set(), ms = await M().collection('matches').where('status', '==', 'completed').get(); ms.docs.forEach((d) => done.add(d.id));
  let n = 0;
  if (scope === 'A') {
    for (let i = 0; i < ms.docs.length; i += 400) { const b = M().batch(); ms.docs.slice(i, i + 400).forEach((d) => b.update(d.ref, { joined: 0, participants: [], takenSlots: [] })); await b.commit(); n += Math.min(400, ms.docs.length - i); }
    for await (const docs of pages(usersCol().select('joined_matches'))) {
      const b = M().batch(); let k = 0;
      for (const d of docs) { const jm = d.get('joined_matches') || [], keep = jm.filter((x) => !done.has(x)); if (keep.length !== jm.length) { b.update(d.ref, { joined_matches: keep }); k++; } }
      if (k) await b.commit(); n += k; if (Date.now() > deadline) break;
    }
  } else {
    const uref = usersCol().doc(scope), us = await uref.get(); if (!us.exists) throw new HttpError(404, 'no_user', 'User not found');
    const jm = us.data().joined_matches || [];
    for (const id of jm.filter((x) => done.has(x))) {
      await M().runTransaction(async (tx) => {
        const s = await tx.get(M().collection('matches').doc(id)); if (!s.exists) return;
        const m = s.data(), mine = (m.participants || []).filter((p) => p.uid === scope);
        tx.update(s.ref, { participants: (m.participants || []).filter((p) => p.uid !== scope), joined: Math.max(0, (m.joined || 0) - mine.length), takenSlots: (m.takenSlots || []).filter((x) => !mine.some((p) => p.slot === x)) });
      }); n++;
    }
    await uref.update({ joined_matches: jm.filter((x) => !done.has(x)) });
  }
  return n;
}

export async function deleteUserCascade(uid) {
  let n = 0;
  for (const sub of ['transactions', 'notifications', 'matchHistory']) for await (const docs of pages(userSub(uid, sub))) { const b = M().batch(); docs.forEach((d) => b.delete(d.ref)); await b.commit(); n += docs.length; }
  await usersCol().doc(uid).delete(); n++;
  try { await getAuth(mainApp()).deleteUser(uid); } catch (e) { if (e.code !== 'auth/user-not-found') throw e; }
  try { await callInternal(env('CHAT_BASE_URL'), '/internal/profile-delete', { uid }); } catch (e) { console.warn('chat delete', e.message); }
  return n;
}

export async function deleteData(cat, scope, deadline) {
  const C = CATS[cat]; let n = 0, partial = false;
  if (C.kind === 'docs') {
    let buf = [];
    const flush = async () => { const b = M().batch(); buf.forEach((d) => b.delete(d.ref)); await b.commit(); n += buf.length; buf = []; };
    outer: for (const src of C.sources) for await (const d of iterSource(src, scope)) { buf.push(d); if (buf.length >= 400) { await flush(); if (Date.now() > deadline) { partial = true; break outer; } } }
    if (buf.length) await flush();
  } else if (C.kind === 'fields') {
    if (scope === 'A') { for await (const docs of pages(usersCol().select())) { const b = M().batch(); docs.forEach((d) => b.update(d.ref, C.reset)); await b.commit(); n += docs.length; if (Date.now() > deadline) { partial = true; break; } } }
    else { const ref = usersCol().doc(scope); if (!(await ref.get()).exists) throw new HttpError(404, 'no_user', 'User not found'); await ref.update(C.reset); n = 1; }
  } else if (C.kind === 'mj') n = await clearMatchJoin(scope, deadline);
  else if (C.kind === 'users') {
    if (scope === 'A') throw new HttpError(400, 'disabled', 'Deleting ALL users is disabled for safety. Use Find user and delete one user.');
    n = await deleteUserCascade(scope);
  }
  return { deleted: n, partial };
}

export async function parseBackupFile(buf, expectCat) {
  let b = buf; if (b[0] === 0x1f && b[1] === 0x8b) { try { b = await gunzip(b); } catch { throw new HttpError(400, 'bad_file', 'Corrupt .gz file'); } }
  let j; try { j = JSON.parse(b.toString('utf8')); } catch { throw new HttpError(400, 'bad_file', 'File is not valid JSON / JSON.GZ'); }
  if (!j || j.v !== 1 || !Array.isArray(j.docs)) throw new HttpError(400, 'bad_file', 'Not a backup made by this bot');
  if (j.cat !== expectCat) throw new HttpError(400, 'wrong_file', `This is a "${CATS[j.cat]?.title || j.cat}" backup, but you chose "${CATS[expectCat].title}".`);
  return j;
}

export async function restoreData(cat, scope, file) {
  const C = CATS[cat]; let written = 0, skipped = 0; const ok = [];
  const inScope = (path, data) => scope === 'A' || path === `users/${scope}` || path.startsWith(`users/${scope}/`) || (data && data.uid === scope);
  for (const it of file.docs) {
    if (!it || typeof it.path !== 'string' || !it.data || typeof it.data !== 'object' || it.path.split('/').length % 2) { skipped++; continue; }
    if (!inScope(it.path, it.data)) { skipped++; continue; }
    if (C.kind === 'docs') { const d = dec(it.data), src = C.sources.find((s) => s.allow.test(it.path)); if (!src || !src.check(d)) { skipped++; continue; } ok.push({ path: it.path, data: d, merge: false }); }
    else if (C.kind === 'fields') {
      if (!/^users\/[^/]+$/.test(it.path)) { skipped++; continue; }
      const data = {}; for (const f of C.restore) if (it.data[f] !== undefined && C.validate(f, it.data[f])) data[f] = it.data[f];
      if (!Object.keys(data).length) { skipped++; continue; } ok.push({ path: it.path, data, merge: true, mustExist: true });
    } else if (C.kind === 'mj') {
      if (/^users\/[^/]+$/.test(it.path)) { const data = {}; if (Array.isArray(it.data.joined_matches)) data.joined_matches = it.data.joined_matches.filter((x) => typeof x === 'string').slice(0, 500); if (!Object.keys(data).length) { skipped++; continue; } ok.push({ path: it.path, data, merge: true, mustExist: true }); }
      else if (/^matches\/[^/]+$/.test(it.path) && scope === 'A') { const { joined, participants, takenSlots } = it.data; if (typeof joined !== 'number' || !Array.isArray(participants) || !Array.isArray(takenSlots)) { skipped++; continue; } ok.push({ path: it.path, data: { joined, participants, takenSlots }, merge: true, mustExist: true, onlyCompleted: true }); }
      else skipped++;
    } else if (C.kind === 'users') {
      if (!/^users\/[^/]+(\/(transactions|notifications|matchHistory)\/[^/]+)?$/.test(it.path)) { skipped++; continue; }
      ok.push({ path: it.path, data: dec(it.data), merge: false });
    }
  }
  for (let i = 0; i < ok.length; i += 300) {
    const chunk = ok.slice(i, i + 300), refs = chunk.map((x) => M().doc(x.path));
    const snaps = chunk.some((x) => x.mustExist) ? await M().getAll(...refs) : null, b = M().batch(); let k = 0;
    chunk.forEach((x, j) => {
      if (x.mustExist) { const s = snaps[j]; if (!s.exists || (x.onlyCompleted && s.data().status !== 'completed')) { skipped++; return; } }
      b.set(refs[j], x.data, { merge: x.merge }); written++; k++;
    });
    if (k) await b.commit();
  }
  return { written, skipped };
}

export async function findUsers(q) {
  q = String(q || '').trim().slice(0, 128); if (!q) return [];
  const U = usersCol(), tries = [];
  if (q.includes('@')) tries.push(U.where('email', '==', q.toLowerCase()));
  else {
    const digits = q.replace(/\D/g, '');
    if (digits.length >= 10) tries.push(U.where('phone', '==', digits.slice(-10)));
    if (digits) { tries.push(U.where('playerId', '==', digits)); tries.push(U.where('gameUid', '==', digits)); }
    tries.push(U.where('appName', '==', q));
  }
  if (/^[A-Za-z0-9_-]{10,40}$/.test(q)) { const d = await U.doc(q).get(); if (d.exists) return [d]; }
  for (const t of tries) { const s = await t.limit(5).get(); if (!s.empty) return s.docs; }
  return [];
}
