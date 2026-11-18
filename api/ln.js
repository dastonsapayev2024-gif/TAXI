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

const HOURS_ONLINE = 12;      // liniyada qolish muddati (soat)
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
async function freeEnd() { const v = await setting('free_until', ''); const t = v ? new Date(v).getTime() : 0; return t > Date.now() ? new Date(t) : null; }
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
const rname = async id => { if (!id) return '—'; const r = (await db.q('select name from ln_regions where id=$1', [id])).rows[0]; return r ? r.name : '—'; };
const routeOf = async (f, t) => esc(await rname(f)) + ' → ' + esc(await rname(t));
const reg = async id => (await db.q('select id,name,kind,parent_id,active from ln_regions where id=$1', [id])).rows[0] || null;
async function pathName(id) {
  const parts = []; let cur = await reg(id), n = 0;
  while (cur && n++ < 5) { parts.unshift(cur.name); cur = cur.parent_id ? await reg(cur.parent_id) : null; }
  return parts.join(' › ');
}
// mode: tm/fm (mahalla taksi: qayerga/qayerdan), pt/pf (viloyat taksi: qayerga/qayerdan), dm/dv (haydovchi: mahalla/viloyat)
const TUMAN_ONLY = m => m === 'pf' || m === 'pt' || m === 'dv' || m === 'dw';
const HEAD = {
  tm: '🏁 <b>Qayerga borasiz?</b>', fm: '📍 <b>Qayerdan minasiz?</b>', pt: '🏁 <b>Qayerga borasiz?</b>', pf: '📍 <b>Qayerdan minasiz?</b>',
  dm: '', dv: '', dt: '', dw: ''
};

// ---------- admin o'zgartira oladigan matnlar ----------
const TX = {};
const TXD = [
  ['b.taxi', 'Tugma: yo‘lovchi — taksi chaqirish', B.taxi], ['b.drv', 'Tugma: haydovchi bo‘lish', B.drv],
  ['b.on', 'Tugma: liniyaga chiqish', B.on], ['b.off', 'Tugma: liniyadan chiqish', B.off],
  ['b.pay', 'Tugma: to‘lov', B.pay], ['b.me', 'Tugma: holatim', B.me], ['b.line', 'Tugma: liniyani o‘zgartirish', B.line],
  ['b.adm', 'Tugma: admin', B.adm], ['b.cancel', 'Tugma: bekor', B.cancel], ['b.menu', 'Tugma: menyu', B.menu],
  ['h.tm', '1-oyna sarlavhasi (mahalla taksisi)', '🏁 Qayerga borasiz?'], ['h.fm', '2-oyna sarlavhasi (mahalla taksisi)', '📍 Qayerdan minasiz?'],
  ['h.pt', '1-oyna sarlavhasi (viloyat taksisi)', '🏁 Qayerga borasiz?'], ['h.pf', '2-oyna sarlavhasi (viloyat taksisi)', '📍 Qayerdan minasiz?'],
  ['h.dm', 'Haydovchi (mahalla): qayerdan', '🚕 Liniyangiz: qayerdan qatnaysiz?'], ['h.dv', 'Haydovchi (viloyat): qayerdan', '🚕 Liniyangiz: qayerdan qatnaysiz?'], ['h.dt', 'Haydovchi (mahalla): qayerga', '🏁 Qayerga qatnaysiz?'], ['h.dw', 'Haydovchi (viloyat): qayerga', '🏁 Qayerga qatnaysiz?'],
  ['hint_flat', 'Izoh: mahalla taksisi ro‘yxati', 'Joyni tanlang:'], ['hint_root', 'Izoh: viloyat tanlash', 'Viloyatni tanlang:'], ['hint_tuman', 'Izoh: tuman tanlash', 'Tumanni tanlang:'],
  ['hint_mahalla', 'Izoh: mahalla tanlash ({n} = tuman nomi)', 'Mahallani tanlang yoki «Butun {n}» ni bosing:'],
  ['whole', 'Tugma: butun tuman ({n} = tuman nomi)', '✅ Butun {n}'], ['back', 'Tugma: orqaga', '⬅️ Orqaga'],
  ['l_from', 'Haydovchiga: qayerdan', '📍 Qayerdan minadi'], ['l_to', 'Haydovchiga: qayerga', '🏁 Qayerga boradi']
];
for (const [k, , def] of TXD) if (!/^[bh]\./.test(k)) TX[k] = def;
let TXOV = {}, txAt = 0;
async function loadTx(force) {
  if (!force && Date.now() - txAt < 15000) return;
  const r = await db.q("select key,val from settings where key like 'tx:%'");
  const o = {}; for (const x of r.rows) o[x.key.slice(3)] = x.val;
  for (const [k, , def] of TXD) {
    const v = o[k] != null ? o[k] : def, i = k.indexOf('.');
    if (i > 0 && k[0] === 'b') B[k.slice(2)] = v;
    else if (i > 0 && k[0] === 'h') HEAD[k.slice(2)] = '<b>' + esc(v) + '</b>';
    else TX[k] = v;
  }
  TXOV = o; txAt = Date.now();
}
async function regScreen(mode, nodeId) {
  // mahalla taksisi va mahalla haydovchisi: bitta tekis ro'yxat (oyna ichida oyna yo'q)
  if (TUMAN_ONLY(mode)) {
    // viloyat taksisi: faqat viloyatlar ro'yxati (viloyat → viloyat)
    const vs = (await kids(null)).filter(k => k.kind === 'viloyat');
    return { text: HEAD[mode] + '\n\n' + esc(TX.hint_root), kb: { inline_keyboard: vs.map(k => [{ text: k.name, callback_data: 'rs:' + mode + ':' + k.id }]) } };
  }
  if (mode === 'tm' || mode === 'fm' || mode === 'dm' || mode === 'dt') {
    const tum = [], mah = [];
    for (const v of (await kids(null)).filter(k => k.active)) {
      for (const t of (await kids(v.id)).filter(k => k.active)) {
        tum.push(t);
        for (const m of (await kids(t.id)).filter(k => k.active)) mah.push(m);
      }
    }
    const srt = (x, y) => String(x.name).localeCompare(String(y.name), 'uz');
    const all = mah.sort(srt).concat(tum.sort(srt));
    if (!all.length) return { text: HEAD[mode] + '\n\nBu yerda hududlar hali qo‘shilmagan. Tez kunda ishga tushadi.', kb: { inline_keyboard: [] } };
    return { text: HEAD[mode] + '\n\n' + esc(TX.hint_flat), kb: { inline_keyboard: all.map(k => [{ text: k.name, callback_data: 'rs:' + mode + ':' + k.id }]) } };
  }
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
  if (node && node.kind === 'tuman' && !TUMAN_ONLY(mode)) rows.push([{ text: TX.whole.replace('{n}', node.name), callback_data: 'rs:' + mode + ':' + node.id }]);
  if (node && !(solo && node.kind === 'viloyat')) rows.push([{ text: TX.back, callback_data: 'rg:' + mode + ':' + (node.parent_id || 0) }]);
  let hint;
  if (!node) hint = esc(TX.hint_root);
  else if (node.kind === 'viloyat' || TUMAN_ONLY(mode)) hint = esc(TX.hint_tuman);
  else hint = esc(TX.hint_mahalla).replace('{n}', esc(node.name));
  const text = HEAD[mode] + (node && !(solo && node.kind === 'viloyat' && local) ? '\n📍 ' + esc(await pathName(node.id)) : '') + '\n\n' + hint + (list.some(k => !k.active) ? '\n<i>🕓 — tez kunda ishga tushadi</i>' : '');
  return { text: list.length ? text : HEAD[mode] + '\n\nBu yerda hududlar hali qo‘shilmagan. Tez kunda ishga tushadi.', kb: { inline_keyboard: rows } };
}

// ---------- menyu ----------
let menuFresh = 0;
async function menuKb(id) {
  menuFresh = id;
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
async function activeOrder(uid) {
  return (await db.q("select id,status from ln_orders where uid=$1 and ((status='new' and created > now() - interval '" + ORDER_MIN + " minutes') or (status='taken' and taken_at > now() - interval '3 hours')) order by created desc limit 1", [uid])).rows[0] || null;
}
async function startTaxi(chat) {
  const d = await getDriver(chat);
  if (isPaid(d) && !isAdmin(chat)) return home(chat, '🚕 Siz haydovchisiz, oylik muddatingiz amal qilmoqda (' + fdate(d.paid_until) + ' gacha). Shu muddat ichida o‘zingiz taksi chaqira olmaysiz.');
  const act = await activeOrder(chat);
  if (act && !isAdmin(chat)) return send(chat, '⏳ <b>Sizda faol buyurtma bor</b> #' + act.id + '\n' + (act.status === 'taken' ? 'Haydovchi qabul qilgan, u siz bilan bog‘lanadi.' : 'Haydovchilarga yuborilgan, javobni kuting.') + '\n\nYangi buyurtma berish uchun avval shuni yakunlang yoki bekor qiling.', { reply_markup: { inline_keyboard: [[{ text: '❌ Buyurtmani bekor qilish', callback_data: 'pc:' + act.id }]] } });
  await clrSt(chat);
  return send(chat, '🚖 <b>Qanday taksi kerak?</b>\n\n🏘 <b>Mahalla taksisi</b> — o‘z qishlog‘ingiz/mahallangiz ichida\n🛣 <b>Viloyat taksisi</b> — tuman va shaharlar orasida', { reply_markup: { inline_keyboard: [
    [{ text: '🏘 Mahalla taksisi', callback_data: 'pk:m' }],
    [{ text: '🛣 Viloyat taksisi', callback_data: 'pk:v' }]] } });
}
const askAddr = async (chat, text) => send(chat, (text ? text + '\n\n' : '') + '📍 <b>Sizni qayerdan olib ketamiz?</b>\nLokatsiya yuboring (tugma) yoki uy manzilini yozing.', { reply_markup: { keyboard: [[{ text: '📍 Lokatsiya yuborish', request_location: true }], [{ text: B.cancel }]], resize_keyboard: true } });

async function eligible(kind, rid, toId, except) {
  const r = await db.q(
    "select d.tg_id from ln_drivers d where d.blocked=false and d.online and d.online_at > now() - interval '" + HOURS_ONLINE + " hours' and d.paid_until > now() and d.kind=$1 " +
    "and d.region_id=$2 and d.to_id=$3 and d.tg_id<>$4 " +
    "order by d.online_at limit 60", [kind, rid, toId || 0, except || 0]);
  return r.rows.map(x => +x.tg_id);
}

async function placeOrder(uid, pname, phone, data) {
  if (!isAdmin(uid) && await activeOrder(uid)) { await clrSt(uid); return home(uid, '⏳ Sizda faol buyurtma bor. Avval uni yakunlang yoki bekor qiling.'); }
  const ids = await eligible(data.k, data.rid, data.to_id, isAdmin(uid) ? 0 : uid); // admin o'zini sinab ko'ra oladi
  if (!ids.length && process.env.ADMIN_ID) {
    try {
      const x = (await db.q("select count(*) filter (where region_id=$1 and to_id=$2)::int r, count(*) filter (where region_id=$1 and to_id=$2 and kind=$3)::int k, count(*) filter (where region_id=$1 and to_id=$2 and kind=$3 and online)::int o, count(*) filter (where region_id=$1 and to_id=$2 and kind=$3 and online and paid_until>now())::int p, count(*) filter (where region_id=$1 and to_id=$2 and kind=$3 and online and paid_until>now() and not blocked and online_at>now()-interval '" + HOURS_ONLINE + " hours')::int ok from ln_drivers", [data.rid, data.to_id || 0, data.k])).rows[0];
      await quiet(send(String(process.env.ADMIN_ID).trim(), '🔎 <b>Buyurtma uchun haydovchi topilmadi</b>\nYo‘nalish: <b>' + (await routeOf(data.rid, data.to_id)) + '</b> (' + (data.k === 'viloyat' ? 'viloyat' : 'mahalla') + ' taksisi)\n\nShu yo‘nalishdagi haydovchilar: <b>' + x.r + '</b>\n• shu turdagi: ' + x.k + '\n• liniyada: ' + x.o + '\n• to‘lovi bor: ' + x.p + '\n• buyurtma olishga tayyor: <b>' + x.ok + '</b>\n\nBatafsil: /tekshir'));
    } catch (e) { /* tashxis xatosi buyurtmaga ta'sir qilmasin */ }
  }
  if (!ids.length) { await clrSt(uid); return home(uid, '😔 Hozir bu yo‘nalishda liniyada haydovchi yo‘q. Birozdan keyin qayta urinib ko‘ring.'); }
  const id = newId(), where = esc(TX.l_from) + ': <b>' + esc(await rname(data.rid)) + '</b>\n' + esc(TX.l_to) + ': <b>' + esc(await rname(data.to_id)) + '</b>';
  await db.q('insert into ln_orders(id,uid,pname,phone,kind,region_id,to_text,addr,lat,lng,to_id,people,uname,acc) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
    [id, uid, pname, phone, data.k, data.rid, data.to_text || '', data.addr || '', data.lat == null ? null : data.lat, data.lng == null ? null : data.lng, data.to_id || null, data.people || 1, data.uname || '', data.acc == null ? null : data.acc]);
  const text = '🚕 <b>Yangi buyurtma</b> #' + id + '\n📍 ' + where + '\n📌 Manzil: ' + esc(data.addr || 'Lokatsiya') + '\n👥 Necha kishi: <b>' + (data.people || 1) + '</b>\n👤 ' + esc(pname);
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
  d.uid = chat; d.uname = from.username || '';
  await setSt(chat, 'p_ppl', d);
  return send(chat, '👥 <b>Necha kishi borasiz?</b>\nPastdagi raqamlardan birini bosing.', { reply_markup: { keyboard: [[{ text: '1' }, { text: '2' }, { text: '3' }, { text: '4' }], [{ text: '5' }, { text: '6' }, { text: '7' }, { text: '8' }], [{ text: B.cancel }]], resize_keyboard: true } });
}
const LOC_MAX = 25, LOC_OK = '✅ Shu lokatsiya yetadi';
const PH_YES = '✅ Ha, shu raqam', PH_OTHER = '✏️ Boshqa raqam';
const phoneKb = () => ({ keyboard: [[{ text: '📲 Telegram raqamimni yuborish', request_contact: true }], [{ text: B.cancel }]], resize_keyboard: true });
async function afterPeople(chat, from, d) {
  const u = (await db.q('select phone from ln_users where tg_id=$1', [chat])).rows[0];
  await setSt(chat, 'p_phone', d);
  if (u && u.phone) return send(chat, '📞 <b>Telefon raqamingiz:</b> <code>' + esc(showPhone(u.phone)) + '</code>\n\nHaydovchi shu raqamga qo‘ng‘iroq qiladi. <b>Shu raqammi?</b>', { reply_markup: { keyboard: [[{ text: PH_YES }], [{ text: PH_OTHER }], [{ text: B.cancel }]], resize_keyboard: true } });
  return send(chat, PHONE_ASK, { reply_markup: phoneKb() });
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
  const pr = await priceOf(d.kind), rn = d.region_id && d.to_id ? await routeOf(d.region_id, d.to_id) : '—';
  const st = isPaid(d) ? '✅ Amal qiladi: <b>' + fdate(d.paid_until) + '</b> gacha (' + daysLeft(d.paid_until) + ' kun)' : '⚠️ To‘lov yo‘q yoki muddati tugagan';
  return home(chat, '🚕 <b>' + esc(d.name) + '</b>\n📞 ' + esc(showPhone(d.phone)) + '\n🚗 ' + esc(d.car) + '\n🏷 ' + (d.kind === 'viloyat' ? 'Viloyat taksisi' : 'Mahalla taksisi') + '\n📍 Liniyangiz: <b>' + rn +
    '</b>\n💰 Oylik to‘lov: ' + fmt(pr) + ' so‘m\n' + st + '\n' + (d.online && isPaid(d) ? '🟢 Liniyadasiz' : '🔴 Liniyada emassiz'));
}
async function goOnline(chat, on) {
  const d = await getDriver(chat);
  if (!d) return home(chat, 'Avval «' + B.drv + '» orqali ro‘yxatdan o‘ting.');
  if (d.blocked) return home(chat, '⛔ Hisobingiz bloklangan. Admin bilan bog‘laning.');
  if (on) {
    if (!isPaid(d)) return home(chat, '⚠️ Liniyaga chiqish uchun oylik to‘lov kerak. «' + B.pay + '» ni bosing.');
    if (!d.region_id || !d.to_id) return startChange(chat);
    await db.q('update ln_drivers set online=true, online_at=now() where tg_id=$1', [chat]);
    return home(chat, '🟢 Siz liniyadasiz: <b>' + (await routeOf(d.region_id, d.to_id)) + '</b>\nBuyurtma kelsa, shu yerga xabar keladi.\n\n⚠️ Xizmatni tugatgandan keyin liniyani o‘chirib qo‘yish esingizdan chiqmasin. Unutsangiz, yoqilgandan ' + HOURS_ONLINE + ' soat o‘tgach o‘zi avto chiqadi. Xohlagan paytingizda yana yoqishingiz mumkin.\n\nBoshqa joyga o‘tish: «' + B.line + '».');
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
async function finishReg(chat, from, d, rid, toId) {
  await db.q("insert into ln_drivers(tg_id,name,username,phone,car,kind,region_id,to_id) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict (tg_id) do update set name=excluded.name, phone=excluded.phone, car=excluded.car, kind=excluded.kind, region_id=excluded.region_id, to_id=excluded.to_id",
    [chat, d.name, from.username || '', d.phone, d.car, d.kind, rid, toId]);
  await clrSt(chat);
  const pr = await priceOf(d.kind), fe = await freeEnd();
  if (fe) {
    await db.q('update ln_drivers set paid_until=greatest(coalesce(paid_until, now()), $2::timestamptz) where tg_id=$1', [chat, fe.toISOString()]);
    return home(chat, '✅ <b>Ro‘yxatdan o‘tdingiz!</b>\n\n🎁 Hozir <b>bepul davr</b>: <b>' + fdate(fe) + '</b> gacha to‘lovsiz ishlaysiz. «' + B.on + '» ni bosing.\nKeyin oylik to‘lov: <b>' + fmt(pr) + ' so‘m</b> («' + B.pay + '»).\n\nLiniyani istagan payt «' + B.line + '» orqali almashtira olasiz.');
  }
  return home(chat, '✅ <b>Ro‘yxatdan o‘tdingiz!</b>\n\nKeyingi qadam: oylik to‘lov <b>' + fmt(pr) + ' so‘m</b>. «' + B.pay + '» ni bosing, to‘lab chekni yuboring. Admin tasdiqlagach «' + B.on + '» ishlaydi.\n\nLiniyani istagan payt «' + B.line + '» orqali almashtira olasiz.');
}

async function accept(q) {
  const id = q.data.split(':')[1], from = q.from, chat = q.message.chat.id, mid = q.message.message_id;
  const d = await getDriver(from.id);
  if (!d) return answer(q, 'Avval haydovchi sifatida ro‘yxatdan o‘ting', true);
  if (d.blocked) return answer(q, 'Hisobingiz bloklangan', true);
  if (!isPaid(d)) return answer(q, 'To‘lov muddati tugagan. «💳 To‘lov» ni bosing.', true);
  const r = await db.q("update ln_orders set status='taken', driver_id=$2, taken_at=now() where id=$1 and status='new' and created > now() - interval '" + ORDER_MIN + " minutes' returning *", [id, from.id]);
  const o = r.rows[0];
  if (!o) {
    const x = (await db.q('select status from ln_orders where id=$1', [id])).rows[0];
    if (x && x.status === 'new') { await db.q("update ln_orders set status='expired' where id=$1", [id]); await edit(chat, mid, '⌛ Buyurtma muddati o‘tdi.'); return answer(q, 'Muddati o‘tdi', true); }
    await edit(chat, mid, x && x.status === 'cancelled' ? '❌ Yo‘lovchi bekor qildi.' : '⏱ Boshqa haydovchi oldi.');
    return answer(q, x && x.status === 'cancelled' ? 'Yo‘lovchi bekor qildi' : 'Boshqa haydovchi oldi', true);
  }
  await answer(q, 'Buyurtma sizniki ✅');
  const where = esc(TX.l_from) + ': ' + esc(await rname(o.region_id)) + '\n' + esc(TX.l_to) + ': ' + esc(o.to_id ? await rname(o.to_id) : (o.to_text || '—'));
  const tgl = o.uname ? '@' + esc(o.uname) : '<a href="tg://user?id=' + o.uid + '">Telegramda yozish</a>';
  const kb = [[{ text: '✅ Keldim', callback_data: 'ld:' + id }, { text: '❌ Bekor', callback_data: 'lc:' + id }]];
  if (o.lat != null) kb.unshift([{ text: '🗺 Xaritada ko‘rish', url: mapLink(o.lat, o.lng) }]);
  await edit(chat, mid, '✅ <b>Siz oldingiz</b> #' + id + '\n\n👤 ' + esc(o.pname) + '\n📞 <b>' + esc(showPhone(o.phone)) + '</b>\n💬 ' + tgl + '\n👥 Necha kishi: <b>' + (o.people || 1) + '</b>\n📍 ' + where + '\n📌 ' + esc(o.addr || 'Lokatsiya') + '\n\nYo‘lovchi bilan bog‘lanib, borib oling. Narxni o‘zaro kelishasiz.', { reply_markup: { inline_keyboard: kb } });
  if (o.lat != null) await quiet(tg('sendLocation', Object.assign({ chat_id: chat, latitude: o.lat, longitude: o.lng }, o.acc != null ? { horizontal_accuracy: Math.min(1500, Math.max(1, o.acc)) } : {})));
  const others = (await db.q('select chat_id,msg_id from ln_msgs where order_id=$1 and chat_id<>$2', [id, from.id])).rows;
  for (const m of others) await edit(m.chat_id, m.msg_id, '⏱ Buyurtma #' + id + ' boshqa haydovchi tomonidan olindi.');
  const rr = (await db.q('select count(rating)::int n, round(avg(rating)::numeric,1) a from ln_orders where driver_id=$1', [d.tg_id])).rows[0];
  const ratingLine = rr && rr.n > 0 ? '\n⭐ Baho: <b>' + rr.a + '</b> (' + rr.n + ' ta)' : '';
  const cardText = '✅ <b>Buyurtmangiz qabul qilindi!</b> #' + id + '\n\n🚕 Haydovchi: <b>' + esc(d.name) + '</b>\n🚗 ' + esc(d.car) + ratingLine + '\n📞 <b>' + esc(showPhone(d.phone)) + '</b>\n\nHaydovchi siz bilan bog‘lanadi va kelib oladi. Narxni haydovchi bilan o‘zaro kelishasiz.';
  const cardKb = { inline_keyboard: [[{ text: '🔔 Haydovchiga eslatish', callback_data: 'pr:' + id }], [{ text: '❌ Bekor qilish', callback_data: 'pc:' + id }]] };
  let sentCard = false;
  try {
    const ph = await tg('getUserProfilePhotos', { user_id: d.tg_id, limit: 1 });
    const sizes = ph && ph.photos && ph.photos[0];
    if (sizes && sizes.length) {
      await tg('sendPhoto', { chat_id: o.uid, photo: sizes[Math.min(1, sizes.length - 1)].file_id, caption: cardText, parse_mode: 'HTML', reply_markup: cardKb });
      sentCard = true;
    }
  } catch (e) {}
  if (!sentCard) await quiet(send(o.uid, cardText, { reply_markup: cardKb }));
}
async function remind(q) {
  const id = q.data.split(':')[1], from = q.from;
  const r = await db.q("update ln_orders set remind_at=now() where id=$1 and uid=$2 and status='taken' and (remind_at is null or remind_at < now() - interval '3 minutes') returning *", [id, from.id]);
  const o = r.rows[0];
  if (!o) {
    const x = (await db.q('select status from ln_orders where id=$1 and uid=$2', [id, from.id])).rows[0];
    return answer(q, x && x.status === 'taken' ? 'Eslatma yaqinda yuborilgan. Birozdan keyin yana bosing.' : 'Buyurtma yopilgan', true);
  }
  await answer(q, 'Haydovchiga eslatma yuborildi 🔔');
  const tgl = o.uname ? '@' + esc(o.uname) : '<a href="tg://user?id=' + o.uid + '">Telegramda yozish</a>';
  const kb = [[{ text: '✅ Keldim', callback_data: 'ld:' + id }, { text: '❌ Bekor', callback_data: 'lc:' + id }]];
  if (o.lat != null) kb.unshift([{ text: '🗺 Xaritada ko‘rish', url: mapLink(o.lat, o.lng) }]);
  await quiet(send(o.driver_id, '🔔 <b>Yo‘lovchi eslatmoqda</b> #' + id + '\n\n👤 ' + esc(o.pname) + '\n📞 <b>' + esc(showPhone(o.phone)) + '</b>\n💬 ' + tgl + '\n👥 Necha kishi: <b>' + (o.people || 1) + '</b>\n📌 ' + esc(o.addr || 'Lokatsiya') + '\n\nYo‘lovchi sizni kutyapti.', { reply_markup: { inline_keyboard: kb } }));
}
async function finish(q, kind) {
  const id = q.data.split(':')[1], from = q.from, chat = q.message.chat.id, mid = q.message.message_id;
  const r = await db.q("update ln_orders set status=$3, done_at=now() where id=$1 and driver_id=$2 and status='taken' returning uid", [id, from.id, kind === 'done' ? 'done' : 'cancelled']);
  if (!r.rows[0]) return answer(q, 'Buyurtma allaqachon yopilgan', true);
  await answer(q, kind === 'done' ? 'Rahmat! 🏁' : 'Bekor qilindi');
  await edit(chat, mid, (kind === 'done' ? '✅ Keldim deb belgilandi' : '❌ Siz bekor qildingiz') + ' #' + id + '. Liniyada qolasiz.');
  if (kind === 'done') {
    const dr = await getDriver(from.id);
    await quiet(send(r.rows[0].uid, '🚖 <b>Haydovchi yetib keldi!</b> #' + id + '\n\n' + (dr ? esc(dr.name) + ' · ' + esc(dr.car) + '\n📞 ' + esc(showPhone(dr.phone)) + '\n\n' : '') + 'Iltimos, chiqing. Safardan keyin haydovchiga baho bering 👇',
      { reply_markup: { inline_keyboard: [[1, 2, 3, 4, 5].map(n => ({ text: '⭐' + n, callback_data: 'rt:' + id + ':' + n }))] } }));
  }
  if (kind !== 'done') await quiet(send(r.rows[0].uid, '❌ Haydovchi buyurtmani bekor qildi #' + id + '. Qayta buyurtma bering: «' + B.taxi + '».'));
}
async function rate(q) {
  const [, id, n] = q.data.split(':'), from = q.from, chat = q.message.chat.id, mid = q.message.message_id;
  const v = +n;
  if (!(v >= 1 && v <= 5)) return answer(q, 'Xato', true);
  const r = await db.q("update ln_orders set rating=$3 where id=$1 and uid=$2 and status='done' and rating is null returning id", [id, from.id, v]);
  if (!r.rows[0]) return answer(q, 'Baho allaqachon qo‘yilgan', true);
  await answer(q, 'Rahmat! ⭐');
  await quiet(edit(chat, mid, '⭐ <b>Bahoingiz: ' + v + '/5</b> #' + id + '\nRahmat, fikringiz biz uchun muhim!'));
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
  [{ text: '🗺 Hududlar', callback_data: 'am:reg' }, { text: '✏️ Matnlar', callback_data: 'am:tx' }]] };
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
  const n = (await db.q("select count(*) filter (where status='done')::int done, count(*)::int tot, count(rating)::int rn, round(avg(rating)::numeric,1) ra from ln_orders where driver_id=$1", [id])).rows[0];
  const text = '🚕 <b>' + esc(d.name) + '</b> · <code>' + d.tg_id + '</code>' + (d.username ? ' · @' + esc(d.username) : '') + '\n📞 ' + esc(showPhone(d.phone)) + '\n🚗 ' + esc(d.car) +
    '\n🏷 ' + (d.kind === 'viloyat' ? 'Viloyat' : 'Mahalla') + ' taksisi\n📍 ' + (d.region_id && d.to_id ? await routeOf(d.region_id, d.to_id) : '—') +
    '\n💰 ' + (isPaid(d) ? '✅ ' + fdate(d.paid_until) + ' gacha (' + daysLeft(d.paid_until) + ' kun)' : '❌ to‘lov yo‘q') + '\n' + (d.online ? '🟢 Liniyada' : '🔴 Liniyada emas') + (d.blocked ? '\n⛔ <b>Bloklangan</b>' : '') +
    '\n📦 Buyurtmalar: ' + n.done + ' bajarilgan / ' + n.tot + ' jami' + (n.rn > 0 ? '\n⭐ Baho: ' + n.ra + ' (' + n.rn + ' ta)' : '') + '\n🗓 Ro‘yxatdan: ' + fdate(d.created);
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
    const r = (await db.q("select d.name, d.kind, d.region_id, d.to_id from ln_drivers d where d.online and d.paid_until>now() and d.blocked=false and d.online_at>now()-interval '" + HOURS_ONLINE + " hours' order by d.region_id")).rows;
    if (!r.length) return send(chat, '🔴 Hozir liniyada hech kim yo‘q.');
    const g = {};
    for (const d of r) { const k = (d.region_id && d.to_id ? (await rname(d.region_id)) + ' → ' + (await rname(d.to_id)) : '—') + ' (' + (d.kind === 'viloyat' ? 'viloyat' : 'mahalla') + ')'; (g[k] = g[k] || []).push(d.name); }
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
  if (what === 'tx') {
    await loadTx(true);
    const rows = TXD.map((x, i) => [{ text: (TXOV[x[0]] != null ? '✏️ ' : '') + x[1] + ': ' + String(TXOV[x[0]] != null ? TXOV[x[0]] : x[2]).slice(0, 28), callback_data: 'tx:e:' + i }]);
    return send(chat, '✏️ <b>Matnlar</b>\nO‘zgartirmoqchi bo‘lgan matnni bosing. ✏️ belgisi — o‘zgartirilgan.\n\nO‘zgartirgach foydalanuvchilar tugmalar yangilanishi uchun botga /start yozishi kerak.', { reply_markup: { inline_keyboard: rows } });
  }
  if (what === 'reg') {
    return send(chat, '🗺 <b>Hududlar</b>\n\n' + (await regTree(null, 0)) + '\n🕓 — «tez kunda» (odamlar bossa shunday xabar oladi)\n\n<b>Buyruqlar:</b>\n<code>/hudud Xorazm &gt; Shovot</code> — tuman qo‘shish\n<code>/hudud Xorazm &gt; Shovot &gt; Yangi mahalla</code>\n<code>/hudud Buxoro</code> — yangi viloyat\n<code>/tekshir</code> — haydovchilar nega buyurtma olmayotganini ko‘rsatadi\n<code>/nom Eski nom &gt; Yangi nom</code> — nomini o‘zgartirish\n<code>/hudud_on Buxoro</code> — ishga tushirish\n<code>/hudud_off Buxoro</code> — «tez kunda» holatiga qaytarish');
  }
}
async function sendCheque(admChat, p, name, phone, kind) {
  const cap = '💳 <b>To‘lov cheki</b> #' + p.id + '\n👤 ' + esc(name) + ' · ' + esc(showPhone(phone)) + '\n🏷 ' + (kind === 'viloyat' ? 'Viloyat' : 'Mahalla') + ' taksisi · <code>' + p.driver_id + '</code>';
  const kb = { inline_keyboard: [[{ text: '✅ Tasdiqlash', callback_data: 'pa:ok:' + p.id }, { text: '❌ Rad', callback_data: 'pa:no:' + p.id }]] };
  const isDoc = String(p.file_id).startsWith('d:'), fid = String(p.file_id).slice(2);
  return tg(isDoc ? 'sendDocument' : 'sendPhoto', isDoc ? { chat_id: admChat, document: fid, caption: cap, parse_mode: 'HTML', reply_markup: kb } : { chat_id: admChat, photo: fid, caption: cap, parse_mode: 'HTML', reply_markup: kb });
}
async function activate(id, days) {
  const r = await db.q("update ln_drivers set paid_until = greatest(now(), coalesce(paid_until, now())) + ($2 || ' days')::interval where tg_id=$1 returning paid_until, kind, region_id, to_id", [id, String(days)]);
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
  if (u) await quiet(send(p.driver_id, '✅ <b>To‘lov tasdiqlandi!</b>\nAmal qilish muddati: <b>' + fdate(u.paid_until) + '</b> gacha.\n\n📍 Liniyangiz: <b>' + (u.region_id && u.to_id ? await routeOf(u.region_id, u.to_id) : '—') + '</b>\nTo‘g‘ri bo‘lsa «' + B.on + '» ni bosing. Boshqa joy kerak bo‘lsa, avval liniyani o‘zgartiring.',
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
  if ((m = t.match(/^\/tekin(?:\s+(\d{1,3}))?$/))) {
    const days = m[1] === undefined ? 7 : +m[1];
    if (!days) { await setSetting('free_until', ''); return send(chat, '✅ Bepul davr to‘xtatildi. Yangi haydovchilar endi to‘laydi. Allaqachon berilgan muddatlar o‘z kunigacha amal qiladi.'); }
    const end = new Date(Date.now() + days * 86400000);
    await setSetting('free_until', end.toISOString());
    const r = await db.q('update ln_drivers set paid_until=greatest(coalesce(paid_until, now()), $1::timestamptz) where blocked=false returning tg_id', [end.toISOString()]);
    for (const x of r.rows) await quiet(send(x.tg_id, '🎁 <b>Bepul davr!</b>\n<b>' + fdate(end) + '</b> gacha to‘lovsiz ishlaysiz. «' + B.on + '» ni bosing.', { reply_markup: await menuKb(+x.tg_id) }));
    return send(chat, '✅ Bepul davr: <b>' + days + ' kun</b> (' + fdate(end) + ' gacha).\n' + r.rows.length + ' ta haydovchiga berildi. Yangi ro‘yxatdan o‘tganlarga ham avtomatik beriladi.\n\nTo‘xtatish: <code>/tekin 0</code>');
  }
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
  if (/^\/tekshir$/.test(t)) {
    const r = (await db.q("select d.tg_id,d.name,d.kind,d.region_id,d.to_id,d.online,d.blocked,(d.paid_until>now()) paid,(d.online_at>now()-interval '" + HOURS_ONLINE + " hours') fresh from ln_drivers d order by d.created desc limit 30")).rows;
    if (!r.length) return send(chat, 'Haydovchi yo‘q.');
    let out = '🔎 <b>Haydovchilar holati</b>\n';
    for (const d of r) {
      const bad = [];
      if (!d.region_id || !d.to_id) bad.push('yo‘nalish tanlanmagan');
      if (d.blocked) bad.push('bloklangan');
      if (!d.paid) bad.push('to‘lov yo‘q');
      if (!d.online) bad.push('liniyada emas'); else if (!d.fresh) bad.push('liniya muddati tugagan');
      out += '\n' + (bad.length ? '❌' : '✅') + ' <b>' + esc(d.name) + '</b> · ' + (d.kind === 'viloyat' ? 'viloyat' : 'mahalla') + '\n   ' + (d.region_id && d.to_id ? await routeOf(d.region_id, d.to_id) : '—') + (bad.length ? '\n   ⚠️ ' + bad.join(', ') : '\n   buyurtma oladi') + '\n';
    }
    return send(chat, out);
  }
  if ((m = t.match(/^\/nom\s+(.+?)\s*>\s*(.+)$/))) {
    const nq = z => z.replace(/[’ʻ'`´]/g, '‘').trim().toLowerCase();
    const all = (await db.q('select id,name from ln_regions')).rows.filter(r => nq(r.name) === nq(m[1]));
    if (all.length !== 1) return send(chat, all.length ? '❌ Bu nom bir nechta joyda bor' : '❌ Topilmadi: ' + esc(m[1]));
    try { await db.q('update ln_regions set name=$2 where id=$1', [all[0].id, m[2].trim().slice(0, 60)]); } catch (e) { return send(chat, '❌ Bunday nom bu joyda allaqachon bor'); }
    return send(chat, '✅ Nom o‘zgardi: <b>' + esc(m[2].trim()) + '</b>');
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
  if (admin && st === 'a_tx') {
    const x = TXD[d.i]; await clrSt(chat);
    if (!x || t.length < 1) return send(chat, 'Bekor qilindi.');
    await setSetting('tx:' + x[0], t.slice(0, 120)); await loadTx(true);
    return send(chat, '✅ Saqlandi: <b>' + esc(t.slice(0, 120)) + '</b>\n\nBoshqa matn: Admin → ✏️ Matnlar', { reply_markup: await menuKb(chat) });
  }
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
  if (st === 'p_ppl') {
    const n = parseInt(t, 10);
    if (!(n >= 1 && n <= 8)) return send(chat, 'Necha kishi ekanini raqam bilan bosing: 1 dan 8 gacha.');
    d.people = n; return afterPeople(chat, from, d);
  }
  if (st === 'p_addr') {
    if (t === LOC_OK && d.pend) { d.lat = d.pend.lat; d.lng = d.pend.lng; d.acc = d.pend.acc; d.addr = 'Lokatsiya'; delete d.pend; }
    else if (m.location) {
      const acc = m.location.horizontal_accuracy == null ? null : Math.round(m.location.horizontal_accuracy);
      if (acc != null && acc > LOC_MAX && !d.warned) {
        d.warned = true; d.pend = { lat: m.location.latitude, lng: m.location.longitude, acc };
        await setSt(chat, 'p_addr', d);
        return send(chat, '📍 Lokatsiya aniqligi taxminan <b>±' + acc + ' metr</b> (kerak: ' + LOC_MAX + ' m gacha).\n\nAniqroq bo‘lishi uchun <b>ochiq joyda turib</b>, GPS yoqilgan holda qayta yuboring.\n📱 iPhone: Sozlamalar → Maxfiylik → Joylashuv xizmatlari → Telegram → <b>«Aniq joylashuv»</b> ni yoqing.\n\nQayta yuborish yoki shu lokatsiya yetarli bo‘lsa, pastdagi tugmani bosing.', { reply_markup: { keyboard: [[{ text: '📍 Lokatsiyani qayta yuborish', request_location: true }], [{ text: LOC_OK }], [{ text: B.cancel }]], resize_keyboard: true } });
      }
      d.lat = m.location.latitude; d.lng = m.location.longitude; d.acc = acc; delete d.pend; d.addr = (t && t !== B.cancel ? t : 'Lokatsiya');
    }
    else if (t.length >= 3) { d.addr = t.slice(0, 200); }
    else return send(chat, 'Lokatsiya yuboring yoki manzilni yozing.');
    return afterAddr(chat, from, d);
  }
  if (st === 'p_phone') {
    if (t === PH_YES) {
      const u = (await db.q('select phone from ln_users where tg_id=$1', [chat])).rows[0];
      if (u && u.phone) return placeOrder(chat, nameOf(from), u.phone, d);
    }
    if (t === PH_OTHER) return send(chat, '✏️ <b>Yangi raqamni yozing</b>: <code>90 123 45 67</code>\nYoki pastdagi tugma bilan Telegram raqamingizni yuboring.', { reply_markup: phoneKb() });
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
    if (!node.active && !TUMAN_ONLY(mode)) return answer(q, '🕓 Bu hudud uchun xizmat tez kunda ishga tushadi.', true);
    await answer(q);
    const { st, d: sd } = await getSt(chat);
    if (mode === 'tm' || mode === 'pt') {
      sd.to_id = rid; sd.to_text = await pathName(rid); await setSt(chat, 'p_reg', sd);
      const sc = await regScreen(mode === 'tm' ? 'fm' : 'pf', 0);
      return edit(chat, mid, '✅ Qayerga: <b>' + esc(await rname(rid)) + '</b>\n\n' + sc.text, { reply_markup: sc.kb });
    }
    if (mode === 'fm' || mode === 'pf') {
      sd.rid = rid; await setSt(chat, 'p_addr', sd);
      await edit(chat, mid, '✅ Qayerdan: <b>' + esc(await rname(rid)) + '</b>\n🏁 Qayerga: <b>' + esc(await rname(sd.to_id)) + '</b>');
      return askAddr(chat, '');
    }
    if (mode === 'dm' || mode === 'dv') {
      sd.from_id = rid; await setSt(chat, st === 'd_reg' ? 'd_reg2' : 'd_chg2', sd);
      const sc = await regScreen(mode === 'dm' ? 'dt' : 'dw', 0);
      return edit(chat, mid, '✅ Qayerdan: <b>' + esc(await rname(rid)) + '</b>\n\n' + sc.text, { reply_markup: sc.kb });
    }
    if (mode === 'dt' || mode === 'dw') {
      if (!sd.from_id) return;
      await edit(chat, mid, '✅ Liniya: <b>' + (await routeOf(sd.from_id, rid)) + '</b>');
      if (st === 'd_reg2') return finishReg(chat, from, sd, sd.from_id, rid);
      const dr = await getDriver(chat);
      if (!dr) return home(chat, 'Avval «' + B.drv + '» orqali ro‘yxatdan o‘ting.');
      await db.q('update ln_drivers set region_id=$2, to_id=$3 where tg_id=$1', [chat, sd.from_id, rid]); await clrSt(chat);
      return send(chat, '📍 Liniyangiz: <b>' + (await routeOf(sd.from_id, rid)) + '</b>' + (isPaid(dr) ? '\nEndi «' + B.on + '» ni bosing.' : '\nLiniyaga chiqish uchun oylik to‘lov kerak.'), { reply_markup: await menuKb(chat) });
    }
    return;
  }
  if (k === 'on') { await answer(q); return goOnline(chat, true); }
  if (k === 'ch') { await answer(q); return startChange(chat); }
  if (k === 'la') return accept(q);
  if (k === 'ld') return finish(q, 'done');
  if (k === 'rt') return rate(q);
  if (k === 'lc') return finish(q, 'cancel');
  if (k === 'pc') return passengerCancel(q);
  if (k === 'pr') return remind(q);
  if (k === 'pa') return payDecide(q);
  if (k === 'tx') {
    if (!admin) return answer(q, 'Faqat admin', true);
    await answer(q); await loadTx(true);
    const x = TXD[Number(d[2])]; if (!x) return;
    if (d[1] === 'r') { await db.q('delete from settings where key=$1', ['tx:' + x[0]]); await loadTx(true); return send(chat, '↩️ Asl holiga qaytdi: <b>' + esc(x[2]) + '</b>'); }
    await setSt(chat, 'a_tx', { i: Number(d[2]) });
    return send(chat, '✏️ <b>' + esc(x[1]) + '</b>\nHozirgi: <b>' + esc(TXOV[x[0]] != null ? TXOV[x[0]] : x[2]) + '</b>\n\nYangi matnni yozing (emoji ham mumkin):', { reply_markup: { inline_keyboard: [[{ text: '↩️ Asl holiga qaytarish', callback_data: 'tx:r:' + d[2] }]] } });
  }
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
const CB = new Set(['tx', 'pk', 'kd', 'rg', 'rs', 'pw', 'la', 'ld', 'lc', 'pc', 'pr', 'rt', 'pa', 'am', 'ia', 'on', 'ch', 'bc', 'bk', 'dc']);
const menuChats = new Set();
async function chatMenu(chat) {
  if (!chat || menuChats.has(chat)) return;
  menuChats.add(chat);
  try { await tg('setChatMenuButton', { chat_id: chat, menu_button: { type: 'commands' } }); } catch (e) { menuChats.delete(chat); }
}
async function handleInner(up) {
  await loadTx();
  if (up.message && typeof up.message.text === 'string') {
    const t0 = up.message.text;
    for (const [k, , def] of TXD) if (k[0] === 'b' && k[1] === '.' && t0 === def && B[k.slice(2)] !== def) { up.message.text = B[k.slice(2)]; break; }
  }
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

// ---------- menyuni avto yangilash (odam /start bosmasa ham) ----------
const MENU_VER = '1';   // menyu tuzilishi o'zgarganda oshiring
let menuTbl = false;
async function refreshMenu(up) {
  const chat = up.message && up.message.chat && up.message.chat.type === 'private' ? up.message.chat.id
    : (up.callback_query && up.callback_query.message && up.callback_query.message.chat.type === 'private' ? up.callback_query.message.chat.id : 0);
  if (!chat) return;
  try {
    if (!menuTbl) { await db.q('create table if not exists ln_menu(tg_id bigint primary key, sig text not null, updated timestamptz not null default now())'); menuTbl = true; }
    const sig = crypto.createHash('md5').update(MENU_VER + JSON.stringify(B)).digest('hex');
    const row = (await db.q('select sig from ln_menu where tg_id=$1', [chat])).rows[0];
    if (row && row.sig === sig) return;
    const { st } = await getSt(chat);
    if (st) return;                       // oyna/jarayon ichida turgan odamga tegmaymiz
    if (menuFresh !== chat) await send(chat, '🔄 Menyu yangilandi.', { reply_markup: await menuKb(chat) });
    await db.q('insert into ln_menu(tg_id,sig) values($1,$2) on conflict (tg_id) do update set sig=excluded.sig, updated=now()', [chat, sig]);
  } catch (e) { /* menyu yangilanmasa ham asosiy ish buzilmasin */ }
}
async function handle(up) {
  menuFresh = 0;
  const r = await handleInner(up);
  await refreshMenu(up);
  return r;
}
module.exports = { handle };
