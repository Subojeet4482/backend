import crypto from 'node:crypto';
export const env = (k, d = '') => process.env[k] ?? d;
export class HttpError extends Error {
  constructor(status, code, message, extra) { super(message || code); this.status = status; this.code = code; this.extra = extra || {}; }
}
export const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 24);
export const safeEq = (a, b) => {
  a = Buffer.from(String(a)); b = Buffer.from(String(b));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
export function clientIp(req) {
  const h = req.headers;
  return String(h['x-real-ip'] || h['x-vercel-forwarded-for'] || (h['x-forwarded-for'] || '').split(',')[0] || req.socket?.remoteAddress || '0.0.0.0').trim();
}
export const r2 = (n) => Math.round(Number(n) * 100) / 100;
