// Telegram control center for the CORE service. Owners = env OWNER_TG_IDS, admins = added by owners.
import { tg, cfg, guard, logs, roles, state } from './svc.js';
import { db } from './fb.js';
import { esc, kb, ladder, showIdToStrangers } from './tg.js';
import { env, HttpError } from './base.js';
import { callInternal } from './internal.js';
import { makeDomainUI } from './domreq.js';
import * as W from './wallet.js';
import * as D from './dataops.js';
import { archiveOld, purgeIpLogs, sendSnapshot } from './backup.js';
import { newKey, revokeKey } from './logkey.js';
import crypto from 'node:crypto';
import * as PA from './paneladmins.js';
import { hashSecret, envAccounts, MAX_PANEL_LOGINS } from './adminauth.js';

const audit = (a, actor, d) => logs.audit(a, actor, d);
const dom = makeDomainUI({ cfg, audit });
const onoff = (v) => (v ? '🟢 ON' : '🔴 OFF');
const BACK = [['⬅️ Menu', 'm:home']];
const OPNAME = { b: '💾 BACKUP', d: '🗑 DELETE', u: '📤 UPLOAD' };
const count = async (q) => { try { return (await q.count().get()).data().count; } catch { return '?'; } };
const lbl = (scope) => (scope === 'A' ? 'ALL users' : `user <code>${esc(scope)}</code>`);


// ---- panel logins (owner adds/removes admin-panel email + password + PIN from Telegram) ----
const PA_EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const genPw = () => crypto.randomBytes(15).toString('base64url');
const genPin = () => String(crypto.randomInt(0, 1e8)).padStart(8, '0');
const paPwPrompt = (email) => ({ text: `🔑 <b>Add panel login 2/3</b>\n<code>${esc(email)}</code>\n\nSend the <b>password</b> (12+ characters). I delete your message right after.\nOr tap 🎲 to generate a strong one.`, kb: kb([[['🎲 Generate password', 'pa:gp']], [['✖ Cancel', 'pa:l']]]) });
const paPinPrompt = (email) => ({ text: `🔢 <b>Add panel login 3/3</b>\n<code>${esc(email)}</code>\n\nSend the <b>PIN</b> (6–12 digits). I delete your message right after.\nOr tap 🎲 to generate one.`, kb: kb([[['🎲 Generate PIN', 'pa:gn']], [['✖ Cancel', 'pa:l']]]) });
const paConfirm = (email, n) => ladder({ n, total: 2, title: `Add panel login <code>${esc(email)}</code>?`, body: n === 1 ? 'Password and PIN are saved as hashes (nobody can read them later). This login works on the admin panel.' : 'Final check — is this the right email?', next: n === 1 ? 'pa:ok:2' : 'pa:ok:9', cancel: 'pa:l', danger: false });

const views = {
  async home(ctx) {
    const c = await cfg.get(), n = await dom.pendingCount().catch(() => 0);
    const rows = [
      [['📊 Stats', 'm:stats'], ['💸 Withdrawals', 'm:wd']],
      [['💰 Money data', 'm:money'], ['🏆 Match data', 'm:match']],
      [['👤 User data', 'm:user'], ['🔎 Find user', 'f:go']],
      [['🌐 Domains', 'dm:l'], [`📨 Requests${n ? ` (${n})` : ''}`, 'dr:l']],
      [['🛡 Security', 'm:sec'], ['📜 Logs', 'lg:new']],
      [[c.stopped ? '▶️ START SERVER' : '⏯ Server', 'm:srv']],
    ];
    if (ctx.owner) rows.push([['👑 Admins', 'adm:l']]);
    return { text: `🎮 <b>FF Control Center</b>\nRole: <b>${ctx.owner ? 'Owner' : 'Admin'}</b>\nServer: ${c.stopped ? '⛔ <b>STOPPED</b>' : c.maintenance ? '🟠 Maintenance' : '🟢 Running'}\n\n<b>Commands</b>\n/start /menu /help — this menu\n/logs — logs link + key\n/find &lt;gmail|phone|id&gt; — find user\n/user &lt;uid&gt; — user card\n/addbal &lt;uid&gt; dep|wd &lt;amt&gt; — add balance\n/cutbal &lt;uid&gt; dep|wd &lt;amt&gt; — cut balance\n/block &lt;ip&gt; [hours] • /unblock &lt;ip&gt;\n/stop • /startserver — server off / on\n/cancel — cancel current step\n\nChoose:`, kb: kb(rows) };
  },
  async stats() {
    const m = db.main(), c = await cfg.get();
    const [users, pend, deps, blocked] = await Promise.all([count(m.collection('users')), count(m.collection('withdraw_queue').where('status', '==', 'pending')), count(m.collection('deposit_requests').where('status', '==', 'pending')), count(m.collection('ip_blocks').where('until', '>', Date.now()))]);
    return { text: `📊 <b>Stats</b>\nUsers: <b>${users}</b>\nPending withdrawals: <b>${pend}</b>\nPending deposits: <b>${deps}</b>\nBlocked IPs: <b>${blocked}</b>\nMaintenance: ${onoff(c.maintenance)}`, kb: kb([[['🔄 Refresh', 'm:stats']], BACK]) };
  },
  async wd() {
    const list = await W.pendingWithdrawals(6);
    if (!list.length) return { text: '💸 No pending withdrawals ✅', kb: kb([[['🔄 Refresh', 'm:wd']], BACK]) };
    return { text: `💸 <b>Pending withdrawals</b> (${list.length})`, kb: kb([...list.map((t) => [[`₹${String(t.amount).replace(/[^\d.]/g, '')} • ${t.method} • ${(t.title || '').slice(-14)}`, `wd:v:${t.uid}:${t.trxId}`]]), BACK]) };
  },
  money: async () => ({ text: '💰 <b>Money data</b>\nPick a data set:', kb: kb([[['📥 Deposit history', 'c:dp'], ['📤 Withdrawal history', 'c:wd']], [['💰 Balance', 'c:bl'], ['🧾 Balance history', 'c:bh']], BACK]) }),
  match: async () => ({ text: '🏆 <b>Match data</b>\nPick a data set:', kb: kb([[['🏆 Match history', 'c:mh'], ['🎯 Match join', 'c:mj']], BACK]) }),
  user: async () => ({ text: '👤 <b>User data</b>\nPick a data set (or find one user first):', kb: kb([[['🎮 FF ID / name / gmail', 'c:ff'], ['👤 User name & all', 'c:ua']], [['🔎 Find user', 'f:go']], BACK]) }),
  async sec() {
    const c = await cfg.get();
    return { text: `🛡 <b>Security</b>\nGlobal limit: <b>${c.globalLimit}</b> req/min per IP\nLogin: ${c.loginIpMax} wrong tries → ${c.loginBlockHours}h IP block\nWithdraw fee ₹${c.withdrawFee} • min ₹${c.withdrawMin}`, kb: kb([[['🚫 Blocked IPs', 'm:ips'], ['⚙️ Switches', 'm:set']], [['🗄 System archive / snapshot', 'm:bak']], BACK]) };
  },
  async ips() {
    const l = await guard.list();
    return { text: l.length ? '🚫 <b>Blocked IPs</b>\n' + l.map((x) => `<code>${esc(x.ip)}</code> until ${new Date(x.until).toLocaleString('en-IN')}`).join('\n') : '🚫 No blocked IPs ✅', kb: kb([...l.map((x) => [[`✅ Unblock ${x.ip}`, 'ip:u:' + x.ip]]), [['⬅️ Security', 'm:sec']]]) };
  },
  async set() {
    const c = await cfg.get();
    return { text: `⚙️ <b>Switches</b>`, kb: kb([[[`Maintenance ${onoff(c.maintenance)}`, 'set:maint']], [[`Withdraw ${onoff(c.withdrawEnabled)}`, 'set:withdrawEnabled'], [`Deposit ${onoff(c.depositEnabled)}`, 'set:depositEnabled']], [[`Join ${onoff(c.joinEnabled)}`, 'set:joinEnabled']], [['Limit 60', 'lim:60'], ['120', 'lim:120'], ['240', 'lim:240']], [['⬅️ Security', 'm:sec']]]) };
  },
  bak: async () => ({ text: '🗄 <b>System jobs</b>\n• Archive: transactions older than 30 days → archive DB (verified) → removed from main.\n• Snapshot: balances + deposits + audit as .json.gz here.\n(Automatic: daily archive, weekly snapshot)', kb: kb([[['🗄 Run archive now', 'bak:run'], ['📦 Send snapshot', 'bak:snap']], [['⬅️ Security', 'm:sec']]]) }),
  async srv() {
    const c = await cfg.get();
    return { text: `⏯ <b>Server control</b>\nStatus: ${c.stopped ? '⛔ <b>STOPPED</b> — every request gets an error page' : '🟢 <b>RUNNING</b>'}\n\n/stop = stop • /startserver = start\n(applies to core + chat, takes up to ~30 s)`, kb: kb([[c.stopped ? ['▶️ Start server', 'srv:start:1'] : ['⛔ Stop server', 'srv:stop:1']], BACK]) };
  },
  async pa() {
    const l = PA.list(), e = envAccounts();
    return { text: `🔑 <b>Admin panel logins</b>\nAdded here: <b>${l.length}/${MAX_PANEL_LOGINS}</b>\n${l.map((a) => `• ${esc(a.email)}`).join('\n') || '—'}${e.length ? `\n\n<b>From server env</b> (permanent, change in Render)\n${e.map((a) => `• ${esc(a.email)}`).join('\n')}` : ''}\n\nWrong-password rules: 5 tries → IP blocked 24h • 10 tries on one login → that login locked 24h (/unlockadmin &lt;email&gt;).`,
      kb: kb([...(l.length < MAX_PANEL_LOGINS ? [[['➕ Add login', 'pa:add']]] : []), ...l.map((a) => [[`🗑 Delete ${a.email}`.slice(0, 60), `pa:d:${a.sid}:1`]]), [['⬅️ Admins', 'adm:l']]]) };
  },
  async adm(ctx) {
    const r = await roles.get();
    return { text: `👑 <b>Owners</b>\n${r.owners.map((x) => `• <code>${x}</code>`).join('\n') || '—'}\n\n<b>Admins</b>\n${r.admins.map((x) => `• <code>${x}</code>`).join('\n') || '—'}`, kb: kb([[['➕ Add admin', 'adm:add'], ['🔑 Panel logins', 'pa:l']], ...r.admins.map((x) => [[`🗑 Remove ${x}`, `adm:rm:${x}:1`]]), BACK]) };
  },
};

function catScreen(cat) {
  const C = D.CATS[cat], back = ['dp', 'wd', 'bl', 'bh'].includes(cat) ? 'm:money' : ['mh', 'mj'].includes(cat) ? 'm:match' : 'm:user';
  return { text: `${C.icon} <b>${C.title}</b>\n${D.NOTES[cat]?.d || ''}\n\nEvery action asks 2–3 confirmations.`, kb: kb([[['💾 Backup', `x:${cat}:b:?`], ['🗑 Delete', `x:${cat}:d:?`], ['📤 Upload', `x:${cat}:u:?`]], [['⬅️ Back', back]]]) };
}

async function userCard(uid) {
  const s = await db.main().collection('users').doc(uid).get(); if (!s.exists) return { text: 'User not found', kb: kb([BACK]) };
  const u = s.data(), banned = W.isBanned(u);
  return { text: `👤 <b>${esc(u.appName)}</b> ${banned ? '🚫 BANNED' : ''}\nID: <code>${esc(u.playerId)}</code>\nGmail: ${esc(u.email)}\nPhone: ${esc(u.phone || '-')}\nFF: ${esc(u.gameName || '-')} / <code>${esc(u.gameUid || '-')}</code>\nDeposit ₹${W.depBal(u)} • Withdraw ₹${W.wdBal(u)}\nLifetime dep ₹${u.totalDeposited || 0} • wd ₹${u.totalWithdrawn || 0}\nUID: <code>${esc(uid)}</code>\n\nBalance: <code>/addbal ${esc(uid)} dep 50</code>`, kb: kb([[['💾 Backup ▸', `uo:${uid}:b`], ['🗑 Delete ▸', `uo:${uid}:d`], ['📤 Upload ▸', `uo:${uid}:u`]], [[banned ? '✅ Unban' : '🚫 Ban', `ban:1:${uid}:${banned ? 0 : 1}`]], [['🔎 Find another', 'f:go']], BACK]) };
}
const userOp = (uid, op) => ({ text: `${OPNAME[op]} — pick data for user <code>${esc(uid)}</code>`, kb: kb([...Object.entries(D.CATS).filter(([k]) => !(k === 'ua' && op === 'u' && false)).map(([k, C]) => [[`${C.icon} ${C.title}`, `x:${k}:${op}:${op === 'u' ? 'f' : 1}:${uid}`]]), [['⬅️ Back', `uc:${uid}`]]]) });

async function wdView(uid, tid) {
  const t = (await db.main().collection('users').doc(uid).collection('transactions').doc(tid).get()).data();
  if (!t) return { text: 'Not found', kb: kb([BACK]) };
  const det = t.method === 'BANK' ? `${esc(t.accountName)}\nA/c <code>${esc(t.accountNumber)}</code>\nIFSC <code>${esc(t.ifsc)}</code>` : `${esc(t.coin)} • ${esc(t.network)}\n<code>${esc(t.walletAddress)}</code>`, s = t.snapshot || {};
  const k = t.status === 'pending' ? [[['✅ Approve', `wd:a:${uid}:${tid}`], ['↩️ Refund', `wd:r:${uid}:${tid}`]], [['❌ Reject (no refund)', `wd:x:${uid}:${tid}`]], [['⬅️ Back', 'm:wd']]] : [[['⬅️ Back', 'm:wd']]];
  return { text: `💸 <b>Withdrawal</b> — ${esc(t.status)}\nAmount: <b>${esc(t.amount)}</b> (net ${esc(t.net)})\nMethod: ${esc(t.method)}\n${det}\n\nBefore: dep ₹${s.depositBalance ?? '?'} • wd ₹${s.withdrawBalance ?? '?'}\nLifetime deposited ₹${s.totalDeposited ?? 0} • withdrawn ₹${s.totalWithdrawn ?? 0}\nIP: <code>${esc(t.ip || '-')}</code>\nUser: <code>${esc(uid)}</code>`, kb: kb(k) };
}

// ---------- data actions: backup / delete / upload with confirmation ladder ----------
async function xFlow(cat, op, step, scope, ctx) {
  const C = D.CATS[cat]; if (!C) return { text: 'Unknown data set', kb: kb([BACK]) };
  if (scope === 'A' && op !== 'b' && !ctx.owner) return { text: '🔒 Only owners can run bulk delete/upload. Use <b>Find user</b> for one user.', kb: kb([[['🔎 Find user', 'f:go']], BACK]) };
  if (step === '?') {
    const rows = [];
    if (!(cat === 'ua' && op === 'd') && (op === 'b' || ctx.owner)) rows.push([['🌍 All users', `x:${cat}:${op}:${op === 'u' ? 'f' : 1}:A`]]);
    rows.push([['👤 One user (search)', `x:${cat}:${op}:find:?`]], [['⬅️ Back', `c:${cat}`]]);
    return { text: `${OPNAME[op]} • ${C.icon} <b>${C.title}</b>\nWho is it for?${cat === 'ua' && op === 'd' ? '\n<i>Deleting all users is disabled for safety.</i>' : ''}`, kb: kb(rows) };
  }
  if (step === 'find') { await state.set(ctx.chatId, { mode: 'find', next: { cat, op } }); return { text: '🔎 Send the user\'s <b>gmail</b>, <b>phone</b>, <b>player ID</b>, <b>FF UID</b> or <b>app UID</b>.\n/cancel to abort.', kb: kb([[['✖ Cancel', 'm:home']]]) }; }
  if (op === 'u' && step === 'f') { await state.set(ctx.chatId, { mode: 'file', cat, scope }); return { text: `📤 Send the backup file for <b>${C.title}</b> (${lbl(scope)}) now.\nFormat: .json or .json.gz made by this bot • max 20 MB.\n/cancel to abort.`, kb: kb([[['✖ Cancel', 'm:home']]]) }; }
  const total = op === 'b' ? 2 : 3, title = `${OPNAME[op]} • ${C.icon} ${C.title} • ${lbl(scope)}`;
  if (step !== 'run') {
    const n = Number(step); let body = '';
    const st = op === 'u' ? await state.get(ctx.chatId) : null;
    if (op === 'u' && (!st || st.mode !== 'file' || st.cat !== cat || st.scope !== scope || !st.fileId)) return { text: 'No file received. Start the upload again.', kb: kb([[['⬅️ Back', `c:${cat}`]]]) };
    if (n === 1) body = op === 'b' ? 'A backup file will be sent to this chat.' : op === 'd' ? `${D.NOTES[cat]?.d || ''}\nA backup file is sent first.` : `File: <b>${st.count}</b> records, made ${new Date(st.createdAt).toLocaleString('en-IN')}.\nMatching records will be overwritten.`;
    if (n === 2) body = op === 'u' ? `Restore ${st.count} records into ${lbl(scope)}?` : `About <b>${await D.countData(cat, scope)}</b> records.${op === 'd' ? '\nIf the backup cannot be sent, nothing is deleted.' : ''}`;
    if (n === 3) body = op === 'd' ? `Backup first, then <b>delete</b> ${C.title} for ${lbl(scope)}.` : `Restore <b>${st.count}</b> records now.`;
    return ladder({ n, total, title, body, next: n < total ? `x:${cat}:${op}:${n + 1}:${scope}` : `x:${cat}:${op}:run:${scope}`, cancel: 'm:home', danger: op !== 'b' });
  }
  const actor = 'tg:' + ctx.from;
  if (op === 'b') { await ctx.show({ text: '⏳ Preparing backup…', kb: kb([BACK]) }); const r = await D.sendBackup(tg, ctx.chatId, cat, scope); await audit('backup_' + cat, actor, { scope, ...r }); return { text: `✅ Backup sent • ${r.count} records • ${r.parts} file(s)`, kb: kb([[['⬅️ ' + C.title, `c:${cat}`]], BACK]) }; }
  if (op === 'd') {
    await ctx.show({ text: '⏳ Sending backup first…', kb: kb([BACK]) });
    const b = await D.sendBackup(tg, ctx.chatId, cat, scope, 'pre-delete backup');
    await ctx.show({ text: `✅ Backup sent (${b.count} records). ⏳ Deleting…`, kb: kb([BACK]) });
    const r = await D.deleteData(cat, scope, Date.now() + 45000); await audit('delete_' + cat, actor, { scope, ...r });
    return { text: `🗑 Deleted ${r.deleted} record(s)${r.partial ? '\n⚠️ Stopped early (time limit). Run Delete again to continue.' : ''}\nBackup file is above ☝️`, kb: kb([[['⬅️ ' + C.title, `c:${cat}`]], BACK]) };
  }
  const st = await state.get(ctx.chatId);
  if (!st || st.mode !== 'file' || st.cat !== cat || st.scope !== scope) return { text: 'Upload expired. Start again.', kb: kb([BACK]) };
  const file = await D.parseBackupFile(await tg.download(st.fileId), cat);
  if (JSON.stringify(file.docs).length === 0 || file.docs.length !== st.count) throw new HttpError(409, 'changed', 'File changed. Start again.');
  await ctx.show({ text: '⏳ Restoring…', kb: kb([BACK]) });
  const r = await D.restoreData(cat, scope, file); await state.clear(ctx.chatId); await audit('restore_' + cat, actor, { scope, ...r });
  return { text: `📤 Restored ${r.written} record(s) • skipped ${r.skipped}`, kb: kb([[['⬅️ ' + C.title, `c:${cat}`]], BACK]) };
}

async function afterFind(uid, st, ctx) {
  await state.clear(ctx.chatId);
  if (st?.next) return xFlow(st.next.cat, st.next.op, st.next.op === 'u' ? 'f' : '1', uid, ctx);
  return userCard(uid);
}

export async function handleUpdate(u) {
  const msg = u.message, cb = u.callback_query, from = (msg || cb)?.from;
  if (!from) return;
  const dbgText = String(msg?.text || cb?.data || '').slice(0, 80);
  console.log('[tg:core] update', u.update_id, 'from', from.id, from.username ? '@' + from.username : '', JSON.stringify(dbgText));
  if (!(await roles.isAdmin(from.id))) {
    console.warn('[tg:core] NOT ADMIN', from.id, from.username || '', JSON.stringify(dbgText));
    const cid = (msg?.chat || cb?.message?.chat)?.id;
    if (cid && showIdToStrangers()) await tg.send(cid, `⛔ <b>Access denied</b>\nYou are not an admin of this bot.\nYour Telegram ID: <code>${from.id}</code>`).catch(() => {});
    return;
  }
  try { if (u.update_id && !(await state.claim('upd' + u.update_id))) { console.log('[tg:core] duplicate update skipped', u.update_id); return; } }
  catch (e) { console.error('[tg:core] state.claim failed (Firestore?)', e.message); }
  const chatId = (msg?.chat || cb?.message?.chat).id, mid = cb?.message?.message_id, owner = await roles.isOwner(from.id);
  const show = async (v) => { if (cb) { const r = await tg.edit(chatId, mid, v.text, v.kb); if (r.ok === false && !/not modified/.test(r.description || '')) await tg.send(chatId, v.text, v.kb); } else await tg.send(chatId, v.text, v.kb); };
  const ctx = { from: from.id, chatId, owner, show, state, actor: 'tg:' + from.id };
  const say = (t, k) => tg.send(chatId, t, k);
  const home = () => views.home(ctx);

  try {
    // ---------------- callbacks ----------------
    if (cb) {
      const parts = cb.data.split(':'), ns = parts[0], act = parts[1], rest = parts.slice(2);
      await tg.answer(cb.id);
      if (ns === 'm') return show(await views[act](ctx));
      if (ns === 'c') return show(catScreen(act));
      if (ns === 'x') return show(await xFlow(act, rest[0], rest[1], rest[2], ctx));
      if (ns === 'f' && act === 'go') { await state.set(chatId, { mode: 'find', next: null }); return show({ text: '🔎 Send the user\'s <b>gmail</b>, <b>phone</b>, <b>player ID</b>, <b>FF UID</b> or <b>app UID</b>.\n/cancel to abort.', kb: kb([[['✖ Cancel', 'm:home']]]) }); }
      if (ns === 'uc') return show(await userCard(act));
      if (ns === 'uo') return show(userOp(act, rest[0]));
      const dv = await dom.cb(ns, act, rest, ctx); if (dv) return show(dv);
      if (ns === 'wd') {
        const [uid, tid] = rest;
        if (act === 'v') return show(await wdView(uid, tid));
        const names = { a: ['approve', 'APPROVE (mark paid)'], r: ['refund', 'REFUND (return money to user)'], x: ['reject', 'REJECT (no refund)'] };
        if (names[act]) return show({ text: `⚠️ Confirm <b>${names[act][1]}</b>?`, kb: kb([[['✅ Yes', `wd:${act.toUpperCase()}:${uid}:${tid}`], ['⬅️ Cancel', `wd:v:${uid}:${tid}`]]]) });
        const dec = { A: 'approve', R: 'refund', X: 'reject' }[act];
        if (dec) { const out = await W.decideWithdraw({ uid, trxId: tid, decision: dec, actor: ctx.actor }); await audit('withdraw_' + dec, ctx.actor, { uid, trxId: tid, ...out }); return show({ text: `✅ ${dec.toUpperCase()} done • ₹${out.amount} • ${out.order}`, kb: kb([[['💸 Pending list', 'm:wd']], BACK]) }); }
      }
      if (ns === 'ip' && act === 'u') { const ip = rest.join(':'); await guard.unblock(ip); await audit('unblock', ctx.actor, { ip }); return show({ text: `✅ Unblocked <code>${esc(ip)}</code>`, kb: kb([BACK]) }); }
      if (ns === 'set') { const k = act === 'maint' ? 'maintenance' : act, c = await cfg.get(); await cfg.set({ [k]: !c[k] }); await audit('setting', ctx.actor, { k }); return show(await views.set()); }
      if (ns === 'lim') { await cfg.set({ globalLimit: Number(act) }); return show(await views.set()); }
      if (ns === 'bak') {
        if (act === 'run') { await show({ text: '⏳ Archiving…', kb: kb([BACK]) }); const a = await archiveOld({}), p = await purgeIpLogs(); return show({ text: `✅ Archived ${a.archived} tx • purged ${p} IP logs`, kb: kb([BACK]) }); }
        if (act === 'snap') { await show({ text: '⏳ Building snapshot…', kb: kb([BACK]) }); const n = await sendSnapshot(tg, await roles.recipients()); return show({ text: `✅ Snapshot sent (${n} chat)`, kb: kb([BACK]) }); }
      }
      if (ns === 'lg') {
        if (act === 'off') { await revokeKey(); return show({ text: '🗑 Logs key revoked.', kb: kb([BACK]) }); }
        const { key, exp } = await newKey(from.id), url = (env('PUBLIC_BASE_URL') || '').replace(/\/+$/, '') + '/logs';
        await audit('logs_key', ctx.actor, {});
        return show({ text: `📜 <b>Server logs</b>\n\n🔗 Link:\n${esc(url)}\n\n🔑 Key:\n<code>${esc(key)}</code>\n\n⏱ Valid for 10 minutes (until ${new Date(exp).toLocaleTimeString('en-IN')}). Open the link and enter the key.`, kb: kb([[['🔁 New key', 'lg:new'], ['🗑 Revoke', 'lg:off']], BACK]) });
      }
      if (ns === 'bal') {                                            // bal:<step>:<uid>:<t>:<amt>
        const step = Number(act), [uid, t, amt] = rest, a = Number(amt), what = `${a > 0 ? 'ADD' : 'CUT'} ₹${Math.abs(a)} ${t === 'd' ? 'deposit' : 'withdraw'} balance of <code>${esc(uid)}</code>`;
        if (step < 9) return show(ladder({ n: step, total: 2, title: what + '?', next: step === 1 ? `bal:2:${uid}:${t}:${amt}` : `bal:9:${uid}:${t}:${amt}`, danger: false }));
        const out = await W.adjustBalance({ uid, type: t === 'd' ? 'deposit' : 'withdraw', amount: a, reason: 'Admin (Telegram)', actor: ctx.actor }); await audit('balance_adjust', ctx.actor, { uid, t, amt: a, ...out });
        return show({ text: `✅ ${esc(out.name)}: ₹${out.before} → ₹${out.after}`, kb: kb([[['👤 User', `uc:${uid}`]], BACK]) });
      }
      if (ns === 'ban') {                                            // ban:<step>:<uid>:<1|0>
        const step = Number(act), [uid, flag] = rest;
        if (step < 9) return show(ladder({ n: step, total: 2, title: `${flag === '1' ? '🚫 BAN' : '✅ UNBAN'} <code>${esc(uid)}</code>?`, body: flag === '1' ? 'The user is logged out and cannot play, deposit or withdraw.' : '', next: step === 1 ? `ban:2:${uid}:${flag}` : `ban:9:${uid}:${flag}`, danger: false }));
        await W.setBan(uid, flag === '1'); await audit(flag === '1' ? 'ban' : 'unban', ctx.actor, { uid });
        return show({ text: flag === '1' ? '🚫 Banned' : '✅ Unbanned', kb: kb([[['👤 User', `uc:${uid}`]], BACK]) });
      }
      if (ns === 'srv') {
        const n = Number(rest[0]);
        if (act === 'stop') {
          if (n < 9) return show(ladder({ n, total: 3, title: '⛔ <b>STOP THE SERVER</b>', body: ['', 'Every app / admin request will get an error page.', 'Users cannot login, play, deposit or withdraw.', 'Last check. You can start it again from this bot.'][n], next: `srv:stop:${n === 3 ? 9 : n + 1}` }));
          await cfg.set({ stopped: true }); try { await callInternal(env('CHAT_BASE_URL'), '/internal/set-stopped', { stopped: true }); } catch (e) { console.warn('chat stop', e.message); }
          await audit('server_stop', ctx.actor, {}); return show({ text: '⛔ <b>Server stopped</b> (within ~30 s everywhere).\nUse the button or /startserver to start again.', kb: kb([[['▶️ Start server', 'srv:start:1']], BACK]) });
        }
        if (act === 'start') {
          if (n < 9) return show(ladder({ n: 1, total: 1, title: '▶️ Start the server again?', next: 'srv:start:9', danger: false }));
          await cfg.set({ stopped: false }); try { await callInternal(env('CHAT_BASE_URL'), '/internal/set-stopped', { stopped: false }); } catch (e) { console.warn('chat start', e.message); }
          await audit('server_start', ctx.actor, {}); return show({ text: '🟢 <b>Server started</b>', kb: kb([BACK]) });
        }
      }
      if (ns === 'pa') {                                             // owner only: panel logins
        if (!owner) return show({ text: '🔒 Owner only.', kb: kb([BACK]) });
        if (act === 'l') { await PA.load(); return show(await views.pa()); }
        if (act === 'add') {
          await PA.load(); if (PA.list().length >= MAX_PANEL_LOGINS) return show({ text: `❌ Limit reached (${MAX_PANEL_LOGINS}). Delete one first.`, kb: kb([[['🔑 Panel logins', 'pa:l']]]) });
          await state.set(chatId, { mode: 'pa_email' });
          return show({ text: '🔑 <b>Add panel login 1/3</b>\nSend the <b>email</b> for the new admin login (any email; it is only used to log in to the panel).\n/cancel to abort.', kb: kb([[['✖ Cancel', 'pa:l']]]) });
        }
        if (act === 'gp') {
          const st = await state.get(chatId); if (!st || st.mode !== 'pa_pw') return show({ text: 'Expired. Start again.', kb: kb([[['🔑 Panel logins', 'pa:l']]]) });
          const pw = genPw(), h = await hashSecret(pw);
          await state.set(chatId, { mode: 'pa_pin', email: st.email, salt: h.salt, pw: h.hash });
          await say(`🎲 <b>Generated password</b> for <code>${esc(st.email)}</code>\n<code>${esc(pw)}</code>\n\nSave it in your password manager now — I cannot show it again. Then delete this message.`);
          return show(paPinPrompt(st.email));
        }
        if (act === 'gn') {
          const st = await state.get(chatId); if (!st || st.mode !== 'pa_pin') return show({ text: 'Expired. Start again.', kb: kb([[['🔑 Panel logins', 'pa:l']]]) });
          const pin = genPin(), h = await hashSecret(pin);
          await state.set(chatId, { mode: 'pa_c', email: st.email, salt: st.salt, pw: st.pw, pinSalt: h.salt, pin: h.hash });
          await say(`🎲 <b>Generated PIN</b> for <code>${esc(st.email)}</code>\n<code>${esc(pin)}</code>\n\nSave it now — I cannot show it again. Then delete this message.`);
          return show(paConfirm(st.email, 1));
        }
        if (act === 'ok') {
          const st = await state.get(chatId), n = Number(rest[0]); if (!st || st.mode !== 'pa_c') return show({ text: 'Expired. Start again.', kb: kb([[['🔑 Panel logins', 'pa:l']]]) });
          if (n < 9) return show(paConfirm(st.email, n));
          const total = await PA.add({ email: st.email, salt: st.salt, pw: st.pw, pinSalt: st.pinSalt, pin: st.pin }, ctx.actor);
          await state.clear(chatId); await audit('panel_login_add', ctx.actor, { email: st.email });
          return show({ text: `✅ Panel login added: <code>${esc(st.email)}</code>\nTotal: ${total}/${MAX_PANEL_LOGINS}\n\nThey can log in to the admin panel now with this email + password + PIN.`, kb: kb([[['🔑 Panel logins', 'pa:l']], BACK]) });
        }
        if (act === 'd') {
          const sid = rest[0], n = Number(rest[1]), a = PA.list().find((x) => x.sid === sid);
          if (!a) return show({ text: 'Not found (already deleted?).', kb: kb([[['🔑 Panel logins', 'pa:l']]]) });
          if (n < 9) return show(ladder({ n, total: 2, title: `🗑 Delete panel login <code>${esc(a.email)}</code>?`, body: n === 1 ? 'This admin is logged out immediately and cannot log in again.' : 'Final check — delete this login?', next: n === 1 ? `pa:d:${sid}:2` : `pa:d:${sid}:9`, cancel: 'pa:l' }));
          const email = await PA.remove(sid); await audit('panel_login_delete', ctx.actor, { email });
          return show({ text: `🗑 Deleted panel login <code>${esc(email)}</code>`, kb: kb([[['🔑 Panel logins', 'pa:l']], BACK]) });
        }
        return;
      }
      if (ns === 'adm') {                                            // owner only
        if (!owner) return show({ text: '🔒 Owner only.', kb: kb([BACK]) });
        const syncChat = async (ids) => { try { await callInternal(env('CHAT_BASE_URL'), '/internal/admins-set', { ids }); } catch (e) { console.warn('chat admins', e.message); } };
        if (act === 'l') return show(await views.adm(ctx));
        if (act === 'add') { await state.set(chatId, { mode: 'adm_add' }); return show({ text: '➕ Send the new admin\'s <b>Telegram numeric ID</b> (they can get it from @userinfobot).\n/cancel to abort.', kb: kb([[['✖ Cancel', 'm:home']]]) }); }
        if (act === 'ad') {
          const st = await state.get(chatId), n = Number(rest[0]); if (!st || st.mode !== 'adm_add_c') return show({ text: 'Expired.', kb: kb([BACK]) });
          if (n < 9) return show(ladder({ n, total: 2, title: `Add admin <code>${esc(st.id)}</code>?`, body: n === 1 ? 'Admins can manage users, data and withdrawals (not other admins).' : 'Final check — is this the right person?', next: n === 1 ? 'adm:ad:2' : 'adm:ad:9', danger: false }));
          const r = await roles.get(), ids = [...r.admins, st.id]; await roles.setAdmins(ids); await syncChat(ids); await state.clear(chatId); await audit('admin_add', ctx.actor, { id: st.id });
          return show({ text: `✅ Admin added: <code>${esc(st.id)}</code>`, kb: kb([[['👑 Admins', 'adm:l']], BACK]) });
        }
        if (act === 'rm') {
          const id = rest[0], n = Number(rest[1]);
          if (n < 9) return show(ladder({ n, total: 2, title: `Remove admin <code>${esc(id)}</code>?`, next: n === 1 ? `adm:rm:${id}:2` : `adm:rm:${id}:9`, cancel: 'adm:l', danger: false }));
          const r = await roles.get(), ids = r.admins.filter((x) => x !== id); await roles.setAdmins(ids); await syncChat(ids); await audit('admin_remove', ctx.actor, { id });
          return show({ text: `🗑 Removed <code>${esc(id)}</code>`, kb: kb([[['👑 Admins', 'adm:l']], BACK]) });
        }
      }
      return;
    }

    // ---------------- file upload (restore) ----------------
    if (msg.document) {
      const st = await state.get(chatId);
      if (!st || st.mode !== 'file') return say('I was not waiting for a file. Open <b>Menu → data set → Upload</b> first.', kb([BACK]));
      if ((msg.document.file_size || 0) > 20 * 1024 * 1024) return say('❌ File is larger than 20 MB (Telegram bot limit).');
      const file = await D.parseBackupFile(await tg.download(msg.document.file_id), st.cat);
      await state.set(chatId, { ...st, fileId: msg.document.file_id, count: file.docs.length, createdAt: file.createdAt || Date.now() });
      return show(await xFlow(st.cat, 'u', '1', st.scope, ctx));
    }

    // ---------------- text / commands ----------------
    const text = (msg.text || '').trim(); if (!text) return;
    const [cmdRaw, ...args] = text.split(/\s+/), cmd = cmdRaw.startsWith('/') ? cmdRaw.split('@')[0].toLowerCase() : '';
    if (cmd === '/cancel') { await state.clear(chatId); return say('Cancelled.', (await home()).kb); }
    if (!cmd) {
      const st = await state.get(chatId);
      if (st?.mode === 'find') { const docs = await D.findUsers(text); if (!docs.length) return say('❌ No user found. Try gmail / phone / player ID / FF UID. /cancel to stop.'); if (docs.length > 1) return say('Several users matched:', kb([...docs.map((d) => [[`${d.data().appName} • ${d.data().email}`.slice(0, 50), `uc:${d.id}`]]), BACK])); return show(await afterFind(docs[0].id, st, ctx)); }
      if (st?.mode === 'dom_add') return show(await dom.onText(text, ctx));
      if (st?.mode === 'pa_email') {
        if (!owner) return;
        const em = text.toLowerCase(); if (!PA_EMAIL.test(em)) return say('❌ Send a valid email. /cancel to stop.');
        await PA.load(); if (envAccounts().some((a) => a.email === em) || PA.list().some((a) => a.email === em)) return say('❌ This email already has a panel login.');
        await state.set(chatId, { mode: 'pa_pw', email: em }); return show(paPwPrompt(em));
      }
      if (st?.mode === 'pa_pw' || st?.mode === 'pa_pin') {
        if (!owner) return;
        const gone = await tg.call('deleteMessage', { chat_id: chatId, message_id: msg.message_id }).catch(() => ({}));   // remove the secret from the chat
        const warn = gone.ok ? '' : '\n⚠️ I could not delete your message — please delete it yourself.';
        if (st.mode === 'pa_pw') {
          if (text.length < 12 || text.length > 128) return say('❌ Password must be 12–128 characters. Try again.' + warn);
          const h = await hashSecret(text); await state.set(chatId, { mode: 'pa_pin', email: st.email, salt: h.salt, pw: h.hash });
          return say('✅ Password saved (hidden).' + warn).then(() => show(paPinPrompt(st.email)));
        }
        if (!/^\d{6,12}$/.test(text)) return say('❌ PIN must be 6–12 digits. Try again.' + warn);
        const h = await hashSecret(text); await state.set(chatId, { mode: 'pa_c', email: st.email, salt: st.salt, pw: st.pw, pinSalt: h.salt, pin: h.hash });
        return say('✅ PIN saved (hidden).' + warn).then(() => show(paConfirm(st.email, 1)));
      }
      if (st?.mode === 'adm_add') { if (!owner) return; if (!/^\d{5,15}$/.test(text)) return say('❌ Send only the numeric Telegram ID.'); await state.set(chatId, { mode: 'adm_add_c', id: text }); return show(ladder({ n: 1, total: 2, title: `Add admin <code>${esc(text)}</code>?`, body: 'Admins can manage users, data and withdrawals (not other admins).', next: 'adm:ad:2', danger: false })); }
      if (st?.mode === 'file') return say('Please send the backup <b>file</b> (not text). /cancel to abort.');
      return show(await home());
    }
    if (['/start', '/menu', '/help'].includes(cmd)) return show(await home());
    if (cmd === '/logs') return show({ text: 'Tap to create a 10-minute key:', kb: kb([[['📜 Get logs link + key', 'lg:new']]]) });
    if (cmd === '/stop') return show(ladder({ n: 1, total: 3, title: '⛔ <b>STOP THE SERVER</b>', body: '', next: 'srv:stop:2' }));
    if (cmd === '/startserver' || cmd === '/resume') return show(ladder({ n: 1, total: 1, title: '▶️ Start the server again?', next: 'srv:start:9', danger: false }));
    if (cmd === '/find') { const docs = await D.findUsers(args.join(' ')); if (!docs.length) return say('❌ No user found'); return show(await userCard(docs[0].id)); }
    if (cmd === '/user' && args[0]) return show(await userCard(args[0]));
    if ((cmd === '/addbal' || cmd === '/cutbal') && args.length >= 3) {
      const [uid, t, a] = args, amt = Math.abs(Number(a)) * (cmd === '/cutbal' ? -1 : 1);
      if (!['dep', 'wd'].includes(t) || !amt) return say('Usage: <code>/addbal UID dep|wd AMOUNT</code>');
      return show(ladder({ n: 1, total: 2, title: `${amt > 0 ? 'ADD' : 'CUT'} ₹${Math.abs(amt)} ${t === 'dep' ? 'deposit' : 'withdraw'} balance of <code>${esc(uid)}</code>?`, next: `bal:2:${uid}:${t === 'dep' ? 'd' : 'w'}:${amt}`, danger: false }));
    }
    if (cmd === '/unlockadmin' && args[0]) { if (!owner) return say('⛔ Owner only.'); const em = args[0].trim().toLowerCase(); await guard.unlockEmail('admin:' + em); await audit('admin_unlock', ctx.actor, { email: em }); return say(`✅ Admin login unlocked: <code>${esc(em)}</code>`); }
    if (cmd === '/unblock' && args[0]) { await guard.unblock(args[0]); return say(`✅ Unblocked <code>${esc(args[0])}</code>`); }
    if (cmd === '/block' && args[0]) { await guard.block(args[0], (Number(args[1]) || 24) * 3600, 'manual'); return say(`🚫 Blocked <code>${esc(args[0])}</code> for ${Number(args[1]) || 24}h`); }
    return say('Use /start for the menu.');
  } catch (e) {
    if (!(e instanceof HttpError)) console.error('bot', e);
    await tg.send(chatId, `❌ ${esc(e.message)}`, kb([BACK]));
  }
}
