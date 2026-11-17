'use strict';
const { checkInit } = require('./_lib');
const db = require('./_db');
const cleanName = v => { const n = String(v || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40); return n.split(' ').filter(w => w.length > 1).length >= 2 ? n : ''; };
const phoneOf = v => { let d = String(v || '').replace(/\D/g, ''); if (d.length === 9) d = '998' + d; return /^998\d{9}$/.test(d) ? d : ''; };

// Yo'lovchi profili (bir marta ism-familiya va telefon)
module.exports = async (req, res) => {
  res.setHeader('cache-control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const u = checkInit(b.initData);
    if (!u) return res.status(401).json({ error: 'Telegram orqali oching' });
    if (b.action === 'save') {
      const name = cleanName(b.name);
      if (!name) return res.status(400).json({ error: 'Ism va familiyangizni to‘liq yozing (kamida 2 ta so‘z)' });
      const phone = phoneOf(b.phone);
      if (!phone) return res.status(400).json({ error: 'Telefon raqami noto‘g‘ri (masalan 90 123 45 67)' });
      await db.q('insert into passengers(tg_id,name,phone) values($1,$2,$3) on conflict (tg_id) do update set name=$2, phone=$3', [u.id, name, phone]);
      return res.status(200).json({ ok: true, name, phone });
    }
    const p = (await db.q('select name, phone from passengers where tg_id=$1', [u.id])).rows[0];
    return res.status(200).json({ ok: true, profile: p || null });
  } catch (e) {
    console.error('profile', e);
    return res.status(500).json({ error: 'Server xatosi' });
  }
};
