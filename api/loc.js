'use strict';
const { CFG, checkInit, closeGroup } = require('./_lib');
const db = require('./_db');
const OK_ID = /^[A-Za-z0-9]{4,12}$/;
const num = v => (typeof v === 'number' && isFinite(v)) ? v : NaN;

// Haydovchi ekrani uchun: info (buyurtma ma'lumoti), pos (joylashuv yuborish), done (safarni tugatish)
module.exports = async (req, res) => {
  res.setHeader('cache-control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const u = checkInit(b.initData);
    if (!u) return res.status(401).json({ error: 'Telegram orqali oching' });
    const id = String(b.id || '');
    if (!OK_ID.test(id)) return res.status(400).json({ error: 'noto‘g‘ri so‘rov' });

    if (b.action === 'info') {
      const r = await db.q("select status, fromp, top, km, price, phone, name from orders where id=$1 and driver_id=$2", [id, u.id]);
      const o = r.rows[0];
      if (!o) return res.status(404).json({ error: 'Bu buyurtma sizniki emas' });
      return res.status(200).json({ ok: true, status: o.status, from: o.fromp, to: o.top, km: o.km, price: o.price, phone: o.phone, name: o.name });
    }
    if (b.action === 'pos') {
      const lat = num(b.lat), lng = num(b.lng), B = CFG.bounds;
      if (!(lat >= B.latMin && lat <= B.latMax && lng >= B.lngMin && lng <= B.lngMax)) return res.status(400).json({ error: 'joylashuv noto‘g‘ri' });
      const r = await db.q("update orders set dlat=$1, dlng=$2, dts=now() where id=$3 and driver_id=$4 and status='taken' and (dts is null or dts < now() - interval '2 seconds') returning id", [lat, lng, id, u.id]);
      const st = r.rowCount ? 'ok' : (await db.q("select status from orders where id=$1 and driver_id=$2", [id, u.id])).rows[0];
      if (st === 'ok') return res.status(200).json({ ok: true });
      if (!st) return res.status(404).json({ error: 'Bu buyurtma sizniki emas' });
      return res.status(200).json({ ok: true, status: st.status, skipped: st.status === 'taken' });
    }
    if (b.action === 'done') {
      const r = await db.fn('done_order', id, u.id);
      if (r.err) return res.status(409).json({ error: 'Bu buyurtma sizniki emas yoki allaqachon tugagan' });
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'noto‘g‘ri so‘rov' });
  } catch (e) { return res.status(500).json({ error: 'Server xatosi' }); }
};
