'use strict';
const crypto = require('crypto');
const { CFG, esc, tg, secret, fmt, closeGroup } = require('./_lib');
const db = require('./_db');

const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const nameOf = u => [u.first_name, u.last_name].filter(Boolean).join(' ').slice(0, 40) || 'Haydovchi';
const who = u => esc(nameOf(u)) + (u.username ? ' (@' + esc(u.username) + ')' : '');
const isAdmin = id => !!process.env.ADMIN_ID && String(id) === String(process.env.ADMIN_ID).trim();
let botName = '';
async function bot() { if (!botName) { const r = await tg('getMe', {}); botName = r && r.result ? r.result.username : ''; } return botName; }

const MENU = { keyboard: [[{ text: '💰 Balans' }, { text: '➕ To‘ldirish' }], [{ text: '📋 Buyurtmalarim' }, { text: '🚗 Mashinam' }], [{ text: 'ℹ️ Yordam' }]], resize_keyboard: true };
const send = (chat, text, extra) => tg('sendMessage', Object.assign({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }, extra || {}));
const alert_ = (q, text) => tg('answerCallbackQuery', { callback_query_id: q.id, text: String(text).slice(0, 190), show_alert: true });

const CAR_ASK = '🚗 Mashinangiz ma‘lumotini <b>bitta xabarda</b> yozing: markasi, rangi va davlat raqami.\nMasalan: <code>Cobalt, oq, 01 A 123 BC</code>\n\nYo‘lovchi sizni shu bo‘yicha taniydi.';
async function driverOf(id) { const r = await db.q('select * from drivers where tg_id=$1', [id]); return r.rows[0] || null; }

function rowsKeep(q) { // xabardagi "Yo'nalish" (url) tugmasini saqlab qolamiz
  const rows = (q.message.reply_markup && q.message.reply_markup.inline_keyboard) || [];
  return rows.filter(r => r.some(b => b.url));
}
const acceptKb = (id, keep) => ({ inline_keyboard: [[{ text: '✅ Qabul qilaman', callback_data: 'a:' + id }]].concat(keep) });
const takenKb = (id, name, keep) => ({ inline_keyboard: [
  [{ text: '✅ Qabul qildi: ' + name.slice(0, 40), callback_data: 'x' }],
  [{ text: '📞 Raqam', callback_data: 'p:' + id }, { text: '❌ Bekor', callback_data: 'c:' + id }, { text: '🏁 Tugadi', callback_data: 'd:' + id }]
].concat(keep) });

async function onPrivate(m) {
  const chat = m.chat.id, from = m.from, t = (m.text || '').trim();
  const admin = isAdmin(from.id);

  if (/^\/start(@\w+)?(\s+driver)?$/i.test(t)) {
    if (/driver/i.test(t)) {
      await db.q('insert into drivers(tg_id,name,username,free_left) values($1,$2,$3,$4) on conflict (tg_id) do update set name=case when drivers.phone<>\'\' then drivers.name else $2 end, username=$3', [from.id, nameOf(from), from.username || '', CFG.freeOrders]);
      const d = await driverOf(from.id);
      return send(chat, '🚕 <b>Xush kelibsiz, haydovchi ' + esc(nameOf(from)) + '!</b>\n\n' +
        '💼 Komissiya: faqat <b>' + CFG.feePct + '%</b> (boshqa xizmatlardan arzon)\n' +
        '🎁 Dastlabki <b>' + d.free_left + '</b> buyurtma komissiyasiz\n' +
        '💰 Balansingiz: <b>' + fmt(d.balance) + ' so‘m</b>\n\n' +
        'Buyurtmalarni <b>haydovchi ilovasida</b> ko‘rasiz va qabul qilasiz: raqam sizga ko‘rinadi, komissiya balansdan yechiladi. Noto‘g‘ri buyurtmani ' + CFG.cancelMin + ' daqiqa ichida bekor qilsangiz, komissiya qaytadi.', { reply_markup: MENU }).then(() => send(chat, '👇 Ilovani oching (birinchi marta mashina ma‘lumotini so‘raydi):', { reply_markup: { inline_keyboard: [[{ text: '🚕 Haydovchi ilovasi', web_app: { url: BASE + '/drv.html' } }]] } }));
    }
    return send(chat, '🚕 <b>Baxu Taksi</b>\n\nKim sifatida kirasiz? Pastdagi tugmalardan birini tanlang 👇',
      { reply_markup: { inline_keyboard: [[{ text: '🚖 Yo‘lovchiman', web_app: { url: BASE + '/' } }], [{ text: '🚕 Haydovchiman', web_app: { url: BASE + '/drv.html' } }]] } });
  }
  if (/^\/id(@\w+)?$/.test(t)) return send(chat, 'Chat ID: ' + chat);

  // ---- admin buyruqlari ----
  if (admin) {
    let m2;
    if (/^\/stat/.test(t)) {
      const a = (await db.q("select count(*) filter (where created>=date_trunc('day',now()))::int today, count(*) filter (where status in ('taken','done'))::int taken, count(*) filter (where status='done')::int done, coalesce(sum(fee_paid) filter (where taken_at>=date_trunc('day',now())),0)::bigint fee_today, coalesce(sum(fee_paid),0)::bigint fee_all from orders")).rows[0];
      const b = (await db.q("select count(*)::int n, coalesce(sum(balance),0)::bigint bal from drivers")).rows[0];
      return send(chat, '📊 <b>Statistika</b>\n\nBugun buyurtma: ' + a.today + '\nQabul qilingan (jami): ' + a.taken + ' · bajarilgan: ' + a.done + '\n💼 Bugungi komissiya: <b>' + fmt(a.fee_today) + '</b> so‘m\n💼 Jami komissiya: <b>' + fmt(a.fee_all) + '</b> so‘m\n\n👥 Haydovchilar: ' + b.n + '\n💰 Haydovchilar balansi yig‘indisi: ' + fmt(b.bal) + ' so‘m');
    }
    if ((m2 = t.match(/^\/add\s+(\d{4,15})\s+(-?\d{1,9})$/))) {
      const r = await db.fn('admin_add', m2[1], m2[2]);
      if (r.err) return send(chat, '❌ Haydovchi topilmadi');
      await send(m2[1], '💰 Balansingiz ' + (+m2[2] >= 0 ? 'to‘ldirildi: +' : 'o‘zgartirildi: ') + fmt(m2[2]) + ' so‘m. Yangi balans: <b>' + fmt(r.bal) + ' so‘m</b>').catch(() => {});
      return send(chat, '✅ Tayyor. Yangi balans: ' + fmt(r.bal) + ' so‘m');
    }
    if ((m2 = t.match(/^\/(block|unblock)\s+(\d{4,15})$/))) {
      await db.q('update drivers set blocked=$1 where tg_id=$2', [m2[1] === 'block', m2[2]]);
      return send(chat, m2[1] === 'block' ? '⛔ Bloklandi' : '✅ Blok olindi');
    }
    if (/^\/(panel|admin)$/.test(t)) return send(chat, '🛠 <b>Admin paneli</b> (xarita, statistika, haydovchilar, buyurtmalar):', { reply_markup: { inline_keyboard: [[{ text: '🛠 Panelni ochish', web_app: { url: BASE + '/admin.html' } }]] } });
    if (/^\/(help|yordam)$/.test(t)) return send(chat, '/panel — admin paneli\n/stat — statistika\n/add ID SUMMA — balans qo‘shish (minus ham mumkin)\n/block ID, /unblock ID');
  }

  // ---- haydovchi menyusi ----
  const d = await driverOf(from.id);
  if (!d) return send(chat, 'Haydovchi sifatida ro‘yxatdan o‘tish uchun /start driver deb yozing.');
  if (d.blocked) return send(chat, '⛔ Hisobingiz bloklangan. Admin bilan bog‘laning.');

  if (d.state === 'car' && t && !t.startsWith('/') && !/^(💰|➕|📋|ℹ️|🚗)/.test(t)) {
    const c = t.replace(/\s+/g, ' ').slice(0, 60);
    if (c.length < 5) return send(chat, 'Juda qisqa. Masalan: <code>Cobalt, oq, 01 A 123 BC</code>');
    await db.q("update drivers set car=$1, state='' where tg_id=$2", [c, from.id]);
    return send(chat, '✅ Saqlandi: <b>' + esc(c) + '</b>\nEndi buyurtmalarni qabul qila olasiz.', { reply_markup: MENU });
  }
  if (/^(🚗 Mashinam|\/mashina)$/i.test(t)) {
    await db.q("update drivers set state='car' where tg_id=$1", [from.id]);
    return send(chat, (d.car ? 'Hozirgi: <b>' + esc(d.car) + '</b>\n\n' : '') + CAR_ASK);
  }
  if (m.photo && d.state === 'chek') {
    const fid = m.photo[m.photo.length - 1].file_id;
    const r = await db.q('insert into topups(driver_id,amount,file_id) values($1,$2,$3) returning id', [from.id, d.state_n, fid]);
    await db.q("update drivers set state='', state_n=0 where tg_id=$1", [from.id]);
    const aid = process.env.ADMIN_ID;
    if (!aid) return send(chat, '⚠️ Admin sozlanmagan. Keyinroq urinib ko‘ring.');
    await tg('sendPhoto', { chat_id: aid, photo: fid, parse_mode: 'HTML', caption: '💳 <b>Balans to‘ldirish #' + r.rows[0].id + '</b>\nHaydovchi: ' + who(from) + ' · ID ' + from.id + '\nSumma: <b>' + fmt(d.state_n) + ' so‘m</b>',
      reply_markup: { inline_keyboard: [[{ text: '✅ Tasdiqlash', callback_data: 't:ok:' + r.rows[0].id }, { text: '❌ Rad etish', callback_data: 't:no:' + r.rows[0].id }]] } });
    return send(chat, '✅ Chek yuborildi. Admin tasdiqlagach, balansingiz to‘ldiriladi (odatda bir necha daqiqa).');
  }
  if (/^\/app$/i.test(t)) return send(chat, '🚕 Haydovchi ilovasi:', { reply_markup: { inline_keyboard: [[{ text: '🚕 Ochish', web_app: { url: BASE + '/drv.html' } }]] } });
  if (/^(💰 Balans|\/balans)$/i.test(t)) return send(chat, '💰 Balansingiz: <b>' + fmt(d.balance) + ' so‘m</b>\n🎁 Bepul buyurtmalar: ' + d.free_left + '\n💼 Komissiya: ' + CFG.feePct + '%', { reply_markup: MENU });
  if (/^(➕ To‘ldirish|➕ To'ldirish|\/toldirish)$/i.test(t)) {
    await db.q("update drivers set state='amount', state_n=0 where tg_id=$1", [from.id]);
    return send(chat, 'Qancha so‘m to‘ldirmoqchisiz? Faqat raqam yozing (eng kam ' + fmt(CFG.minTopup) + ').');
  }
  if (d.state === 'amount' && /^\d[\d\s]*$/.test(t)) {
    const n = +t.replace(/\s/g, '');
    if (n < CFG.minTopup || n > CFG.maxTopup) return send(chat, 'Summa ' + fmt(CFG.minTopup) + ' dan ' + fmt(CFG.maxTopup) + ' gacha bo‘lishi kerak.');
    await db.q("update drivers set state='chek', state_n=$1 where tg_id=$2", [n, from.id]);
    const card = String(process.env.CARD_INFO || '').trim() || '(karta ma’lumoti sozlanmagan)';
    return send(chat, '💳 <b>' + fmt(n) + ' so‘m</b> ni shu kartaga o‘tkazing:\n\n<code>' + esc(card) + '</code>\n\nO‘tkazgach, <b>chek rasmini (skrinshot)</b> shu yerga yuboring.');
  }
  if (/^(📋 Buyurtmalarim|\/orders)$/i.test(t)) {
    const r = await db.q("select id,price,fee_paid,status,fromp,top from orders where driver_id=$1 order by taken_at desc nulls last limit 5", [from.id]);
    if (!r.rows.length) return send(chat, 'Hozircha buyurtma yo‘q.');
    return send(chat, '📋 <b>Oxirgi buyurtmalar</b>\n\n' + r.rows.map(o => '#' + o.id + ' · ' + fmt(o.price) + ' so‘m · ' + (o.status === 'done' ? '✅' : '🚕') + '\n' + esc((o.fromp && o.fromp.addr) || '?') + ' → ' + esc((o.top && o.top.addr) || '?')).join('\n\n'));
  }
  if (/^(ℹ️ Yordam|\/help|\/yordam)$/i.test(t)) return send(chat, 'ℹ️ Buyurtmalarni haydovchi ilovasida qabul qilasiz: pastdagi tugma yoki /app. Balans tugasa, «➕ To‘ldirish» orqali kartaga o‘tkazib chek yuboring.', { reply_markup: { inline_keyboard: [[{ text: '🚕 Haydovchi ilovasi', web_app: { url: BASE + '/drv.html' } }]] } });
  return send(chat, 'Menyudan tanlang 👇', { reply_markup: MENU });
}

async function onCallback(q) {
  const d = q.data.split(':'), from = q.from, chat = q.message.chat.id, mid = q.message.message_id;
  if (d[0] === 'x') return tg('answerCallbackQuery', { callback_query_id: q.id });

  // ---- admin: balans to'ldirishni tasdiqlash ----
  if (d[0] === 't') {
    if (!isAdmin(from.id)) return alert_(q, 'Faqat admin');
    const r = await db.fn('topup_decide', +d[2], d[1] === 'ok');
    if (r.err) return alert_(q, r.err === 'done' ? 'Allaqachon hal qilingan: ' + r.status : 'Xato: ' + r.err);
    await tg('answerCallbackQuery', { callback_query_id: q.id, text: r.rejected ? 'Rad etildi' : 'Tasdiqlandi ✅' });
    await tg('editMessageCaption', { chat_id: chat, message_id: mid, caption: (q.message.caption || '') + '\n\n' + (r.rejected ? '❌ Rad etildi' : '✅ Tasdiqlandi'), reply_markup: { inline_keyboard: [] } }).catch(() => {});
    await send(r.driver, r.rejected ? '❌ To‘ldirish so‘rovingiz rad etildi. Savol bo‘lsa admin bilan bog‘laning.' : '✅ Balansingiz to‘ldirildi: +' + fmt(r.amount) + ' so‘m\n💰 Yangi balans: <b>' + fmt(r.bal) + ' so‘m</b>').catch(() => {});
    return;
  }
  if (from.is_bot) return;
  const id = d[1];

  if (d[0] === 'a') {
    const r = await db.fn('accept_order', id, from.id, CFG.expireMin);
    if (r.err === 'expired') { await closeGroup(r.msg, '⌛ Muddati o‘tdi'); return alert_(q, 'Buyurtma muddati o‘tdi (' + CFG.expireMin + ' daqiqa). Yo‘lovchi qayta buyurtma berishi mumkin.'); }
    if (r.err === 'gone') { await closeGroup(q.message.message_id, '❌ Bekor qilingan'); return alert_(q, 'Bu buyurtma bekor qilingan'); }
    if (r.err === 'nocar') return alert_(q, 'Avval mashina ma‘lumotini kiriting: botga o‘tib «🚗 Mashinam» ni bosing.');
    if (r.err === 'taken' || r.err === 'noorder') return alert_(q, 'Bu buyurtmani boshqa haydovchi oldi');
    if (r.err === 'nodriver') { const bn = await bot(); return alert_(q, 'Avval haydovchi sifatida ro‘yxatdan o‘ting: @' + bn + ' ga o‘tib /start driver yozing.'); }
    if (r.err === 'balance') return alert_(q, 'Balans yetarli emas. Kerak: ' + fmt(r.need) + ' so‘m, sizda: ' + fmt(r.bal) + ' so‘m. Botga o‘tib «➕ To‘ldirish» ni bosing.');
    await tg('editMessageReplyMarkup', { chat_id: chat, message_id: mid, reply_markup: takenKb(id, nameOf(from), rowsKeep(q)) });
    await alert_(q, '✅ Buyurtma sizniki!\n📞 +998' + r.phone + '\n' + (r.free ? '🎁 Bepul buyurtma (qolgan: ' + r.left + ')' : '💼 Komissiya: ' + fmt(r.fee) + ' so‘m yechildi') + '\n💰 Balans: ' + fmt(r.bal) + ' so‘m');
    await send(from.id, '🧭 Yo‘lovchiga borish uchun navigatsiyani oching (xarita, yo‘nalish, yo‘lovchi sizni jonli ko‘radi):', { reply_markup: { inline_keyboard: [[{ text: '🧭 Navigatsiya', web_app: { url: BASE + '/driver.html?o=' + id } }]] } }).catch(() => {});
    if (+r.uid > 0) await send(+r.uid, '🚕 Haydovchi topildi: <b>' + who(from) + '</b>\n🚗 ' + esc(r.car || '') + '\nBuyurtma #' + esc(id) + '. Tez orada siz bilan bog‘lanadi.').catch(() => {});
    return;
  }
  if (d[0] === 'p') {
    const r = await db.q("select phone from orders where id=$1 and driver_id=$2 and status='taken'", [id, from.id]);
    return alert_(q, r.rows[0] ? '📞 +998' + r.rows[0].phone + '\nBuyurtma #' + id : 'Bu buyurtma sizniki emas');
  }
  if (d[0] === 'c') {
    const r = await db.fn('cancel_order', id, from.id, CFG.cancelMin);
    if (r.err === 'late') return alert_(q, CFG.cancelMin + ' daqiqadan o‘tdi. Bekor qilish uchun admin bilan bog‘laning.');
    if (r.err) return alert_(q, 'Bu buyurtma sizniki emas');
    await tg('editMessageReplyMarkup', { chat_id: chat, message_id: mid, reply_markup: acceptKb(id, rowsKeep(q)) });
    return alert_(q, 'Bekor qilindi' + (r.refund ? '. Komissiya qaytarildi: ' + fmt(r.refund) + ' so‘m' : ''));
  }
  if (d[0] === 'd') {
    const r = await db.fn('done_order', id, from.id);
    if (r.err) return alert_(q, 'Bu buyurtma sizniki emas yoki allaqachon tugagan');
    await tg('editMessageReplyMarkup', { chat_id: chat, message_id: mid, reply_markup: { inline_keyboard: [[{ text: '🏁 Bajarildi: ' + nameOf(from).slice(0, 40), callback_data: 'x' }]].concat(rowsKeep(q)) } });
    return tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Rahmat! Buyurtma yakunlandi 🏁' });
  }
  return tg('answerCallbackQuery', { callback_query_id: q.id });
}

let BASE = '';
module.exports = async (req, res) => {
  res.setHeader('cache-control', 'no-store');
  BASE = String(process.env.APP_URL || '').trim().replace(/\/$/, '') || (req.headers && req.headers.host ? 'https://' + req.headers.host : '');
  if (req.method === 'GET') { // bir martalik o'rnatish: /api/tg?setup=SETUP_KEY
    const key = String((req.query && req.query.setup) || ''), want = String(process.env.SETUP_KEY || '');
    if (!want || !key || !same(key, want)) return res.status(403).send('Ruxsat yo‘q');
    try {
      await db.ensure();
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
      const r = await tg('setWebhook', { url: 'https://' + host + '/api/tg', secret_token: secret(), allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
      return res.status(200).send(r && r.ok ? 'OK: bot va baza ulandi ✅' : 'Xato: ' + JSON.stringify(r));
    } catch (e) { return res.status(500).send('Xato: ' + e.message); }
  }
  if (req.method !== 'POST') return res.status(405).end();
  if (!same(req.headers['x-telegram-bot-api-secret-token'] || '', secret())) return res.status(401).end();
  const up = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  try {
    if (up.message && up.message.chat && up.message.chat.type === 'private') await onPrivate(up.message);
    else if (up.message && up.message.text && /^\/id(@\w+)?$/.test(up.message.text.trim())) await send(up.message.chat.id, 'Chat ID: ' + up.message.chat.id);
    if (up.callback_query && up.callback_query.data && up.callback_query.message) await onCallback(up.callback_query);
  } catch (e) { if (process.env.TEST_DBG) console.log('TGERR', e.message); /* Telegram qayta yubormasligi uchun 200 qaytaramiz */ }
  return res.status(200).end();
};
