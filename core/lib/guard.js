// IP blocking + login-failure tracking, all in Firestore (survives restarts, shared by every instance).
//  - ip_blocks/{sha(ip)}      : blocked IPs. Loaded as one small query, cached 30 s per instance -> ~2 reads/min, not per request.
//  - login_fails/{ip_*|em_*}  : failure counters. Written ONLY on a wrong password (cheap), expire by themselves.
import { sha } from './base.js';
export function makeGuard(getDb) {
  let blocks = new Map(), loadedAt = 0, loading = null;
  const col = () => getDb().collection('ip_blocks');
  const fails = () => getDb().collection('login_fails');
  async function refresh() {
    if (Date.now() - loadedAt < 30000) return;
    if (loading) return loading;
    loading = (async () => {
      try { const s = await col().where('until', '>', Date.now()).limit(500).get(); const m = new Map(); s.docs.forEach((d) => { const x = d.data(); m.set(x.ip, x.until); }); blocks = m; }
      catch (e) { console.warn('blocklist', e.message); }
      loadedAt = Date.now(); loading = null;
    })();
    return loading;
  }
  const bump = (id, ttlSec) => {
    const ref = fails().doc(id);
    return getDb().runTransaction(async (tx) => {
      const s = await tx.get(ref), now = Date.now();
      let n = 1, exp = now + ttlSec * 1000;
      if (s.exists && s.data().exp > now) { n = s.data().n + 1; exp = s.data().exp; }
      tx.set(ref, { n, exp }); return n;
    });
  };
  const g = {
    async isBlocked(ip) { await refresh(); const u = blocks.get(ip); return !!u && u > Date.now(); },
    async block(ip, seconds, reason) {
      const until = Date.now() + seconds * 1000; blocks.set(ip, until);
      await col().doc(sha(ip)).set({ ip, until, reason: reason || '', at: Date.now() });
    },
    async unblock(ip) { blocks.delete(ip); await Promise.all([col().doc(sha(ip)).delete(), fails().doc('ip_' + sha(ip)).delete()]); },
    async list() { return (await col().where('until', '>', Date.now()).limit(10).get()).docs.map((d) => d.data()); },
    async loginFail(ip, email, c) {
      const max = c.loginIpMax || 5;
      const n = await bump('ip_' + sha(ip), 3600), en = await bump('em_' + sha(email), (c.loginEmailLockMin || 30) * 60);
      let blocked = false;
      if (n >= max) { await g.block(ip, (c.loginBlockHours || 24) * 3600, 'login_fail'); blocked = true; }
      return { fails: n, left: Math.max(max - n, 0), blocked, emailFails: en };
    },
    async emailLocked(email, c) {
      const s = await fails().doc('em_' + sha(email)).get();
      return s.exists && s.data().exp > Date.now() && s.data().n >= (c.loginEmailMax || 10);
    },
    async loginOk(ip, email) {                       // reset counters, but only write if something exists
      const refs = [fails().doc('ip_' + sha(ip)), fails().doc('em_' + sha(email))], snaps = await Promise.all(refs.map((r) => r.get()));
      await Promise.all(snaps.map((s, i) => (s.exists ? refs[i].delete() : null)));
    },
  };
  return g;
}
