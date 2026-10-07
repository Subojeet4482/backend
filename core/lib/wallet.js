// All money logic. Every function runs inside a Firestore transaction (Admin SDK) — client can never touch balances.
import { FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import crypto from 'node:crypto';
import { db, mainApp } from './fb.js';
import { HttpError, sha, r2, env } from './base.js';
import { callInternal } from './internal.js';

const num = (v) => (Number.isFinite(+v) ? +v : 0);
export const depBal = (u) => num(u.depositBalance !== undefined ? u.depositBalance : u.balance);
export const wdBal = (u) => num(u.withdrawBalance);
export const isBanned = (u) => {
  if (!u.isBanned) return false;
  const b = u.bannedUntil; if (b == null || b === 'permanent') return true;
  const t = typeof b === 'number' ? b : Date.parse(b); return Number.isNaN(t) ? true : t > Date.now();   // panel stores ISO strings
};
const today = () => new Date().toLocaleDateString();
export const orderNum = (type, docId, createdAt) => {
  const d = new Date((Number(createdAt) || Date.now()) + 5.5 * 3600e3), p2 = (n) => String(n).padStart(2, '0');
  return `${type === 'withdraw' ? 'WD' : 'DP'}-${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}-${String(docId || 'XXXX').slice(-4).toUpperCase()}`;
};
export const notif = (tx, uid, title, body, type) => tx.set(db.main().collection('users').doc(uid).collection('notifications').doc(), { title, body, message: body, type, read: false, date: today(), createdAt: Date.now(), timestamp: FieldValue.serverTimestamp() });

// ---------------- WITHDRAW ----------------
export async function requestWithdraw(uid, input, ctx) {
  const c = ctx.cfg;
  if (!c.withdrawEnabled) throw new HttpError(503, 'withdraw_off', 'Withdrawals are paused right now');
  const amt = r2(parseFloat(input.amount));
  if (!Number.isFinite(amt) || amt < c.withdrawMin) throw new HttpError(400, 'min_amount', `Minimum withdrawal is ₹${c.withdrawMin}`);
  if (amt > c.withdrawMax) throw new HttpError(400, 'max_amount', `Maximum withdrawal is ₹${c.withdrawMax}`);
  const method = String(input.method || '').toUpperCase();
  let details, masked;
  if (method === 'BANK') {
    const name = String(input.accountName || '').trim(), acc = String(input.accountNumber || '').trim(), ifsc = String(input.ifsc || '').trim().toUpperCase();
    if (name.length < 3 || name.length > 60) throw new HttpError(400, 'bad_name', 'Enter account holder name');
    if (!/^\d{9,18}$/.test(acc)) throw new HttpError(400, 'bad_account', 'Invalid account number');
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) throw new HttpError(400, 'bad_ifsc', 'Invalid IFSC');
    details = { accountName: name, accountNumber: acc, ifsc };
    masked = `A/c ${acc.slice(0, 2)}${'x'.repeat(Math.max(acc.length - 4, 2))}${acc.slice(-2)}`;
  } else if (method === 'CRYPTO') {
    const addr = String(input.walletAddress || '').trim(), network = String(input.network || '').trim().slice(0, 20), coin = String(input.coin || 'USDT').trim().slice(0, 10);
    if (!/^[A-Za-z0-9]{20,100}$/.test(addr)) throw new HttpError(400, 'bad_address', 'Invalid wallet address');
    if (!network) throw new HttpError(400, 'bad_network', 'Select network');
    details = { coin, network, walletAddress: addr };
    masked = `${addr.slice(0, 4)}xxxx${addr.slice(-4)}`;
  } else throw new HttpError(400, 'bad_method', 'Invalid method');
  const rid = String(input.requestId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  if (rid.length < 8) throw new HttpError(400, 'bad_request', 'Missing request id');

  const d = db.main(), uref = d.collection('users').doc(uid);
  const tid = 'wd_' + sha(uid + rid).slice(0, 12), tref = uref.collection('transactions').doc(tid);
  const pendingQ = uref.collection('transactions').where('type', '==', 'withdraw').where('status', '==', 'pending').limit(1);
  const out = await d.runTransaction(async (tx) => {
    const [us, ts, pend] = await Promise.all([tx.get(uref), tx.get(tref), tx.get(pendingQ)]);
    if (ts.exists) return { dup: true, id: tid };                       // retry of same request -> no double debit
    if (!us.exists) throw new HttpError(404, 'no_user', 'User not found');
    const u = us.data();
    if (isBanned(u)) throw new HttpError(403, 'banned', 'Account restricted');
    if (!pend.empty) throw new HttpError(409, 'pending_exists', 'You already have a pending withdrawal');
    const dep = depBal(u), wd = wdBal(u);
    if (dep < 0 || wd < 0) throw new HttpError(409, 'balance_error', 'Balance error. Contact support.');
    if (amt > wd) throw new HttpError(400, 'insufficient', `Withdraw balance is ₹${wd}`);
    const after = r2(wd - amt);
    tx.update(uref, { withdrawBalance: after });
    tx.set(tref, { title: `Withdrawal ₹${amt} (${masked})`, amount: `-₹${amt}`, net: `₹${(amt - c.withdrawFee).toFixed(2)}`, type: 'withdraw', status: 'pending', method, balanceType: 'withdraw', ...details, requestId: rid, snapshot: { depositBalance: dep, withdrawBalance: wd, totalDeposited: num(u.totalDeposited), totalWithdrawn: num(u.totalWithdrawn) }, after: { withdrawBalance: after }, ip: ctx.ip, date: today(), createdAt: Date.now(), timestamp: FieldValue.serverTimestamp() });
    tx.set(d.collection('withdraw_queue').doc(tid), { uid, trxId: tid, amount: amt, method, name: u.appName || '', status: 'pending', createdAt: Date.now() });
    return { id: tid, amount: amt, net: r2(amt - c.withdrawFee), name: u.appName || '', method, masked };
  });
  return { ...out, ref: tid.slice(0, 8).toUpperCase() };
}

export async function decideWithdraw({ uid, trxId, decision, actor }) {
  const d = db.main(), uref = d.collection('users').doc(uid), tref = uref.collection('transactions').doc(trxId), qref = d.collection('withdraw_queue').doc(trxId);
  const res = await d.runTransaction(async (tx) => {
    const [ts, us] = await Promise.all([tx.get(tref), tx.get(uref)]);
    if (!ts.exists || !us.exists) throw new HttpError(404, 'not_found', 'Request not found');
    const t = ts.data();
    if (t.type !== 'withdraw') throw new HttpError(400, 'not_withdraw', 'Not a withdrawal');
    if (decision === 'refund' ? !['pending', 'rejected'].includes(t.status) : t.status !== 'pending') throw new HttpError(409, 'already_done', `Already ${t.status}`);
    const amt = money(t.amount), ord = orderNum('withdraw', trxId, t.createdAt), base = { orderNo: ord, processedAt: Date.now(), decidedBy: String(actor) };
    if (decision === 'approve') {
      tx.update(tref, { status: 'success', ...base }); tx.update(uref, { totalWithdrawn: FieldValue.increment(amt) });
      notif(tx, uid, `Withdrawal success: ₹${amt}`, `Order ${ord} • ₹${amt} withdrawal approved. Funds will reach you shortly.`, 'withdraw');
    } else if (decision === 'refund') {
      tx.update(tref, { status: 'refunded', ...base }); tx.update(uref, { withdrawBalance: FieldValue.increment(amt) });
      notif(tx, uid, `Withdrawal refunded: ₹${amt}`, `Order ${ord} • ₹${amt} returned to your withdraw balance.`, 'withdraw');
    } else if (decision === 'reject') {
      tx.update(tref, { status: 'rejected', ...base });
      notif(tx, uid, `Withdrawal rejected: ₹${amt}`, `Order ${ord} • Request rejected. No refund issued.`, 'withdraw');
    } else throw new HttpError(400, 'bad_decision', 'approve | refund | reject');
    tx.set(qref, { status: decision, decidedAt: Date.now() }, { merge: true });
    return { amount: amt, order: ord };
  });
  return res;
}

export async function pendingWithdrawals(limit = 5) {
  const d = db.main(), s = await d.collection('withdraw_queue').where('status', '==', 'pending').limit(limit).get();
  const out = [];
  for (const q of s.docs) {                                           // drop stale queue rows (processed from old admin panel)
    const { uid, trxId } = q.data();
    const t = await d.collection('users').doc(uid).collection('transactions').doc(trxId).get();
    if (!t.exists || t.data().status !== 'pending') { await q.ref.set({ status: 'stale' }, { merge: true }); continue; }
    out.push({ uid, trxId, ...t.data() });
  }
  return out;
}

// ---------------- DEPOSIT ----------------
export async function submitDeposit(uid, { utr, amount }, ctx) {
  const c = ctx.cfg;
  if (!c.depositEnabled) throw new HttpError(503, 'deposit_off', 'Deposits are paused right now');
  utr = String(utr || '').trim();
  const amt = r2(parseFloat(amount));
  if (!/^[A-Za-z0-9]{6,30}$/.test(utr)) throw new HttpError(400, 'bad_utr', 'Invalid UTR');
  if (!Number.isFinite(amt) || amt < c.depositMin || amt > c.depositMax) throw new HttpError(400, 'bad_amount', `Amount must be ₹${c.depositMin} – ₹${c.depositMax}`);
  const d = db.main(), uref = d.collection('users').doc(uid), rref = d.collection('deposit_requests').doc(utr);
  await d.runTransaction(async (tx) => {
    const [us, rs] = await Promise.all([tx.get(uref), tx.get(rref)]);
    if (!us.exists) throw new HttpError(404, 'no_user', 'User not found');
    if (isBanned(us.data())) throw new HttpError(403, 'banned', 'Account restricted');
    if (rs.exists) {
      const r = rs.data();
      if (r.uid && r.uid !== uid) throw new HttpError(409, 'utr_other', 'This UTR belongs to another account');
      if (r.status === 'success') throw new HttpError(409, 'utr_used', 'This UTR is already used');
      if (['failed', 'mismatch', 'rejected'].includes(r.status)) throw new HttpError(409, 'utr_rejected', 'This UTR was rejected');
      if (Math.abs(num(r.amount) - amt) > 0.01) throw new HttpError(409, 'utr_amount', 'Amount differs from your earlier request');
      return;
    }
    const tref = uref.collection('transactions').doc();
    tx.set(rref, { utr, amount: amt, uid, name: us.data().appName || 'User', status: 'pending', createdAt: Date.now(), trxDocId: tref.id, ip: ctx.ip });
    tx.set(tref, { title: `Deposit ₹${amt}`, amount: `+₹${amt}`, type: 'deposit', status: 'pending', trxId: utr, method: 'UPI', date: today(), createdAt: Date.now(), timestamp: FieldValue.serverTimestamp() });
  });
  return { utr, amount: amt };
}

export async function checkDeposit(uid, utr) {
  utr = String(utr || '').trim();
  if (!/^[A-Za-z0-9]{6,30}$/.test(utr)) throw new HttpError(400, 'bad_utr', 'Invalid UTR');
  const d = db.main(), uref = d.collection('users').doc(uid), rref = d.collection('deposit_requests').doc(utr), fref = d.collection('fampay_deposits').doc(utr);
  return d.runTransaction(async (tx) => {
    const rs = await tx.get(rref);
    if (!rs.exists || rs.data().uid !== uid) return { status: 'gone' };
    const r = rs.data();
    if (!['pending', 'processing'].includes(r.status)) return { status: r.status, amount: r.receivedAmount || r.amount };
    if (Date.now() - num(r.createdAt) > 24 * 3600e3) return { status: 'expired' };
    const [fs, us] = await Promise.all([tx.get(fref), tx.get(uref)]);
    if (!fs.exists) return { status: 'notfound' };
    const fAmt = num(fs.data().amount);
    if (!(fAmt > 0) || Math.abs(fAmt - num(r.amount)) > 0.01) return { status: 'notfound', received: fAmt };
    if (!us.exists) throw new HttpError(404, 'no_user', 'User not found');
    tx.update(uref, { depositBalance: FieldValue.increment(fAmt), totalDeposited: FieldValue.increment(fAmt), lastDepositUtr: utr });
    tx.update(rref, { status: 'success', verifiedAt: Date.now(), receivedAmount: fAmt, claimed: true });
    tx.delete(fref);
    if (r.trxDocId) tx.update(uref.collection('transactions').doc(r.trxDocId), { status: 'success', orderNo: orderNum('deposit', r.trxDocId, r.createdAt), processedAt: Date.now() });
    notif(tx, uid, `Deposit success: ₹${fAmt}`, `₹${fAmt} added to your deposit balance.`, 'deposit');
    return { status: 'success', amount: fAmt };
  });
}

export async function decideDeposit({ uid, trxId, decision, actor }) {
  const d = db.main(), uref = d.collection('users').doc(uid), tref = uref.collection('transactions').doc(trxId);
  return d.runTransaction(async (tx) => {
    const ts = await tx.get(tref); if (!ts.exists) throw new HttpError(404, 'not_found', 'Request not found');
    const t = ts.data();
    if (t.type !== 'deposit') throw new HttpError(400, 'not_deposit', 'Not a deposit');
    if (t.status !== 'pending') throw new HttpError(409, 'already_done', `Already ${t.status}`);
    const amt = money(t.amount), utr = String(t.trxId || ''), ord = orderNum('deposit', trxId, t.createdAt);
    const drref = utr ? d.collection('deposit_requests').doc(utr) : null, dr = drref ? await tx.get(drref) : null;
    if (decision === 'approve') {
      if (!(amt > 0 && amt <= 100000)) throw new HttpError(400, 'bad_amount', 'Invalid amount');
      if (dr && dr.exists) {
        const x = dr.data();
        if (x.status === 'success' && x.claimed) { tx.update(tref, { status: 'success', orderNo: ord, processedAt: Date.now() }); return { already: true, amount: amt }; }
        if (x.uid && x.uid !== uid) throw new HttpError(409, 'utr_other', 'UTR belongs to another user');
        tx.update(drref, { status: 'success', claimed: true, verifiedAt: Date.now(), receivedAmount: amt, verifiedBy: 'admin' });
      }
      tx.update(tref, { status: 'success', orderNo: ord, processedAt: Date.now(), decidedBy: String(actor) });
      tx.update(uref, { depositBalance: FieldValue.increment(amt), totalDeposited: FieldValue.increment(amt) });
      notif(tx, uid, `Deposit success: ₹${amt}`, `Order ${ord} • ₹${amt} added to your deposit balance.`, 'deposit');
    } else if (decision === 'reject') {
      tx.update(tref, { status: 'rejected', orderNo: ord, processedAt: Date.now(), decidedBy: String(actor) });
      if (dr && dr.exists) tx.update(drref, { status: 'rejected', rejectedAt: Date.now(), verifiedBy: 'admin' });
      notif(tx, uid, `Deposit rejected: ₹${amt}`, `Order ${ord} • Request rejected by admin. No refund issued.`, 'deposit');
    } else throw new HttpError(400, 'bad_decision', 'approve | reject');
    return { amount: amt, order: ord };
  });
}

// ---------------- HISTORY (recent from main, older from archive) ----------------
export async function history(uid, { limit = 20, before, archive }) {
  limit = Math.min(Math.max(parseInt(limit) || 20, 1), 50);
  const ref = archive ? db.archive().collection('tx_archive').doc(uid).collection('items') : db.main().collection('users').doc(uid).collection('transactions');
  let q = ref.orderBy('createdAt', 'desc');
  if (before) q = q.where('createdAt', '<', Number(before));
  const s = await q.limit(limit).get();
  const items = s.docs.map((x) => { const t = x.data(); delete t.accountNumber; delete t.ifsc; delete t.walletAddress; delete t.ip; delete t.snapshot; return { id: x.id, ...t, timestamp: undefined }; });
  return { items, next: items.length === limit ? items[items.length - 1].createdAt : null };
}

// ---------------- MATCH ----------------
export async function joinMatch(uid, { matchId, gameName, gameUid }, ctx) {
  if (!ctx.cfg.joinEnabled) throw new HttpError(503, 'join_off', 'Joining is paused right now');
  matchId = String(matchId || ''); gameName = String(gameName || '').trim(); gameUid = String(gameUid || '').trim();
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(matchId)) throw new HttpError(400, 'bad_match', 'Invalid match');
  if (gameName.length < 3 || gameName.length > 30) throw new HttpError(400, 'bad_name', 'Name too short');
  if (!/^\d{6,12}$/.test(gameUid)) throw new HttpError(400, 'bad_uid', 'FF UID invalid (6-12 digits)');
  const d = db.main(), mref = d.collection('matches').doc(matchId), uref = d.collection('users').doc(uid), tref = uref.collection('transactions').doc();
  return d.runTransaction(async (tx) => {
    const [ms, us] = await Promise.all([tx.get(mref), tx.get(uref)]);
    if (!ms.exists) throw new HttpError(404, 'no_match', 'Match not available');
    if (!us.exists) throw new HttpError(404, 'no_user', 'User not found');
    const m = ms.data(), u = us.data();
    if (isBanned(u)) throw new HttpError(403, 'banned', 'Account restricted');
    if (['completed', 'cancelled', 'canceled', 'ended', 'live'].includes(m.status)) throw new HttpError(409, 'match_closed', 'Joining is closed');
    if (num(m.joined) >= num(m.total || 48)) throw new HttpError(409, 'full', 'Match is full');
    if ((u.joined_matches || []).includes(matchId)) throw new HttpError(409, 'already_joined', 'Already joined');
    if ((m.participants || []).some((p) => String(p.gameUid) === gameUid)) throw new HttpError(409, 'uid_in_use', 'This FF UID is already in the match');
    const fee = r2(num(m.fee)), dep = depBal(u), wd = wdBal(u);
    if (dep < 0 || wd < 0) throw new HttpError(409, 'balance_error', 'Balance error. Contact support.');
    if (dep + wd < fee) throw new HttpError(400, 'insufficient', 'Insufficient balance');
    const payDep = Math.min(dep, fee), payWd = r2(fee - payDep);
    tx.update(mref, { joined: FieldValue.increment(1), participants: FieldValue.arrayUnion({ uid, appName: u.appName || '', gameName, gameUid }) });
    tx.update(uref, { depositBalance: r2(dep - payDep), withdrawBalance: r2(wd - payWd), joined_matches: FieldValue.arrayUnion(matchId), matchesPlayed: FieldValue.increment(1), gameName, gameUid });
    tx.set(tref, { title: `Joined ${m.title || 'match'}`, amount: `-₹${fee}`, type: 'game', status: 'success', matchId, snapshot: { depositBalance: dep, withdrawBalance: wd }, ip: ctx.ip, date: today(), createdAt: Date.now(), timestamp: FieldValue.serverTimestamp() });
    return { matchId, fee, depositBalance: r2(dep - payDep), withdrawBalance: r2(wd - payWd) };
  });
}

export async function pickSlot(uid, { matchId, slot }) {
  slot = parseInt(slot);
  const d = db.main(), mref = d.collection('matches').doc(String(matchId || ''));
  return d.runTransaction(async (tx) => {
    const ms = await tx.get(mref);
    if (!ms.exists) throw new HttpError(404, 'no_match', 'Match not available');
    const m = ms.data(), parts = [...(m.participants || [])], i = parts.findIndex((p) => p.uid === uid);
    if (i < 0) throw new HttpError(403, 'not_joined', 'Join the match first');
    if (!(slot >= 1 && slot <= num(m.total || 48))) throw new HttpError(400, 'bad_slot', 'Invalid slot');
    if (parts[i].slot) throw new HttpError(409, 'slot_set', 'Slot already chosen');
    if ((m.takenSlots || []).includes(slot)) throw new HttpError(409, 'slot_taken', 'Slot already taken');
    parts[i] = { ...parts[i], slot };
    tx.update(mref, { participants: parts, takenSlots: FieldValue.arrayUnion(slot) });
    return { slot };
  });
}

export async function roomFor(uid, matchId) {
  const d = db.main(), us = await d.collection('users').doc(uid).get();
  if (!us.exists || !(us.data().joined_matches || []).includes(matchId)) throw new HttpError(403, 'not_joined', 'Join the match to see room details');
  const priv = await d.collection('matches').doc(matchId).collection('private').doc('room').get();
  if (priv.exists) return { roomId: priv.data().roomId || '', roomPass: priv.data().roomPass || '' };
  const m = (await d.collection('matches').doc(matchId).get()).data() || {};
  return { roomId: m.roomId || '', roomPass: m.roomPass || '' };
}
export async function setRoom(matchId, roomId, roomPass) {
  const d = db.main(), mref = d.collection('matches').doc(matchId);
  if (!(await mref.get()).exists) throw new HttpError(404, 'not_found', 'Match not found');
  const rid = String(roomId || '').slice(0, 40), rp = String(roomPass || '').slice(0, 40);
  await mref.collection('private').doc('room').set({ roomId: rid, roomPass: rp, at: Date.now() });
  await mref.update(env('ROOM_PRIVATE') === '1' ? { roomId: FieldValue.delete(), roomPass: FieldValue.delete(), hasRoom: true } : { roomId: rid, roomPass: rp, hasRoom: true });
}
export async function getRoomAdmin(matchId) {
  const d = db.main(), p = await d.collection('matches').doc(matchId).collection('private').doc('room').get();
  if (p.exists) return { roomId: p.data().roomId || '', roomPass: p.data().roomPass || '' };
  const m = (await d.collection('matches').doc(matchId).get()).data() || {}; return { roomId: m.roomId || '', roomPass: m.roomPass || '' };
}

// ---------------- ADMIN HELPERS ----------------
export async function adjustBalance({ uid, type, amount, reason, actor }) {
  amount = r2(amount);
  if (!amount || !['deposit', 'withdraw'].includes(type)) throw new HttpError(400, 'bad_input', 'type + amount required');
  if (Math.abs(amount) > 1e6) throw new HttpError(400, 'too_big', 'Amount too large');
  const d = db.main(), uref = d.collection('users').doc(uid), tref = uref.collection('transactions').doc(), field = type === 'deposit' ? 'depositBalance' : 'withdrawBalance', label = type === 'withdraw' ? 'withdrawal' : 'deposit', abs = Math.abs(amount);
  return d.runTransaction(async (tx) => {
    const us = await tx.get(uref); if (!us.exists) throw new HttpError(404, 'no_user', 'User not found');
    const u = us.data(), cur = type === 'deposit' ? depBal(u) : wdBal(u), next = r2(cur + amount);
    if (next < 0) throw new HttpError(400, 'negative', `Balance would go below 0 (now ₹${cur})`);
    const up = { [field]: FieldValue.increment(amount) };
    if (amount > 0 && type === 'deposit') up.totalDeposited = FieldValue.increment(amount);
    if (amount < 0 && type === 'withdraw') up.totalWithdrawn = FieldValue.increment(abs);
    tx.update(uref, up);
    const why = reason ? ` (${String(reason).slice(0, 60)})` : '';
    const title = amount > 0 ? `Admin credit: ₹${abs}` : `System ${label} cut: ₹${abs}`;
    tx.set(tref, { title, amount: `${amount > 0 ? '+' : '-'}₹${abs}`, type: amount > 0 ? 'deposit' : 'withdraw', status: 'success', method: 'ADMIN', balanceType: type, adminBy: String(actor), date: today(), createdAt: Date.now(), timestamp: FieldValue.serverTimestamp() });
    notif(tx, uid, amount > 0 ? `🎁 You received ₹${abs} from Admin` : title, amount > 0 ? `An admin has added ₹${abs} to your ${label} balance.${why}` : `Admin deducted ₹${abs} from your ${label} balance.${why}`, 'admin');
    return { before: cur, after: next, name: u.appName || '' };
  });
}
export async function setBan(uid, ban, hours = 0) {
  const ref = db.main().collection('users').doc(uid);
  if (!(await ref.get()).exists) throw new HttpError(404, 'no_user', 'User not found');
  const h = Number(hours) || 0;
  await ref.update(ban ? { isBanned: true, bannedUntil: h > 0 ? new Date(Date.now() + h * 3600e3).toISOString() : 'permanent' } : { isBanned: false, bannedUntil: null });
  if (ban) { try { await getAuth(mainApp()).revokeRefreshTokens(uid); } catch (e) { console.warn('revoke', e.message); } }
  try { await callInternal(env('CHAT_BASE_URL'), '/internal/user-ban', { uid, banned: !!ban }); } catch (e) { console.warn('chat sync', e.message); }
}
