// Service-to-service calls (core <-> chat): HMAC-SHA256 signed, 60s window.
import crypto from 'node:crypto';
import { env, sha, safeEq, HttpError } from './base.js';
const sign = (ts, method, path, body) => crypto.createHmac('sha256', env('INTERNAL_SECRET')).update(`${ts}.${method}.${path}.${sha(JSON.stringify(body || {}))}`).digest('hex');
export async function callInternal(base, path, body = {}, timeoutMs = 4000) {
  if (!base || !env('INTERNAL_SECRET')) throw new Error('internal link not configured');
  const ts = Date.now();
  const r = await fetch(base.replace(/\/+$/, '') + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-ts': String(ts), 'x-sig': sign(ts, 'POST', path, body) }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j?.error?.message || 'internal ' + r.status);
  return j;
}
export function verifyInternal(req, body) {
  const ts = Number(req.headers['x-ts']); const sig = String(req.headers['x-sig'] || '');
  if (!env('INTERNAL_SECRET') || !ts || Math.abs(Date.now() - ts) > 60000) throw new HttpError(401, 'bad_internal', 'Unauthorized');
  const path = new URL(req.url, 'http://x').pathname;
  if (!safeEq(sig, sign(ts, req.method, path, body))) throw new HttpError(401, 'bad_internal', 'Unauthorized');
}
