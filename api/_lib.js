'use strict';
const crypto = require('crypto');

// ====== SOZLAMALAR (narx va komissiya shu yerda o'zgartiriladi) ======
const CFG = {
  base: 5000,        // minimal boshlang'ich narx (so'm)
  perKm: 2000,       // 1 km uchun (so'm)
  min: 8000,         // eng kam narx (so'm)
  round: 500,        // narx 500 so'mgacha yaxlitlanadi
  feePct: 7,         // sizning komissiyangiz (%). Yandex Go ~14.6% (2023), biz taxminan 2 barobar arzon
  freeOrders: 3,     // yangi haydovchiga dastlabki bepul buyurtmalar soni
  minTopup: 20000,   // balansni eng kam to'ldirish (so'm)
  maxTopup: 5000000, // bir martalik eng ko'p to'ldirish (so'm)
  cancelMin: 10,     // haydovchi buyurtmani necha daqiqa ichida bekor qila oladi
  maxKm: 80,         // bundan uzoq buyurtma qabul qilinmaydi
  center: [41.3111, 69.2797], // xarita markazi (Toshkent)
  bounds: { latMin: 37.0, latMax: 46.0, lngMin: 55.0, lngMax: 74.0 } // O'zbekiston atrofi
};

const esc = t => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const token = () => String(process.env.BOT_TOKEN || '').replace(/\s+/g, '');
const secret = () => crypto.createHash('sha256').update(token()).digest('hex').slice(0, 32);

async function tg(method, body) {
  const t = token();
  if (!t) throw new Error('BOT_TOKEN sozlanmagan');
  const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch('https://api.telegram.org/bot' + t + '/' + method, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), signal: ac.signal
    });
    return await r.json();
  } finally { clearTimeout(tm); }
}

function distKm(a, b) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function priceOf(km) {
  const raw = CFG.base + Math.max(0, km - 1) * CFG.perKm;   // 1-km boshlang'ich narxga kiradi
  const p = Math.round(raw / CFG.round) * CFG.round;
  return Math.max(CFG.min, p);
}
const fmt = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

// Telegram Mini App initData tekshiruvi (foydalanuvchi shaxsi soxta bo'lmasligi uchun)
function checkInit(initData) {
  try {
    if (!initData || !token()) return null;
    const p = new URLSearchParams(initData), hash = p.get('hash');
    if (!hash) return null;
    p.delete('hash');
    const s = [...p.entries()].map(([k, v]) => k + '=' + v).sort().join('\n');
    const key = crypto.createHmac('sha256', 'WebAppData').update(token()).digest();
    const h = crypto.createHmac('sha256', key).update(s).digest('hex');
    const a = Buffer.from(h), b = Buffer.from(hash);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const ad = +p.get('auth_date'); if (!ad || Date.now() / 1000 - ad > 86400) return null;
    const u = JSON.parse(p.get('user') || 'null');
    return u && Number.isInteger(u.id) ? u : null;
  } catch (e) { return null; }
}

module.exports = { CFG, esc, tg, token, secret, distKm, priceOf, fmt, checkInit };
