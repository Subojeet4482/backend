import { FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { svc, guard, logs, tg, roles, notifyAdmins, cfg } from './svc.js';
import { db, mainApp } from './fb.js';
import { env, HttpError } from './base.js';
import * as store from './store.js';
import { callInternal } from './internal.js';
import { esc, kb, webhookOk } from './tg.js';
import { listReqs } from './domreq.js';
import { checkKey } from './logkey.js';
import { purgeExpired } from './state.js';
import { LOG_PAGE } from './logpage.js';
import * as A from './adminapi.js';
import { adminLoginEnabled, checkAdminCreds, issueAdminToken, isAdminEmail } from './adminauth.js';
import * as W from './wallet.js';
import { registerUser } from './userapi.js';
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


// Sends the verify-email mail. Cooldown 60s per user (memory). Returns 'sent' | 'wait' | 'error'.
async function sendVerify(uid, idToken) {
  if (!(await store.once('ff:vmail:' + uid, 60))) return 'wait';
  try { await idp('accounts:sendOobCode', { requestType: 'VERIFY_EMAIL', idToken }); return 'sent'; }
  catch (e) { console.warn('verify mail failed:', e.message); await store.del('ff:vmail:' + uid); return 'error'; }
}

async function ensureProfile(uid, email, hint = {}) {
  const d = db.main(), ref = d.collection('users').doc(uid), s = await ref.get();
  if (s.exists) return s.data();
  const p = (await d.collection('pending_profiles').doc(uid).get()).data() || {};
  let playerId = '';
  for (let i = 0; i < 20; i++) { playerId = String(Math.floor(1000000 + Math.random() * 9000000)); if ((await d.collection('users').where('playerId', '==', playerId).limit(1).get()).empty) break; }
  const doc = { appName: String(p.name || hint.name || email.split('@')[0]).replace(/[<>]/g, '').trim().slice(0, 30).padEnd(3, '_'), email, phone: p.phone || '', balance: 0, depositBalance: 0, withdrawBalance: 0, uid, playerId, joined_matches: [], score: 0, kills: 0, matchesPlayed: 0, matchesWon: 0, totalEarned: 0, gameName: '', gameUid: '', isUidVerified: false, photoUrl: /^https:\/\/\S{5,480}$/.test(hint.photoUrl || '') ? hint.photoUrl : '', nameChangesLeft: 2, createdAt: Date.now() };
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
    let r, again = false;
    try { r = await idp('accounts:signUp', { email, password, returnSecureToken: true }); }
    catch (e) {
      if (e.code === 'WEAK_PASSWORD') throw new HttpError(400, 'weak_password', 'Password too weak');
      if (e.code !== 'EMAIL_EXISTS') throw new HttpError(502, 'auth_unavailable', 'Registration unavailable (' + e.code + ')');
      // Email already in Firebase. If it was never verified and the password matches, just send the link again (user is stuck otherwise).
      try { r = await idp('accounts:signInWithPassword', { email, password, returnSecureToken: true }); again = true; }
      catch { throw new HttpError(409, 'email_exists', 'This email is already registered. Please login (or use Forgot password).'); }
      const look = await idp('accounts:lookup', { idToken: r.idToken }).catch(() => ({}));
      if (look.users?.[0]?.emailVerified) throw new HttpError(409, 'email_exists', 'This email is already registered. Please login.');
    }
    const mail = await sendVerify(r.localId, r.idToken);
    if (mail === 'error') throw new HttpError(502, 'mail_failed', 'Account created but the verification email could not be sent. Tap Register again in a minute to resend.');
    await db.main().collection('pending_profiles').doc(r.localId).set({ name, phone, email, at: Date.now(), ip: ctx.ip });
    await logs.ipLog('register', { uid: r.localId, ip: ctx.ip, ua: ctx.ua, email, resend: again });
    return { uid: r.localId, message: mail === 'wait' ? 'Verification link was sent a moment ago. Check your inbox and Spam.' : 'Verification email sent' };
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
    if (!look.users?.[0]?.emailVerified) {
      const mail = await sendVerify(r.localId, r.idToken);
      throw new HttpError(403, 'email_not_verified', mail === 'sent' ? 'Email not verified. We just sent a new verification link - open it, then login again (check Spam too).' : mail === 'wait' ? 'Email not verified. A verification link was sent a moment ago - check your inbox and Spam.' : 'Email not verified and the verification mail could not be sent. Try again in a minute.');
    }
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


  // Google sign-in: the app gets a Google access token (Google Identity Services popup) and sends it here.
  // We exchange it with Firebase Auth (signInWithIdp), create the profile on first login, and hand back a custom token like /auth/login does.
  svc.add('POST', '/auth/google', { rl: [20, 60] }, async (ctx) => {
    const at = String(ctx.body.accessToken || '').trim();
    if (at.length < 20 || at.length > 4096 || /[\s&=]/.test(at)) throw new HttpError(400, 'bad_input', 'Google sign-in failed. Try again.');
    let r;
    try { r = await idp('accounts:signInWithIdp', { postBody: `access_token=${encodeURIComponent(at)}&providerId=google.com`, requestUri: env('FIREBASE_REFERER') || String(ctx.req.headers.origin || 'http://localhost'), returnIdpCredential: true, returnSecureToken: true }); }
    catch (e) {
      if (e.code === 'USER_DISABLED') throw new HttpError(403, 'disabled', 'Account disabled');
      if (/INVALID_IDP_RESPONSE|INVALID_CREDENTIAL/.test(e.message)) throw new HttpError(401, 'google_invalid', 'Google sign-in expired. Try again.');
      if (/OPERATION_NOT_ALLOWED/.test(e.message)) throw new HttpError(503, 'google_off', 'Google sign-in is not enabled for this app yet.');
      console.error('google idp', e.message); throw new HttpError(502, 'auth_unavailable', 'Google sign-in unavailable');
    }
    if (r.needConfirmation || !r.localId) throw new HttpError(409, 'use_password', 'This email already has a password account. Login with email & password.');
    const email = String(r.email || '').toLowerCase();
    if (!EMAIL_RE.test(email) || r.emailVerified === false) throw new HttpError(403, 'email_not_verified', 'Your Google email is not verified');
    const u = await ensureProfile(r.localId, email, { name: r.displayName || r.fullName, photoUrl: r.photoUrl });
    if (W.isBanned(u)) throw new HttpError(403, 'banned', 'Your account is banned');
    await logs.ipLog('login_google', { uid: r.localId, ip: ctx.ip, ua: ctx.ua });
    const customToken = await getAuth(mainApp()).createCustomToken(r.localId);
    return { customToken, uid: r.localId, isNew: !!r.isNewUser };
  });

  // ---------- READ (replaces heavy onSnapshot listeners) ----------
  svc.add('GET', '/me', { auth: 'user', rl: [60, 60] }, async (ctx) => {
    const s = await db.main().collection('users').doc(ctx.user.uid).get();
    if (s.exists) return { user: s.data() };
    // first login after email verification: create the profile here (login itself happens directly on Firebase in the panel)
    const em = String(ctx.user.email || '').toLowerCase();
    if (!EMAIL_RE.test(em)) throw new HttpError(404, 'no_user', 'Profile missing');
    if (ctx.user.email_verified === false) throw new HttpError(403, 'email_not_verified', 'Email not verified. Open the verification link first.');
    return { user: await ensureProfile(ctx.user.uid, em, { name: ctx.user.name, photoUrl: ctx.user.picture }) };
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

  // ---------- ADMIN PANEL LOGIN: email + password + PIN from Render env ----------
  // Panel sends them here; on success it gets a signed session token (Authorization: Bearer ...) valid on core AND /chat admin routes.
  // Rules: 5 wrong tries from one IP (within 1h) -> IP blocked 24h. 10 wrong tries on a real admin email -> that admin email locked 24h
  // (even the right password is refused during the lock; an owner can unlock with the bot command /unlockadmin <email>).
  svc.add('POST', '/admin/login', { rl: [10, 60] }, async (ctx) => {
    if (!adminLoginEnabled()) throw new HttpError(503, 'admin_login_off', 'Admin login is not configured');
    const email = String(ctx.body.email || '').trim().toLowerCase().slice(0, 254), known = isAdminEmail(email);
    const gk = known ? 'admin:' + email : 'admin:unknown', cc = { ...ctx.cfg, loginIpMax: 5, loginBlockHours: 24, loginEmailMax: 10, loginEmailLockMin: 1440 };
    if (known && (await guard.emailLocked(gk, cc))) throw new HttpError(429, 'account_locked', 'This admin account is locked for 24 hours after too many wrong attempts.');
    const acct = await checkAdminCreds({ email, password: String(ctx.body.password || '').slice(0, 256), pin: String(ctx.body.pin || '').slice(0, 32) });
    if (!acct) {
      const f = await guard.loginFail(ctx.ip, gk, cc);
      await logs.ipLog('admin_login_fail', { ip: ctx.ip, ua: ctx.ua, email: email.slice(0, 80), left: f.left });
      if (f.blocked) {
        await notifyAdmins(`🚫 <b>IP blocked</b> (admin panel login) for 24h\nIP: <code>${esc(ctx.ip)}</code>`, kb([[['✅ Unblock', 'ip:u:' + ctx.ip]]]));
        throw new HttpError(403, 'ip_blocked', 'Too many wrong attempts. Blocked for 24 hours.');
      }
      if (known && f.emailFails >= 10) {
        await guard.lockEmail(gk, 1440, f.emailFails);
        await logs.audit('admin_email_locked', email, { ip: ctx.ip });
        await notifyAdmins(`🔒 <b>Admin account locked 24h</b>\n${esc(email)}\n10 wrong login attempts. Last IP: <code>${esc(ctx.ip)}</code>\nUnlock: <code>/unlockadmin ${esc(email)}</code> (owner)`);
        throw new HttpError(429, 'account_locked', 'This admin account is locked for 24 hours after too many wrong attempts.');
      }
      throw new HttpError(401, 'invalid_credentials', 'Invalid email, password or PIN', { attemptsLeft: f.left });   // never say which one was wrong
    }
    await guard.loginOk(ctx.ip, gk);
    const t = issueAdminToken(acct);
    await logs.audit('admin_login', acct.email, { ip: ctx.ip, ua: String(ctx.ua || '').slice(0, 120) });
    notifyAdmins(`🔐 <b>Admin panel login</b>\n${esc(acct.email)}\nIP: <code>${esc(ctx.ip)}</code>`).catch(() => {});
    return { token: t.token, expiresAt: t.expiresAt, email: acct.email };
  });
  svc.add('GET', '/admin/me', { auth: 'admin', rl: [60, 60] }, async (ctx) => ({ email: ctx.user.email, expiresAt: ctx.user.exp || null }));

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
    const u = s.data(); return { exists: true, banned: W.isBanned(u), appName: u.appName || '', photoUrl: u.photoUrl || '', isVerified: !!u.isVerified };
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
  registerUser(svc, { notifyAdmins, logs, verifyPassword: (email, password) => idp('accounts:signInWithPassword', { email, password, returnSecureToken: false }) });

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
