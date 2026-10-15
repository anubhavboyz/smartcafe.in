// Vercel serverless function: saves orders (public POST) and lets the owner read/update them (password).
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmd) {
  const r = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

const s = (v, n) => String(v == null ? '' : v).slice(0, n);

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!URL_ || !TOKEN) return res.status(500).json({ error: 'storage not configured' });

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};

    // ---- Customer places an order (public) ----
    if (req.method === 'POST') {
      const modes = ['delivery', 'takeaway', 'dinein'];
      const mode = modes.includes(body.mode) ? body.mode : 'delivery';
      const items = (Array.isArray(body.items) ? body.items : []).slice(0, 60).map(i => ({
        n: s(i.n, 80),
        p: Math.max(0, Math.round(Number(i.p) || 0)),
        q: Math.max(1, Math.min(99, Math.round(Number(i.q) || 1)))
      }));
      if (!items.length) return res.status(400).json({ error: 'empty order' });
      const sub = items.reduce((t, i) => t + i.p * i.q, 0);
      const del = mode === 'delivery' ? 30 : 0;
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const order = {
        id, ts: Date.now(), status: 'new', mode,
        name: s(body.name, 60), addr: s(body.addr, 300), time: s(body.time, 40), people: s(body.people, 10),
        items, sub, del, tot: sub + del
      };
      await redis(['HSET', 'orders', id, JSON.stringify(order)]);
      return res.status(200).json({ ok: true, id });
    }

    // ---- Everything below is owner-only ----
    const ok = process.env.ADMIN_PASSWORD && req.headers['x-admin-password'] === process.env.ADMIN_PASSWORD;
    if (!ok) return res.status(401).json({ error: 'wrong password' });

    if (req.method === 'GET') {
      const arr = (await redis(['HGETALL', 'orders'])) || [];
      const orders = [];
      for (let i = 1; i < arr.length; i += 2) { try { orders.push(JSON.parse(arr[i])); } catch (e) {} }
      orders.sort((a, b) => b.ts - a.ts);
      return res.status(200).json({ orders: orders.slice(0, 200) });
    }

    if (req.method === 'PATCH') {
      const raw = await redis(['HGET', 'orders', s(body.id, 40)]);
      if (!raw) return res.status(404).json({ error: 'not found' });
      const o = JSON.parse(raw);
      if (['new', 'preparing', 'done'].includes(body.status)) o.status = body.status;
      await redis(['HSET', 'orders', o.id, JSON.stringify(o)]);
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      await redis(['HDEL', 'orders', s(body.id, 40)]);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: 'server error' });
  }
};
