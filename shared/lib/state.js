// Per-admin conversation state + "run once" claims for Telegram updates, in Firestore (collection bot_state).
export function makeState(getDb) {
  const col = () => getDb().collection('bot_state');
  return {
    async get(id) { const s = await col().doc(String(id)).get(); const v = s.exists ? s.data() : null; return v && v.exp > Date.now() ? v : null; },
    async set(id, v) { await col().doc(String(id)).set({ ...v, exp: Date.now() + 15 * 60000 }); },
    async clear(id) { await col().doc(String(id)).delete().catch(() => {}); },
    // exactly-once: true for the first caller, false for every retry (Telegram re-sends slow webhooks)
    async claim(key) {
      try { await col().doc('c_' + String(key).replace(/[^A-Za-z0-9_-]/g, '')).create({ exp: Date.now() + 15 * 60000 }); return true; }
      catch (e) { if (e.code === 6 || /ALREADY_EXISTS/i.test(e.message || '')) return false; throw e; }
    },
  };
}
// delete expired helper docs (bot_state, login_fails). Run from the daily job.
export async function purgeExpired(getDb, cols = ['bot_state', 'login_fails']) {
  let n = 0;
  for (const c of cols) {
    try {
      const s = await getDb().collection(c).where('exp', '<', Date.now()).limit(400).get();
      if (s.empty) continue; const b = getDb().batch(); s.docs.forEach((d) => b.delete(d.ref)); await b.commit(); n += s.size;
    } catch (e) { console.warn('purge', c, e.message); }
  }
  return n;
}
