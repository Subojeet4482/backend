import { FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { svc, guard, logs, tg, roles, notifyAdmins, cfg } from './svc.js';
import { db, mainApp } from './fb.js';
import { env, HttpError } from './base.js';
import { callInternal } from './internal.js';
import { esc, kb, webhookOk } from './tg.js';
import { listReqs } from './domreq.js';
import { checkKey } from './logkey.js';
import { purgeExpired } from './state.js';
import { LOG_PAGE } from './logpage.js';
import * as A from './adminapi.js';
import * as W from './wallet.js';
import { handleUpdate } from './bot.js';
import { archiveOld, purgeIpLogs, cleanupPending, sendSnapshot } from './backup.js';

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const KEY = () => env('FIREBASE_WEB_API_KEY');
async function idp(endpoint, payload) {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/${endpoint}?key=${KEY()}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(env('FIREBASE_REFERER') ? { Referer: env('FIREBASE_REFERER') } : {}) }, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const m = j?.error?.message || 'UNKNOWN'; const e = new Error(m); e.code = m.split(' ')[0]; throw e; }
  return j;
}

async function ensureProfile(uid, email) {
  const d = db.main(), ref = d.collection('users').doc(uid), s = await ref.get();
  if (s.exists) return s.data();
  const p = (await d.collection('pending_profiles').doc(uid).get()).data() || {};
  let playerId = '';
  for (let i = 0; i < 20; i++) { playerId = String(Math.floor(1000000 + Math.random() * 9000000)); if ((await d.collection('users').where('playerId', '==', playerId).limit(1).get()).empty) break; }
  const doc = { appName: p.name || email.split('@')[0], email, phone: p.phone || '', balance: 0, depositBalance: 0, withdrawBalance: 0, uid, playerId, joined_matches: [], score: 0, kills: 0, matchesPlayed: 0, matchesWon: 0, totalEarned: 0, gameName: '', gameUid: '', isUidVerified: false, photoUrl: '', nameChangesLeft: 2, createdAt: Date.now() };
  await ref.set(doc); await d.collection('pending_profiles').doc(uid).delete().catch(() => {});
  try { await callInternal(env('CHAT_BASE_URL'), '/internal/profile-init', { uid, appName: doc.appName, photoUrl: '' }); } catch (e) { console.warn('chat profile-init', e.message); }
  return doc;
}

// short-lived caches so public lists don't burn Firestore reads
const cache = {};
async function cached(key, ttl, fn) { const c = cache[key]; if (c && Date.now() - c.t < ttl) return c.v; const v = await fn(); cache[key] = { v, t: Date.now() }; return v; }

export function registerAll() {
  // ---------- AUTH ----------
  svc.add('POST', '/auth/register', { rl: [5, 3600] }, async (ctx) => {
    const name = String(ctx.body.name || '').trim(), email = String(ctx.body.email || '').trim().toLowerCase(), phone = String(ctx.body.phone || '').replace(/\D/g, '').slice(-10), password = String(ctx.body.password || '');
    if (name.length < 3 || name.length > 30) throw new HttpError(400, 'bad_name', 'Name must be 3-30 characters');
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'bad_email', 'Enter a valid email');
    if (password.length < 8 || password.length > 128) throw new HttpError(400, 'weak_password', 'Password must be at least 8 characters');
    if (phone && phone.length !== 10) throw new HttpError(400, 'bad_phone', 'Enter a valid 10 digit phone');
    let r;
    try { r = await idp('accounts:signUp', { email, password, returnSecureToken: true }); }
    catch (e) {
      if (e.code === 'EMAIL_EXISTS') throw new HttpError(409, 'email_exists', 'Email already registered');
      if (e.code === 'WEAK_PASSWORD') throw new HttpError(400, 'weak_password', 'Password too weak');
      throw new HttpError(502, 'auth_unavailable', 'Registration unavailable');
    }
    await idp('accounts:sendOobCode', { requestType: 'VERIFY_EMAIL', idToken: r.idToken }).catch((e) => console.warn('verify mail', e.message));
    await db.main().collection('pending_profiles').doc(r.localId).set({ name, phone, email, at: Date.now(), ip: ctx.ip });
    await logs.ipLog('register', { uid: r.localId, ip: ctx.ip, ua: ctx.ua, email });
    return { uid: r.localId, message: 'Verification email sent' };
  });

  svc.add('POST', '/auth/login', { rl: [20, 60] }, async (ctx) => {
    const email = String(ctx.body.email || '').trim().toLowerCase(), password = String(ctx.body.password || ''), c = ctx.cfg;
    if (!EMAIL_RE.test(email) || password.length < 6 || password.length > 128) throw new HttpError(400, 'bad_input', 'Enter a valid email and password');
    if (await guard.emailLocked(email, c)) throw new HttpError(429, 'account_locked', `Too many attempts. Try again in ${c.loginEmailLockMin} minutes.`);
    let r;
    try { r = await idp('accounts:signInWithPassword', { email, password, returnSecureToken: true }); }
    catch (e) {
      if (['INVALID_PASSWORD', 'EMAIL_NOT_FOUND', 'INVALID_LOGIN_CREDENTIALS'].includes(e.code)) {
        const f = await guard.loginFail(ctx.ip, email, c);
        await logs.ipLog('login_fail', { ip: ctx.ip, ua: ctx.ua, email, left: f.left });
        if (f.blocked) {
          await notifyAdmins(`🚫 <b>IP blocked</b> for ${c.loginBlockHours}h\nIP: <code>${esc(ctx.ip)}</code>\nLast email: ${esc(email)}`, kb([[['✅ Unblock', 'ip:u:' + ctx.ip]]]));
          throw new HttpError(403, 'ip_blocked', `Too many wrong attempts. Blocked for ${c.loginBlockHours} hours.`);
        }
        throw new HttpError(401, 'invalid_credentials', 'Invalid email or password', { attemptsLeft: f.left });
      }
      if (e.code === 'USER_DISABLED') throw new HttpError(403, 'disabled', 'Account disabled');
      if (e.code === 'TOO_MANY_ATTEMPTS_TRY_LATER') throw new HttpError(429, 'rate_limited', 'Too many attempts. Try later.');
      console.error('login idp', e.message); throw new HttpError(502, 'auth_unavailable', 'Login unavailable');
    }
    const look = await idp('accounts:lookup', { idToken: r.idToken });
    if (!look.users?.[0]?.emailVerified) throw new HttpError(403, 'email_not_verified', 'Verify your email first (check Spam too)');
    const u = await ensureProfile(r.localId, email);
    if (W.isBanned(u)) throw new HttpError(403, 'banned', 'Your account is banned');
    await guard.loginOk(ctx.ip, email);
    await logs.ipLog('login', { uid: r.localId, ip: ctx.ip, ua: ctx.ua });
    const customToken = await getAuth(mainApp()).createCustomToken(r.localId);
    return { customToken, uid: r.localId };
  });

  svc.add('POST', '/auth/forgot', { rl: [5, 3600] }, async (ctx) => {
    const email = String(ctx.body.email || '').trim().toLowerCase();
    if (EMAIL_RE.test(email)) await idp('accounts:sendOobCode', { requestType: 'PASSWORD_RESET', email }).catch(() => {});
    await logs.ipLog('forgot', { ip: ctx.ip, ua: ctx.ua, email });
    return { message: 'If this email exists, a reset link was sent.' };
  });

  // ---------- READ (replaces heavy onSnapshot listeners) ----------
  svc.add('GET', '/me', { auth: 'user', rl: [60, 60] }, async (ctx) => {
    const s = await db.main().collection('users').doc(ctx.user.uid).get();
    if (!s.exists) throw new HttpError(404, 'no_user', 'Profile missing');
    return { user: s.data() };
  });
  svc.add('GET', '/matches', { auth: 'user', rl: [30, 60] }, async () => ({
    matches: await cached('matches', 15000, async () => (await db.main().collection('matches').limit(100).get()).docs.map((x) => {
      const m = x.data(); delete m.roomId; delete m.roomPass;
      m.participants = (m.participants || []).map((p) => ({ appName: p.appName, gameName: p.gameName, slot: p.slot }));
      return { id: x.id, ...m };
    })),
  }));
  svc.add('GET', '/leaderboard', { auth: 'user', rl: [20, 60] }, async () => ({
    users: await cached('lb', 60000, async () => (await db.main().collection('users').orderBy('score', 'desc').limit(50).select('appName', 'score', 'kills', 'matchesWon', 'photoUrl', 'playerId', 'totalEarned').get()).docs.map((x) => ({ uid: x.id, ...x.data() }))),
  }));

  // ---------- WALLET ----------
  svc.add('POST', '/wallet/withdraw', { auth: 'user', rl: [5, 60] }, async (ctx) => {
    const out = await W.requestWithdraw(ctx.user.uid, ctx.body, ctx);
    if (!out.dup) {
      await logs.ipLog('withdraw', { uid: ctx.user.uid, ip: ctx.ip, ua: ctx.ua, amount: out.amount, method: out.method });
      await notifyAdmins(`💸 <b>New withdrawal</b>\n${esc(out.name)} • ₹${out.amount} (net ₹${out.net}) • ${out.method}\n${esc(out.masked)}`, kb([[['👁 Open', `wd:v:${ctx.user.uid}:${out.id}`]]]));
    }
    return out;
  });
  svc.add('POST', '/wallet/deposit', { auth: 'user', rl: [10, 60] }, async (ctx) => {
    const out = await W.submitDeposit(ctx.user.uid, ctx.body, ctx);
    await logs.ipLog('deposit_submit', { uid: ctx.user.uid, ip: ctx.ip, ua: ctx.ua, amount: out.amount, utr: out.utr });
    return out;
  });
  svc.add('POST', '/wallet/deposit/check', { auth: 'user', rl: [30, 60] }, async (ctx) => {
    const out = await W.checkDeposit(ctx.user.uid, ctx.body.utr);
    if (out.status === 'success') await logs.ipLog('deposit_credit', { uid: ctx.user.uid, ip: ctx.ip, ua: ctx.ua, amount: out.amount, utr: ctx.body.utr });
    return out;
  });
  svc.add('GET', '/wallet/history', { auth: 'user', rl: [30, 60] }, (ctx) => W.history(ctx.user.uid, { limit: ctx.query.limit, before: ctx.query.before, archive: ctx.query.archive === '1' }));

  // ---------- MATCH ----------
  svc.add('POST', '/match/join', { auth: 'user', rl: [10, 60] }, async (ctx) => {
    const out = await W.joinMatch(ctx.user.uid, ctx.body, ctx);
    await logs.ipLog('join', { uid: ctx.user.uid, ip: ctx.ip, ua: ctx.ua, matchId: out.matchId, fee: out.fee });
    return out;
  });
  svc.add('POST', '/match/slot', { auth: 'user', rl: [10, 60] }, (ctx) => W.pickSlot(ctx.user.uid, ctx.body));
  svc.add('GET', '/match/:id/room', { auth: 'user', rl: [20, 60] }, (ctx) => W.roomFor(ctx.user.uid, ctx.params.id));

  // ---------- ADMIN (panel + same logic the Telegram bot uses) ----------
  svc.add('GET', '/admin/withdrawals', { auth: 'admin' }, async () => ({ items: await W.pendingWithdrawals(20) }));
  svc.add('POST', '/admin/withdrawals/decide', { auth: 'admin', rl: [60, 60] }, async (ctx) => {
    const out = await W.decideWithdraw({ uid: String(ctx.body.uid), trxId: String(ctx.body.trxId), decision: ctx.body.decision, actor: ctx.user.email });
    await logs.audit('withdraw_' + ctx.body.decision, ctx.user.email, { uid: ctx.body.uid, trxId: ctx.body.trxId, ip: ctx.ip, ...out });
    return out;
  });
        svc.add('GET', '/admin/blocked', { auth: 'admin' }, async () => ({ items: await guard.list() }));
  svc.add('POST', '/admin/unblock', { auth: 'admin' }, async (ctx) => { await guard.unblock(String(ctx.body.ip)); await logs.audit('unblock', ctx.user.email, { ip: ctx.body.ip }); });

  // ---------- INTERNAL (chat service <-> core) ----------
  svc.add('POST', '/internal/ping', { auth: 'internal' }, async () => ({ service: 'core', time: Date.now() }));
  svc.add('POST', '/internal/user-status', { auth: 'internal' }, async (ctx) => {
    const s = await db.main().collection('users').doc(String(ctx.body.uid)).get();
    if (!s.exists) return { exists: false, banned: true };
    const u = s.data(); return { exists: true, banned: W.isBanned(u), appName: u.appName || '', photoUrl: u.photoUrl || '' };
  });

  // ---------- TELEGRAM + CRON ----------
  svc.add('POST', '/tg/webhook', { origin: false, skipGuard: true }, async (ctx) => {
    if (!webhookOk(ctx.req)) { console.warn('[tg:%s] webhook REJECTED: secret mismatch (Render TG_WEBHOOK_SECRET %s)', 'core', env('TG_WEBHOOK_SECRET') ? 'is set' : 'is EMPTY'); throw new HttpError(401, 'bad_secret', 'Unauthorized'); }
    try { await handleUpdate(ctx.body); } catch (e) { console.error('tg', e); }
  });
  svc.add('GET', '/cron/daily', { auth: 'cron' }, async () => {
    const a = await archiveOld({}), p = await purgeIpLogs(), u = await cleanupPending(); let mr = {}; try { mr = await A.monthlyReward(); } catch (e) { console.error('monthly reward', e); }
    await purgeExpired(() => db.main());
    await notifyAdmins(`🗄 <b>Daily job</b>\nArchived tx: ${a.archived}\nIP logs purged: ${p}\nUnverified accounts removed: ${u}${mr.rewarded ? `\nMonthly rewards: ${mr.rewarded}` : ''}`);
    return { archived: a.archived, purged: p, unverified: u };
  });
  svc.add('GET', '/cron/weekly', { auth: 'cron' }, async () => ({ sent: await sendSnapshot(tg, await roles.recipients()) }));

  // ---------- ADMIN API v2 (panel: matches, users, ban, balance, deposits) ----------
  A.registerAdmin(svc, logs, { roles, tg });

  // ---------- INTERNAL: stop/start + admins sync come from the chat side too ----------
  svc.add('POST', '/internal/set-stopped', { auth: 'internal' }, async (ctx) => { await cfg.set({ stopped: !!ctx.body.stopped }); });

  // ---------- LOGS PAGE (temporary key from the bot, 10 min) ----------
  svc.add('GET', '/logs', { origin: false, always: true }, async () => ({ __html: LOG_PAGE }));
  svc.add('POST', '/logs/data', { origin: false, always: true, rl: [8, 60] }, async (ctx) => {
    const k = await checkKey(String(ctx.body.key || '').slice(0, 40));
    if (!k) { await logs.ipLog('logs_key_fail', { ip: ctx.ip, ua: ctx.ua }); throw new HttpError(401, 'bad_key', 'Invalid or expired key'); }
    const a = db.archive(), pick = async (c, n) => (await a.collection(c).orderBy('at', 'desc').limit(n).get()).docs.map((d) => d.data());
    const [events, audit, dreq, blocked] = await Promise.all([pick('ip_logs', 80), pick('audit_logs', 60), listReqs(cfg), guard.list()]);
    return { exp: k.exp, events, audit, dreq, blocked };
  });
}
