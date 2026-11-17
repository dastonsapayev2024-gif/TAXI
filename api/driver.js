'use strict';
const { CFG, esc, tg, checkInit, closeGroup } = require('./_lib');
const db = require('./_db');
const OK_ID = /^[A-Za-z0-9]{4,12}$/;
const cleanName = v => { const n = String(v || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40); return n.split(' ').filter(w => w.length > 1).length >= 2 ? n : ''; };
const phoneOf = v => { let d = String(v || '').replace(/\D/g, ''); if (d.length === 9) d = '998' + d; return /^998\d{9}$/.test(d) ? d : ''; };
const nameOf = u => [u.first_name, u.last_name].filter(Boolean).join(' ').slice(0, 40) || 'Haydovchi';

// Haydovchi ilovasi uchun yagona nuqta (Telegram initData bilan tekshiriladi)
module.exports = async (req, res) => {
  res.setHeader('cache-control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const u = checkInit(b.initData);
    if (!u) return res.status(401).json({ error: 'Telegram orqali oching' });
    const me = u.id;
    const drv = async () => (await db.q('select * from drivers where tg_id=$1', [me])).rows[0] || null;
    const cfg = { feePct: CFG.feePct, freeOrders: CFG.freeOrders, cancelMin: CFG.cancelMin, expireMin: CFG.expireMin, minTopup: CFG.minTopup, test: !String(process.env.CARD_INFO || '').trim() };

    if (b.action === 'me') {
      const d = await drv();
      if (!d || !d.car || !d.phone) return res.status(200).json({ ok: true, registered: false, name: (d && d.phone ? d.name : '') || nameOf(u), phone: d ? d.phone : '', car: d ? d.car : '', cfg });
      const a = (await db.q("select id, price, fee_paid, km, phone, name, fromp, top, floor(extract(epoch from (now() - taken_at)))::int tage from orders where driver_id=$1 and status='taken' order by taken_at desc limit 1", [me])).rows[0] || null;
      return res.status(200).json({ ok: true, registered: true, blocked: d.blocked, name: d.name, car: d.car, balance: d.balance, free: d.free_left, cfg,
        active: a ? { id: a.id, price: a.price, fee: a.fee_paid, km: a.km, phone: a.phone, pname: a.name, from: a.fromp, to: a.top, canCancel: a.tage < CFG.cancelMin * 60 } : null });
    }
    if (b.action === 'register') {
      const car = String(b.car || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (car.length < 5) return res.status(400).json({ error: 'Mashina ma‘lumoti juda qisqa. Masalan: Cobalt, oq, 01 A 123 BC' });
      const fname = cleanName(b.name);
      if (!fname) return res.status(400).json({ error: 'Ism va familiyangizni to‘liq yozing (kamida 2 ta so‘z)' });
      const phone = phoneOf(b.phone);
      if (!phone) return res.status(400).json({ error: 'Telefon raqami noto‘g‘ri (masalan 90 123 45 67)' });
      await db.q('insert into drivers(tg_id,name,username,free_left,car,phone) values($1,$2,$3,$4,$5,$6) on conflict (tg_id) do update set name=$2, username=$3, car=$5, phone=$6',
        [me, fname, u.username || '', CFG.freeOrders, car, phone]);
      return res.status(200).json({ ok: true });
    }
    const d = await drv();
    if (!d) return res.status(403).json({ error: 'Avval ro‘yxatdan o‘ting' });
    if (!d.phone || !d.car) return res.status(403).json({ error: 'Avval ro‘yxatdan o‘ting' });
    if (d.blocked) return res.status(403).json({ error: 'Hisobingiz bloklangan. Admin bilan bog‘laning.' });

    if (b.action === 'orders') {
      const r = await db.q("select id, price, fee, km, fromp, top, name, floor(extract(epoch from (now() - created)))::int age from orders where status='new' and created > now() - make_interval(mins => $1) order by created desc limit 30", [CFG.expireMin]);
      const free = d.free_left > 0;
      return res.status(200).json({ ok: true, orders: r.rows.map(o => ({ id: o.id, price: o.price, fee: free ? 0 : o.fee, km: o.km, from: o.fromp, to: o.top, pname: o.name, age: o.age })), balance: d.balance, free: d.free_left });
    }
    if (b.action === 'car') {
      const car = String(b.car || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (car.length < 5) return res.status(400).json({ error: 'Mashina ma‘lumoti juda qisqa' });
      await db.q('update drivers set car=$1 where tg_id=$2', [car, me]);
      return res.status(200).json({ ok: true });
    }
    const id = String(b.id || '');
    if (!OK_ID.test(id)) return res.status(400).json({ error: 'noto‘g‘ri so‘rov' });

    if (b.action === 'accept') {
      const busy = (await db.q("select id from orders where driver_id=$1 and status='taken' limit 1", [me])).rows[0];
      if (busy) return res.status(409).json({ error: 'Avval joriy buyurtmani (#' + busy.id + ') tugating', code: 'busy' });
      const r = await db.fn('accept_order', id, me, CFG.expireMin);
      if (r.err === 'expired') { await closeGroup(r.msg, '⌛ Muddati o‘tdi'); return res.status(409).json({ error: 'Buyurtma muddati o‘tdi', code: 'expired' }); }
      if (r.err === 'gone') return res.status(409).json({ error: 'Bu buyurtma bekor qilingan', code: 'gone' });
      if (r.err === 'taken' || r.err === 'noorder') return res.status(409).json({ error: 'Bu buyurtmani boshqa haydovchi oldi', code: 'taken' });
      if (r.err === 'nocar') return res.status(409).json({ error: 'Avval mashina ma‘lumotini kiriting', code: 'nocar' });
      if (r.err === 'balance') return res.status(402).json({ error: 'Balans yetarli emas. Kerak: ' + r.need + ' so‘m, sizda: ' + r.bal + ' so‘m', code: 'balance' });
      if (r.err) return res.status(403).json({ error: 'Qabul qilib bo‘lmadi' });
      const o = (await db.q('select tg_msg from orders where id=$1', [id])).rows[0];
      if (o && o.tg_msg) await closeGroup(o.tg_msg, '🚕 Qabul qilindi: ' + nameOf(u).slice(0, 30));
      if (+r.uid > 0) {
        const dr = (await db.q('select phone from drivers where tg_id=$1', [me])).rows[0] || {};
        const po = (await db.q('select price from orders where id=$1', [id])).rows[0] || {};
        const ph = /^998\d{9}$/.test(dr.phone || '') ? '+' + dr.phone.replace(/^(\d{3})(\d{2})(\d{3})(\d{2})(\d{2})$/, '$1 $2 $3 $4 $5') : '';
        const money = String(po.price || '').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
        tg('sendMessage', { chat_id: +r.uid, parse_mode: 'HTML', text: '✅ <b>Buyurtmangiz tasdiqlandi!</b> #' + esc(id) + '\n\n👤 Haydovchi: <b>' + esc(nameOf(u)) + '</b>\n🚗 ' + esc(r.car || '') + (ph ? '\n📞 ' + ph : '') + (money ? '\n\n💰 Narx: <b>' + money + ' so‘m</b>\nSafar oxirida haydovchiga naqd to‘laysiz.' : '') + '\n\nHaydovchi tez orada siz bilan bog‘lanadi. Xaritani ilovada ko‘rishingiz mumkin.' }).catch(() => {});
      }
      return res.status(200).json({ ok: true, phone: r.phone, fee: r.fee, free: r.free, balance: r.bal, left: r.left });
    }
    if (b.action === 'cancel') {
      const r = await db.fn('cancel_order', id, me, CFG.cancelMin);
      if (r.err === 'late') return res.status(409).json({ error: CFG.cancelMin + ' daqiqadan o‘tdi. Bekor qilish uchun admin bilan bog‘laning.' });
      if (r.err) return res.status(404).json({ error: 'Bu buyurtma sizniki emas' });
      return res.status(200).json({ ok: true, refund: r.refund });
    }
    if (b.action === 'done') {
      const r = await db.fn('done_order', id, me);
      if (r.err) return res.status(409).json({ error: 'Bu buyurtma sizniki emas yoki allaqachon tugagan' });
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'noto‘g‘ri so‘rov' });
  } catch (e) { if (process.env.TEST_DBG) console.log('DRVERR', e.message); return res.status(500).json({ error: 'Server xatosi' }); }
};
