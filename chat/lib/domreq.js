// Domain allow-list UI shared by both bots: allowed list, "last 10 rejected requests" with accept/reject, 3-step accept.
import { sha } from './base.js';
import { kb, esc, ladder } from './tg.js';
export const h8 = (o) => sha(o).slice(0, 8);
export async function listReqs(cfg) {
  const seen = new Set();
  return (await cfg.reqList()).filter((x) => x && !seen.has(x.o) && seen.add(x.o)).slice(0, 10);
}
const BACK = [['⬅️ Menu', 'm:home']];
const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago'; };

export function makeDomainUI({ cfg, audit }) {
  const dropReq = async (o) => cfg.reqSet((await cfg.reqList()).filter((x) => x.o !== o));
  const views = {
    async list() {
      const c = await cfg.get(), l = c.allowedOrigins || [];
      return { text: `🌐 <b>Allowed domains</b>\nOnly these can send requests.\n${l.map((x) => '• ' + esc(x)).join('\n') || '— none (env ALLOWED_ORIGINS only)'}`, kb: kb([[['➕ Add domain', 'dm:add']], ...l.map((x, i) => [[('🗑 ' + x).slice(0, 40), `dm:rm:${i}:1`]]), [['📨 Last 10 requests', 'dr:l']], BACK]) };
    },
    async reqs() {
      const l = await listReqs(cfg);
      if (!l.length) return { text: '📨 <b>Domain requests</b>\nNo blocked requests yet ✅', kb: kb([[['🔄 Refresh', 'dr:l']], [['⬅️ Domains', 'dm:l']], BACK]) };
      return { text: '📨 <b>Last requests from unknown domains</b>\nThey were blocked. Accept = that domain can use the server.\n\n' + l.map((x, i) => `${i + 1}. <code>${esc(x.o)}</code> • ${ago(x.t)} • ${esc(x.ip || '')}`).join('\n'), kb: kb([...l.map((x, i) => [[`${i + 1}. ${x.o}`.slice(0, 40), 'dr:v:' + h8(x.o)]]), [['🔄 Refresh', 'dr:l']], [['⬅️ Domains', 'dm:l']], BACK]) };
    },
  };
  async function find(h) { return (await listReqs(cfg)).find((x) => h8(x.o) === h); }
  // returns a view, or null when the callback isn't ours. ctx: {actor, state, chatId}
  async function cb(ns, act, rest, ctx) {
    if (ns === 'dm' && act === 'l') return views.list();
    if (ns === 'dr' && act === 'l') return views.reqs();
    if (ns === 'dr' && act === 'v') {
      const r = await find(rest[0]); if (!r) return views.reqs();
      return { text: `📨 <b>Blocked request</b>\nDomain: <code>${esc(r.o)}</code>\nWhen: ${ago(r.t)}\nIP: <code>${esc(r.ip || '-')}</code>`, kb: kb([[['✅ Accept', `dr:a:${rest[0]}:1`], ['❌ Reject', `dr:r:${rest[0]}:1`]], [['⬅️ Back', 'dr:l']]]) };
    }
    if (ns === 'dr' && act === 'a') {
      const h = rest[0], step = Number(rest[1]), r = await find(h); if (!r) return views.reqs();
      if (step < 9) return ladder({ n: step, total: 3, title: `Accept domain <code>${esc(r.o)}</code>?`, body: step === 1 ? 'This domain will be allowed to send requests to the server.' : step === 2 ? 'Anyone controlling that website can then call your API with their own users.' : 'Last chance. Only accept a domain you own.', next: `dr:a:${h}:${step === 1 ? 2 : step === 2 ? 3 : 9}`, cancel: 'dr:l', danger: false });
      const c = await cfg.get(); await cfg.set({ allowedOrigins: [...new Set([...(c.allowedOrigins || []), r.o])], deniedOrigins: (c.deniedOrigins || []).filter((x) => x !== r.o) });
      await dropReq(r.o); await audit('domain_accept', ctx.actor, { o: r.o });
      return { text: `✅ Accepted <code>${esc(r.o)}</code>\nIt can send requests now (within ~30 s).`, kb: kb([[['📨 Requests', 'dr:l']], BACK]) };
    }
    if (ns === 'dr' && act === 'r') {
      const h = rest[0], step = Number(rest[1]), r = await find(h); if (!r) return views.reqs();
      if (step < 9) return ladder({ n: 1, total: 1, title: `Reject <code>${esc(r.o)}</code>?`, body: 'It will be blocked silently from now on.', next: `dr:r:${h}:9`, cancel: 'dr:l', danger: false });
      const c = await cfg.get(); await cfg.set({ deniedOrigins: [...new Set([...(c.deniedOrigins || []), r.o])] }); await dropReq(r.o); await audit('domain_reject', ctx.actor, { o: r.o });
      return { text: `❌ Rejected <code>${esc(r.o)}</code>`, kb: kb([[['📨 Requests', 'dr:l']], BACK]) };
    }
    if (ns === 'dm' && act === 'rm') {
      const i = Number(rest[0]), step = Number(rest[1]), c = await cfg.get(), l = c.allowedOrigins || [], o = l[i]; if (!o) return views.list();
      if (step < 9) return ladder({ n: step, total: 2, title: `Remove <code>${esc(o)}</code>?`, body: step === 1 ? 'Requests from this domain will stop working.' : 'Your website/app on this domain may break.', next: step === 1 ? `dm:rm:${i}:2` : `dm:rm:${i}:9`, cancel: 'dm:l', danger: false });
      await cfg.set({ allowedOrigins: l.filter((x) => x !== o) }); await audit('domain_remove', ctx.actor, { o });
      return { text: `🗑 Removed <code>${esc(o)}</code>`, kb: kb([[['🌐 Domains', 'dm:l']], BACK]) };
    }
    if (ns === 'dm' && act === 'add') { await ctx.state.set(ctx.chatId, { mode: 'dom_add' }); return { text: '➕ Send the domain now, e.g. <code>https://myapp.com</code>\n/cancel to abort.', kb: kb([[['✖ Cancel', 'm:home']]]) }; }
    if (ns === 'dm' && act === 'ad') {
      const st = await ctx.state.get(ctx.chatId), step = Number(rest[0]); if (!st || st.mode !== 'dom_add_c') return { text: 'Expired. Start again.', kb: kb([[['🌐 Domains', 'dm:l']]]) };
      if (step < 9) return ladder({ n: step, total: 3, title: `Add domain <code>${esc(st.origin)}</code>?`, body: ['', 'It will be able to send requests to the server.', 'Make sure you own this domain.', 'Final check — correct spelling?'][step], next: step === 1 ? 'dm:ad:2' : step === 2 ? 'dm:ad:3' : 'dm:ad:9', cancel: 'dm:l', danger: false });
      const c = await cfg.get(); await cfg.set({ allowedOrigins: [...new Set([...(c.allowedOrigins || []), st.origin])], deniedOrigins: (c.deniedOrigins || []).filter((x) => x !== st.origin) });
      await ctx.state.clear(ctx.chatId); await audit('domain_add', ctx.actor, { o: st.origin });
      return { text: `✅ Added <code>${esc(st.origin)}</code>`, kb: kb([[['🌐 Domains', 'dm:l']], BACK]) };
    }
    return null;
  }
  // text typed after "Add domain"
  async function onText(text, ctx) {
    let o; try { const u = new URL(text.trim()); if (!['https:', 'http:'].includes(u.protocol)) throw 0; o = u.origin.toLowerCase(); } catch { return { text: '❌ Not a valid URL. Example: <code>https://myapp.com</code>', kb: kb([[['✖ Cancel', 'm:home']]]) }; }
    await ctx.state.set(ctx.chatId, { mode: 'dom_add_c', origin: o });
    return ladder({ n: 1, total: 3, title: `Add domain <code>${esc(o)}</code>?`, body: 'Only domains you own should be added.', next: 'dm:ad:2', cancel: 'dm:l', danger: false });
  }
  return { views, cb, onText, pendingCount: async () => (await listReqs(cfg)).length };
}
