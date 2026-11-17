'use strict';
const { esc, tg, fmt, checkInit } = require('./_lib');
const db = require('./_db');
const isAdmin = id => !!process.env.ADMIN_ID && String(id) === String(process.env.ADMIN_ID).trim();
const ID = /^\d{4,15}$/;

// Admin paneli uchun yagona nuqta. Faqat ADMIN_ID egasi (Telegram initData orqali tekshiriladi).
module.exports = async (req, res) => {
  res.setHeader('cache-control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const u = checkInit(b.initData);
    if (!u || !isAdmin(u.id)) return res.status(403).json({ error: 'Ruxsat yo‘q' });
    await db.ensure().catch(() => {});

    if (b.action === 'stats') {
      const a = (await db.q(`select
        count(*) filter (where created >= date_trunc('day', now()))::int today,
        count(*) filter (where status='new')::int open,
        count(*) filter (where status='taken')::int taken,
        count(*) filter (where status='done')::int done,
        count(*) filter (where status='cancelled')::int cancelled,
        count(*) filter (where status='expired')::int expired,
        count(*)::int total,
        coalesce(sum(price) filter (where status in ('taken','done')),0)::bigint turnover,
        coalesce(sum(fee_paid) filter (where status in ('taken','done') and taken_at >= date_trunc('day', now())),0)::bigint fee_today,
        coalesce(sum(fee_paid) filter (where status in ('taken','done') and taken_at >= date_trunc('month', now())),0)::bigint fee_month,
        coalesce(sum(fee_paid) filter (where status in ('taken','done')),0)::bigint fee_all
        from orders`)).rows[0];
      const d = (await db.q("select count(*)::int n, count(*) filter (where blocked)::int blocked, coalesce(sum(balance),0)::bigint bal from drivers")).rows[0];
      const t = (await db.q("select count(*)::int n, coalesce(sum(amount),0)::bigint s from topups where status='pending'")).rows[0];
      return res.status(200).json({ ok: true, orders: a, drivers: d, pendingTopups: t });
    }
    if (b.action === 'live') {
      const r = await db.q(`select o.id, o.status, o.price, o.fromp, o.top, o.name, o.phone, o.created, o.driver_id,
        o.dlat, o.dlng, floor(extract(epoch from (now() - o.dts)))::int dage, d.name dn, d.car dc
        from orders o left join drivers d on d.tg_id = o.driver_id
        where o.status in ('new','taken') order by o.created desc limit 60`);
      return res.status(200).json({ ok: true, orders: r.rows });
    }
    if (b.action === 'drivers') {
      const r = await db.q("select tg_id, name, username, car, balance, free_left, blocked, created from drivers order by created desc limit 200");
      return res.status(200).json({ ok: true, drivers: r.rows });
    }
    if (b.action === 'orders') {
      const r = await db.q(`select o.id, o.status, o.price, o.fee_paid, o.km, o.created, o.fromp, o.top, d.name dn
        from orders o left join drivers d on d.tg_id = o.driver_id order by o.created desc limit 40`);
      return res.status(200).json({ ok: true, orders: r.rows });
    }
    if (b.action === 'add') {
      const id = String(b.driver || ''), amt = Math.trunc(Number(b.amount));
      if (!ID.test(id) || !Number.isFinite(amt) || amt === 0 || Math.abs(amt) > 5000000) return res.status(400).json({ error: 'Noto‘g‘ri summa yoki ID' });
      const r = await db.fn('admin_add', id, amt);
      if (r.err) return res.status(404).json({ error: 'Haydovchi topilmadi' });
      tg('sendMessage', { chat_id: Number(id), parse_mode: 'HTML', text: '💰 Balansingiz ' + (amt >= 0 ? 'to‘ldirildi: +' : 'o‘zgartirildi: ') + fmt(amt) + ' so‘m. Yangi balans: <b>' + fmt(r.bal) + ' so‘m</b>' }).catch(() => {});
      return res.status(200).json({ ok: true, balance: r.bal });
    }
    if (b.action === 'block' || b.action === 'unblock') {
      const id = String(b.driver || '');
      if (!ID.test(id)) return res.status(400).json({ error: 'Noto‘g‘ri ID' });
      await db.q('update drivers set blocked=$1 where tg_id=$2', [b.action === 'block', id]);
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'noto‘g‘ri so‘rov' });
  } catch (e) { if (process.env.TEST_DBG) console.log('ADMERR', e.message); return res.status(500).json({ error: 'Server xatosi' }); }
};
