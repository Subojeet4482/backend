// Live settings (domains, maintenance, limits) in Firestore doc config/security, cached 30s. Bots edit it.
// Also keeps the "last 10 requests from unknown domains" list in config/domreq.
export function makeCfg(getDb, defaults) {
  let c = null, t = 0;
  const reqRef = () => getDb().collection('config').doc('domreq');
  return {
    async get() {
      if (c && Date.now() - t < 30000) return c;
      try { const s = await getDb().collection('config').doc('security').get(); c = { ...defaults, ...(s.exists ? s.data() : {}) }; }
      catch (e) { console.warn('cfg', e.message); c = c || { ...defaults }; }
      t = Date.now(); return c;
    },
    async set(patch) { await getDb().collection('config').doc('security').set(patch, { merge: true }); c = null; },
    async reqPush(entry) {
      const db = getDb(), ref = reqRef();
      await db.runTransaction(async (tx) => {
        const s = await tx.get(ref), list = (s.exists ? s.data().list : null) || [];
        const old = list.find((x) => x.o === entry.o); if (old && Date.now() - old.t < 300000) return;
        tx.set(ref, { list: [entry, ...list.filter((x) => x.o !== entry.o)].slice(0, 10) });
      });
    },
    async reqList() { const s = await reqRef().get(); return (s.exists ? s.data().list : null) || []; },
    async reqSet(list) { await reqRef().set({ list }); },
  };
}
