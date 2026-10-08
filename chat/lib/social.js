// Social layer of the chat service: friends, requests, block, DMs, groups (+music box), reactions/edit/delete,
// presence (in-memory, zero Firestore writes per heartbeat), discover, reports.
// Data lives in the CHAT Firebase project:
//   social/{uid}                 friends[], outgoing[], blocked[], pinnedFriends[], muted[], pinnedChats[], archived[]
//   friend_requests/{from_to}    {from,to,status,createdAt}
//   chats/{a__b}                 {members, last, unread:{uid:n}}      + /messages/{id}
//   groups/{gid}                 {name,desc,ownerUid,admins,members,memberCount,public,nowPlaying,last}  + /messages/{id}
//   reports/{id}
import { FieldValue } from 'firebase-admin/firestore';
import { db } from './fb.js';
import { env, HttpError, sha } from './base.js';
import * as store from './store.js';
import { callInternal } from './internal.js';

const D = () => db.chat();
const pairId = (a, b) => [a, b].sort().join('__');
const UID_RE = /^[A-Za-z0-9_-]{5,128}$/;
const ID_RE = /^[A-Za-z0-9_-]{5,60}$/;
const okUid = (u) => { u = String(u || ''); if (!UID_RE.test(u)) throw new HttpError(400, 'bad_uid', 'Invalid user'); return u; };
const okId = (u) => { u = String(u || ''); if (!ID_RE.test(u)) throw new HttpError(400, 'bad_id', 'Invalid id'); return u; };
const ARR = ['friends', 'outgoing', 'blocked', 'pinnedFriends', 'muted', 'pinnedChats', 'archived'];
const EMOJI_RE = /^[^\s<>&"'`]{1,12}$/u;
const IMG_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_FRIENDS = 300, MAX_GROUP = 500;
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

export function registerSocial(svc, H) {
  const { getProfile, invalidateProfile, invalidateLatest, prof, coreBanned, notifyAdmins } = H;

  // ------------------------------------------------------------------ helpers
  const soc = new Map();                                            // uid -> {v,t} (5s)
  const socInvalidate = (...ids) => ids.forEach((i) => soc.delete(i));
  async function getSocial(uid) {
    const c = soc.get(uid); if (c && Date.now() - c.t < 5000) return c.v;
    const s = await D().collection('social').doc(uid).get(), d = s.exists ? s.data() : {}, v = {};
    for (const k of ARR) v[k] = Array.isArray(d[k]) ? d[k] : [];
    soc.set(uid, { v, t: Date.now() }); return v;
  }
  const socRef = (uid) => D().collection('social').doc(uid);

  async function getProfiles(ids) {                                 // batched + shares the 30s profile cache of routes.js
    const out = {}, miss = [];
    for (const id of [...new Set(ids)]) { const c = prof.get(id); if (c && Date.now() - c.t < 30000) out[id] = c.v; else miss.push(id); }
    if (miss.length) {
      const snaps = await D().getAll(...miss.map((i) => D().collection('profiles').doc(i)));
      snaps.forEach((s, i) => { const v = s.exists ? s.data() : null; prof.set(miss[i], { v, t: Date.now() }); out[miss[i]] = v; });
    }
    return out;
  }

  // chat profile is created on demand (older accounts / failed profile-init)
  async function ensureProfile(uid) {
    let p = await getProfile(uid); if (p) return p;
    let st = {}; try { st = await callInternal(env('CORE_BASE_URL'), '/internal/user-status', { uid }); } catch (e) { console.warn('ensureProfile core', e.message); }
    if (st.exists === false) throw new HttpError(404, 'no_user', 'Account not found');
    const doc = { uid, appName: clip(st.appName || 'Player', 30), nameKey: String(st.appName || '').toLowerCase().replace(/[^a-z0-9_.]/g, '').slice(0, 30), username: '', usernameLower: '', bio: '', photoUrl: '', coverURL: '', privacy: 'public', usernameChangesLeft: 3, createdAt: Date.now() };
    await D().collection('profiles').doc(uid).set(doc, { merge: true }); invalidateProfile(uid);
    return (await getProfile(uid)) || doc;
  }
  // every account gets a searchable username automatically (can be changed 3 times)
  async function ensureUsername(uid, p) {
    if (!p.nameKey && p.appName) { const nameKey = String(p.appName).toLowerCase().replace(/[^a-z0-9_.]/g, '').slice(0, 30); await D().collection('profiles').doc(uid).set({ nameKey }, { merge: true }).catch(() => {}); invalidateProfile(uid); p = { ...p, nameKey }; }
    if (p.usernameLower) return p;
    const base = (String(p.appName || 'player').toLowerCase().replace(/[^a-z0-9]/g, '') || 'player').slice(0, 14).padEnd(5, 'x');
    for (let i = 0; i < 12; i++) {
      const un = i === 0 ? base : base + Math.floor(1000 + Math.random() * 9000);
      try {
        const ok = await D().runTransaction(async (tx) => {
          const pref = D().collection('profiles').doc(uid), nref = D().collection('usernames').doc(un), [ps, ns] = await Promise.all([tx.get(pref), tx.get(nref)]);
          if (ps.exists && ps.data().usernameLower) return 'has';
          if (ns.exists) return false;
          tx.set(nref, { uid, at: Date.now() }); tx.set(pref, { username: un, usernameLower: un }, { merge: true }); return true;
        });
        if (ok) break;
      } catch (e) { console.warn('ensureUsername', e.message); }
    }
    invalidateProfile(uid); return (await getProfile(uid)) || p;
  }

  // ---- presence: memory only. Heartbeat = no Firestore write. lastSeen is persisted at most every 5 min and on offline.
  const pres = new Map();
  const isOn = (uid) => { const x = pres.get(uid); return !!x && x.state !== 'offline' && Date.now() - x.t < 70000; };
  const seenOf = (uid, p) => Math.max((pres.get(uid) || {}).t || 0, Number(p && p.lastSeen) || 0);
  setInterval(() => { const cut = Date.now() - 3600e3; for (const [k, v] of pres) if (v.t < cut) pres.delete(k); }, 600000).unref();

  const card = (p, uid) => ({ uid, appName: p.appName || 'Player', username: p.username || '', photoUrl: p.photoUrl || '' });
  const live = (p, uid, canSee) => (canSee ? { online: isOn(uid), lastSeen: seenOf(uid, p) } : { online: false, lastSeen: 0 });

  function textRules(c, text, { links = false, max } = {}) {
    text = String(text || '').replace(/[ \t]+/g, ' ').trim();
    const lim = max || c.msgMaxLen || 300;
    if (!text || text.length > lim) throw new HttpError(400, 'bad_text', `Message must be 1-${lim} characters`);
    const low = text.toLowerCase();
    if (links && c.blockLinks && (/(https?:\/\/|www\.|t\.me\/|\.com\b|\.in\b)/i.test(low) || /\d{10}/.test(low.replace(/[\s.-]/g, '')))) throw new HttpError(400, 'links_not_allowed', 'Links and phone numbers are not allowed');
    if ((c.badWords || []).some((w) => w && low.includes(w))) throw new HttpError(400, 'blocked_word', 'Message contains a blocked word');
    return text;
  }
  async function sendGuard(ctx, uid) {
    const c = ctx.cfg;
    if (c.worldEnabled === false) throw new HttpError(503, 'chat_off', 'Chat is paused');
    const p = await ensureProfile(uid);
    if (p.banned || (await coreBanned(uid))) throw new HttpError(403, 'banned', 'Account restricted');
    if (Number(p.chatBanUntil) > Date.now()) throw new HttpError(403, 'chat_banned', 'You are muted in chat', { until: p.chatBanUntil });
    if ((await store.incr('ff:cd:' + uid, c.cooldownSec || 2)) > 1) throw new HttpError(429, 'slow_down', 'Wait a moment before sending again');
    return p;
  }
  // text or image message body (images are small data URLs, compressed by the app)
  function buildMsg(ctx, p, uid, { links = false } = {}) {
    const b = ctx.body, type = ['text', 'image'].includes(b.type) ? b.type : 'text', m = { uid, name: p.appName || 'Player', type, createdAt: Date.now() };
    if (type === 'image') {
      if (ctx.cfg.mediaOn === false) throw new HttpError(403, 'media_off', 'Photos are turned off right now');
      const u = String(b.url || ''); if (!IMG_RE.test(u) || u.length > 260000) throw new HttpError(400, 'bad_image', 'Image invalid or too large');
      m.url = u; m.fileName = clip(b.fileName || 'photo.jpg', 80); m.text = b.text ? textRules(ctx.cfg, b.text, { links }) : '';
    } else m.text = textRules(ctx.cfg, b.text, { links });
    if (b.replyTo && typeof b.replyTo === 'object') m.replyTo = { mid: clip(b.replyTo.mid, 60), text: clip(b.replyTo.text, 120) };
    if (b.forwarded) m.forwarded = true;
    return m;
  }
  const preview = (m) => ({ text: m.type === 'image' ? '📷 Photo' : clip(m.text, 80), type: m.type, at: m.createdAt, uid: m.uid });
  const unreadFlag = new Set();                                       // 'cid|uid' = someone sent uid a message (avoids a Firestore write on every poll)
  const listCache = new Map();                                      // collection path -> {t,list}
  const colPath = (col) => col.path;
  async function readMsgs(col, ttl = 1500) {
    const k = colPath(col), c = listCache.get(k); if (c && Date.now() - c.t < ttl) return c.list;
    const s = await col.orderBy('createdAt', 'desc').limit(100).get();
    const list = s.docs.map((d) => ({ id: d.id, ...d.data() })).reverse(); listCache.set(k, { t: Date.now(), list });
    if (listCache.size > 400) for (const [kk, v] of listCache) if (Date.now() - v.t > 20000) listCache.delete(kk);
    return list;
  }
  const bust = (col) => listCache.delete(colPath(col));
  // ---- relation rules
  async function dmAllowed(uid, peer) {
    if (uid === peer) throw new HttpError(400, 'self', 'You cannot message yourself');
    const [me, they, pp] = await Promise.all([getSocial(uid), getSocial(peer), getProfile(peer)]);
    if (!pp || pp.banned) throw new HttpError(404, 'not_found', 'User not found');
    if (me.blocked.includes(peer)) throw new HttpError(403, 'you_blocked', 'You blocked this user. Unblock to chat.');
    if (they.blocked.includes(uid)) throw new HttpError(403, 'blocked_by', 'You cannot message this user');
    const friends = me.friends.includes(peer);
    if (!friends && (pp.privacy || 'public') !== 'public') throw new HttpError(403, 'private', 'This profile is private. Send a friend request first.');
    return { friends, me, peerProfile: pp };
  }

  const A = (method, path, rl, fn, extra = {}) => svc.add(method, path, { auth: 'user', rl, ...extra }, fn);

  // ------------------------------------------------------------------ my social state
  A('GET', '/social/me', [30, 60], async (ctx) => {
    const uid = ctx.user.uid; let p = await ensureProfile(uid); p = await ensureUsername(uid, p);
    const s = await getSocial(uid);
    const inc = await D().collection('friend_requests').where('to', '==', uid).where('status', '==', 'pending').limit(50).get();
    const grp = await D().collection('groups').where('members', 'array-contains', uid).limit(60).get();
    return { social: { ...s, incoming: inc.docs.map((d) => d.data().from), groups: grp.docs.map((d) => d.id) }, profile: { uid, appName: p.appName, username: p.username || '', bio: p.bio || '', photoUrl: p.photoUrl || '', coverURL: p.coverURL || '', privacy: p.privacy || 'public', usernameChangesLeft: p.usernameChangesLeft ?? 3 } };
  });

  // small avatars, fetched once per uid by the app and cached there (photos are never embedded inside messages)
  A('GET', '/avatars', [60, 60], async (ctx) => {
    const ids = String(ctx.query.uids || '').split(',').map((x) => x.trim()).filter((x) => UID_RE.test(x)).slice(0, 40), ps = await getProfiles(ids), out = {};
    for (const id of ids) if (ps[id] && ps[id].photoUrl && ps[id].photoUrl.length < 40000) out[id] = ps[id].photoUrl;
    return { avatars: out };
  });

  // ------------------------------------------------------------------ presence
  A('POST', '/presence/ping', [8, 20], async (ctx) => {
    const uid = ctx.user.uid, state = ctx.body.state === 'offline' ? 'offline' : 'online', prev = pres.get(uid), now = Date.now();
    pres.set(uid, { t: now, state, saved: prev ? prev.saved : 0 });
    if (state === 'offline' || !prev || now - (prev.saved || 0) > 300000) {
      pres.get(uid).saved = now;
      D().collection('profiles').doc(uid).set({ lastSeen: now }, { merge: true }).then(() => invalidateProfile(uid)).catch(() => {});
    }
  });
  A('GET', '/presence', [40, 60], async (ctx) => {
    const ids = String(ctx.query.uids || '').split(',').map((s) => s.trim()).filter((s) => UID_RE.test(s)).slice(0, 60);
    if (!ids.length) return { users: {} };
    const [me, ps] = await Promise.all([getSocial(ctx.user.uid), getProfiles(ids)]), out = {};
    for (const id of ids) { const p = ps[id]; if (!p) continue; out[id] = live(p, id, id === ctx.user.uid || (p.privacy || 'public') === 'public' || me.friends.includes(id)); }
    return { users: out };
  });

  // ------------------------------------------------------------------ friends
  A('GET', '/friends', [40, 60], async (ctx) => {
    const uid = ctx.user.uid, s = await getSocial(uid), ids = s.friends.slice(0, 120);
    if (!ids.length) return { friends: [] };
    const [ps, cs] = await Promise.all([getProfiles(ids), D().getAll(...ids.map((i) => D().collection('chats').doc(pairId(uid, i))))]);
    const friends = ids.map((id, i) => {
      const p = ps[id]; if (!p || p.banned) return null; const c = cs[i].exists ? cs[i].data() : {}, cid = pairId(uid, id);
      return { ...card(p, id), ...live(p, id, true), last: c.last || null, unread: Number((c.unread || {})[uid]) || 0, pinned: s.pinnedFriends.includes(id), chatPinned: s.pinnedChats.includes(cid), muted: s.muted.includes(cid), archived: s.archived.includes(cid) };
    }).filter(Boolean);
    friends.sort((a, b) => (b.last ? b.last.at : 0) - (a.last ? a.last.at : 0));
    return { friends };
  });

  A('POST', '/friends/request', [20, 3600], async (ctx) => {
    const uid = ctx.user.uid, to = okUid(ctx.body.to); if (to === uid) throw new HttpError(400, 'self', 'You cannot add yourself');
    const [me, they, pp] = await Promise.all([getSocial(uid), getSocial(to), getProfile(to)]);
    if (!pp || pp.banned) throw new HttpError(404, 'not_found', 'User not found');
    if (me.friends.includes(to)) throw new HttpError(409, 'already_friends', 'Already friends');
    if (they.blocked.includes(uid)) throw new HttpError(403, 'blocked_by', 'You cannot send a request to this user');
    if (me.blocked.includes(to)) throw new HttpError(403, 'you_blocked', 'Unblock this user first');
    if (me.friends.length >= MAX_FRIENDS) throw new HttpError(400, 'limit', 'Friend limit reached');
    if (me.outgoing.length >= 100) throw new HttpError(400, 'limit', 'Too many pending requests');
    const rev = await D().collection('friend_requests').doc(`${to}_${uid}`).get();          // they already asked me -> accept
    if (rev.exists && rev.data().status === 'pending') return befriend(uid, to, true);
    await D().collection('friend_requests').doc(`${uid}_${to}`).set({ from: uid, to, status: 'pending', createdAt: Date.now() });
    await socRef(uid).set({ outgoing: FieldValue.arrayUnion(to) }, { merge: true }); socInvalidate(uid, to);
    return { status: 'pending' };
  });
  async function befriend(uid, other, fromReverse) {                // uid accepts other's request (or auto-accept)
    const b = D().batch();
    b.set(socRef(uid), { friends: FieldValue.arrayUnion(other), outgoing: FieldValue.arrayRemove(other) }, { merge: true });
    b.set(socRef(other), { friends: FieldValue.arrayUnion(uid), outgoing: FieldValue.arrayRemove(uid) }, { merge: true });
    b.set(D().collection('friend_requests').doc(`${other}_${uid}`), { from: other, to: uid, status: 'accepted', respondedAt: Date.now(), createdAt: Date.now() }, { merge: true });
    b.delete(D().collection('friend_requests').doc(`${uid}_${other}`));
    await b.commit(); socInvalidate(uid, other); return { status: 'friends', auto: !!fromReverse };
  }
  A('POST', '/friends/cancel', [30, 60], async (ctx) => {
    const uid = ctx.user.uid, to = okUid(ctx.body.to);
    await D().collection('friend_requests').doc(`${uid}_${to}`).delete().catch(() => {});
    await socRef(uid).set({ outgoing: FieldValue.arrayRemove(to) }, { merge: true }); socInvalidate(uid, to);
  });
  A('GET', '/friends/requests', [30, 60], async (ctx) => {
    const uid = ctx.user.uid, [i, o] = await Promise.all([
      D().collection('friend_requests').where('to', '==', uid).where('status', '==', 'pending').limit(50).get(),
      D().collection('friend_requests').where('from', '==', uid).where('status', '==', 'pending').limit(50).get(),
    ]);
    const inc = i.docs.map((d) => d.data()), out = o.docs.map((d) => d.data()), ps = await getProfiles([...inc.map((r) => r.from), ...out.map((r) => r.to)]);
    const mk = (id, r) => (ps[id] && !ps[id].banned ? { ...card(ps[id], id), at: r.createdAt } : null);
    return { incoming: inc.map((r) => mk(r.from, r)).filter(Boolean), outgoing: out.map((r) => mk(r.to, r)).filter(Boolean) };
  });
  A('POST', '/friends/accept', [30, 60], async (ctx) => {
    const uid = ctx.user.uid, from = okUid(ctx.body.from), r = await D().collection('friend_requests').doc(`${from}_${uid}`).get();
    if (!r.exists || r.data().status !== 'pending') throw new HttpError(404, 'no_request', 'Request not found');
    const me = await getSocial(uid); if (me.friends.length >= MAX_FRIENDS) throw new HttpError(400, 'limit', 'Friend limit reached');
    return befriend(uid, from);
  });
  A('POST', '/friends/reject', [30, 60], async (ctx) => {
    const uid = ctx.user.uid, from = okUid(ctx.body.from);
    await D().collection('friend_requests').doc(`${from}_${uid}`).delete().catch(() => {});
    await socRef(from).set({ outgoing: FieldValue.arrayRemove(uid) }, { merge: true }); socInvalidate(uid, from);
  });
  A('POST', '/friends/remove', [20, 60], async (ctx) => {
    const uid = ctx.user.uid, other = okUid(ctx.body.uid), b = D().batch();
    b.set(socRef(uid), { friends: FieldValue.arrayRemove(other), pinnedFriends: FieldValue.arrayRemove(other) }, { merge: true });
    b.set(socRef(other), { friends: FieldValue.arrayRemove(uid), pinnedFriends: FieldValue.arrayRemove(uid) }, { merge: true });
    await b.commit(); socInvalidate(uid, other);
  });
  A('POST', '/friends/pin', [30, 60], async (ctx) => {
    const uid = ctx.user.uid, other = okUid(ctx.body.uid), s = await getSocial(uid); if (!s.friends.includes(other)) throw new HttpError(400, 'not_friend', 'Not a friend');
    const has = s.pinnedFriends.includes(other), next = has ? s.pinnedFriends.filter((x) => x !== other) : [other, ...s.pinnedFriends].slice(0, 20);
    await socRef(uid).set({ pinnedFriends: next }, { merge: true }); socInvalidate(uid); return { pinned: !has, pinnedFriends: next };
  });

  // ------------------------------------------------------------------ block / report
  A('POST', '/block', [20, 60], async (ctx) => {
    const uid = ctx.user.uid, other = okUid(ctx.body.uid); if (other === uid) throw new HttpError(400, 'self', 'You cannot block yourself');
    const b = D().batch();
    b.set(socRef(uid), { blocked: FieldValue.arrayUnion(other), friends: FieldValue.arrayRemove(other), pinnedFriends: FieldValue.arrayRemove(other), outgoing: FieldValue.arrayRemove(other) }, { merge: true });
    b.set(socRef(other), { friends: FieldValue.arrayRemove(uid), pinnedFriends: FieldValue.arrayRemove(uid), outgoing: FieldValue.arrayRemove(uid) }, { merge: true });
    b.delete(D().collection('friend_requests').doc(`${uid}_${other}`)); b.delete(D().collection('friend_requests').doc(`${other}_${uid}`));
    await b.commit(); socInvalidate(uid, other);
  });
  A('POST', '/unblock', [20, 60], async (ctx) => { const uid = ctx.user.uid; await socRef(uid).set({ blocked: FieldValue.arrayRemove(okUid(ctx.body.uid)) }, { merge: true }); socInvalidate(uid); });
  A('GET', '/blocked', [20, 60], async (ctx) => {
    const s = await getSocial(ctx.user.uid), ps = await getProfiles(s.blocked.slice(0, 100));
    return { users: s.blocked.slice(0, 100).map((id) => (ps[id] ? card(ps[id], id) : { uid: id, appName: 'User', username: '', photoUrl: '' })) };
  });
  A('POST', '/report', [10, 3600], async (ctx) => {
    const type = ctx.body.type === 'message' ? 'message' : 'user', reason = clip(ctx.body.reason, 300).trim(); if (reason.length < 2) throw new HttpError(400, 'bad_reason', 'Tell us the reason');
    const doc = { type, target: clip(ctx.body.target, 120), scope: clip(ctx.body.scope, 12), ref: clip(ctx.body.ref, 120), reason, reporter: ctx.user.uid, createdAt: Date.now(), status: 'open' };
    if (type === 'message' && ctx.body.text) doc.text = clip(ctx.body.text, 300);
    await D().collection('reports').add(doc);
    notifyAdmins && notifyAdmins(`🚩 <b>Chat report</b> (${type})\nReason: ${reason.replace(/[<>&]/g, '')}\nTarget: <code>${doc.target.replace(/[<>&]/g, '')}</code>`).catch(() => {});
  });

  // ------------------------------------------------------------------ per-chat preferences (mute / pin / archive)
  A('POST', '/chatpref', [40, 60], async (ctx) => {
    const uid = ctx.user.uid, peer = okUid(ctx.body.peer), cid = pairId(uid, peer);
    const map = { mute: ['muted', 1], unmute: ['muted', 0], pin: ['pinnedChats', 1], unpin: ['pinnedChats', 0], archive: ['archived', 1], unarchive: ['archived', 0] }, m = map[ctx.body.op];
    if (!m) throw new HttpError(400, 'bad_op', 'Unknown action');
    await socRef(uid).set({ [m[0]]: m[1] ? FieldValue.arrayUnion(cid) : FieldValue.arrayRemove(cid) }, { merge: true }); socInvalidate(uid);
  });

  // ------------------------------------------------------------------ DM
  const dmCol = (cid) => D().collection('chats').doc(cid).collection('messages');
  A('GET', '/dm/:peer/messages', [90, 60], async (ctx) => {
    const uid = ctx.user.uid, peer = okUid(ctx.params.peer), cid = pairId(uid, peer);
    const me = await getSocial(uid); if (me.blocked.includes(peer)) throw new HttpError(403, 'you_blocked', 'You blocked this user');
    const [list] = await Promise.all([readMsgs(dmCol(cid))]);
    const rd = ctx.query.read;
    if (rd === '2' || (rd === '1' && unreadFlag.delete(cid + '|' + uid))) D().collection('chats').doc(cid).set({ unread: { [uid]: 0 } }, { merge: true }).catch(() => {});
    const after = Number(ctx.query.after) || 0, vis = after ? list.filter((m) => m.createdAt > after || m.editedAt > after || m.reactAt > after) : list;
    return { messages: vis, serverTime: Date.now() };
  });
  A('POST', '/dm/:peer/send', [40, 60], async (ctx) => {
    const uid = ctx.user.uid, peer = okUid(ctx.params.peer), cid = pairId(uid, peer);
    const p = await sendGuard(ctx, uid); await dmAllowed(uid, peer);
    const m = buildMsg(ctx, p, uid), col = dmCol(cid);
    const ref = await col.add(m);
    await D().collection('chats').doc(cid).set({ members: [uid, peer].sort(), last: preview(m), updatedAt: m.createdAt, unread: { [peer]: FieldValue.increment(1), [uid]: 0 } }, { merge: true });
    unreadFlag.add(cid + '|' + peer); bust(col); return { message: { id: ref.id, ...m } };
  }, { maxBody: 330000 });

  // ------------------------------------------------------------------ message actions (world / dm / group)
  async function scopeOf(ctx) {
    const uid = ctx.user.uid, b = ctx.body, scope = String(b.scope || '');
    if (scope === 'world') return { scope, col: D().collection('world_messages'), after: invalidateLatest };
    if (scope === 'dm') { const peer = okUid(b.peer), col = dmCol(pairId(uid, peer)); await dmAllowed(uid, peer).catch((e) => { if (!['private'].includes(e.code)) throw e; }); return { scope, col, after: () => bust(col) }; }
    if (scope === 'group') { const gid = okId(b.gid), g = await groupOf(gid, uid, true), col = D().collection('groups').doc(gid).collection('messages'); return { scope, col, group: g, after: () => bust(col) }; }
    throw new HttpError(400, 'bad_scope', 'Unknown chat');
  }
  A('POST', '/msg/react', [60, 60], async (ctx) => {
    const { col, after } = await scopeOf(ctx), mid = okId(ctx.body.mid), emoji = String(ctx.body.emoji || ''); if (!EMOJI_RE.test(emoji)) throw new HttpError(400, 'bad_emoji', 'Invalid reaction');
    const ref = col.doc(mid), uid = ctx.user.uid;
    await D().runTransaction(async (tx) => {
      const s = await tx.get(ref); if (!s.exists) throw new HttpError(404, 'not_found', 'Message not found'); if (s.data().deleted) return;
      const r = { ...(s.data().reactions || {}) }, arr = Array.isArray(r[emoji]) ? r[emoji] : [];
      r[emoji] = arr.includes(uid) ? arr.filter((x) => x !== uid) : [...arr, uid].slice(-200); if (!r[emoji].length) delete r[emoji];
      tx.update(ref, { reactions: r, reactAt: Date.now() });
    });
    after();
  });
  A('POST', '/msg/edit', [30, 60], async (ctx) => {
    const { scope, col, after } = await scopeOf(ctx), mid = okId(ctx.body.mid), ref = col.doc(mid), s = await ref.get();
    if (!s.exists) throw new HttpError(404, 'not_found', 'Message not found'); const m = s.data();
    if (m.uid !== ctx.user.uid) throw new HttpError(403, 'forbidden', 'Not your message'); if (m.deleted) throw new HttpError(409, 'deleted', 'Message was deleted'); if (m.edited) throw new HttpError(409, 'edited', 'Already edited once'); if (m.type === 'image') throw new HttpError(400, 'bad_type', 'Photos cannot be edited');
    const text = textRules(ctx.cfg, ctx.body.text, { links: scope === 'world' });
    await ref.update({ text, edited: true, editedAt: Date.now() }); after();
  });
  A('POST', '/msg/delete', [30, 60], async (ctx) => {
    const { col, after, group } = await scopeOf(ctx), mid = okId(ctx.body.mid), ref = col.doc(mid), s = await ref.get(); if (!s.exists) return;
    const uid = ctx.user.uid, m = s.data(), mod = group && (group.ownerUid === uid || (group.admins || []).includes(uid));
    if (m.uid !== uid && !mod) throw new HttpError(403, 'forbidden', 'Not your message');
    await ref.update({ deleted: true, text: '', url: FieldValue.delete(), reactions: {}, deletedAt: Date.now() }); after();
  });

  // ------------------------------------------------------------------ groups
  async function groupOf(gid, uid, mustBeMember) {
    const s = await D().collection('groups').doc(gid).get(); if (!s.exists) throw new HttpError(404, 'no_group', 'Group not found');
    const g = { id: gid, ...s.data() }; g.members = g.members || []; g.admins = g.admins || [];
    if (mustBeMember && !g.members.includes(uid)) throw new HttpError(403, 'not_member', 'Join the group first');
    return g;
  }
  const gCard = (g, uid) => ({ id: g.id, name: g.name, desc: g.desc || '', public: !!g.public, category: g.category || '', memberCount: g.members.length, joined: g.members.includes(uid), role: g.ownerUid === uid ? 'owner' : g.admins.includes(uid) ? 'admin' : g.members.includes(uid) ? 'member' : '', last: g.last || null, createdAt: g.createdAt || 0 });
  const isMod = (g, uid) => g.ownerUid === uid || g.admins.includes(uid);

  A('POST', '/groups', [5, 3600], async (ctx) => {
    const uid = ctx.user.uid, name = clip(ctx.body.name, 40).trim(), desc = clip(ctx.body.desc, 120).trim();
    if (name.length < 2) throw new HttpError(400, 'bad_name', 'Group name must be 2-40 characters');
    if ((ctx.cfg.badWords || []).some((w) => w && name.toLowerCase().includes(w))) throw new HttpError(400, 'blocked_word', 'Name contains a blocked word');
    const p = await sendGuard(ctx, uid);
    const owned = await D().collection('groups').where('ownerUid', '==', uid).limit(11).get(); if (owned.size >= 10) throw new HttpError(400, 'limit', 'You can own up to 10 groups');
    const ref = await D().collection('groups').add({ name, desc, ownerUid: uid, ownerName: p.appName || 'Player', admins: [], members: [uid], memberCount: 1, public: !!ctx.body.public, createdAt: Date.now() });
    return { id: ref.id, name };
  });
  A('GET', '/groups/mine', [30, 60], async (ctx) => {
    const uid = ctx.user.uid, s = await D().collection('groups').where('members', 'array-contains', uid).limit(60).get();
    return { groups: s.docs.map((d) => gCard({ id: d.id, ...d.data(), members: d.data().members || [], admins: d.data().admins || [] }, uid)).sort((a, b) => (b.last ? b.last.at : b.createdAt) - (a.last ? a.last.at : a.createdAt)) };
  });
  const pubCache = { t: 0, list: [] };
  A('GET', '/groups/discover', [20, 60], async (ctx) => {
    const uid = ctx.user.uid;
    if (Date.now() - pubCache.t > 20000) { const s = await D().collection('groups').where('public', '==', true).limit(100).get(); pubCache.list = s.docs.map((d) => ({ id: d.id, ...d.data(), members: d.data().members || [], admins: d.data().admins || [] })); pubCache.t = Date.now(); }
    const list = pubCache.list.slice(), trending = ctx.query.sort !== 'new';
    list.sort((a, b) => (trending ? b.members.length - a.members.length : (b.createdAt || 0) - (a.createdAt || 0)));
    return { groups: list.slice(0, 30).map((g) => gCard(g, uid)) };
  });
  A('GET', '/groups/:gid', [60, 60], async (ctx) => {
    const uid = ctx.user.uid, g = await groupOf(okId(ctx.params.gid), uid, false);
    if (!g.public && !g.members.includes(uid)) throw new HttpError(403, 'private', 'This group is private');
    const out = { group: { ...gCard(g, uid), ownerUid: g.ownerUid, admins: g.admins, nowPlaying: g.nowPlaying || null } };
    if (ctx.query.members === '1' && g.members.includes(uid)) {
      const ps = await getProfiles(g.members.slice(0, 200));
      out.members = g.members.slice(0, 200).map((id) => (ps[id] ? { ...card(ps[id], id), role: id === g.ownerUid ? 'owner' : g.admins.includes(id) ? 'admin' : 'member' } : null)).filter(Boolean);
    }
    return out;
  });
  A('POST', '/groups/:gid/join', [20, 60], async (ctx) => {
    const uid = ctx.user.uid, gid = okId(ctx.params.gid), p = await ensureProfile(uid);
    if (p.banned) throw new HttpError(403, 'banned', 'Account restricted');
    return D().runTransaction(async (tx) => {
      const ref = D().collection('groups').doc(gid), s = await tx.get(ref); if (!s.exists) throw new HttpError(404, 'no_group', 'Group not found');
      const g = s.data(), members = g.members || [];
      if (members.includes(uid)) return { joined: true, name: g.name };
      if (!g.public && ctx.body.invite !== true) throw new HttpError(403, 'private', 'This group is private. Ask for an invite link.');
      if ((g.banned || []).includes(uid)) throw new HttpError(403, 'kicked', 'You were removed from this group');
      if (members.length >= MAX_GROUP) throw new HttpError(400, 'full', 'Group is full');
      tx.update(ref, { members: [...members, uid], memberCount: members.length + 1 }); pubCache.t = 0; return { joined: true, name: g.name };
    });
  });
  A('POST', '/groups/:gid/leave', [20, 60], async (ctx) => {
    const uid = ctx.user.uid, gid = okId(ctx.params.gid), g = await groupOf(gid, uid, true);
    if (g.ownerUid === uid) throw new HttpError(400, 'owner', 'Owner cannot leave. Delete the group instead.');
    await D().collection('groups').doc(gid).update({ members: FieldValue.arrayRemove(uid), admins: FieldValue.arrayRemove(uid), memberCount: Math.max(g.members.length - 1, 0) }); pubCache.t = 0;
  });
  A('POST', '/groups/:gid/kick', [30, 60], async (ctx) => {
    const uid = ctx.user.uid, gid = okId(ctx.params.gid), t = okUid(ctx.body.uid), g = await groupOf(gid, uid, true);
    if (!isMod(g, uid)) throw new HttpError(403, 'forbidden', 'Admins only'); if (t === g.ownerUid) throw new HttpError(403, 'forbidden', 'Owner cannot be removed');
    if (g.admins.includes(t) && g.ownerUid !== uid) throw new HttpError(403, 'forbidden', 'Only the owner can remove an admin');
    await D().collection('groups').doc(gid).update({ members: FieldValue.arrayRemove(t), admins: FieldValue.arrayRemove(t), banned: FieldValue.arrayUnion(t), memberCount: Math.max(g.members.length - 1, 0) }); pubCache.t = 0;
  });
  A('POST', '/groups/:gid/role', [30, 60], async (ctx) => {
    const uid = ctx.user.uid, gid = okId(ctx.params.gid), t = okUid(ctx.body.uid), g = await groupOf(gid, uid, true);
    if (g.ownerUid !== uid) throw new HttpError(403, 'forbidden', 'Only the owner can change roles'); if (!g.members.includes(t) || t === uid) throw new HttpError(400, 'bad_target', 'Invalid member');
    await D().collection('groups').doc(gid).update({ admins: ctx.body.admin ? FieldValue.arrayUnion(t) : FieldValue.arrayRemove(t) });
  });
  A('PUT', '/groups/:gid', [20, 60], async (ctx) => {
    const uid = ctx.user.uid, gid = okId(ctx.params.gid), g = await groupOf(gid, uid, true); if (!isMod(g, uid)) throw new HttpError(403, 'forbidden', 'Admins only');
    const b = ctx.body, patch = {};
    if (b.public !== undefined) patch.public = !!b.public;
    if (b.name !== undefined) { const n = clip(b.name, 40).trim(); if (n.length < 2) throw new HttpError(400, 'bad_name', 'Group name must be 2-40 characters'); patch.name = n; }
    if (b.desc !== undefined) patch.desc = clip(b.desc, 120).trim();
    if (!Object.keys(patch).length) throw new HttpError(400, 'nothing', 'Nothing to update');
    await D().collection('groups').doc(gid).update(patch); pubCache.t = 0;
  });
  A('DELETE', '/groups/:gid', [10, 60], async (ctx) => {
    const uid = ctx.user.uid, gid = okId(ctx.params.gid), g = await groupOf(gid, uid, true); if (g.ownerUid !== uid) throw new HttpError(403, 'forbidden', 'Only the owner can delete');
    for (let n = 0; n < 50; n++) { const s = await D().collection('groups').doc(gid).collection('messages').limit(400).get(); if (s.empty) break; const b = D().batch(); s.docs.forEach((d) => b.delete(d.ref)); await b.commit(); }
    await D().collection('groups').doc(gid).delete(); pubCache.t = 0;
  });
  const gCol = (gid) => D().collection('groups').doc(gid).collection('messages');
  A('GET', '/groups/:gid/messages', [90, 60], async (ctx) => {
    const uid = ctx.user.uid, gid = okId(ctx.params.gid), g = await groupOf(gid, uid, true), list = await readMsgs(gCol(gid));
    const after = Number(ctx.query.after) || 0, vis = after ? list.filter((m) => m.createdAt > after || m.editedAt > after || m.reactAt > after || m.deletedAt > after) : list;
    return { messages: vis, group: { id: gid, name: g.name, nowPlaying: g.nowPlaying || null, role: g.ownerUid === uid ? 'owner' : g.admins.includes(uid) ? 'admin' : 'member' }, serverTime: Date.now() };
  });
  A('POST', '/groups/:gid/send', [40, 60], async (ctx) => {
    const uid = ctx.user.uid, gid = okId(ctx.params.gid), g = await groupOf(gid, uid, true), p = await sendGuard(ctx, uid);
    const m = buildMsg(ctx, p, uid, { links: !!g.public }), col = gCol(gid), ref = await col.add(m);
    D().collection('groups').doc(gid).update({ last: { ...preview(m), name: p.appName || 'Player' } }).catch(() => {}); bust(col);
    return { message: { id: ref.id, ...m } };
  }, { maxBody: 330000 });
  A('POST', '/groups/:gid/song', [20, 60], async (ctx) => {
    const uid = ctx.user.uid, gid = okId(ctx.params.gid), g = await groupOf(gid, uid, true), p = await ensureProfile(uid);
    if (ctx.body.clear) { if (g.nowPlaying && g.nowPlaying.byUid !== uid && !isMod(g, uid)) throw new HttpError(403, 'forbidden', 'Only the person who added it or an admin can stop it'); await D().collection('groups').doc(gid).update({ nowPlaying: FieldValue.delete() }); return; }
    const url = clip(ctx.body.url, 500).trim(), title = clip(ctx.body.title || 'Untitled', 80).trim();
    if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new HttpError(400, 'bad_url', 'Enter a valid audio URL');
    await D().collection('groups').doc(gid).update({ nowPlaying: { url, title, by: p.appName || 'Player', byUid: uid, startAt: Date.now() } });
  });

  // ------------------------------------------------------------------ discover people
  const peopleCache = { t: 0, list: [] };
  A('GET', '/discover/people', [20, 60], async (ctx) => {
    const uid = ctx.user.uid;
    if (Date.now() - peopleCache.t > 30000) { const s = await D().collection('profiles').orderBy('createdAt', 'desc').limit(60).get(); peopleCache.list = s.docs.map((d) => d.data()).filter((p) => !p.banned && p.usernameLower && (p.privacy || 'public') !== 'private'); peopleCache.t = Date.now(); }
    const me = await getSocial(uid), skip = new Set([uid, ...me.friends, ...me.blocked, ...me.outgoing]);
    return { users: peopleCache.list.filter((p) => !skip.has(p.uid)).slice(0, 20).map((p) => card(p, p.uid)) };
  });

  return { ensureProfile, ensureUsername, getSocial, socInvalidate, isOn, seenOf, live, getProfiles, card };
}
