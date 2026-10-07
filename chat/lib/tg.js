import { env, safeEq } from './base.js';
export const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
export const kb = (rows) => ({ inline_keyboard: rows.map((r) => r.map(([text, cb]) => ({ text, callback_data: cb }))) });
export const adminIds = () => env('ADMIN_TG_IDS').split(',').map((s) => s.trim()).filter(Boolean);
// Strangers get a reply (their Telegram ID) ONLY during setup: no owner configured yet, or SETUP_SHOW_ID=1.
// Otherwise the bot stays silent to anyone who is not an admin.
export const showIdToStrangers = () => env('SETUP_SHOW_ID') === '1' || !(env('OWNER_TG_IDS') || env('ADMIN_TG_IDS')).trim();
export function webhookOk(req) { const s = env('TG_WEBHOOK_SECRET'); return !!s && safeEq(req.headers['x-telegram-bot-api-secret-token'] || '', s); }
export function makeTg(token) {
  const call = async (method, payload) => {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000) });
    return r.json().catch(() => ({}));
  };
  return {
    call,
    send: (chat_id, text, kbd) => call('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: kbd }),
    edit: (chat_id, message_id, text, kbd) => call('editMessageText', { chat_id, message_id, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: kbd }),
    answer: (id, text) => call('answerCallbackQuery', { callback_query_id: id, text: text || '' }),
    async download(file_id) {
      const g = await call('getFile', { file_id });
      if (!g.ok) throw new Error('Telegram getFile failed: ' + (g.description || 'error'));
      const r = await fetch(`https://api.telegram.org/file/bot${token}/${g.result.file_path}`, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error('download failed ' + r.status);
      return Buffer.from(await r.arrayBuffer());
    },
    async sendDoc(chat_id, filename, buf, caption) {
      const f = new FormData(); f.append('chat_id', String(chat_id)); if (caption) f.append('caption', caption);
      f.append('document', new Blob([buf]), filename);
      const r = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: f, signal: AbortSignal.timeout(30000) });
      return r.json().catch(() => ({}));
    },
  };
}
export const notify = (tg, ids, text, kbd) => Promise.all(ids.map((id) => tg.send(id, text, kbd).catch(() => {})));
// Multi-step confirmation screen. n = current step, total = steps, next = callback for "continue".
export function ladder({ n, total, title, body = '', next, cancel = 'm:home', danger = true }) {
  const last = n === total;
  const yes = [last ? (danger ? '🔴 YES, DO IT NOW' : '✅ YES, RUN') : '✅ Continue', next], no = ['✖ Cancel', cancel];
  return { text: `⚠️ <b>Confirm ${n}/${total}</b>\n${title}${body ? '\n\n' + body : ''}${last && danger ? '\n\n<b>This cannot be undone.</b>' : ''}`, kb: kb([n % 2 ? [yes, no] : [no, yes]]) };
}
