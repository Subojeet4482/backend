// Tiny in-memory helper (per server instance) for cheap, short-lived things: rate-limit counters, cooldowns, de-dupe.
// Anything that must survive restarts / be shared (IP blocks, login-fail counters, domain requests, bot de-dupe)
// lives in Firestore instead (see guard.js, cfg.js, state.js). No Redis / Upstash needed.
export const persistent = false;
const mem = new Map();
const live = (k) => { const e = mem.get(k); if (!e) return null; if (e.x && e.x < Date.now()) { mem.delete(k); return null; } return e; };
let sweep = 0;
const gc = () => { if (++sweep % 500) return; const now = Date.now(); for (const [k, e] of mem) if (e.x && e.x < now) mem.delete(k); if (mem.size > 20000) mem.clear(); };
export async function incr(key, ttlSec) { gc(); let e = live(key); if (!e) { e = { v: 0, x: Date.now() + ttlSec * 1000 }; mem.set(key, e); } return ++e.v; }
export async function get(key) { const e = live(key); return e ? e.v : null; }
export async function set(key, val, ttlSec) { mem.set(key, { v: val, x: ttlSec ? Date.now() + ttlSec * 1000 : 0 }); }
export async function del(key) { mem.delete(key); }
export async function once(key, ttlSec) { gc(); if (live(key)) return false; mem.set(key, { v: 1, x: Date.now() + ttlSec * 1000 }); return true; }
