// Telegram control for the CHAT service. Owners = env OWNER_TG_IDS, admins synced from the core bot.
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { tg, cfg, guard, roles, state, logs } from './svc.js';
import { db } from './fb.js';
import { esc, kb, ladder } from './tg.js';
import { env, HttpError } from './base.js';
import { callInternal } from './internal.js';
import { makeDomainUI } from './domreq.js';
import { invalidateLatest, invalidateProfile } from './routes.js';
const gzip = promisify(zlib.gzip);
const BACK = [['⬅️ Menu', 'm:home']];
const onoff = (v) => (v ? '🟢 ON' : '🔴 OFF');
const dom = makeDomainUI({ cfg, audit: (a, actor, d) => logs.audit(a, actor, d) });

export async function exportOldMessages() {
  const c = await cfg.get(), cut = Date.now() - (c.retentionDays || 7) * 864e5, d = db.chat();
  const s = await d.collection('world_messages').where('createdAt', '<', cut).orderBy('createdAt').limit(1500).get();
  if (s.empty) return 0;
  const buf = await gzip(JSON.stringify(s.docs.map((x) => ({ id: x.id, ...x.data() })))); let ok = 0;
  for (const id of await roles.recipients()) { const r = await tg.sendDoc(id, `world-chat-${new Date().toISOString().slice(0, 10)}.json.gz`, buf, `Chat backup • ${s.size} messages`); if (r.ok) ok++; }
  if (!ok) throw new Error('telegram backup failed — nothing deleted');           // never delete unless a backup landed
  const b = d.batch(); s.docs.forEach((x) => b.delete(x.ref)); await b.commit(); invalidateLatest(); return s.size;
}

const views = {
  async home() {
    const c = await cfg.get(), n = await dom.pendingCount().catch(() => 0);
    return { text: `💬 <b>FF Chat Control</b>\nServer: ${c.stopped ? '⛔ <b>STOPPED</b>' : c.maintenance ? '🟠 Maintenance' : '🟢 Running'}\n\n<b>Commands</b>\n/start /menu /help — this menu\n/cban &lt;uid&gt; [min] • /cunban &lt;uid&gt; — mute / unmute\n/delmsg &lt;id&gt; — delete message\n/addword &lt;w&gt; • /rmword &lt;w&gt; — blocked words\n/unblock &lt;ip&gt; — unblock IP\n/stop • /startserver — chat server off / on\n/cancel — cancel current step`, kb: kb([[['📊 Stats', 'm:stats'], ['💬 Recent messages', 'm:msgs']], [['🧱 Words', 'm:words'], ['⚙️ Settings', 'm:set']], [['🌐 Domains', 'dm:l'], [`📨 Requests${n ? ` (${n})` : ''}`, 'dr:l']], [['💾 Backup', 'm:bak'], ['🔗 Core link', 'm:link']], [[c.stopped ? '▶️ START chat server' : '⏯ Server', 'm:srv']]]) };
  },
  async stats() {
    const d = db.chat(), n = async (q) => { try { return (await q.count().get()).data().count; } catch { return '?'; } };
    const [p, m, h] = await Promise.all([n(d.collection('profiles')), n(d.collection('world_messages')), n(d.collection('world_messages').where('createdAt', '>', Date.now() - 36e5))]);
    return { text: `📊 <b>Chat stats</b>\nProfiles: <b>${p}</b>\nStored messages: <b>${m}</b>\nLast hour: <b>${h}</b>`, kb: kb([[['🔄 Refresh', 'm:stats']], BACK]) };
  },
  async msgs() {
    const s = await db.chat().collection('world_messages').orderBy('createdAt', 'desc').limit(6).get();
    if (s.empty) return { text: '💬 No messages', kb: kb([BACK]) };
    return { text: '💬 <b>Recent</b>\n' + s.docs.map((x) => `• <b>${esc(x.data().name)}</b>: ${esc(x.data().text).slice(0, 80)}`).join('\n'), kb: kb([...s.docs.map((x) => [[`🗑 ${String(x.data().text).slice(0, 18)}`, 'cm:del:' + x.id], ['🔇 Mute 1h', `cm:mute:${x.data().uid}`]]), [['🔄 Refresh', 'm:msgs']], BACK]) };
  },
  async words() { const c = await cfg.get(); return { text: `🧱 <b>Blocked words</b>\n${(c.badWords || []).map(esc).join(', ') || '—'}\n\n<code>/addword word</code> • <code>/rmword word</code>`, kb: kb([BACK]) }; },
  async set() { const c = await cfg.get(); return { text: `⚙️ <b>Settings</b>\nWorld chat ${onoff(c.worldEnabled)} • Links blocked ${onoff(c.blockLinks)}\nMax length ${c.msgMaxLen} • Keep ${c.retentionDays} days • Limit ${c.globalLimit}/min`, kb: kb([[[`Maintenance ${onoff(c.maintenance)}`, 'set:maintenance']], [[`World chat ${onoff(c.worldEnabled)}`, 'set:worldEnabled'], [`Block links ${onoff(c.blockLinks)}`, 'set:blockLinks']], [['Limit 60', 'lim:60'], ['120', 'lim:120'], ['240', 'lim:240']], BACK]) }; },
  bak: async () => ({ text: '💾 <b>Backup</b>\nMessages older than the retention days are sent here as .json.gz, then deleted (only if the file was delivered). Runs daily.', kb: kb([[['📦 Run now', 'bak:run']], BACK]) }),
  async link() {
    let t; const s = Date.now();
    try { await callInternal(env('CORE_BASE_URL'), '/internal/ping', {}); t = `🟢 Core service OK (${Date.now() - s} ms)`; } catch (e) { t = `🔴 Core unreachable: ${esc(e.message)}`; }
    return { text: `🔗 <b>Service link</b>\n${t}`, kb: kb([[['🔄 Check again', 'm:link']], BACK]) };
  },
  async srv() { const c = await cfg.get(); return { text: `⏯ <b>Chat server</b>\n${c.stopped ? '⛔ STOPPED' : '🟢 RUNNING'}\n(The core bot\'s Stop/Start also controls this service.)`, kb: kb([[c.stopped ? ['▶️ Start', 'srv:start:1'] : ['⛔ Stop', 'srv:stop:1']], BACK]) }; },
};

export async function handleUpdate(u) {
  const msg = u.message, cb = u.callback_query, from = (msg || cb)?.from;
  if (!from) return;
  const dbgText = String(msg?.text || cb?.data || '').slice(0, 80);
  console.log('[tg:chat] update', u.update_id, 'from', from.id, from.username ? '@' + from.username : '', JSON.stringify(dbgText));
  if (!(await roles.isAdmin(from.id))) {
    console.warn('[tg:chat] NOT ADMIN', from.id, from.username || '', JSON.stringify(dbgText));
    const cid = (msg?.chat || cb?.message?.chat)?.id;
    if (cid) await tg.send(cid, `⛔ <b>Access denied</b>\nYou are not an admin of this bot.\nYour Telegram ID: <code>${from.id}</code>`).catch(() => {});
    return;
  }
  try { if (u.update_id && !(await state.claim('cupd' + u.update_id))) { console.log('[tg:chat] duplicate update skipped', u.update_id); return; } }
  catch (e) { console.error('[tg:chat] state.claim failed (Firestore?)', e.message); }
  const chatId = (msg?.chat || cb?.message?.chat).id, mid = cb?.message?.message_id, actor = 'tg:' + from.id;
  const show = async (v) => { if (cb) { const r = await tg.edit(chatId, mid, v.text, v.kb); if (r.ok === false && !/not modified/.test(r.description || '')) await tg.send(chatId, v.text, v.kb); } else await tg.send(chatId, v.text, v.kb); };
  const say = (t, k) => tg.send(chatId, t, k);
  const ctx = { actor, state, chatId };
  const muteUser = async (uid, minutes) => { await db.chat().collection('profiles').doc(uid).set({ chatBanUntil: minutes === 0 ? 9e15 : Date.now() + minutes * 60000 }, { merge: true }); invalidateProfile(uid); };
  try {
    if (cb) {
      const parts = cb.data.split(':'), ns = parts[0], act = parts[1], rest = parts.slice(2);
      await tg.answer(cb.id);
      if (ns === 'm') return show(await views[act]());
      const dv = await dom.cb(ns, act, rest, ctx); if (dv) return show(dv);
      if (ns === 'cm' && act === 'del') { await db.chat().collection('world_messages').doc(rest[0]).delete(); invalidateLatest(); return show(await views.msgs()); }
      if (ns === 'cm' && act === 'mute') { await muteUser(rest[0], 60); return show({ text: `🔇 Muted <code>${esc(rest[0])}</code> for 1h`, kb: kb([[['💬 Back', 'm:msgs']], BACK]) }); }
      if (ns === 'set') { const c = await cfg.get(); await cfg.set({ [act]: !c[act] }); return show(await views.set()); }
      if (ns === 'lim') { await cfg.set({ globalLimit: Number(act) }); return show(await views.set()); }
      if (ns === 'bak' && act === 'run') { await show({ text: '⏳ Exporting…', kb: kb([BACK]) }); const n = await exportOldMessages(); return show({ text: `✅ Exported & removed ${n} messages`, kb: kb([BACK]) }); }
      if (ns === 'srv') {
        const n = Number(rest[0]);
        if (act === 'stop') { if (n < 9) return show(ladder({ n, total: 3, title: '⛔ <b>STOP the chat server</b>', next: `srv:stop:${n === 3 ? 9 : n + 1}` })); await cfg.set({ stopped: true }); await logs.audit('server_stop', actor, {}); return show({ text: '⛔ Chat server stopped.', kb: kb([[['▶️ Start', 'srv:start:1']], BACK]) }); }
        if (act === 'start') { if (n < 9) return show(ladder({ n: 1, total: 1, title: '▶️ Start the chat server?', next: 'srv:start:9', danger: false })); await cfg.set({ stopped: false }); await logs.audit('server_start', actor, {}); return show({ text: '🟢 Chat server started.', kb: kb([BACK]) }); }
      }
      return;
    }
    const text = (msg.text || '').trim(); if (!text) return;
    const [cmdRaw, ...args] = text.split(/\s+/), cmd = cmdRaw.startsWith('/') ? cmdRaw.split('@')[0].toLowerCase() : '';
    if (cmd === '/cancel') { await state.clear(chatId); return say('Cancelled.', (await views.home()).kb); }
    if (!cmd) { const st = await state.get(chatId); if (st?.mode === 'dom_add') return show(await dom.onText(text, ctx)); return show(await views.home()); }
    if (['/start', '/menu', '/help'].includes(cmd)) return show(await views.home());
    if (cmd === '/stop') return show(ladder({ n: 1, total: 3, title: '⛔ <b>STOP the chat server</b>', next: 'srv:stop:2' }));
    if (cmd === '/startserver' || cmd === '/resume') return show(ladder({ n: 1, total: 1, title: '▶️ Start the chat server?', next: 'srv:start:9', danger: false }));
    if (cmd === '/cban' && args[0]) { const m = Number(args[1]); await muteUser(args[0], Number.isFinite(m) ? m : 0); return say(`🔇 Muted <code>${esc(args[0])}</code> ${m ? m + ' min' : 'permanently'}`); }
    if (cmd === '/cunban' && args[0]) { await db.chat().collection('profiles').doc(args[0]).set({ chatBanUntil: 0 }, { merge: true }); invalidateProfile(args[0]); return say('✅ Unmuted'); }
    if (cmd === '/delmsg' && args[0]) { await db.chat().collection('world_messages').doc(args[0]).delete(); invalidateLatest(); return say('🗑 Deleted'); }
    if (cmd === '/addword' && args[0]) { const c = await cfg.get(); await cfg.set({ badWords: [...new Set([...(c.badWords || []), args[0].toLowerCase()])] }); return say('✅ Word added'); }
    if (cmd === '/rmword' && args[0]) { const c = await cfg.get(); await cfg.set({ badWords: (c.badWords || []).filter((w) => w !== args[0].toLowerCase()) }); return say('✅ Word removed'); }
    if (cmd === '/unblock' && args[0]) { await guard.unblock(args[0]); return say('✅ Unblocked'); }
    return say('Use /start for the menu.');
  } catch (e) {
    if (!(e instanceof HttpError)) console.error('bot', e);
    await tg.send(chatId, '❌ ' + esc(e.message), kb([BACK]));
  }
}
