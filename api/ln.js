'use strict';
// Tugmali taksi boti: yo'lovchi buyurtma beradi, liniyadagi haydovchilarga xabar boradi.
// Haydovchilar oylik to'lov (chek orqali, admin tasdiqlaydi) bilan ishlaydi. Komissiya yo'q.
const crypto = require('crypto');
const db = require('./_db');
const { tg, esc, fmt } = require('./_lib');

const isAdmin = id => !!process.env.ADMIN_ID && String(id) === String(process.env.ADMIN_ID).trim();
const send = (chat, text, extra) => tg('sendMessage', Object.assign({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }, extra || {}));
const edit = (chat, mid, text, extra) => tg('editMessageText', Object.assign({ chat_id: chat, message_id: mid, text, parse_mode: 'HTML', disable_web_page_preview: true }, extra || {})).catch(() => {});
const answer = (q, text, alert) => tg('answerCallbackQuery', { callback_query_id: q.id, text: text ? String(text).slice(0, 190) : undefined, show_alert: !!alert }).catch(() => {});
const quiet = p => p.catch(() => {});

const HOURS_ONLINE = 14;      // liniyada qolish muddati (soat)
const ORDER_MIN = 20;         // buyurtma necha daqiqa amal qiladi
const B = {
  taxi: '🚖 Taksi chaqirish', drv: '🚕 Haydovchiman', on: '🟢 Liniyaga chiqish', off: '🔴 Liniyadan chiqish',
  pay: '💳 To‘lov', me: 'ℹ️ Holatim', line: '📍 Liniyani o‘zgartirish', adm: '🛠 Admin',
  cancel: '❌ Bekor', menu: '🏠 Menyu', skip: '⏭ O‘tkazib yuborish'
};

// ---------- sozlamalar ----------
async function setting(k, def) { const r = await db.q('select val from settings where key=$1', [k]); return r.rows[0] ? r.rows[0].val : def; }
async function setSetting(k, v) { await db.q('insert into settings(key,val) values($1,$2) on conflict (key) do update set val=excluded.val, updated=now()', [k, String(v)]); }
async function priceOf(kind) { return Number(await setting(kind === 'viloyat' ? 'lp_v' : 'lp_m', kind === 'viloyat' ? '40000' : '20000')) || 0; }
async function payDays() { return Math.max(1, Number(await setting('lp_days', '30')) || 30); }

// ---------- yordamchilar ----------
const getSt = async id => { const r = await db.q('select st,data from ln_state where tg_id=$1', [id]); return r.rows[0] ? { st: r.rows[0].st, d: r.rows[0].data || {} } : { st: '', d: {} }; };
const setSt = (id, st, d) => db.q('insert into ln_state(tg_id,st,data) values($1,$2,$3) on conflict (tg_id) do update set st=excluded.st, data=excluded.data, updated=now()', [id, st, JSON.stringify(d || {})]);
const clrSt = id => setSt(id, '', {});
const getDriver = async id => (await db.q('select * from ln_drivers where tg_id=$1', [id])).rows[0] || null;
const nameOf = u => [u.first_name, u.last_name].filter(Boolean).join(' ').slice(0, 40) || 'Foydalanuvchi';
const isPaid = d => !!(d && d.paid_until && new Date(d.paid_until).getTime() > Date.now());
const fdate = t => new Date(t).toLocaleDateString('ru-RU', { timeZone: 'Asia/Tashkent' });
const daysLeft = t => Math.max(0, Math.ceil((new Date(t).getTime() - Date.now()) / 86400000));
function normPhone(s) {
  let d = String(s || '').replace(/\D/g, '');
  if (d.length === 9) d = '998' + d;
  return /^998\d{9}$/.test(d) ? d : null;
}
const showPhone = d => { const p = String(d || '').replace(/\D/g, ''); return p.length === 12 ? '+' + p.slice(0, 3) + ' ' + p.slice(3, 5) + ' ' + p.slice(5, 8) + ' ' + p.slice(8, 10) + ' ' + p.slice(10) : (d || ''); };
const newId = () => 'T' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
const mapLink = (lat, lng) => 'https://yandex.com/maps/?pt=' + lng + ',' + lat + '&z=17&l=map';
const plain = t => esc(String(t || '').slice(0, 3500));

// ---------- hududlar ----------
async function kids(pid) {
  const r = pid ? await db.q('select id,name,kind,parent_id,active from ln_regions where parent_id=$1 order by id', [pid]) : await db.q('select id,name,kind,parent_id,active from ln_regions where parent_id is null order by id');
  return r.rows;
}
const reg = async id => (await db.q('select id,name,kind,parent_id,active from ln_regions where id=$1', [id])).rows[0] || null;
async function pathName(id) {
  const parts = []; let cur = await reg(id), n = 0;
  while (cur && n++ < 5) { parts.unshift(cur.name); cur = cur.parent_id ? await reg(cur.parent_id) : null; }
  return parts.join(' › ');
}
// mode: tm/fm (mahalla taksi: qayerga/qayerdan), pt/pf (viloyat taksi: qayerga/qayerdan), dm/dv (haydovchi: mahalla/viloyat)
const TUMAN_ONLY = m => m === 'pf' || m === 'pt' || m === 'dv';
const HEAD = {
  tm: '🏁 <b>Qayerga borasiz?</b>', fm: '📍 <b>Qayerdan yo‘lga chiqasiz?</b>', pt: '🏁 <b>Qayerga borasiz?</b>', pf: '📍 <b>Qayerdan yo‘lga chiqasiz?</b>',
  dm: '🚕 <b>Qaysi mahallada ishlaysiz?</b>', dv: '🚕 <b>Qaysi tumandan ishlaysiz?</b>'
};
async function regScreen(mode, nodeId) {
  // mahalla taksisi: faqat ishlaydigan hududlar; bitta viloyat bo'lsa to'g'ri o'shandan boshlanadi
  const local = mode === 'tm' || mode === 'fm' || mode === 'dm';
  let solo = false;
  if (local && !nodeId) {
    const act = (await kids(null)).filter(k => k.active);
    if (act.length === 1) { nodeId = act[0].id; solo = true; }
  }
  const node = nodeId ? await reg(nodeId) : null, list = await kids(nodeId || null), rows = [];
  if (local && node && node.kind === 'viloyat' && !node.parent_id) { const act = (await kids(null)).filter(k => k.active); solo = act.length === 1; }
  for (const k of list) {
    if (local && !k.active) continue;
    if (TUMAN_ONLY(mode) && k.kind === 'mahalla') continue;
    if (!k.active) { rows.push([{ text: '🕓 ' + k.name, callback_data: 'ia:0' }]); continue; }
    const deep = k.kind === 'viloyat' || (!TUMAN_ONLY(mode) && k.kind === 'tuman' && (await kids(k.id)).length > 0);
    rows.push([{ text: k.name + (deep ? ' ›' : ''), callback_data: (deep ? 'rg:' : 'rs:') + mode + ':' + k.id }]);
  }
  if (node && node.kind === 'tuman' && !TUMAN_ONLY(mode)) rows.push([{ text: '✅ Butun ' + node.name, callback_data: 'rs:' + mode + ':' + node.id }]);
  if (node && !(solo && node.kind === 'viloyat')) rows.push([{ text: '⬅️ Orqaga', callback_data: 'rg:' + mode + ':' + (node.parent_id || 0) }]);
  let hint;
  if (!node) hint = 'Viloyatni tanlang:';
  else if (node.kind === 'viloyat' || TUMAN_ONLY(mode)) hint = 'Tumanni tanlang:';
  else hint = 'Mahallani tanlang yoki «Butun ' + esc(node.name) + '» ni bosing:';
  const text = HEAD[mode] + (node && !(solo && node.kind === 'viloyat' && local) ? '\n📍 ' + esc(await pathName(node.id)) : '') + '\n\n' + hint + (list.some(k => !k.active) ? '\n<i>🕓 — tez kunda ishga tushadi</i>' : '');
  return { text: list.length ? text : HEAD[mode] + '\n\nBu yerda hududlar hali qo‘shilmagan. Tez kunda ishga tushadi.', kb: { inline_keyboard: rows } };
}

// ---------- menyu ----------
async function menuKb(id) {
  const d = await getDriver(id), canOrder = !(isPaid(d) && !isAdmin(id)), rows = [];
  if (canOrder) rows.push([{ text: B.taxi }]);
  if (d) rows.push([{ text: d.online ? B.off : B.on }, { text: B.pay }], [{ text: B.line }, { text: B.me }]); else rows.push([{ text: B.drv }]);
  if (isAdmin(id)) rows.push([{ text: B.adm }]);
  return { keyboard: rows, resize_keyboard: true };
}
const home = async (chat, text) => send(chat, text || 'Bosh menyu 👇', { reply_markup: await menuKb(chat) });
const PH_NOTE = 'Pastdagi tugmani bosganda Telegram «ulashasizmi?» deb so‘raydi. Bu oddiy savol, <b>OK</b> bosing. Raqamingiz faqat haydovchiga ko‘rinadi.\n\n❗ Faqat bitta qoida: <b>SMS kodlarni hech kimga, botga ham yubormang.</b>';
const PHONE_ASK = '📞 Telefon raqamingizni yuboring (haydovchi qo‘ng‘iroq qiladi).\n\n' + PH_NOTE + '\n\nYoki raqamni yozing: <code>90 123 45 67</code>';
const WELCOME = 'Assalomu alaykum! 🚕 <b>Baxu Taksi</b>\n\n🚖 <b>Taksi chaqirish</b> — yo‘lovchi uchun\n🚕 <b>Haydovchiman</b> — haydovchi bo‘lish uchun (oyiga qat’iy to‘lov, komissiya yo‘q)';
const welcome = async () => { const w = await setting('welcome', ''); return w ? plain(w) : WELCOME; };

// ---------- yo'lovchi ----------
async function startTaxi(chat) {
  const d = await getDriver(chat);
  if (isPaid(d) && !isAdmin(chat)) return home(chat, '🚕 Siz haydovchisiz, oylik muddatingiz amal qilmoqda (' + fdate(d.paid_until) + ' gacha). Shu muddat ichida o‘zingiz taksi chaqira olmaysiz.');
  await clrSt(chat);
  return send(chat, '🚖 <b>Qanday taksi kerak?</b>\n\n🏘 <b>Mahalla taksisi</b> — o‘z qishlog‘ingiz/mahallangiz ichida\n🛣 <b>Viloyat taksisi</b> — tuman va shaharlar orasida', { reply_markup: { inline_keyboard: [
    [{ text: '🏘 Mahalla taksisi', callback_data: 'pk:m' }],
    [{ text: '🛣 Viloyat taksisi', callback_data: 'pk:v' }]] } });
}
const askAddr = async (chat, text) => send(chat, (text ? text + '\n\n' : '') + '📍 <b>Sizni qayerdan olib ketamiz?</b>\nLokatsiya yuboring (tugma) yoki uy manzilini yozing.', { reply_markup: { keyboard: [[{ text: '📍 Lokatsiya yuborish', request_location: true }], [{ text: B.cancel }]], resize_keyboard: true } });

async function eligible(kind, rid, except) {
  const r = await db.q(
    "select d.tg_id from ln_drivers d where d.blocked=false and d.online and d.online_at > now() - interval '" + HOURS_ONLINE + " hours' and d.paid_until > now() and d.kind=$1 " +
    "and d.region_id in (select id from ln_regions where id=$2 or parent_id=$2 or id=(select parent_id from ln_regions where id=$2)) and d.tg_id<>$3 " +
    "and not exists (select 1 from ln_orders o where o.driver_id=d.tg_id and o.status='taken') order by d.online_at limit 60", [kind, rid, except || 0]);
  return r.rows.map(x => +x.tg_id);
}

async function placeOrder(uid, pname, phone, data) {
  const ids = await eligible(data.k, data.rid, uid);
  if (!ids.length) { await clrSt(uid); return home(uid, '😔 Hozir bu hududda liniyada haydovchi yo‘q. Birozdan keyin qayta urinib ko‘ring.'); }
  const id = newId(), where = data.k === 'viloyat'
    ? 'Qayerdan: <b>' + esc(await pathName(data.rid)) + '</b>\n🏁 Qayerga: <b>' + esc(data.to_text || '—') + '</b>'
    : 'Hudud: <b>' + esc(await pathName(data.rid)) + '</b>' + (data.to_text ? '\n🏁 Qayerga: <b>' + esc(data.to_text) + '</b>' : '');
  await db.q('insert into ln_orders(id,uid,pname,phone,kind,region_id,to_text,addr,lat,lng) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [id, uid, pname, phone, data.k, data.rid, data.to_text || '', data.addr || '', data.lat == null ? null : data.lat, data.lng == null ? null : data.lng]);
  const text = '🚕 <b>Yangi buyurtma</b> #' + id + '\n📍 ' + where + '\n📌 Manzil: ' + esc(data.addr || 'Lokatsiya') + '\n👤 ' + esc(pname);
  const kb = [[{ text: '✅ Qabul qilaman', callback_data: 'la:' + id }]];
  if (data.lat != null) kb.push([{ text: '🗺 Xaritada ko‘rish', url: mapLink(data.lat, data.lng) }]);
  let sent = 0;
  for (const dId of ids) {
    try {
      const r = await send(dId, text, { reply_markup: { inline_keyboard: kb } });
      if (r && r.ok && r.result) { sent++; await db.q('insert into ln_msgs(order_id,chat_id,msg_id) values($1,$2,$3)', [id, dId, r.result.message_id]); }
    } catch (e) { /* haydovchi botni bloklagan bo'lishi mumkin */ }
  }
  await clrSt(uid);
  if (!sent) { await db.q("update ln_orders set status='cancelled' where id=$1", [id]); return home(uid, '😔 Haydovchilarga xabar yetmadi. Birozdan keyin qayta urinib ko‘ring.'); }
  return send(uid, '✅ <b>Buyurtma yuborildi</b> #' + id + '\n' + sent + ' ta haydovchiga xabar ketdi. Birinchi qabul qilgan haydovchi sizga yozadi va telefoni shu yerga keladi.',
    { reply_markup: { inline_keyboard: [[{ text: '❌ Buyurtmani bekor qilish', callback_data: 'pc:' + id }]] } }).then(() => home(uid, 'Kuting… ⏳'));
}
async function afterAddr(chat, from, d) {
  const u = (await db.q('select phone from ln_users where tg_id=$1', [chat])).rows[0];
  if (u && u.phone) return placeOrder(chat, nameOf(from), u.phone, d);
  await setSt(chat, 'p_phone', d);
  return send(chat, PHONE_ASK, { reply_markup: { keyboard: [[{ text: '📞 Raqamni yuborish', request_contact: true }], [{ text: B.cancel }]], resize_keyboard: true } });
}

// ---------- haydovchi ----------
async function startDriver(chat) {
  const d = await getDriver(chat);
  if (d) return showMe(chat);
  await setSt(chat, 'd_name', {});
  return send(chat, '🚕 <b>Haydovchi bo‘lish</b>\n\n1/4 Ism va familiyangizni yozing:', { reply_markup: { keyboard: [[{ text: B.cancel }]], resize_keyboard: true } });
}
async function showMe(chat) {
  const d = await getDriver(chat);
  if (!d) return home(chat, 'Siz haydovchi emassiz. «' + B.drv + '» ni bosing.');
  const pr = await priceOf(d.kind), rn = d.region_id ? await pathName(d.region_id) : '—';
  const st = isPaid(d) ? '✅ Amal qiladi: <b>' + fdate(d.paid_until) + '</b> gacha (' + daysLeft(d.paid_until) + ' kun)' : '⚠️ To‘lov yo‘q yoki muddati tugagan';
  return home(chat, '🚕 <b>' + esc(d.name) + '</b>\n📞 ' + esc(showPhone(d.phone)) + '\n🚗 ' + esc(d.car) + '\n🏷 ' + (d.kind === 'viloyat' ? 'Viloyat taksisi' : 'Mahalla taksisi') + '\n📍 Liniyangiz: <b>' + esc(rn) +
    '</b>\n💰 Oylik to‘lov: ' + fmt(pr) + ' so‘m\n' + st + '\n' + (d.online && isPaid(d) ? '🟢 Liniyadasiz' : '🔴 Liniyada emassiz'));
}
async function goOnline(chat, on) {
  const d = await getDriver(chat);
  if (!d) return home(chat, 'Avval «' + B.drv + '» orqali ro‘yxatdan o‘ting.');
  if (d.blocked) return home(chat, '⛔ Hisobingiz bloklangan. Admin bilan bog‘laning.');
  if (on) {
    if (!isPaid(d)) return home(chat, '⚠️ Liniyaga chiqish uchun oylik to‘lov kerak. «' + B.pay + '» ni bosing.');
    if (!d.region_id) return startChange(chat);
    await db.q('update ln_drivers set online=true, online_at=now() where tg_id=$1', [chat]);
    return home(chat, '🟢 Siz liniyadasiz: <b>' + esc(await pathName(d.region_id)) + '</b>\nBuyurtma kelsa, shu yerga xabar keladi. ' + HOURS_ONLINE + ' soatdan keyin o‘zi chiqadi.\n\nBoshqa joyga o‘tish: «' + B.line + '».');
  }
  await db.q('update ln_drivers set online=false where tg_id=$1', [chat]);
  return home(chat, '🔴 Liniyadan chiqdingiz.');
}
async function startChange(chat) {
  const d = await getDriver(chat);
  if (!d) return home(chat, 'Avval «' + B.drv + '» orqali ro‘yxatdan o‘ting.');
  await setSt(chat, 'd_chg', {});
  const s = await regScreen(d.kind === 'viloyat' ? 'dv' : 'dm', 0);
  return send(chat, s.text, { reply_markup: s.kb });
}
async function startPay(chat) {
  const d = await getDriver(chat);
  if (!d) return home(chat, 'Avval «' + B.drv + '» orqali ro‘yxatdan o‘ting.');
  const pr = await priceOf(d.kind), card = await setting('card', '');
  if (!card) return home(chat, 'Karta ma’lumoti hali kiritilmagan. Admin bilan bog‘laning.');
  await setSt(chat, 'pay', {});
  return send(chat, '💳 <b>Oylik to‘lov: ' + fmt(pr) + ' so‘m</b> (' + (await payDays()) + ' kun)\n\nKarta:\n<code>' + esc(card) + '</code>\n\nTo‘lagach <b>chek rasmini (skrinshot)</b> shu yerga yuboring. Admin tasdiqlagach liniyaga chiqa olasiz.',
    { reply_markup: { keyboard: [[{ text: B.cancel }]], resize_keyboard: true } });
}
async function finishReg(chat, from, d, rid) {
  await db.q("insert into ln_drivers(tg_id,name,username,phone,car,kind,region_id) values($1,$2,$3,$4,$5,$6,$7) on conflict (tg_id) do update set name=excluded.name, phone=excluded.phone, car=excluded.car, kind=excluded.kind, region_id=excluded.region_id",
    [chat, d.name, from.username || '', d.phone, d.car, d.kind, rid]);
  await clrSt(chat);
  const pr = await priceOf(d.kind);
  return home(chat, '✅ <b>Ro‘yxatdan o‘tdingiz!</b>\n\nKeyingi qadam: oylik to‘lov <b>' + fmt(pr) + ' so‘m</b>. «' + B.pay + '» ni bosing, to‘lab chekni yuboring. Admin tasdiqlagach «' + B.on + '» ishlaydi.\n\nLiniyani istagan payt «' + B.line + '» orqali almashtira olasiz.');
}

async function accept(q) {
  const id = q.data.split(':')[1], from = q.from, chat = q.message.chat.id, mid = q.message.message_id;
  const d = await getDriver(from.id);
  if (!d) return answer(q, 'Avval haydovchi sifatida ro‘yxatdan o‘ting', true);
  if (d.blocked) return answer(q, 'Hisobingiz bloklangan', true);
  if (!isPaid(d)) return answer(q, 'To‘lov muddati tugagan. «💳 To‘lov» ni bosing.', true);
  if ((await db.q("select 1 from ln_orders where driver_id=$1 and status='taken'", [from.id])).rows.length) return answer(q, 'Sizda tugamagan buyurtma bor. Avval «🏁 Tugadi» ni bosing.', true);
  const r = await db.q("update ln_orders set status='taken', driver_id=$2, taken_at=now() where id=$1 and status='new' and created > now() - interval '" + ORDER_MIN + " minutes' returning *", [id, from.id]);
  const o = r.rows[0];
  if (!o) {
    const x = (await db.q('select status from ln_orders where id=$1', [id])).rows[0];
    if (x && x.status === 'new') { await db.q("update ln_orders set status='expired' where id=$1", [id]); await edit(chat, mid, '⌛ Buyurtma muddati o‘tdi.'); return answer(q, 'Muddati o‘tdi', true); }
    await edit(chat, mid, x && x.status === 'cancelled' ? '❌ Yo‘lovchi bekor qildi.' : '⏱ Boshqa haydovchi oldi.');
    return answer(q, x && x.status === 'cancelled' ? 'Yo‘lovchi bekor qildi' : 'Boshqa haydovchi oldi', true);
  }
  await answer(q, 'Buyurtma sizniki ✅');
  const where = o.kind === 'viloyat' ? 'Qayerdan: ' + esc(await pathName(o.region_id)) + '\n🏁 Qayerga: ' + esc(o.to_text || '—') : 'Hudud: ' + esc(await pathName(o.region_id)) + (o.to_text ? '\n🏁 Qayerga: ' + esc(o.to_text) : '');
  const kb = [[{ text: '🏁 Tugadi', callback_data: 'ld:' + id }, { text: '❌ Bekor', callback_data: 'lc:' + id }]];
  if (o.lat != null) kb.unshift([{ text: '🗺 Xaritada ko‘rish', url: mapLink(o.lat, o.lng) }]);
  await edit(chat, mid, '✅ <b>Siz oldingiz</b> #' + id + '\n\n👤 ' + esc(o.pname) + '\n📞 <b>' + esc(showPhone(o.phone)) + '</b>\n📍 ' + where + '\n📌 ' + esc(o.addr || 'Lokatsiya') + '\n\nYo‘lovchi bilan bog‘lanib, borib oling. Narxni o‘zaro kelishasiz.', { reply_markup: { inline_keyboard: kb } });
  if (o.lat != null) await quiet(tg('sendLocation', { chat_id: chat, latitude: o.lat, longitude: o.lng }));
  const others = (await db.q('select chat_id,msg_id from ln_msgs where order_id=$1 and chat_id<>$2', [id, from.id])).rows;
  for (const m of others) await edit(m.chat_id, m.msg_id, '⏱ Buyurtma #' + id + ' boshqa haydovchi tomonidan olindi.');
  await quiet(send(o.uid, '✅ <b>Buyurtmangiz qabul qilindi!</b> #' + id + '\n\n🚕 Haydovchi: <b>' + esc(d.name) + '</b>\n🚗 ' + esc(d.car) + '\n📞 <b>' + esc(showPhone(d.phone)) + '</b>\n\nHaydovchi siz bilan bog‘lanadi va kelib oladi. Narxni haydovchi bilan o‘zaro kelishasiz.',
    { reply_markup: { inline_keyboard: [[{ text: '❌ Bekor qilish', callback_data: 'pc:' + id }]] } }));
}
async function finish(q, kind) {
  const id = q.data.split(':')[1], from = q.from, chat = q.message.chat.id, mid = q.message.message_id;
  const r = await db.q("update ln_orders set status=$3, done_at=now() where id=$1 and driver_id=$2 and status='taken' returning uid", [id, from.id, kind === 'done' ? 'done' : 'cancelled']);
  if (!r.rows[0]) return answer(q, 'Buyurtma allaqachon yopilgan', true);
  await answer(q, kind === 'done' ? 'Rahmat! 🏁' : 'Bekor qilindi');
  await edit(chat, mid, (kind === 'done' ? '🏁 Safar yakunlandi' : '❌ Siz bekor qildingiz') + ' #' + id + '. Liniyada qolasiz.');
  if (kind !== 'done') await quiet(send(r.rows[0].uid, '❌ Haydovchi buyurtmani bekor qildi #' + id + '. Qayta buyurtma bering: «' + B.taxi + '».'));
}
async function passengerCancel(q) {
  const id = q.data.split(':')[1], from = q.from;
  const r = await db.q("update ln_orders set status='cancelled' where id=$1 and uid=$2 and status in ('new','taken') returning driver_id", [id, from.id]);
  if (!r.rows[0]) return answer(q, 'Buyurtma allaqachon yopilgan', true);
  await answer(q, 'Bekor qilindi');
  await edit(q.message.chat.id, q.message.message_id, '❌ Buyurtma #' + id + ' bekor qilindi.');
  const ms = (await db.q('select chat_id,msg_id from ln_msgs where order_id=$1', [id])).rows;
  for (const m of ms) await edit(m.chat_id, m.msg_id, '❌ Yo‘lovchi buyurtma #' + id + ' ni bekor qildi.');
  if (r.rows[0].driver_id) await quiet(send(r.rows[0].driver_id, '❌ Yo‘lovchi buyurtma #' + id + ' ni bekor qildi.'));
}

// ---------- admin ----------
const ADM_KB = { inline_keyboard: [
  [{ text: '💳 To‘lovlar', callback_data: 'am:pay' }, { text: '👥 Haydovchilar', callback_data: 'am:drv:0' }],
  [{ text: '🟢 Liniyadagilar', callback_data: 'am:lines' }, { text: '📊 Statistika', callback_data: 'am:st' }],
  [{ text: '✉️ Xabar yuborish', callback_data: 'am:bc' }, { text: '⚙️ Sozlamalar', callback_data: 'am:set' }],
  [{ text: '🗺 Hududlar', callback_data: 'am:reg' }]] };
async function regTree(pid, lvl) {
  let out = '';
  for (const k of await kids(pid || null)) {
    if (lvl === 0 && !k.active && !(await kids(k.id)).length) { out += '• ' + esc(k.name) + ' 🕓\n'; continue; }
    out += '  '.repeat(lvl) + '• ' + esc(k.name) + ' <i>(' + k.kind + ')</i>' + (k.active ? '' : ' 🕓') + '\n' + await regTree(k.id, lvl + 1);
  }
  return out;
}
async function driverCard(chat, id) {
  const d = await getDriver(id);
  if (!d) return send(chat, '❌ Haydovchi topilmadi');
  const n = (await db.q("select count(*) filter (where status='done')::int done, count(*)::int tot from ln_orders where driver_id=$1", [id])).rows[0];
  const text = '🚕 <b>' + esc(d.name) + '</b> · <code>' + d.tg_id + '</code>' + (d.username ? ' · @' + esc(d.username) : '') + '\n📞 ' + esc(showPhone(d.phone)) + '\n🚗 ' + esc(d.car) +
    '\n🏷 ' + (d.kind === 'viloyat' ? 'Viloyat' : 'Mahalla') + ' taksisi\n📍 ' + (d.region_id ? esc(await pathName(d.region_id)) : '—') +
    '\n💰 ' + (isPaid(d) ? '✅ ' + fdate(d.paid_until) + ' gacha (' + daysLeft(d.paid_until) + ' kun)' : '❌ to‘lov yo‘q') + '\n' + (d.online ? '🟢 Liniyada' : '🔴 Liniyada emas') + (d.blocked ? '\n⛔ <b>Bloklangan</b>' : '') +
    '\n📦 Buyurtmalar: ' + n.done + ' bajarilgan / ' + n.tot + ' jami\n🗓 Ro‘yxatdan: ' + fdate(d.created);
  return send(chat, text, { reply_markup: { inline_keyboard: [
    [d.blocked ? { text: '✅ Blokdan olish', callback_data: 'dc:ubl:' + id } : { text: '⛔ Bloklash', callback_data: 'dc:blk:' + id }],
    [{ text: '➕ +30 kun', callback_data: 'dc:add:' + id }, { text: '⏹ To‘xtatish', callback_data: 'dc:off:' + id }],
    [{ text: '✉️ Xabar yuborish', callback_data: 'dc:msg:' + id }]] } });
}
async function adminMenu(chat, what, arg) {
  if (what === 'pay') {
    const r = (await db.q("select p.*, d.name, d.phone, d.kind from ln_pay p join ln_drivers d on d.tg_id=p.driver_id where p.status='pending' order by p.id limit 10")).rows;
    if (!r.length) return send(chat, '✅ Kutilayotgan to‘lov yo‘q.');
    for (const p of r) await sendCheque(chat, p, p.name, p.phone, p.kind);
    return;
  }
  if (what === 'drv') {
    const off = Math.max(0, +arg || 0);
    const c = (await db.q("select count(*)::int n, count(*) filter (where paid_until>now())::int paid, count(*) filter (where online and paid_until>now())::int onl from ln_drivers")).rows[0];
    const l = (await db.q("select tg_id,name,kind,paid_until,blocked from ln_drivers order by created desc limit 10 offset $1", [off])).rows;
    const kb = [];
    if (off + 10 < c.n) kb.push({ text: 'Keyingi ➡️', callback_data: 'am:drv:' + (off + 10) });
    return send(chat, '👥 <b>Haydovchilar</b>: ' + c.n + ' · to‘lagan: ' + c.paid + ' · liniyada: ' + c.onl + '\n\n' + (l.map(d => (d.blocked ? '⛔ ' : '• ') + esc(d.name) + ' · ' + (d.kind === 'viloyat' ? 'viloyat' : 'mahalla') + ' · ' + (isPaid(d) ? fdate(d.paid_until) + ' gacha' : '❌') + '\n   👉 /h' + d.tg_id).join('\n') || 'Hozircha yo‘q') +
      '\n\n/h ID ni bossangiz haydovchi kartasi ochiladi (bloklash, kun qo‘shish, xabar).', kb.length ? { reply_markup: { inline_keyboard: [kb] } } : {});
  }
  if (what === 'lines') {
    const r = (await db.q("select d.name, d.kind, d.region_id from ln_drivers d where d.online and d.paid_until>now() and d.blocked=false and d.online_at>now()-interval '" + HOURS_ONLINE + " hours' order by d.region_id")).rows;
    if (!r.length) return send(chat, '🔴 Hozir liniyada hech kim yo‘q.');
    const g = {};
    for (const d of r) { const k = (d.region_id ? await pathName(d.region_id) : '—') + ' (' + (d.kind === 'viloyat' ? 'viloyat' : 'mahalla') + ')'; (g[k] = g[k] || []).push(d.name); }
    return send(chat, '🟢 <b>Liniyada: ' + r.length + ' ta</b>\n\n' + Object.keys(g).map(k => '📍 <b>' + esc(k) + '</b> — ' + g[k].length + ' ta\n   ' + g[k].map(esc).join(', ')).join('\n\n'));
  }
  if (what === 'st') {
    const u = (await db.q("select count(*)::int n, count(*) filter (where created>=now()-interval '1 day')::int d1, count(*) filter (where blocked)::int bl from ln_users")).rows[0];
    const dr = (await db.q("select count(*)::int n, count(*) filter (where paid_until>now())::int paid, count(*) filter (where online and paid_until>now() and online_at>now()-interval '" + HOURS_ONLINE + " hours')::int onl, count(*) filter (where blocked)::int bl from ln_drivers")).rows[0];
    const o = (await db.q("select count(*) filter (where created>=date_trunc('day',now()))::int today, count(*) filter (where status='new' and created>now()-interval '" + ORDER_MIN + " minutes')::int nw, count(*) filter (where status='taken')::int tk, count(*) filter (where status='done')::int dn, count(*)::int tot from ln_orders")).rows[0];
    return send(chat, '📊 <b>Statistika</b>\n\n👤 Botda: <b>' + u.n + '</b> odam (24 soatda yangi: ' + u.d1 + ', bloklangan: ' + u.bl + ')\n🚕 Haydovchilar: <b>' + dr.n + '</b> · to‘lagan: ' + dr.paid + ' · liniyada: <b>' + dr.onl + '</b> · bloklangan: ' + dr.bl +
      '\n\n📦 Bugungi buyurtma: ' + o.today + '\nKutilayotgan: ' + o.nw + ' · yo‘lda: ' + o.tk + '\nBajarilgan: ' + o.dn + ' · jami: ' + o.tot);
  }
  if (what === 'bc') {
    return send(chat, '✉️ <b>Kimga xabar yuboramiz?</b>', { reply_markup: { inline_keyboard: [
      [{ text: '📣 Botdagi hammaga', callback_data: 'bc:all' }],
      [{ text: '🚕 Barcha haydovchilarga', callback_data: 'bc:drv' }],
      [{ text: '🟢 Liniyadagilarga', callback_data: 'bc:on' }]] } });
  }
  if (what === 'set') {
    return send(chat, '⚙️ <b>Sozlamalar</b>\nMahalla taksisi: <b>' + fmt(await priceOf('mahalla')) + '</b> so‘m/oy\nViloyat taksisi: <b>' + fmt(await priceOf('viloyat')) + '</b> so‘m/oy\nMuddat: ' + (await payDays()) + ' kun\nKarta: <code>' + esc(await setting('card', '— kiritilmagan —')) + '</code>\n\n' +
      '<b>O‘zgartirish:</b>\n<code>/karta 8600 1234 5678 9012 Ism</code>\n<code>/narx_m 20000</code> — mahalla narxi\n<code>/narx_v 40000</code> — viloyat narxi\n<code>/kun 30</code> — muddat\n<code>/salom Matn</code> — bosh xabar matni\n<code>/yoq ID</code> yoki <code>/yoq ID 15</code> — haydovchini yoqish\n<code>/toxtat ID</code> — to‘xtatish\n<code>/blok ID</code>, <code>/blokdan ID</code> — bloklash\n<code>/xabar ID matn</code> — bitta odamga xabar');
  }
  if (what === 'reg') {
    return send(chat, '🗺 <b>Hududlar</b>\n\n' + (await regTree(null, 0)) + '\n🕓 — «tez kunda» (odamlar bossa shunday xabar oladi)\n\n<b>Buyruqlar:</b>\n<code>/hudud Xorazm &gt; Shovot</code> — tuman qo‘shish\n<code>/hudud Xorazm &gt; Shovot &gt; Yangi mahalla</code>\n<code>/hudud Buxoro</code> — yangi viloyat\n<code>/hudud_on Buxoro</code> — ishga tushirish\n<code>/hudud_off Buxoro</code> — «tez kunda» holatiga qaytarish');
  }
}
async function sendCheque(admChat, p, name, phone, kind) {
  const cap = '💳 <b>To‘lov cheki</b> #' + p.id + '\n👤 ' + esc(name) + ' · ' + esc(showPhone(phone)) + '\n🏷 ' + (kind === 'viloyat' ? 'Viloyat' : 'Mahalla') + ' taksisi · <code>' + p.driver_id + '</code>';
  const kb = { inline_keyboard: [[{ text: '✅ Tasdiqlash', callback_data: 'pa:ok:' + p.id }, { text: '❌ Rad', callback_data: 'pa:no:' + p.id }]] };
  const isDoc = String(p.file_id).startsWith('d:'), fid = String(p.file_id).slice(2);
  return tg(isDoc ? 'sendDocument' : 'sendPhoto', isDoc ? { chat_id: admChat, document: fid, caption: cap, parse_mode: 'HTML', reply_markup: kb } : { chat_id: admChat, photo: fid, caption: cap, parse_mode: 'HTML', reply_markup: kb });
}
async function activate(id, days) {
  const r = await db.q("update ln_drivers set paid_until = greatest(now(), coalesce(paid_until, now())) + ($2 || ' days')::interval where tg_id=$1 returning paid_until, kind, region_id", [id, String(days)]);
  return r.rows[0] || null;
}
async function payDecide(q) {
  const d = q.data.split(':'), ok = d[1] === 'ok', pid = +d[2];
  if (!isAdmin(q.from.id)) return answer(q, 'Faqat admin', true);
  const r = await db.q("update ln_pay set status=$2, decided=now() where id=$1 and status='pending' returning *", [pid, ok ? 'ok' : 'no']);
  const p = r.rows[0];
  if (!p) return answer(q, 'Allaqachon hal qilingan', true);
  await quiet(tg('editMessageReplyMarkup', { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: [[{ text: ok ? '✅ Tasdiqlandi' : '❌ Rad etildi', callback_data: 'x' }]] } }));
  await answer(q, ok ? 'Tasdiqlandi' : 'Rad etildi');
  if (!ok) return quiet(send(p.driver_id, '❌ To‘lov chekingiz tasdiqlanmadi. Chekni tekshirib, qayta yuboring: «' + B.pay + '».'));
  const dr = await getDriver(p.driver_id), amount = await priceOf(dr ? dr.kind : 'mahalla');
  await db.q('update ln_pay set amount=$2 where id=$1', [pid, amount]);
  const u = await activate(p.driver_id, await payDays());
  if (u) await quiet(send(p.driver_id, '✅ <b>To‘lov tasdiqlandi!</b>\nAmal qilish muddati: <b>' + fdate(u.paid_until) + '</b> gacha.\n\n📍 Liniyangiz: <b>' + esc(u.region_id ? await pathName(u.region_id) : '—') + '</b>\nTo‘g‘ri bo‘lsa «' + B.on + '» ni bosing. Boshqa joy kerak bo‘lsa, avval liniyani o‘zgartiring.',
    { reply_markup: { inline_keyboard: [[{ text: '🟢 Liniyaga chiqish', callback_data: 'on:0' }], [{ text: '📍 Liniyani o‘zgartirish', callback_data: 'ch:0' }]] } }).then(async () => send(p.driver_id, 'Menyu 👇', { reply_markup: await menuKb(p.driver_id) })));
}
async function blockUser(id, on) {
  await db.q('update ln_users set blocked=$2 where tg_id=$1', [id, on]);
  await db.q(on ? 'update ln_drivers set blocked=true, online=false where tg_id=$1' : 'update ln_drivers set blocked=false where tg_id=$1', [id]);
}
async function recipients(t) {
  const sql = t === 'drv' ? 'select tg_id from ln_drivers where blocked=false'
    : t === 'on' ? "select tg_id from ln_drivers where blocked=false and online and paid_until>now() and online_at>now()-interval '" + HOURS_ONLINE + " hours'"
    : 'select tg_id from ln_users where blocked=false union select tg_id from ln_drivers where blocked=false';
  return (await db.q(sql)).rows.map(x => +x.tg_id);
}
async function broadcast(ids, text) {
  let ok = 0, fail = 0;
  for (let i = 0; i < ids.length; i += 20) {
    const r = await Promise.all(ids.slice(i, i + 20).map(id => send(id, text).then(x => !!(x && x.ok)).catch(() => false)));
    for (const x of r) x ? ok++ : fail++;
  }
  return { ok, fail };
}
async function adminCmd(chat, t) {
  let m;
  if ((m = t.match(/^\/narx_([mv])\s+(\d{4,7})$/))) { await setSetting(m[1] === 'm' ? 'lp_m' : 'lp_v', m[2]); return send(chat, '✅ ' + (m[1] === 'm' ? 'Mahalla' : 'Viloyat') + ' taksisi narxi: ' + fmt(m[2]) + ' so‘m/oy'); }
  if ((m = t.match(/^\/kun\s+(\d{1,3})$/))) { await setSetting('lp_days', m[1]); return send(chat, '✅ Muddat: ' + m[1] + ' kun'); }
  if ((m = t.match(/^\/karta\s+(.{6,80})$/))) { await setSetting('card', m[1].trim()); return send(chat, '✅ Karta saqlandi: <code>' + esc(m[1].trim()) + '</code>'); }
  if ((m = t.match(/^\/salom\s+([\s\S]{3,600})$/))) { await setSetting('welcome', m[1].trim()); return send(chat, '✅ Bosh xabar matni saqlandi.'); }
  if (/^\/menyu_yop$/.test(t)) { await ensureMenu(true); return send(chat, '✅ Burchakdagi «Taksi» tugmasi o‘chirildi. Ko‘rinmasa, botni yopib qayta oching.'); }
  if ((m = t.match(/^\/h\s?(\d{4,15})$/))) return driverCard(chat, m[1]);
  if ((m = t.match(/^\/yoq\s+(\d{4,15})(?:\s+(\d{1,3}))?$/))) {
    const u = await activate(m[1], m[2] ? +m[2] : await payDays());
    if (!u) return send(chat, '❌ Haydovchi topilmadi');
    await quiet(send(m[1], '✅ Hisobingiz yoqildi. Amal qilish muddati: <b>' + fdate(u.paid_until) + '</b> gacha. «' + B.on + '» ni bosing.', { reply_markup: await menuKb(+m[1]) }));
    return send(chat, '✅ Yoqildi: ' + fdate(u.paid_until) + ' gacha');
  }
  if ((m = t.match(/^\/toxtat\s+(\d{4,15})$/))) {
    const r = await db.q('update ln_drivers set paid_until=now(), online=false where tg_id=$1 returning tg_id', [m[1]]);
    return send(chat, r.rows[0] ? '⛔ To‘xtatildi' : '❌ Haydovchi topilmadi');
  }
  if ((m = t.match(/^\/(blok|blokdan)\s+(\d{4,15})$/))) {
    if (isAdmin(m[2])) return send(chat, '❌ Adminni bloklab bo‘lmaydi.');
    await blockUser(m[2], m[1] === 'blok');
    return send(chat, m[1] === 'blok' ? '⛔ Bloklandi: ' + m[2] : '✅ Blokdan olindi: ' + m[2]);
  }
  if ((m = t.match(/^\/xabar\s+(\d{4,15})\s+([\s\S]{1,3000})$/))) {
    const r = await send(m[1], '📩 <b>Admin xabari:</b>\n\n' + plain(m[2]));
    return send(chat, r && r.ok ? '✅ Yuborildi' : '❌ Yuborilmadi (odam botni to‘xtatgan bo‘lishi mumkin)');
  }
  if ((m = t.match(/^\/hudud_(on|off)\s+(.+)$/))) {
    const nm = m[2].trim().slice(0, 60);
    const r = await db.q('update ln_regions set active=$2 where lower(name)=lower($1) returning id', [nm, m[1] === 'on']);
    return send(chat, r.rows.length ? (m[1] === 'on' ? '🟢 Ishga tushirildi: ' : '🕓 «Tez kunda» holatiga o‘tdi: ') + '<b>' + esc(nm) + '</b>' : '❌ Hudud topilmadi');
  }
  if ((m = t.match(/^\/hudud\s+(.+)$/))) {
    const parts = m[1].split('>').map(s => s.trim()).filter(Boolean);
    if (!parts.length || parts.length > 3) return send(chat, '❌ Format: <code>/hudud Xorazm &gt; Shovot</code>');
    let parent = null;
    for (let i = 0; i < parts.length; i++) {
      const nm = parts[i].slice(0, 40), kind = ['viloyat', 'tuman', 'mahalla'][i];
      const ex = parent ? await db.q('select id from ln_regions where parent_id=$1 and lower(name)=lower($2)', [parent, nm]) : await db.q('select id from ln_regions where parent_id is null and lower(name)=lower($1)', [nm]);
      if (ex.rows[0]) { parent = ex.rows[0].id; continue; }
      if (i < parts.length - 1) return send(chat, '❌ «' + esc(nm) + '» topilmadi. Avval uni qo‘shing.');
      await db.q('insert into ln_regions(parent_id,name,kind,active) values($1,$2,$3,$4)', [parent, nm, kind, kind !== 'viloyat']);
      return send(chat, '✅ Qo‘shildi: <b>' + esc(parts.join(' › ')) + '</b>' + (kind === 'viloyat' ? '\n🕓 «Tez kunda» holatida. Ishga tushirish: <code>/hudud_on ' + esc(nm) + '</code>' : ''));
    }
    return send(chat, 'Bu hudud allaqachon bor.');
  }
  return null;
}

// ---------- asosiy kirish ----------
async function onMessage(m) {
  const chat = m.chat.id, from = m.from, t = (m.text || '').trim();
  const admin = isAdmin(from.id);
  const u = (await db.q("insert into ln_users(tg_id,name) values($1,$2) on conflict (tg_id) do update set name=excluded.name returning blocked", [chat, nameOf(from)])).rows[0];
  if (u && u.blocked && !admin) return send(chat, '⛔ Hisobingiz bloklangan. Admin bilan bog‘laning.');
  if (/^\/start/i.test(t) || t === B.menu) { await clrSt(chat); return home(chat, await welcome()); }
  if (t === B.cancel) { await clrSt(chat); return home(chat, 'Bekor qilindi.'); }
  if (admin && t.startsWith('/')) {
    if (/^\/(admin|panel)$/i.test(t)) return send(chat, '🛠 <b>Admin paneli</b>', { reply_markup: ADM_KB });
    const r = await adminCmd(chat, t); if (r !== null) return r;
    return false; // eski admin buyruqlari (/stat, /add ...) tg.js da
  }
  if (t === B.taxi) return startTaxi(chat);
  if (t === B.drv) return startDriver(chat);
  if (t === B.on) return goOnline(chat, true);
  if (t === B.off) return goOnline(chat, false);
  if (t === B.pay) return startPay(chat);
  if (t === B.me) return showMe(chat);
  if (t === B.line) return startChange(chat);
  if (t === B.adm && admin) return send(chat, '🛠 <b>Admin paneli</b>', { reply_markup: ADM_KB });

  const { st, d } = await getSt(chat);
  if (admin && st === 'a_bc') {
    if (t.length < 2) return send(chat, 'Xabar matnini yozing.');
    d.text = t; await setSt(chat, 'a_bc2', d);
    const n = (await recipients(d.t)).length;
    return send(chat, '👀 <b>Ko‘rib chiqing</b> (' + n + ' kishiga boradi):\n\n' + plain(t), { reply_markup: { inline_keyboard: [[{ text: '✅ Yuborish', callback_data: 'bk:go' }, { text: '❌ Bekor', callback_data: 'bk:no' }]] } });
  }
  if (admin && st === 'a_one') {
    if (t.length < 1) return send(chat, 'Xabar matnini yozing.');
    await clrSt(chat);
    const r = await send(d.id, '📩 <b>Admin xabari:</b>\n\n' + plain(t));
    return send(chat, r && r.ok ? '✅ Yuborildi' : '❌ Yuborilmadi (odam botni to‘xtatgan bo‘lishi mumkin)');
  }
  if (st === 'd_name') {
    if (t.split(/\s+/).filter(Boolean).length < 2) return send(chat, 'Ism va familiyangizni to‘liq yozing (kamida 2 ta so‘z).');
    d.name = t.slice(0, 40); await setSt(chat, 'd_phone', d);
    return send(chat, '2/4 📞 Telefon raqamingizni yuboring.\n\n' + PH_NOTE + '\n\nYoki raqamni yozing: <code>90 123 45 67</code>', { reply_markup: { keyboard: [[{ text: '📞 Raqamni yuborish', request_contact: true }], [{ text: B.cancel }]], resize_keyboard: true } });
  }
  if (st === 'd_phone') {
    const ph = normPhone(m.contact ? m.contact.phone_number : t);
    if (!ph) return send(chat, 'Raqam noto‘g‘ri. Masalan: <code>90 123 45 67</code>');
    d.phone = ph; await setSt(chat, 'd_car', d);
    return send(chat, '3/4 🚗 Mashinangiz: markasi, rangi, davlat raqami. Masalan:\n<code>Cobalt, oq, 01 A 123 BC</code>', { reply_markup: { keyboard: [[{ text: B.cancel }]], resize_keyboard: true } });
  }
  if (st === 'd_car') {
    if (t.length < 6) return send(chat, 'Juda qisqa. Marka, rang va raqamni yozing.');
    d.car = t.slice(0, 60); await setSt(chat, 'd_kind', d);
    return send(chat, '4/4 <b>Qaysi turdagi taksi?</b>\n\n🏘 <b>Mahalla taksisi</b> — o‘z mahallangiz/qishlog‘ingiz ichida yurasiz\n🛣 <b>Viloyat taksisi</b> — tumanlararo yo‘lovchi tashiysiz', { reply_markup: { inline_keyboard: [
      [{ text: '🏘 Mahalla taksisi · ' + fmt(await priceOf('mahalla')) + ' so‘m/oy', callback_data: 'kd:m' }],
      [{ text: '🛣 Viloyat taksisi · ' + fmt(await priceOf('viloyat')) + ' so‘m/oy', callback_data: 'kd:v' }]] } });
  }
  if (st === 'p_addr') {
    if (m.location) { d.lat = m.location.latitude; d.lng = m.location.longitude; d.addr = (t && t !== B.cancel ? t : 'Lokatsiya'); }
    else if (t.length >= 3) { d.addr = t.slice(0, 200); }
    else return send(chat, 'Lokatsiya yuboring yoki manzilni yozing.');
    return afterAddr(chat, from, d);
  }
  if (st === 'p_phone') {
    const ph = normPhone(m.contact ? m.contact.phone_number : t);
    if (!ph) return send(chat, 'Raqam noto‘g‘ri. Masalan: <code>90 123 45 67</code>');
    await db.q('insert into ln_users(tg_id,name,phone) values($1,$2,$3) on conflict (tg_id) do update set phone=excluded.phone, name=excluded.name', [chat, nameOf(from), ph]);
    return placeOrder(chat, nameOf(from), ph, d);
  }
  if (st === 'p_to') {
    if (t.length < 2) return send(chat, 'Qayerga borishini yozing.');
    d.to_text = t.slice(0, 80); await setSt(chat, 'p_reg', d);
    const sc = await regScreen(d.k === 'mahalla' ? 'fm' : 'pf', 0);
    return send(chat, '✅ Qayerga: <b>' + esc(d.to_text) + '</b>\n\n' + sc.text, { reply_markup: sc.kb });
  }
  if (st === 'pay') {
    const ph = m.photo && m.photo.length ? 'p:' + m.photo[m.photo.length - 1].file_id : (m.document ? 'd:' + m.document.file_id : '');
    if (!ph) return send(chat, 'Chek <b>rasmini</b> yuboring (skrinshot).');
    const dr = await getDriver(chat);
    if (!dr) { await clrSt(chat); return home(chat, 'Avval ro‘yxatdan o‘ting.'); }
    const r = await db.q('insert into ln_pay(driver_id,file_id) values($1,$2) returning *', [chat, ph]);
    await clrSt(chat);
    if (process.env.ADMIN_ID) await quiet(sendCheque(String(process.env.ADMIN_ID).trim(), r.rows[0], dr.name, dr.phone, dr.kind));
    return home(chat, '✅ Chek yuborildi. Admin tasdiqlagach sizga xabar keladi.');
  }
  return home(chat, 'Menyudan tanlang 👇');
}

async function onCallback(q) {
  const d = q.data.split(':'), chat = q.message.chat.id, mid = q.message.message_id, from = q.from;
  const k = d[0], admin = isAdmin(from.id);
  if (!admin) {
    const u = (await db.q('select blocked from ln_users where tg_id=$1', [from.id])).rows[0];
    if (u && u.blocked) return answer(q, 'Hisobingiz bloklangan', true);
  }
  if (k === 'ia') return answer(q, '🕓 Bu hudud uchun xizmat tez kunda ishga tushadi.', true);
  if (k === 'pk') { // yo'lovchi: taksi turi
    await answer(q);
    const mode = d[1] === 'm' ? 'tm' : 'pt';
    await setSt(chat, 'p_reg', { k: d[1] === 'm' ? 'mahalla' : 'viloyat' });
    const s = await regScreen(mode, 0);
    return edit(chat, mid, s.text, { reply_markup: s.kb });
  }
  if (k === 'kd') { // haydovchi turi
    await answer(q);
    const { d: sd } = await getSt(chat); sd.kind = d[1] === 'm' ? 'mahalla' : 'viloyat';
    await setSt(chat, 'd_reg', sd);
    const s = await regScreen(d[1] === 'm' ? 'dm' : 'dv', 0);
    return edit(chat, mid, s.text, { reply_markup: s.kb });
  }
  if (k === 'rg') { await answer(q); const s = await regScreen(d[1], +d[2] || 0); return edit(chat, mid, s.text, { reply_markup: s.kb }); }
  if (k === 'pw') { await answer(q); const { d: sd } = await getSt(chat); await setSt(chat, 'p_to', sd); return edit(chat, mid, '🏁 <b>Qayerga borasiz?</b>\nYozing (masalan: <i>Urganch bozori</i> yoki <i>Toshkent</i>):'); }
  if (k === 'rs') {
    const mode = d[1], rid = +d[2], node = await reg(rid);
    if (!node) return answer(q, 'Hudud topilmadi', true);
    if (!node.active) return answer(q, '🕓 Bu hudud uchun xizmat tez kunda ishga tushadi.', true);
    await answer(q);
    const { st, d: sd } = await getSt(chat);
    if (mode === 'tm' || mode === 'pt') {
      sd.to_text = await pathName(rid); await setSt(chat, 'p_reg', sd);
      const sc = await regScreen(mode === 'tm' ? 'fm' : 'pf', 0);
      return edit(chat, mid, '✅ Qayerga: <b>' + esc(sd.to_text) + '</b>\n\n' + sc.text, { reply_markup: sc.kb });
    }
    if (mode === 'fm' || mode === 'pf') {
      sd.rid = rid; await setSt(chat, 'p_addr', sd);
      await edit(chat, mid, '✅ Qayerdan: <b>' + esc(await pathName(rid)) + '</b>\n🏁 Qayerga: <b>' + esc(sd.to_text || '—') + '</b>');
      return askAddr(chat, '');
    }
    if (mode === 'dm' || mode === 'dv') {
      await edit(chat, mid, '✅ Liniya: <b>' + esc(await pathName(rid)) + '</b>');
      if (st === 'd_reg') return finishReg(chat, from, sd, rid);
      const dr = await getDriver(chat);
      if (!dr) return home(chat, 'Avval «' + B.drv + '» orqali ro‘yxatdan o‘ting.');
      await db.q('update ln_drivers set region_id=$2 where tg_id=$1', [chat, rid]); await clrSt(chat);
      return send(chat, '📍 Liniyangiz almashdi: <b>' + esc(await pathName(rid)) + '</b>' + (isPaid(dr) ? '\nEndi «' + B.on + '» ni bosing.' : '\nLiniyaga chiqish uchun oylik to‘lov kerak.'), { reply_markup: await menuKb(chat) });
    }
    return;
  }
  if (k === 'on') { await answer(q); return goOnline(chat, true); }
  if (k === 'ch') { await answer(q); return startChange(chat); }
  if (k === 'la') return accept(q);
  if (k === 'ld') return finish(q, 'done');
  if (k === 'lc') return finish(q, 'cancel');
  if (k === 'pc') return passengerCancel(q);
  if (k === 'pa') return payDecide(q);
  if (k === 'am' || k === 'bc' || k === 'bk' || k === 'dc') {
    if (!admin) return answer(q, 'Faqat admin', true);
    await answer(q);
    if (k === 'am') return adminMenu(chat, d[1], d[2]);
    if (k === 'bc') { await setSt(chat, 'a_bc', { t: d[1] }); return send(chat, '✍️ Xabar matnini yozing (' + ({ all: 'botdagi hammaga', drv: 'barcha haydovchilarga', on: 'liniyadagilarga' }[d[1]] || '') + ').\nBekor qilish: «' + B.cancel + '».', { reply_markup: { keyboard: [[{ text: B.cancel }]], resize_keyboard: true } }); }
    if (k === 'bk') {
      const { st, d: sd } = await getSt(chat);
      await quiet(tg('editMessageReplyMarkup', { chat_id: chat, message_id: mid, reply_markup: { inline_keyboard: [] } }));
      if (d[1] === 'no' || st !== 'a_bc2' || !sd.text) { await clrSt(chat); return home(chat, 'Bekor qilindi.'); }
      await clrSt(chat);
      const ids = await recipients(sd.t), r = await broadcast(ids, '📢 ' + plain(sd.text));
      return home(chat, '✅ Yuborildi: ' + r.ok + ' ta' + (r.fail ? ' · yetmadi: ' + r.fail : ''));
    }
    if (k === 'dc') {
      const id = d[2];
      if (d[1] === 'blk' || d[1] === 'ubl') { if (isAdmin(id)) return send(chat, '❌ Adminni bloklab bo‘lmaydi.'); await blockUser(id, d[1] === 'blk'); return driverCard(chat, id); }
      if (d[1] === 'add') { const u = await activate(id, await payDays()); if (u) await quiet(send(id, '✅ Hisobingiz uzaytirildi: <b>' + fdate(u.paid_until) + '</b> gacha.')); return driverCard(chat, id); }
      if (d[1] === 'off') { await db.q('update ln_drivers set paid_until=now(), online=false where tg_id=$1', [id]); return driverCard(chat, id); }
      if (d[1] === 'msg') { await setSt(chat, 'a_one', { id }); return send(chat, '✍️ Shu haydovchiga xabar matnini yozing (bekor: «' + B.cancel + '»):', { reply_markup: { keyboard: [[{ text: B.cancel }]], resize_keyboard: true } }); }
    }
  }
}

let menuDone = false;
async function ensureMenu(force) {
  if (menuDone && !force) return;
  menuDone = true;
  try {
    if (!force && (await setting('menu_off', '')) === '2') return;
    const r = await tg('setChatMenuButton', { menu_button: { type: 'commands' } });
    if (r && r.ok) await setSetting('menu_off', '2'); else menuDone = false;
  } catch (e) { menuDone = false; }
}
const CB = new Set(['pk', 'kd', 'rg', 'rs', 'pw', 'la', 'ld', 'lc', 'pc', 'pa', 'am', 'ia', 'on', 'ch', 'bc', 'bk', 'dc']);
const menuChats = new Set();
async function chatMenu(chat) {
  if (!chat || menuChats.has(chat)) return;
  menuChats.add(chat);
  try { await tg('setChatMenuButton', { chat_id: chat, menu_button: { type: 'commands' } }); } catch (e) { menuChats.delete(chat); }
}
async function handle(up) {
  await ensureMenu();
  { const c = (up.message && up.message.chat && up.message.chat.id) || (up.callback_query && up.callback_query.message && up.callback_query.message.chat.id); if (c) await chatMenu(c); }
  if (up.callback_query && up.callback_query.data && up.callback_query.message) {
    if (!CB.has(String(up.callback_query.data).split(':')[0])) return false;
    await onCallback(up.callback_query); return true;
  }
  const m = up.message;
  if (m && m.chat && m.chat.type === 'private' && m.from) {
    const r = await onMessage(m);
    return r !== false;
  }
  return false;
}
module.exports = { handle };
