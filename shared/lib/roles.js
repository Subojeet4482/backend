// Owners = env OWNER_TG_IDS (can add/remove admins). Admins = Firestore config/admins (managed by owners via bot).
import { env } from './base.js';
export function makeRoles(getDb) {
  let c = null, t = 0;
  const owners = () => (env('OWNER_TG_IDS') || env('ADMIN_TG_IDS')).split(',').map((s) => s.trim()).filter(Boolean);
  const load = async () => {
    if (c && Date.now() - t < 20000) return c;
    let admins = []; try { const s = await getDb().collection('config').doc('admins').get(); admins = s.exists ? (s.data().ids || []).map(String) : []; } catch (e) { console.warn('roles', e.message); }
    c = { owners: owners(), admins }; t = Date.now(); return c;
  };
  return {
    get: load,
    isOwner: async (id) => (await load()).owners.includes(String(id)),
    isAdmin: async (id) => { const r = await load(), s = String(id); return r.owners.includes(s) || r.admins.includes(s); },
    recipients: async () => { const r = await load(); return [...new Set([...r.owners, ...r.admins])]; },
    setAdmins: async (ids) => { await getDb().collection('config').doc('admins').set({ ids: [...new Set(ids.map(String))] }); c = null; },
  };
}
