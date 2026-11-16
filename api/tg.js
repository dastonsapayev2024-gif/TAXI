'use strict';
const crypto = require('crypto');
const { esc, tg, token, secret } = require('./_lib');

const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const who = u => esc([u.first_name, u.last_name].filter(Boolean).join(' ') || 'Haydovchi') + (u.username ? ' (@' + esc(u.username) + ')' : '');

module.exports = async (req, res) => {
  res.setHeader('cache-control', 'no-store');
  // Bir martalik o'rnatish: brauzerda /api/tg?setup=SETUP_KEY ochiladi
  if (req.method === 'GET') {
    const key = String((req.query && req.query.setup) || '');
    const want = String(process.env.SETUP_KEY || '');
    if (!want || !key || !same(key, want)) return res.status(403).send('Ruxsat yo‘q');
    try {
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
      const r = await tg('setWebhook', { url: 'https://' + host + '/api/tg', secret_token: secret(), allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
      return res.status(200).send(r && r.ok ? 'OK: bot ulandi ✅' : 'Xato: ' + JSON.stringify(r));
    } catch (e) { return res.status(500).send('Xato: ' + e.message); }
  }
  if (req.method !== 'POST') return res.status(405).end();
  if (!same(req.headers['x-telegram-bot-api-secret-token'] || '', secret())) return res.status(401).end();
  const up = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  try {
    if (up.message && up.message.text) {
      const m = up.message, t = m.text.trim();
      if (/^\/id(@\w+)?$/.test(t)) await tg('sendMessage', { chat_id: m.chat.id, text: 'Chat ID: ' + m.chat.id });
      else if (/^\/start/.test(t) && m.chat.type === 'private') {
        const app = String(process.env.APP_LINK || '').trim();
        await tg('sendMessage', { chat_id: m.chat.id, text: '🚕 Taksi buyurtma qilish uchun pastdagi tugmani bosing.',
          reply_markup: app ? { inline_keyboard: [[{ text: '🚕 Taksi chaqirish', url: app }]] } : undefined });
      }
    }
    const q = up.callback_query;
    if (q && q.data && q.message) {
      const d = q.data.split(':'), from = q.from;
      if (d[0] === 'a') {
        const [, id, uid, ph] = d;
        const already = JSON.stringify(q.message.reply_markup || '').includes('Qabul qildi');
        if (already) return (await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Bu buyurtmani boshqa haydovchi oldi', show_alert: true }), res.status(200).end());
        if (from.is_bot) return res.status(200).end();
        await tg('editMessageReplyMarkup', { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: [
          [{ text: '✅ Qabul qildi: ' + [from.first_name, from.username ? '@' + from.username : ''].filter(Boolean).join(' ').slice(0, 40), callback_data: 'x' }],
          [{ text: '📞 Yo‘lovchi raqami', callback_data: 'p:' + id + ':' + uid + ':' + ph + ':' + from.id }]
        ] } });
        await tg('answerCallbackQuery', { callback_query_id: q.id, text: '✅ Buyurtma sizniki!\n📞 +998' + ph, show_alert: true });
        if (+uid > 0) await tg('sendMessage', { chat_id: +uid, parse_mode: 'HTML', text: '🚕 Haydovchi topildi: <b>' + who(from) + '</b>\nBuyurtma #' + esc(id) + '. Tez orada siz bilan bog‘lanadi.' }).catch(() => {});
      } else if (d[0] === 'p') {
        const [, id, uid, ph, drv] = d;
        if (String(from.id) === drv) await tg('answerCallbackQuery', { callback_query_id: q.id, text: '📞 +998' + ph + '\nBuyurtma #' + id, show_alert: true });
        else await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Bu buyurtmani boshqa haydovchi oldi', show_alert: true });
      } else await tg('answerCallbackQuery', { callback_query_id: q.id });
    }
  } catch (e) { /* Telegram qayta yubormasligi uchun 200 qaytaramiz */ }
  return res.status(200).end();
};
