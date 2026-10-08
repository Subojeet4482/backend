// Extra endpoints for the user panel: public config, notifications, profile edit, crypto deposit request.
import { FieldValue } from 'firebase-admin/firestore';
import { db } from './fb.js';
import { HttpError, env, r2 } from './base.js';
import { callInternal } from './internal.js';
import * as store from './store.js';
import { isBanned, depBal } from './wallet.js';

const PUBLIC_CFG = ['banners', 'url', 'upi', 'qrUrl', 'cryptoCoin', 'cryptoAddr', 'supportNumber', 'whatsappName', 'whatsappLink', 'whatsappNumber', 'telegramName', 'telegramLink', 'telegramChannel', 'notice'];
const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : Number(t) || 0);
let cfgCache = { t: 0, v: null }, gCache = { t: 0, v: null };

export function registerUser(svc, { notifyAdmins, logs, verifyPassword }) {
  svc.add('GET', '/config', { rl: [30, 60] }, async () => {
    if (!cfgCache.v || Date.now() - cfgCache.t > 30000) {
      const d = db.main(), s = await d.collection('config').doc('banner').get(), all = s.exists ? s.data() : {};
      const config = Object.fromEntries(PUBLIC_CFG.filter((k) => all[k] !== undefined).map((k) => [k, all[k]]));
      const categories = (await d.collection('categories').get()).docs.map((x) => x.data().name).filter(Boolean);
      cfgCache = { t: Date.now(), v: { config, categories } };
    }
    return cfgCache.v;
  });

  svc.add('GET', '/notifications', { rl: [20, 60] }, async () => {
    if (!gCache.v || Date.now() - gCache.t > 20000) {
      const s = await db.main().collection('notifications').orderBy('timestamp', 'desc').limit(15).get();
      gCache = { t: Date.now(), v: { items: s.docs.map((x) => { const n = x.data(); return { title: n.title, message: n.message || n.body, date: n.date, ms: ms(n.timestamp) }; }) } };
    }
    return gCache.v;
  });

  const nref = (uid) => db.main().collection('users').doc(uid).collection('notifications');
  svc.add('GET', '/me/notifications', { auth: 'user', rl: [30, 60] }, async (ctx) => {
    const s = await nref(ctx.user.uid).orderBy('createdAt', 'desc').limit(50).get();
    return { personal: s.docs.map((x) => { const n = x.data(); return { id: x.id, title: n.title, message: n.message || n.body, date: n.date, ms: ms(n.timestamp) || Number(n.createdAt) || 0, claimAmount: n.claimAmount, claimType: n.claimType, claimed: !!n.claimed }; }) };
  });
  svc.add('POST', '/me/notifications/clear', { auth: 'user', rl: [5, 60] }, async (ctx) => {
    const d = db.main(), s = await nref(ctx.user.uid).limit(400).get(), b = d.batch();
    s.docs.forEach((x) => b.delete(x.ref)); await b.commit();
    return { deleted: s.size };
  });
  svc.add('POST', '/me/notifications/claim', { auth: 'user', rl: [20, 60] }, async (ctx) => {
    const id = String(ctx.body.id || ''); if (!/^[A-Za-z0-9_-]{5,40}$/.test(id)) throw new HttpError(400, 'bad_id', 'Invalid id');
    await nref(ctx.user.uid).doc(id).update({ claimed: true, claimedAt: Date.now() });
  });

  svc.add('PUT', '/me/profile', { auth: 'user', rl: [10, 60], maxBody: 150000 }, async (ctx) => {
    const b = ctx.body, uref = db.main().collection('users').doc(ctx.user.uid);
    return db.main().runTransaction(async (tx) => {
      const s = await tx.get(uref); if (!s.exists) throw new HttpError(404, 'no_user', 'Profile missing');
      const u = s.data(), patch = {};
      if (b.appName !== undefined) {
        const n = String(b.appName).trim(); if (n.length < 3 || n.length > 30) throw new HttpError(400, 'bad_name', 'App name must be 3-30 characters');
        if (n !== u.appName) { const left = u.nameChangesLeft ?? 2; if (left <= 0) throw new HttpError(403, 'name_limit', 'Name change limit reached'); patch.appName = n; patch.nameChangesLeft = left - 1; }
      }
      if (b.gameName !== undefined) { const n = String(b.gameName).trim(); if (n.length < 3 || n.length > 30) throw new HttpError(400, 'bad_name', 'Game name must be 3-30 characters'); patch.gameName = n; }
      if (b.gameUid !== undefined) {
        const g = String(b.gameUid).trim(); if (!/^\d{6,12}$/.test(g)) throw new HttpError(400, 'bad_uid', 'FF UID invalid (6-12 digits)');
        if (u.isUidVerified && g !== String(u.gameUid || '')) throw new HttpError(403, 'uid_locked', 'Verified UID cannot be changed');
        patch.gameUid = g;
      }
      if (b.photoUrl !== undefined) {
        const p = String(b.photoUrl);
        if (p && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(p) && !/^https:\/\/\S{5,480}$/.test(p)) throw new HttpError(400, 'bad_photo', 'Invalid image');
        if (p.length > 120000) throw new HttpError(400, 'photo_big', 'Image too large'); patch.photoUrl = p;
      }
      if (b.paymentMethod !== undefined) { patch.paymentMethod = String(b.paymentMethod).slice(0, 60); patch.paymentName = String(b.paymentName || '').slice(0, 60); }
      if (!Object.keys(patch).length) throw new HttpError(400, 'nothing', 'Nothing to update');
      tx.update(uref, patch); return { updated: Object.keys(patch), name: patch.appName };
    }).then(async (out) => {
      if (out.name) { try { await callInternal(env('CHAT_BASE_URL'), '/internal/profile-sync', { uid: ctx.user.uid, appName: out.name }); } catch (e) { console.warn('chat profile-sync', e.message); } }
      return { updated: out.updated };
    });
  });

  // crypto deposit: pending request, admin approves from the panel / Telegram bot (decideDeposit)
  svc.add('POST', '/wallet/deposit/crypto', { auth: 'user', rl: [5, 60] }, async (ctx) => {
    if (!ctx.cfg.depositEnabled) throw new HttpError(503, 'deposit_off', 'Deposits are paused right now');
    const hash = String(ctx.body.hash || '').trim(), amt = Math.round(parseFloat(ctx.body.amount) * 100) / 100;
    if (!/^[A-Za-z0-9]{10,100}$/.test(hash)) throw new HttpError(400, 'bad_hash', 'Invalid transaction hash');
    if (!Number.isFinite(amt) || amt < ctx.cfg.depositMin || amt > ctx.cfg.depositMax) throw new HttpError(400, 'bad_amount', `Amount must be ₹${ctx.cfg.depositMin} – ₹${ctx.cfg.depositMax}`);
    const d = db.main(), uref = d.collection('users').doc(ctx.user.uid), rref = d.collection('deposit_requests').doc(hash.slice(0, 100));
    await d.runTransaction(async (tx) => {
      const [us, rs] = await Promise.all([tx.get(uref), tx.get(rref)]);
      if (!us.exists) throw new HttpError(404, 'no_user', 'User not found');
      if (rs.exists) throw new HttpError(409, 'utr_used', 'This hash was already submitted');
      const tref = uref.collection('transactions').doc();
      tx.set(rref, { utr: hash, amount: amt, uid: ctx.user.uid, name: us.data().appName || 'User', status: 'pending', method: 'CRYPTO', createdAt: Date.now(), trxDocId: tref.id });
      tx.set(tref, { title: `Crypto deposit ₹${amt} (in review)`, amount: `+₹${amt}`, type: 'deposit', status: 'pending', trxId: hash, method: 'CRYPTO', date: new Date().toLocaleDateString(), createdAt: Date.now(), timestamp: FieldValue.serverTimestamp() });
    });
    notifyAdmins && notifyAdmins(`🪙 <b>Crypto deposit request</b>\n₹${amt}\nHash: <code>${hash.slice(0, 40)}</code>`).catch(() => {});
    return { amount: amt };
  });

  // ---------- TRANSFER BY PLAYER ID (server side, atomic; money moves only from deposit balance to deposit balance) ----------
  const findByPlayerId = async (pid) => { const s = await db.main().collection('users').where('playerId', '==', pid).limit(1).get(); return s.empty ? null : s.docs[0]; };
  svc.add('GET', '/wallet/recipient', { auth: 'user', rl: [30, 60] }, async (ctx) => {
    const pid = String(ctx.query.playerId || '').trim(); if (!/^\d{5,10}$/.test(pid)) return { found: false };
    const d = await findByPlayerId(pid); if (!d) return { found: false };
    if (d.id === ctx.user.uid) return { found: false, self: true };
    const u = d.data(); if (isBanned(u)) return { found: false };
    return { found: true, appName: u.appName || 'User' };
  });
  svc.add('POST', '/wallet/transfer', { auth: 'user', rl: [6, 60] }, async (ctx) => {
    const c = ctx.cfg, uid = ctx.user.uid, b = ctx.body;
    if (c.transferEnabled === false) throw new HttpError(503, 'transfer_off', 'Transfers are paused right now');
    const pid = String(b.playerId || '').trim(), amt = r2(parseFloat(b.amount)), min = Number(c.transferMin) || 10, max = Number(c.transferMax) || 5000;
    const note = String(b.note || '').replace(/[<>]/g, '').trim().slice(0, 40), pass = String(b.password || '');
    if (!/^\d{5,10}$/.test(pid)) throw new HttpError(400, 'bad_pid', 'Enter a valid Player ID');
    if (!Number.isFinite(amt) || amt < min) throw new HttpError(400, 'min_amount', `Minimum transfer is ₹${min}`);
    if (amt > max) throw new HttpError(400, 'max_amount', `Maximum transfer is ₹${max}`);
    if (pass.length < 6 || pass.length > 128) throw new HttpError(400, 'bad_password', 'Enter your account password');
    if ((await store.get('ff:tpwlock:' + uid)) >= 5) throw new HttpError(429, 'locked', 'Too many wrong passwords. Try again in 15 minutes.');
    const d = db.main(), uref = d.collection('users').doc(uid), me0 = await uref.get();
    if (!me0.exists) throw new HttpError(404, 'no_user', 'Profile missing');
    try { await verifyPassword(String(me0.data().email || ''), pass); }
    catch (e) {
      if (['INVALID_PASSWORD', 'INVALID_LOGIN_CREDENTIALS', 'EMAIL_NOT_FOUND'].includes(e.code)) { const n = await store.incr('ff:tpwlock:' + uid, 900); await store.set('ff:tpwlock:' + uid, n, 900); throw new HttpError(401, 'wrong_password', 'Wrong password'); }
      if (e.code === 'TOO_MANY_ATTEMPTS_TRY_LATER') throw new HttpError(429, 'rate_limited', 'Too many attempts. Try later.');
      throw new HttpError(502, 'auth_unavailable', 'Could not verify password. Try again.');
    }
    const rd = await findByPlayerId(pid); if (!rd) throw new HttpError(404, 'no_recipient', 'Player ID not found');
    if (rd.id === uid) throw new HttpError(400, 'self', 'You cannot send money to yourself');
    const rref = d.collection('users').doc(rd.id), now = Date.now(), date = new Date().toLocaleDateString();
    const out = await d.runTransaction(async (tx) => {
      const [ss, rs] = await Promise.all([tx.get(uref), tx.get(rref)]);
      if (!ss.exists || !rs.exists) throw new HttpError(404, 'no_user', 'User not found');
      const s = ss.data(), r = rs.data();
      if (isBanned(s)) throw new HttpError(403, 'banned', 'Account restricted');
      if (isBanned(r)) throw new HttpError(403, 'recipient_banned', 'Recipient cannot receive money');
      if (depBal(s) + 1e-9 < amt) throw new HttpError(400, 'low_balance', `Not enough deposit balance. Available ₹${depBal(s).toFixed(2)}`);
      const t1 = uref.collection('transactions').doc(), t2 = rref.collection('transactions').doc(), tid = 'TR' + now.toString(36).toUpperCase() + t1.id.slice(0, 4).toUpperCase();
      tx.update(uref, { depositBalance: s.depositBalance === undefined ? r2(depBal(s) - amt) : FieldValue.increment(-amt), totalTransferred: FieldValue.increment(amt) });   // legacy accounts only had "balance"
      tx.update(rref, { depositBalance: r.depositBalance === undefined ? r2(depBal(r) + amt) : FieldValue.increment(amt) });
      tx.set(t1, { title: `Sent ₹${amt} to ${r.appName || 'player'}`, amount: `-₹${amt}`, type: 'transfer', direction: 'out', status: 'success', trxId: tid, method: 'TRANSFER', note, date, createdAt: now, timestamp: FieldValue.serverTimestamp() });
      tx.set(t2, { title: `Received ₹${amt} from ${s.appName || 'player'}`, amount: `+₹${amt}`, type: 'transfer', direction: 'in', status: 'success', trxId: tid, method: 'TRANSFER', note, date, createdAt: now, timestamp: FieldValue.serverTimestamp() });
      tx.set(rref.collection('notifications').doc(), { title: `You received ₹${amt}`, body: `${s.appName || 'A player'} sent you ₹${amt}${note ? ' • ' + note : ''}`, message: `${s.appName || 'A player'} sent you ₹${amt}${note ? ' • ' + note : ''}`, type: 'transfer', read: false, date, createdAt: now, timestamp: FieldValue.serverTimestamp() });
      tx.set(d.collection('transfers').doc(tid), { from: uid, to: rd.id, amount: amt, note, at: now });
      return { amount: amt, to: r.appName || 'Player', trxId: tid, balance: r2(depBal(s) - amt) };
    });
    await store.del('ff:tpwlock:' + uid);
    logs && logs.ipLog('transfer', { uid, ip: ctx.ip, ua: ctx.ua, amount: amt, to: rd.id });
    if (amt >= 2000 && notifyAdmins) notifyAdmins(`💱 <b>Large transfer</b>\n₹${amt} • ${String(out.to).replace(/[<>&]/g, '')}`).catch(() => {});
    return out;
  });
}
