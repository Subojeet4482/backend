export function makeLogs(getDb) {
  const add = async (col, doc) => { try { await getDb().collection(col).add(doc); } catch (e) { console.warn('log', col, e.message); } };
  return {
    ipLog: (event, { uid, ip, ua, ...extra }) => add('ip_logs', { event, uid: uid || null, ip, ua: String(ua || '').slice(0, 200), at: Date.now(), ...extra }),
    audit: (action, actor, data = {}) => add('audit_logs', { action, actor: String(actor), data, at: Date.now() }),
  };
}
