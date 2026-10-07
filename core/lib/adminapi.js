// Admin panel API. The panel talks ONLY to these endpoints (never to Firestore). Every write is audited with the admin's email + IP.
import { FieldValue, FieldPath } from 'firebase-admin/firestore';
import { db } from './fb.js';
import { HttpError, r2, env } from './base.js';
import * as W from './wallet.js';
import * as D from './dataops.js';

const num = (v) => (Number.isFinite(+v) ? +v : 0);
const today = () => new Date().toLocaleDateString();
const TYPES = ['win_prize', 'per_kill', 'team_win'];
const M = () => db.main();
const id = (v, what = 'id') => { const s = String(v || ''); if (!/^[A-Za-z0-9_-]{1,128}$/.test(s)) throw new HttpError(400, 'bad_' + what, `Invalid ${what}`); return s; };
const text = (v, max) => String(v ?? '').trim().slice(0, max);
const httpsUrl = (v, what) => { const s = text(v, 500); if (s && !/^https:\/\/\S+$/.test(s)) throw new HttpError(400, 'bad_url', `${what} must be an https link`); return s; };
const notifTx = (tx, uid, title, message) => tx.set(M().collection('users').doc(uid).collection('notifications').doc(), { title, message, date: today(), createdAt: Date.now(), timestamp: FieldValue.serverTimestamp() });

function matchFields(b, partial) {
  const o = {};
  if (b.title !== undefined || !partial) { o.title = text(b.title, 80); if (!o.title) throw new HttpError(400, 'bad_title', 'Title required'); }
  const n = (k, min, max, def) => { if (b[k] === undefined && partial) return; const v = b[k] === undefined || b[k] === '' ? def : Number(b[k]); if (!Number.isFinite(v) || v < min || v > max) throw new HttpError(400, 'bad_' + k, `${k} must be ${min}–${max}`); o[k] = v; };
  n('fee', 0, 100000, 0); n('prize', 0, 10000000, 0); n('total', 1, 100, 48);
  if (b.matchType !== undefined || !partial) { o.matchType = text(b.matchType || 'win_prize', 20); if (!TYPES.includes(o.matchType)) throw new HttpError(400, 'bad_type', 'Unknown match type'); }
  if (b.teamMode !== undefined) o.teamMode = text(b.teamMode, 20);
  if (b.map !== undefined) o.map = text(b.map, 40);
  if (b.startTime !== undefined) o.startTime = text(b.startTime, 40);
  if (b.img !== undefined) o.img = httpsUrl(b.img, 'Image');
  return o;
}

async function payMatch(matchId, b, actor) {
  const d = M(), mref = d.collection('matches').doc(matchId);
  return d.runTransaction(async (tx) => {
    const ms = await tx.get(mref); if (!ms.exists) throw new HttpError(404, 'not_found', 'Match not found');
    const m = ms.data();
    if (m.paid) throw new HttpError(409, 'already_paid', 'Payment for this match is already done');
    if (m.status === 'cancelled') throw new HttpError(409, 'cancelled', 'Match is cancelled');
    const kind = m.matchType || 'win_prize', parts = m.participants || [], byUid = new Map(parts.map((p) => [p.uid, p]));
    const pick = (uid) => { if (!byUid.has(uid)) throw new HttpError(400, 'not_participant', 'Selected player is not in this match'); return uid; };
    const credits = [];
    if (kind === 'win_prize') {
      const total = r2(num(b.amount)); if (!(total > 0 && total <= 1e6)) throw new HttpError(400, 'bad_amount', 'Enter a valid prize amount');
      if (!b.first) throw new HttpError(400, 'no_winner', 'Select the 1st winner');
      const seen = new Set();
      for (const [k, pct, rank] of [['first', 0.5, '1st'], ['second', 0.3, '2nd'], ['third', 0.2, '3rd']]) {
        const uid = b[k]; if (!uid) continue; pick(uid); if (seen.has(uid)) throw new HttpError(400, 'duplicate', 'Same player selected twice'); seen.add(uid);
        const amt = r2(total * pct); credits.push({ uid, amt, rank, wins: rank === '1st' ? 1 : 0, title: `Match win success: ₹${amt}`, msg: `${rank} place • Win Prize match reward added to withdrawal balance.` });
      }
    } else if (kind === 'per_kill') {
      const per = num(m.prize); if (per <= 0) throw new HttpError(400, 'no_rate', 'Per-kill amount is not set in this match');
      for (const [uid, k] of Object.entries(b.kills || {})) {
        const kills = parseInt(k) || 0; if (kills <= 0) continue; pick(uid); if (kills > 100) throw new HttpError(400, 'bad_kills', 'Kills must be 0–100');
        const amt = r2(kills * per); credits.push({ uid, amt, kills, title: `Match win success: ₹${amt} (${kills} kills)`, msg: `Per Kill reward: ${kills} × ₹${per}.` });
      }
      if (!credits.length) throw new HttpError(400, 'no_kills', 'Enter kill counts');
    } else {
      const per = r2(num(m.prize)), uids = [...new Set(Array.isArray(b.uids) ? b.uids : [])]; if (!uids.length) throw new HttpError(400, 'no_winner', 'Tick the winning team members');
      if (per <= 0) throw new HttpError(400, 'no_rate', 'Prize amount is not set in this match');
      for (const uid of uids) { pick(uid); credits.push({ uid, amt: per, wins: 1, title: `Match win success: ₹${per} (Team Win)`, msg: 'Team win — reward added to withdrawal balance.' }); }
    }
    if (credits.length > 100) throw new HttpError(400, 'too_many', 'Too many winners');
    const refs = credits.map((c) => d.collection('users').doc(c.uid)), snaps = await tx.getAll(...refs);   // all reads before writes
    snaps.forEach((s) => { if (!s.exists) throw new HttpError(404, 'no_user', 'A winner no longer exists'); });
    credits.forEach((c, i) => {
      tx.update(refs[i], { withdrawBalance: FieldValue.increment(c.amt), totalEarned: FieldValue.increment(c.amt), ...(c.wins ? { matchesWon: FieldValue.increment(c.wins) } : {}), ...(c.kills ? { kills: FieldValue.increment(c.kills) } : {}) });
      notifTx(tx, c.uid, c.title, c.msg);
      tx.set(refs[i].collection('transactions').doc(), { title: c.title, amount: `+₹${c.amt}`, type: 'deposit', status: 'success', matchId, date: today(), createdAt: Date.now(), timestamp: FieldValue.serverTimestamp() });
    });
    const cm = new Map(credits.map((c) => [c.uid, c]));
    const newParts = parts.map((p) => { const c = cm.get(p.uid); return c ? { ...p, winAmount: c.amt, ...(c.rank ? { rank: c.rank } : {}), ...(c.kills !== undefined ? { kills: c.kills } : {}) } : { ...p, winAmount: 0, ...(kind === 'per_kill' ? { kills: 0 } : {}) }; });
    tx.update(mref, { status: 'completed', paid: true, paidAt: Date.now(), paidBy: String(actor), participants: newParts, ...(kind === 'win_prize' ? { winnerUid: b.first } : {}) });
    return { credited: credits.length, total: r2(credits.reduce((a, c) => a + c.amt, 0)) };
  });
}

export async function monthlyReward() {            // top-3 by score on the 1st (IST); idempotent per month
  const ist = new Date(Date.now() + 5.5 * 3600e3);
  if (ist.getUTCDate() !== 1) return { skipped: 'not the 1st' };
  const key = `${ist.getUTCFullYear()}-${ist.getUTCMonth() + 1}`, d = M(), cref = d.collection('config').doc('leaderboard');
  const claimed = await d.runTransaction(async (tx) => { const s = await tx.get(cref); if (s.exists && s.data().lastRewardMonth === key) return false; tx.set(cref, { lastRewardMonth: key, rewardedAt: Date.now() }, { merge: true }); return true; });
  if (!claimed) return { skipped: 'already done' };
  const top = (await d.collection('users').orderBy('score', 'desc').limit(3).get()).docs.filter((x) => num(x.data().score) > 0), rewards = [10, 5, 5];
  for (let i = 0; i < top.length; i++) {
    const r = rewards[i], ref = top[i].ref, b = d.batch();
    b.update(ref, { withdrawBalance: FieldValue.increment(r), totalEarned: FieldValue.increment(r) });
    b.set(ref.collection('notifications').doc(), { title: `🏆 Monthly Rank #${i + 1} Reward!`, message: `You earned ₹${r} for being on top of this month's leaderboard.`, date: today(), createdAt: Date.now(), timestamp: FieldValue.serverTimestamp() });
    b.set(ref.collection('transactions').doc(), { title: `Monthly Leaderboard Rank #${i + 1}`, amount: `+₹${r}`, type: 'deposit', status: 'success', date: today(), createdAt: Date.now(), timestamp: FieldValue.serverTimestamp() });
    await b.commit();
  }
  return { rewarded: top.length, month: key };
}

let finScan = { t: 0, docs: [] };
let mCache = { t: 0, v: null };
export function registerAdmin(svc, logs, { roles, tg }) {
  const adm = (method, path, fn, rl = [90, 60], extra = {}) => svc.add(method, path, { auth: 'admin', rl, ...extra }, fn);
  const aud = (ctx, action, data = {}) => { if (/^(match|booya|room)/.test(action)) mCache.t = 0; return logs.audit(action, ctx.user.email, { ...data, ip: ctx.ip }); };
  const count = async (q) => { try { return (await q.count().get()).data().count; } catch { return null; } };

  // ---------- dashboard ----------
  adm('GET', '/admin/stats', async () => {
    const [users, matches, pd, pw] = await Promise.all([count(M().collection('users')), count(M().collection('matches')), count(M().collection('deposit_requests').where('status', '==', 'pending')), count(M().collection('withdraw_queue').where('status', '==', 'pending'))]);
    return { users, matches, pendingDeposits: pd, pendingWithdrawals: pw };
  });
  adm('GET', '/admin/categories', async () => ({ categories: (await M().collection('categories').get()).docs.map((x) => ({ id: x.id, ...x.data() })) }));
  adm('POST', '/admin/categories', async (ctx) => { const name = text(ctx.body.name, 30); if (!name) throw new HttpError(400, 'bad_name', 'Name required'); const r = await M().collection('categories').add({ name }); await aud(ctx, 'category_add', { name }); return { id: r.id }; });
  adm('DELETE', '/admin/categories/:id', async (ctx) => { await M().collection('categories').doc(id(ctx.params.id)).delete(); await aud(ctx, 'category_delete', { id: ctx.params.id }); });
  adm('GET', '/admin/notifications', async () => ({ items: (await M().collection('notifications').orderBy('timestamp', 'desc').limit(100).get()).docs.map((x) => ({ id: x.id, title: x.data().title, message: x.data().message, date: x.data().date })) }));
  adm('POST', '/admin/notifications', async (ctx) => {
    const title = text(ctx.body.title, 100), message = text(ctx.body.message, 500); if (!title || !message) throw new HttpError(400, 'bad_input', 'Title and message required');
    await M().collection('notifications').add({ title, message, date: today(), timestamp: FieldValue.serverTimestamp() }); await aud(ctx, 'broadcast', { title });
  }, [10, 60]);
  adm('DELETE', '/admin/notifications/:id', async (ctx) => { await M().collection('notifications').doc(id(ctx.params.id)).delete(); await aud(ctx, 'broadcast_delete', { id: ctx.params.id }); });
  adm('GET', '/admin/settings', async () => { const s = await M().collection('config').doc('banner').get(); return { settings: s.exists ? s.data() : {} }; });
  adm('PUT', '/admin/settings', async (ctx) => {
    const b = ctx.body, o = {};
    if (b.banners !== undefined) { if (!Array.isArray(b.banners) || b.banners.length > 10) throw new HttpError(400, 'bad_banners', 'Max 10 banners'); o.banners = b.banners.map((u) => httpsUrl(u, 'Banner')).filter(Boolean); o.url = o.banners[0] || ''; }
    for (const [k, max] of [['notice', 500], ['supportNumber', 40], ['upi', 80], ['cryptoCoin', 20], ['cryptoAddr', 120], ['whatsappName', 60], ['whatsappLink', 300], ['telegramName', 60], ['telegramLink', 300]]) if (b[k] !== undefined) o[k] = text(b[k], max);
    for (const k of ['whatsappLink', 'telegramLink']) if (o[k] && !/^https:\/\//.test(o[k])) throw new HttpError(400, 'bad_url', `${k} must be an https link`);
    if (b.qrUrl !== undefined) { const q = String(b.qrUrl); if (q && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(q) && !/^https:\/\//.test(q)) throw new HttpError(400, 'bad_qr', 'Invalid QR image'); if (q.length > 400000) throw new HttpError(400, 'qr_big', 'QR image too large'); o.qrUrl = q; }
    await M().collection('config').doc('banner').set(o, { merge: true }); await aud(ctx, 'settings_save', { fields: Object.keys(o) });
  }, [20, 60], { maxBody: 600000 });
  adm('POST', '/admin/monthly-reward', async (ctx) => { const r = await monthlyReward(); await aud(ctx, 'monthly_reward', r); return r; }, [3, 60]);

  // ---------- users ----------
  adm('GET', '/admin/users', async (ctx) => {
    const q = text(ctx.query.q, 128);
    if (q) return { users: (await D.findUsers(q)).map((x) => ({ uid: x.id, ...x.data() })), next: null };
    const lim = Math.min(Math.max(parseInt(ctx.query.limit) || 300, 1), 500);
    let qq = M().collection('users').orderBy(FieldPath.documentId()).limit(lim); if (ctx.query.cursor) qq = qq.startAfter(id(ctx.query.cursor, 'cursor'));
    const s = await qq.get(); return { users: s.docs.map((x) => ({ uid: x.id, ...x.data() })), next: s.size === lim ? s.docs[s.size - 1].id : null };
  });
  adm('GET', '/admin/user/:uid', async (ctx) => {
    const uid = id(ctx.params.uid, 'uid'), s = await M().collection('users').doc(uid).get(); if (!s.exists) throw new HttpError(404, 'no_user', 'User not found');
    let t; try { t = await M().collection('users').doc(uid).collection('transactions').orderBy('createdAt', 'desc').limit(60).get(); } catch { t = await M().collection('users').doc(uid).collection('transactions').limit(60).get(); }
    return { user: { uid, ...s.data() }, transactions: t.docs.map((x) => { const v = x.data(); delete v.accountNumber; delete v.ifsc; delete v.walletAddress; return { id: x.id, ...v, timestamp: undefined }; }) };
  });
  adm('POST', '/admin/balance', async (ctx) => {
    const out = await W.adjustBalance({ uid: id(ctx.body.uid, 'uid'), type: ctx.body.type, amount: ctx.body.amount, reason: ctx.body.reason, actor: ctx.user.email });
    await aud(ctx, 'balance_adjust', { uid: ctx.body.uid, type: ctx.body.type, amount: ctx.body.amount, reason: ctx.body.reason, ...out }); return out;
  }, [30, 60]);
  adm('POST', '/admin/ban', async (ctx) => { await W.setBan(id(ctx.body.uid, 'uid'), !!ctx.body.ban, ctx.body.hours); await aud(ctx, ctx.body.ban ? 'ban' : 'unban', { uid: ctx.body.uid, hours: ctx.body.hours }); }, [30, 60]);
  adm('POST', '/admin/user/verify', async (ctx) => {
    const v = !!ctx.body.verified; await M().collection('users').doc(id(ctx.body.uid, 'uid')).update({ isVerified: v, verifiedAt: v ? new Date().toISOString() : null }); await aud(ctx, v ? 'verify' : 'unverify', { uid: ctx.body.uid });
  });
  adm('POST', '/admin/user/delete', async (ctx) => {          // full delete; a backup file goes to the owner on Telegram FIRST
    const uid = id(ctx.body.uid, 'uid'); if (ctx.body.confirm !== uid) throw new HttpError(400, 'not_confirmed', 'Confirmation missing');
    const r = await roles.get(), to = r.owners[0]; if (!to) throw new HttpError(500, 'no_owner', 'No owner configured for the backup');
    const b = await D.sendBackup(tg, to, 'ua', uid, 'pre-delete backup (admin panel)');
    const n = await D.deleteUserCascade(uid); await aud(ctx, 'user_delete', { uid, records: n, backup: b.count }); return { deleted: n };
  }, [5, 60]);

  // ---------- matches ----------
  adm('GET', '/admin/matches', async () => ({ matches: mCache.v && Date.now() - mCache.t < 10000 ? mCache.v : (mCache.v = (await M().collection('matches').limit(300).get()).docs.map((x) => { const m = x.data(); delete m.participants; delete m.roomPass; return { id: x.id, ...m }; }), mCache.t = Date.now(), mCache.v) }));
  adm('GET', '/admin/matches/:id', async (ctx) => { const s = await M().collection('matches').doc(id(ctx.params.id)).get(); if (!s.exists) throw new HttpError(404, 'not_found', 'Match not found'); const m = s.data(); delete m.roomPass; return { match: { id: s.id, ...m } }; });
  adm('POST', '/admin/matches', async (ctx) => {
    const d = { ...matchFields(ctx.body, false), joined: 0, status: 'upcoming', participants: [], takenSlots: [], createdAt: Date.now() };
    const r = await M().collection('matches').add(d); await aud(ctx, 'match_create', { id: r.id, title: d.title }); return { id: r.id };
  }, [30, 60]);
  adm('PUT', '/admin/matches/:id', async (ctx) => { const o = matchFields(ctx.body, true); if (!Object.keys(o).length) throw new HttpError(400, 'nothing', 'Nothing to update'); await M().collection('matches').doc(id(ctx.params.id)).update(o); await aud(ctx, 'match_update', { id: ctx.params.id, fields: Object.keys(o) }); });
  adm('DELETE', '/admin/matches/:id', async (ctx) => {
    const ref = M().collection('matches').doc(id(ctx.params.id)), s = await ref.get(); if (!s.exists) throw new HttpError(404, 'not_found', 'Match not found');
    const m = s.data(); if (num(m.joined) > 0 && !['completed', 'cancelled'].includes(m.status)) throw new HttpError(409, 'has_players', 'Players have joined this match. Cancel it (refund) instead.');
    await ref.delete(); await aud(ctx, 'match_delete', { id: ctx.params.id });
  }, [30, 60]);
  adm('POST', '/admin/matches/:id/complete', async (ctx) => { await M().collection('matches').doc(id(ctx.params.id)).update({ status: 'completed', winnerName: text(ctx.body.winnerName, 60) || 'N/A' }); await aud(ctx, 'match_complete', { id: ctx.params.id }); });
  adm('POST', '/admin/matches/:id/booya', async (ctx) => {
    const ref = M().collection('matches').doc(id(ctx.params.id)), s = await ref.get(); if (!s.exists) throw new HttpError(404, 'not_found', 'Match not found');
    const ok = new Set((s.data().participants || []).map((p) => p.uid)), players = (Array.isArray(ctx.body.players) ? ctx.body.players : []).filter((p) => ok.has(p.uid)).map((p) => ({ uid: p.uid, name: text(p.name, 40) }));
    await ref.update({ booyaPlayers: players }); await aud(ctx, 'booya_save', { id: ctx.params.id, n: players.length });
  });
  adm('POST', '/admin/matches/:id/pay', async (ctx) => { const out = await payMatch(id(ctx.params.id), ctx.body, ctx.user.email); await aud(ctx, 'match_pay', { id: ctx.params.id, ...out }); return out; }, [10, 60]);
  adm('GET', '/admin/match/:id/room', async (ctx) => W.getRoomAdmin(id(ctx.params.id)));
  adm('POST', '/admin/match/room', async (ctx) => { await W.setRoom(id(ctx.body.matchId), ctx.body.roomId, ctx.body.roomPass); await aud(ctx, 'room_set', { matchId: ctx.body.matchId }); }, [30, 60]);
  adm('POST', '/admin/matches/:id/cancel', async (ctx) => {            // refund every entry fee to depositBalance
    const d = M(), mref = d.collection('matches').doc(id(ctx.params.id));
    const out = await d.runTransaction(async (tx) => {
      const ms = await tx.get(mref); if (!ms.exists) throw new HttpError(404, 'not_found', 'Match not found');
      const m = ms.data(); if (['cancelled', 'completed'].includes(m.status)) throw new HttpError(409, 'already', `Match already ${m.status}`);
      const fee = r2(num(m.fee)), parts = m.participants || []; if (parts.length > 120) throw new HttpError(400, 'too_many', 'Too many players for one cancel');
      const refs = parts.map((p) => d.collection('users').doc(p.uid)), snaps = refs.length ? await tx.getAll(...refs) : [];
      snaps.forEach((s, i) => {
        if (!s.exists) return;
        tx.update(refs[i], { depositBalance: r2(W.depBal(s.data()) + fee), joined_matches: (s.data().joined_matches || []).filter((x) => x !== ms.id), matchesPlayed: FieldValue.increment(-1) });
        if (fee > 0) tx.set(refs[i].collection('transactions').doc(), { title: `Refund: ${m.title || 'match'} cancelled`, amount: `+₹${fee}`, type: 'deposit', status: 'success', method: 'REFUND', matchId: ms.id, date: today(), createdAt: Date.now(), timestamp: FieldValue.serverTimestamp() });
        notifTx(tx, parts[i].uid, `Match cancelled: ${m.title || ''}`, fee > 0 ? `₹${fee} entry fee refunded to your deposit balance.` : 'The match was cancelled.');
      });
      tx.update(mref, { status: 'cancelled', cancelledAt: Date.now() });
      return { refunded: snaps.filter((s) => s.exists).length, fee };
    });
    await aud(ctx, 'match_cancel', { id: ctx.params.id, ...out }); return out;
  }, [10, 60]);

  // ---------- finance ----------
  adm('GET', '/admin/finance', async (ctx) => {
    const all = ctx.query.status === 'all', cg = M().collectionGroup('transactions'); let docs;
    try { docs = (all ? await cg.orderBy('createdAt', 'desc').limit(300).get() : await cg.where('status', '==', 'pending').limit(300).get()).docs; }
    catch (e) {                                        // index missing -> slower scan, cached 60 s
      if (e.code !== 9) throw e;
      if (Date.now() - finScan.t > 60000) finScan = { t: Date.now(), docs: (await cg.limit(1500).get()).docs };
      docs = all ? finScan.docs.slice(0, 300) : finScan.docs.filter((x) => x.get('status') === 'pending');
    }
    const items = docs.filter((x) => ['deposit', 'withdraw'].includes(x.get('type')) && x.get('method') !== 'ADMIN' && x.get('method') !== 'REFUND').map((x) => { const v = x.data(); delete v.timestamp; return { ...v, _docId: x.id, _uid: x.ref.parent.parent.id }; });
    return { items };
  }, [60, 60]);
  adm('POST', '/admin/finance/process', async (ctx) => {
    const uid = id(ctx.body.uid, 'uid'), trxId = id(ctx.body.trxId, 'trxId'), action = ctx.body.action;
    const s = await M().collection('users').doc(uid).collection('transactions').doc(trxId).get(); if (!s.exists) throw new HttpError(404, 'not_found', 'Request not found');
    let out;
    if (s.data().type === 'withdraw') out = await W.decideWithdraw({ uid, trxId, decision: { approve: 'approve', reject: 'reject', refund: 'refund' }[action], actor: ctx.user.email });
    else if (s.data().type === 'deposit' && ['approve', 'reject'].includes(action)) out = await W.decideDeposit({ uid, trxId, decision: action, actor: ctx.user.email });
    else throw new HttpError(400, 'bad_action', 'Action not allowed for this request');
    await aud(ctx, `finance_${action}`, { uid, trxId, ...out }); return out;
  }, [60, 60]);

  // ---------- reports ----------
  adm('GET', '/admin/reports', async (ctx) => {
    const st = ['open', 'resolved'].includes(ctx.query.status) ? ctx.query.status : 'open'; let s;
    try { s = await M().collection('reports').where('status', '==', st).orderBy('createdAt', 'desc').limit(80).get(); } catch (e) { if (e.code !== 9) throw e; s = await M().collection('reports').where('status', '==', st).limit(80).get(); }
    return { items: s.docs.map((x) => { const v = x.data(), t = v.createdAt; return { id: x.id, ...v, createdAt: t && t.toMillis ? t.toMillis() : t }; }) };
  });
  adm('GET', '/admin/reports/open-count', async () => ({ count: await count(M().collection('reports').where('status', '==', 'open')) }));
  adm('POST', '/admin/reports/resolve', async (ctx) => { await M().collection('reports').doc(id(ctx.body.id)).update({ status: 'resolved', resolvedAt: Date.now() }); await aud(ctx, 'report_resolve', { id: ctx.body.id }); });

  // ---------- groups / DMs (still in MAIN Firestore until the app is moved to the chat service) ----------
  const MSGPATH = /^(groups\/[A-Za-z0-9_-]+\/messages|[A-Za-z0-9_]+\/[A-Za-z0-9_-]+\/messages)\/[A-Za-z0-9_-]+$/;
  adm('GET', '/admin/groups', async () => ({ groups: (await M().collection('groups').limit(50).get()).docs.map((x) => ({ id: x.id, isGroup: true, ...x.data() })) }));
  adm('GET', '/admin/group/:gid', async (ctx) => { const s = await M().collection('groups').doc(id(ctx.params.gid)).get(); if (!s.exists) throw new HttpError(404, 'not_found', 'Group not found'); const g = s.data(); return { group: { id: s.id, name: g.name, members: (g.members || []).length, public: !!g.public, ownerUid: g.ownerUid || '' } }; });
  adm('POST', '/admin/group/delete', async (ctx) => {
    const gid = id(ctx.body.gid), ref = M().collection('groups').doc(gid); let n = 0;
    for (;;) { const s = await ref.collection('messages').limit(400).get(); if (s.empty) break; const b = M().batch(); s.docs.forEach((x) => b.delete(x.ref)); await b.commit(); n += s.size; }
    await ref.delete(); await aud(ctx, 'group_delete', { gid, messages: n }); return { messages: n };
  }, [10, 60]);
  adm('GET', '/admin/dm-messages', async () => { try { const s = await M().collectionGroup('messages').orderBy('createdAt', 'desc').limit(100).get(); return { items: s.docs.map((x) => { const v = x.data(); return { id: x.id, _path: x.ref.path, ...v, createdAt: v.createdAt && v.createdAt.toMillis ? v.createdAt.toMillis() : v.createdAt }; }) }; } catch { return { items: [] }; } });
  adm('POST', '/admin/msg', async (ctx) => {                   // pin | unpin | hide | delete on a group / DM message
    const path = String(ctx.body.path || ''); if (!MSGPATH.test(path)) throw new HttpError(400, 'bad_path', 'Not a message path');
    const ref = M().doc(path), op = ctx.body.op;
    if (op === 'pin' || op === 'unpin') await ref.update({ pinned: op === 'pin' }); else if (op === 'hide') await ref.update({ deleted: true, text: '', hiddenBy: 'admin' }); else if (op === 'delete') await ref.delete(); else throw new HttpError(400, 'bad_op', 'Unknown op');
    await aud(ctx, 'msg_' + op, { path });
  }, [60, 60]);
}
