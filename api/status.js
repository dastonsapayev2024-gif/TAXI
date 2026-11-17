'use strict';
const crypto = require('crypto');
const { CFG, esc, tg, closeGroup } = require('./_lib');
const db = require('./_db');

const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const OK_ID = /^[A-Za-z0-9]{4,12}$/, OK_T = /^[A-Za-z0-9_-]{8,40}$/;

module.exports = async (req, res) => {
  res.setHeader('cache-control', 'no-store');
  try {
    if (req.method === 'GET') {
      const q = req.query || {}, id = String(q.id || ''), t = String(q.t || '');
      if (!OK_ID.test(id) || !OK_T.test(t)) return res.status(404).json({ error: 'yo‘q' });
      const r = await db.q('select o.status, o.token, o.price, o.created, o.dlat, o.dlng, floor(extract(epoch from (now() - o.dts)))::int as dage, floor(extract(epoch from (o.created + make_interval(mins => $2) - now())))::int as lf, d.name dn, d.username du, d.car dc from orders o left join drivers d on d.tg_id = o.driver_id where o.id = $1', [id, CFG.expireMin]);
      const o = r.rows[0];
      if (!o || !same(o.token, t)) return res.status(404).json({ error: 'yo‘q' });
      let status = o.status;
      if (status === 'new' && o.lf <= 0) {
        const e = await db.fn('expire_if_old', id, CFG.expireMin);
        if (e.changed) { await closeGroup(e.msg, '⌛ Muddati o‘tdi'); status = 'expired'; }
      }
      const out = { status, left: Math.max(0, o.lf), price: o.price };
      if (status === 'taken' || status === 'done') out.driver = { name: o.dn || 'Haydovchi', username: o.du || '', car: o.dc || '' };
      if (status === 'taken' && o.dlat != null && o.dage != null && o.dage < 120) out.pos = { lat: +o.dlat, lng: +o.dlng, age: o.dage };
      return res.status(200).json(out);
    }
    if (req.method === 'POST') {
      const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const id = String(b.id || ''), t = String(b.t || '');
      if (b.action !== 'cancel' || !OK_ID.test(id) || !OK_T.test(t)) return res.status(400).json({ error: 'noto‘g‘ri so‘rov' });
      const r = await db.fn('cancel_by_passenger', id, t);
      if (r.err === 'noorder') return res.status(404).json({ error: 'yo‘q' });
      if (r.err === 'done') return res.status(409).json({ error: 'Safar allaqachon yakunlangan' });
      if (r.err) return res.status(200).json({ ok: true, already: true });
      await closeGroup(r.msg, '❌ Yo‘lovchi bekor qildi');
      if (r.was === 'taken' && r.driver) {
        await tg('sendMessage', { chat_id: Number(r.driver), parse_mode: 'HTML', text: '❌ Yo‘lovchi #' + esc(id) + ' buyurtmani bekor qildi.' + (+r.refund ? ' Komissiya (' + r.refund + ' so‘m) balansingizga qaytarildi.' : '') }).catch(() => {});
      }
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) { return res.status(500).json({ error: 'Server xatosi' }); }
};
