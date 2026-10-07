import { FieldValue } from 'firebase-admin/firestore';
import { svc, tg, logs, cfg, roles } from './svc.js';
import { db } from './fb.js';
import { env, HttpError, sha } from './base.js';
import * as store from './store.js';
import { callInternal } from './internal.js';
import { webhookOk } from './tg.js';
import { handleUpdate, exportOldMessages } from './bot.js';
import { purgeExpired } from './state.js';

const mem = { prof: new Map(), core: new Map(), search: new Map(), latest: { t: 0, list: [] } };
const PUB = ['uid', 'appName', 'username', 'bio', 'photoUrl', 'coverURL', 'createdAt'];
const pub = (p) => Object.fromEntries(PUB.map((k) => [k, p[k] ?? '']));
export const invalidateLatest = () => { mem.latest.t = 0; };
export const invalidateProfile = (uid) => mem.prof.delete(uid);

async function getProfile(uid) {
  const c = mem.prof.get(uid); if (c && Date.now() - c.t < 30000) return c.v;
  const s = await db.chat().collection('profiles').doc(uid).get(); const v = s.exists ? s.data() : null;
  mem.prof.set(uid, { v, t: Date.now() }); return v;
}
async function coreBanned(uid) {                                    // asks the CORE service; cached 60s; fail-open if core is down
  const c = mem.core.get(uid); if (c && Date.now() - c.t < 60000) return c.v;
  let v = false; try { v = !!(await callInternal(env('CORE_BASE_URL'), '/internal/user-status', { uid })).banned; } catch (e) { console.warn('core status', e.message); }
  mem.core.set(uid, { v, t: Date.now() }); return v;
}
async function latest() {
  if (Date.now() - mem.latest.t < 2000) return mem.latest.list;
  const s = await db.chat().collection('world_messages').orderBy('createdAt', 'desc').limit(50).get();
  mem.latest = { t: Date.now(), list: s.docs.map((d) => ({ id: d.id, ...d.data() })).reverse() }; return mem.latest.list;
}

export function registerAll() {
  // ---------- WORLD CHAT (polling, 1 shared read per 2s per instance) ----------
  svc.add('GET', '/world/messages', { auth: 'user', rl: [60, 60] }, async (ctx) => {
    const after = Number(ctx.query.after) || 0, list = await latest();
    const vis = list.filter((m) => !m.deleted);
    return { messages: after ? vis.filter((m) => m.createdAt > after) : vis, serverTime: Date.now() };
  });
  svc.add('GET', '/world/info', { auth: 'user', rl: [20, 60] }, async (ctx) => ({ banner: ctx.cfg.banner || '', cooldownSec: ctx.cfg.cooldownSec || 2, maxLen: ctx.cfg.msgMaxLen, mediaOn: ctx.cfg.mediaOn !== false, enabled: ctx.cfg.worldEnabled !== false }));
  svc.add('POST', '/world/send', { auth: 'user', rl: [20, 60] }, async (ctx) => {
    const c = ctx.cfg, uid = ctx.user.uid;
    if (!c.worldEnabled) throw new HttpError(503, 'chat_off', 'World chat is paused');
    const text = String(ctx.body.text || '').replace(/[ \t]+/g, ' ').trim();
    if (!text || text.length > c.msgMaxLen) throw new HttpError(400, 'bad_text', `Message must be 1-${c.msgMaxLen} characters`);
    const p = await getProfile(uid);
    if (!p) throw new HttpError(409, 'no_profile', 'Profile not ready. Login again.');
    if (p.banned || (await coreBanned(uid))) throw new HttpError(403, 'banned', 'Account restricted');
    if (Number(p.chatBanUntil) > Date.now()) throw new HttpError(403, 'chat_banned', 'You are muted in chat', { until: p.chatBanUntil });
    const low = text.toLowerCase();
    if (c.blockLinks && (/(https?:\/\/|www\.|t\.me\/|\.com\b|\.in\b)/i.test(low) || /\d{10}/.test(low.replace(/[\s.-]/g, '')))) throw new HttpError(400, 'links_not_allowed', 'Links and phone numbers are not allowed');
    if ((c.badWords || []).some((w) => w && low.includes(w))) throw new HttpError(400, 'blocked_word', 'Message contains a blocked word');
    if ((await store.incr('ff:cd:' + uid, c.cooldownSec || 2)) > 1) throw new HttpError(429, 'slow_down', 'Wait a moment before sending again');
    const h = sha(low); if ((await store.get('ff:last:' + uid)) === h) throw new HttpError(400, 'duplicate', 'Duplicate message');
    await store.set('ff:last:' + uid, h, 15);
    const doc = { uid, name: p.appName || 'Player', username: p.username || '', photoUrl: p.photoUrl || '', text, createdAt: Date.now() };
    const ref = await db.chat().collection('world_messages').add(doc);
    invalidateLatest();
    return { message: { id: ref.id, ...doc } };
  });
  svc.add('DELETE', '/world/messages/:id', { auth: 'user', rl: [20, 60] }, async (ctx) => {
    const ref = db.chat().collection('world_messages').doc(ctx.params.id), s = await ref.get();
    if (!s.exists) throw new HttpError(404, 'not_found', 'Message not found');
    if (s.data().uid !== ctx.user.uid) throw new HttpError(403, 'forbidden', 'Not your message');
    await ref.delete(); invalidateLatest();
  });

  // ---------- PROFILE ----------
  svc.add('GET', '/profile/:uid', { auth: 'user', rl: [60, 60] }, async (ctx) => {
    const uid = ctx.params.uid === 'me' ? ctx.user.uid : ctx.params.uid, p = await getProfile(uid);
    if (!p || p.banned) throw new HttpError(404, 'not_found', 'Profile not found');
    return { profile: uid === ctx.user.uid ? { ...pub(p), privacy: p.privacy || 'public', usernameChangesLeft: p.usernameChangesLeft ?? 3 } : pub(p) };
  });
  svc.add('PUT', '/profile', { auth: 'user', rl: [10, 60] }, async (ctx) => {
    const b = ctx.body, patch = {};
    if (b.bio !== undefined) { const bio = String(b.bio).trim(); if (bio.length > 120) throw new HttpError(400, 'bad_bio', 'Bio max 120 characters'); patch.bio = bio; }
    if (b.privacy !== undefined) { if (!['public', 'friends', 'private'].includes(b.privacy)) throw new HttpError(400, 'bad_privacy', 'Invalid privacy'); patch.privacy = b.privacy; }
    for (const k of ['photoUrl', 'coverURL']) if (b[k] !== undefined) { const v = String(b[k]); if (v && !/^https:\/\/[^\s]{5,480}$/.test(v)) throw new HttpError(400, 'bad_url', 'Invalid image URL'); patch[k] = v; }
    if (!Object.keys(patch).length) throw new HttpError(400, 'nothing', 'Nothing to update');
    await db.chat().collection('profiles').doc(ctx.user.uid).update(patch); invalidateProfile(ctx.user.uid);
    return { updated: Object.keys(patch) };
  });
  svc.add('POST', '/profile/username', { auth: 'user', rl: [5, 3600] }, async (ctx) => {
    const un = String(ctx.body.username || '').trim().toLowerCase();
    if (!/^[a-z0-9_.]{3,20}$/.test(un)) throw new HttpError(400, 'bad_username', '3-20 chars: a-z, 0-9, _ and .');
    const d = db.chat(), pref = d.collection('profiles').doc(ctx.user.uid), nref = d.collection('usernames').doc(un);
    await d.runTransaction(async (tx) => {
      const [ps, ns] = await Promise.all([tx.get(pref), tx.get(nref)]);
      if (!ps.exists) throw new HttpError(404, 'no_profile', 'Profile not found');
      const p = ps.data(); if (p.usernameLower === un) return;
      if (ns.exists) throw new HttpError(409, 'username_taken', 'Username already taken');
      const left = p.usernameChangesLeft ?? 3; if (left <= 0) throw new HttpError(403, 'no_changes_left', 'No username changes left');
      if (p.usernameLower) tx.delete(d.collection('usernames').doc(p.usernameLower));
      tx.set(nref, { uid: ctx.user.uid, at: Date.now() });
      tx.update(pref, { username: un, usernameLower: un, usernameChangesLeft: left - 1 });
    });
    invalidateProfile(ctx.user.uid); return { username: un };
  });
  svc.add('GET', '/search', { auth: 'user', rl: [20, 60] }, async (ctx) => {
    const q = String(ctx.query.q || '').trim().toLowerCase();
    if (!/^[a-z0-9_.]{2,20}$/.test(q)) throw new HttpError(400, 'bad_query', 'Type at least 2 characters (a-z, 0-9, _ .)');
    const c = mem.search.get(q); if (c && Date.now() - c.t < 20000) return { users: c.v };
    const s = await db.chat().collection('profiles').where('usernameLower', '>=', q).where('usernameLower', '<=', q + '\uf8ff').limit(15).get();
    const v = s.docs.map((x) => x.data()).filter((p) => !p.banned).map(pub); mem.search.set(q, { v, t: Date.now() }); return { users: v };
  });


  // ---------- ADMIN (admin panel -> chat moderation). Firebase login token + ADMIN_EMAILS ----------
  const adm = (method, path, fn, rl = [90, 60]) => svc.add(method, path, { auth: 'admin', rl }, fn);
  const aud = (ctx, action, data = {}) => logs.audit(action, ctx.user.email, { ...data, ip: ctx.ip });
  const wm = () => db.chat().collection('world_messages');
  adm('GET', '/admin/world', async () => ({ items: (await wm().orderBy('createdAt', 'desc').limit(150).get()).docs.map((d) => ({ id: d.id, ...d.data(), _col: 'world_messages' })) }));
  adm('POST', '/admin/world/action', async (ctx) => {
    const id = String(ctx.body.id || ''); if (!/^[A-Za-z0-9_-]{5,40}$/.test(id)) throw new HttpError(400, 'bad_id', 'Invalid id');
    const ref = wm().doc(id), op = ctx.body.op;
    if (op === 'pin' || op === 'unpin') await ref.update({ pinned: op === 'pin' }); else if (op === 'hide') await ref.update({ deleted: true, text: '', hiddenBy: 'admin' }); else if (op === 'delete') await ref.delete(); else throw new HttpError(400, 'bad_op', 'Unknown op');
    invalidateLatest(); await aud(ctx, 'world_' + op, { id });
  });
  adm('POST', '/admin/world/clear', async (ctx) => {
    let n = 0; for (;;) { const s = await wm().limit(400).get(); if (s.empty) break; const b = db.chat().batch(); s.docs.forEach((d) => b.delete(d.ref)); await b.commit(); n += s.size; if (n > 20000) break; }
    invalidateLatest(); await aud(ctx, 'world_clear', { n }); return { deleted: n };
  }, [3, 60]);
  adm('POST', '/admin/chat/ban', async (ctx) => {          // days = 0 -> permanent
    const uid = String(ctx.body.uid || ''); if (!/^[A-Za-z0-9_-]{5,128}$/.test(uid)) throw new HttpError(400, 'bad_uid', 'Invalid uid');
    const days = Math.max(0, Math.min(3650, parseInt(ctx.body.days) || 0));
    await db.chat().collection('profiles').doc(uid).set({ chatBanUntil: days ? Date.now() + days * 864e5 : 9e15 }, { merge: true }); invalidateProfile(uid); await aud(ctx, 'chat_ban', { uid, days });
  });
  adm('POST', '/admin/chat/unban', async (ctx) => { const uid = String(ctx.body.uid || ''); await db.chat().collection('profiles').doc(uid).set({ chatBanUntil: 0 }, { merge: true }); invalidateProfile(uid); await aud(ctx, 'chat_unban', { uid }); });
  adm('GET', '/admin/chat/config', async (ctx) => ({ banner: ctx.cfg.banner || '', cooldown: ctx.cfg.cooldownSec || 2, maxLen: ctx.cfg.msgMaxLen, mediaOn: ctx.cfg.mediaOn !== false, words: ctx.cfg.badWords || [] }));
  adm('PUT', '/admin/chat/config', async (ctx) => {
    const b = ctx.body, o = {};
    if (b.banner !== undefined) o.banner = String(b.banner).trim().slice(0, 300);
    if (b.cooldown !== undefined) { const v = parseInt(b.cooldown); if (!(v >= 0 && v <= 600)) throw new HttpError(400, 'bad_cooldown', 'Cooldown 0–600 s'); o.cooldownSec = v; }
    if (b.maxLen !== undefined) { const v = parseInt(b.maxLen); if (!(v >= 20 && v <= 2000)) throw new HttpError(400, 'bad_maxlen', 'Max length 20–2000'); o.msgMaxLen = v; }
    if (b.mediaOn !== undefined) o.mediaOn = !!b.mediaOn;
    if (b.words !== undefined) { if (!Array.isArray(b.words) || b.words.length > 500) throw new HttpError(400, 'bad_words', 'Max 500 words'); o.badWords = [...new Set(b.words.map((w) => String(w).trim().toLowerCase().slice(0, 40)).filter(Boolean))]; }
    if (!Object.keys(o).length) throw new HttpError(400, 'nothing', 'Nothing to update');
    await cfg.set(o); await aud(ctx, 'chat_config', { fields: Object.keys(o) });
  }, [20, 60]);

  // ---------- INTERNAL (core -> chat) ----------
  svc.add('POST', '/internal/ping', { auth: 'internal' }, async () => ({ service: 'chat', time: Date.now() }));
  svc.add('POST', '/internal/profile-init', { auth: 'internal' }, async (ctx) => {
    const uid = String(ctx.body.uid || ''); if (!uid) throw new HttpError(400, 'bad_input', 'uid required');
    const ref = db.chat().collection('profiles').doc(uid);
    if (!(await ref.get()).exists) await ref.set({ uid, appName: String(ctx.body.appName || 'Player').slice(0, 30), username: '', usernameLower: '', bio: '', photoUrl: String(ctx.body.photoUrl || ''), coverURL: '', privacy: 'public', usernameChangesLeft: 3, createdAt: Date.now() });
  });
  svc.add('POST', '/internal/user-ban', { auth: 'internal' }, async (ctx) => {
    const uid = String(ctx.body.uid || ''); await db.chat().collection('profiles').doc(uid).set({ banned: !!ctx.body.banned }, { merge: true });
    invalidateProfile(uid); mem.core.delete(uid);
  });

  svc.add('POST', '/internal/set-stopped', { auth: 'internal' }, async (ctx) => { await cfg.set({ stopped: !!ctx.body.stopped }); });
  svc.add('POST', '/internal/admins-set', { auth: 'internal' }, async (ctx) => { await roles.setAdmins((Array.isArray(ctx.body.ids) ? ctx.body.ids : []).map(String).filter((x) => /^\d{5,15}$/.test(x))); });
  svc.add('POST', '/internal/profile-delete', { auth: 'internal' }, async (ctx) => {
    const uid = String(ctx.body.uid || ''); if (!uid) throw new HttpError(400, 'bad_input', 'uid required');
    const ref = db.chat().collection('profiles').doc(uid), s = await ref.get();
    if (s.exists && s.data().usernameLower) await db.chat().collection('usernames').doc(s.data().usernameLower).delete();
    await ref.delete(); invalidateProfile(uid);
  });

  // ---------- TELEGRAM + CRON ----------
  svc.add('POST', '/tg/webhook', { origin: false, skipGuard: true }, async (ctx) => {
    if (!webhookOk(ctx.req)) { console.warn('[tg:%s] webhook REJECTED: secret mismatch (Render TG_WEBHOOK_SECRET %s)', 'chat', env('TG_WEBHOOK_SECRET') ? 'is set' : 'is EMPTY'); throw new HttpError(401, 'bad_secret', 'Unauthorized'); }
    try { await handleUpdate(ctx.body); } catch (e) { console.error('tg', e); }
  });
  svc.add('GET', '/cron/daily', { auth: 'cron' }, async () => { const exported = await exportOldMessages(); await purgeExpired(() => db.chat(), ['bot_state']); return { exported }; });
}
