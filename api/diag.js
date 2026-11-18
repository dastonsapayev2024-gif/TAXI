// Tekshiruv: /api/diag?k=SETUP_KEY  (tokenni ko'rsatmaydi)
const dns = require('dns').promises;
async function timed(name, fn) {
  const t = Date.now();
  try { const r = await fn(); return name + ': ' + (Date.now() - t) + ' ms → ' + r; }
  catch (e) { return name + ': ' + (Date.now() - t) + ' ms → XATO ' + (e.name || '') + ' ' + (e.message || '') + (e.cause && e.cause.code ? ' [' + e.cause.code + ']' : ''); }
}
async function call(url, ms) {
  const c = new AbortController(); const to = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { signal: c.signal }); const b = await r.text(); return 'HTTP ' + r.status + ' ' + b.slice(0, 160); }
  finally { clearTimeout(to); }
}
module.exports = async (req, res) => {
  const key = String((req.query && req.query.k) || ''), want = String(process.env.SETUP_KEY || '');
  if (!want || key !== want) { res.status(403).send('kalit xato'); return; }
  const tok = String(process.env.BOT_TOKEN || '').replace(/\s+/g, '');
  const T = 12000, out = [];
  out.push('Token: ' + (tok ? 'bor, uzunligi ' + tok.length + ', bot id ' + tok.split(':')[0] : 'YOQ'));
  out.push('Region: ' + (process.env.VERCEL_REGION || '?'));
  out.push(await timed('DNS', async () => (await dns.lookup('api.telegram.org')).address));
  out.push(await timed('Soxta token', () => call('https://api.telegram.org/bot123456:fake/getMe', T)));
  if (tok) {
    out.push(await timed('getMe', () => call('https://api.telegram.org/bot' + tok + '/getMe', T)));
    out.push(await timed('getWebhookInfo', () => call('https://api.telegram.org/bot' + tok + '/getWebhookInfo', T)));
  }
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.status(200).send(out.join('\n'));
};
