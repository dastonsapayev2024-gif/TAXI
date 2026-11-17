'use strict';
const { CFG, esc, tg, distKm, priceOf, fmt, checkInit, baseUrl, driverLink } = require('./_lib');
const db = require('./_db');
const crypto = require('crypto');

const last = new Map(); // oddiy spamdan himoya (bir telefon: 60 soniyada 1 buyurtma)
const num = v => typeof v === 'number' && isFinite(v);
function point(p) {
  if (!p || !num(p.lat) || !num(p.lng)) return null;
  const B = CFG.bounds;
  if (p.lat < B.latMin || p.lat > B.latMax || p.lng < B.lngMin || p.lng > B.lngMax) return null;
  return { lat: +p.lat.toFixed(6), lng: +p.lng.toFixed(6), addr: String(p.addr || '').replace(/\s+/g, ' ').trim().slice(0, 120) };
}
function phoneOf(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length === 9) d = '998' + d;
  return /^998\d{9}$/.test(d) ? d : '';
}

module.exports = async (req, res) => {
  res.setHeader('cache-control', 'no-store');
  if (req.method === 'GET') {
    return res.status(200).json({ base: CFG.base, perKm: CFG.perKm, min: CFG.min, round: CFG.round, center: CFG.center, bounds: CFG.bounds, maxKm: CFG.maxKm });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    if (b.hp) return res.status(200).json({ ok: true, id: 'X' }); // bot tuzog'i
    const from = point(b.from), to = point(b.to);
    if (!from || !to) return res.status(400).json({ error: 'Manzil noto‘g‘ri yoki O‘zbekiston tashqarisida' });
    const phone = phoneOf(b.phone);
    if (!phone) return res.status(400).json({ error: 'Telefon raqami noto‘g‘ri (masalan 90 123 45 67)' });
    const name = String(b.name || '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Yo‘lovchi';
    const note = String(b.note || '').replace(/\s+/g, ' ').trim().slice(0, 120);

    // Masofa va narxni SERVER hisoblaydi (mijozga ishonilmaydi)
    const air = distKm(from, to);
    let km = +b.km;
    const ref = air * 1.3;
    if (!num(km) || km < air * 0.95 || km > air * 2.5 + 1) km = ref;
    km = Math.max(0.5, +km.toFixed(1));
    if (km > CFG.maxKm) return res.status(400).json({ error: 'Masofa juda uzoq (' + CFG.maxKm + ' km gacha)' });
    const min = Math.max(1, Math.round(+b.min || km * 2.5)); // taxminiy vaqt (daqiqa)
    const price = priceOf(km), fee = Math.round(price * CFG.feePct / 100 / 100) * 100;

    const now = Date.now();
    if (last.has(phone) && now - last.get(phone) < 60000) return res.status(429).json({ error: 'Iltimos, 1 daqiqadan keyin qayta urinib ko‘ring' });
    last.set(phone, now); if (last.size > 500) last.clear();

    const group = String(process.env.GROUP_ID || '').trim();

    const u = checkInit(b.initData);
    const uid = u ? u.id : 0;
    const id = (now.toString(36) + Math.random().toString(36).slice(2, 4)).toUpperCase().slice(-8);
    const text =
      '🚕 <b>Yangi buyurtma</b> #' + id + '\n\n' +
      '📍 <b>Qayerdan:</b> ' + esc(from.addr || (from.lat + ', ' + from.lng)) + '\n' +
      '🏁 <b>Qayerga:</b> ' + esc(to.addr || (to.lat + ', ' + to.lng)) + '\n' +
      '📏 ~' + km + ' km · ⏱ ~' + min + ' daq\n\n' +
      '💰 <b>Narx: ' + fmt(price) + ' so‘m</b>\n' +
      '💼 Komissiya (' + CFG.feePct + '%): ' + fmt(fee) + ' so‘m · Sizga: ' + fmt(price - fee) + ' so‘m' +
      (note ? '\n🗒 ' + esc(note) : '') + '\n\n' +
      '👆 Qabul qilish uchun ilovani oching: «🚕 Haydovchi ilovasi»';
    const tokn = crypto.randomBytes(9).toString('base64url');
    await db.q('insert into orders(id,uid,phone,name,fromp,top,km,price,fee,token) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [id, uid, phone.slice(3), name, JSON.stringify(from), JSON.stringify(to), km, price, fee, tokn]);
    // 1) haydovchilar guruhiga (ixtiyoriy): faqat xabar, qabul qilish ilovada
    if (group) {
      const dl = await driverLink();
      const r = await tg('sendMessage', {
        chat_id: group, text, parse_mode: 'HTML', disable_web_page_preview: true,
        reply_markup: dl ? { inline_keyboard: [[{ text: '🚕 Haydovchi ilovasi', url: dl }]] } : undefined
      }).catch(() => null);
      if (r && r.ok && r.result && r.result.message_id) await db.q('update orders set tg_msg=$1 where id=$2', [r.result.message_id, id]).catch(() => {});
    }
    // 2) ro'yxatdan o'tgan haydovchilarga shaxsiy xabar (ilovani ochish tugmasi bilan)
    try {
      const base = baseUrl(req);
      const ds = (await db.q("select tg_id from drivers where blocked=false and car<>'' order by created desc limit 80")).rows;
      if (base && ds.length) {
        const dm = '🚕 <b>Yangi buyurtma</b> #' + id + '\n📍 ' + esc(from.addr || '—') + '\n🏁 ' + esc(to.addr || '—') + '\n📏 ~' + km + ' km · 💰 ' + fmt(price) + ' so‘m (sizga ' + fmt(price - fee) + ')';
        await Promise.allSettled(ds.map(d => tg('sendMessage', { chat_id: Number(d.tg_id), text: dm, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🚕 Ochish va qabul qilish', web_app: { url: base + '/drv.html' } }]] } })));
      }
    } catch (e) { /* buyurtma baribir ilovada ko'rinadi */ }
    return res.status(200).json({ ok: true, id, token: tokn, price, km, expire: CFG.expireMin * 60 });
  } catch (e) {
    return res.status(500).json({ error: 'Server xatosi' });
  }
};
