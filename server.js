require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const E = process.env;
const DATA = E.DATA_DIR || __dirname; // set DATA_DIR to a persistent disk path when hosting
const app = express();
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const UP = path.join(DATA, 'uploads');
fs.mkdirSync(UP, { recursive: true });
app.use('/uploads', express.static(UP));

fs.mkdirSync(DATA, { recursive: true });
const DB = path.join(DATA, 'data.json');
const load = () => { try { return JSON.parse(fs.readFileSync(DB, 'utf8')); } catch { return { products: [], orders: [] }; } };
const save = d => fs.writeFileSync(DB, JSON.stringify(d, null, 2));
const token = () => crypto.createHmac('sha256', E.SECRET || 'secret').update(E.ADMIN_PASSWORD || '').digest('hex');
const admin = (req, res, next) => req.headers['x-admin'] === token() ? next() : res.status(401).json({ error: 'Admin login required' });
const COUPON = (E.COUPON_CODE || 'DAISY10').toUpperCase();
const PERCENT = Number(E.COUPON_PERCENT) || 10;
// Advance for cash-on-delivery orders (needs UPI_ID). Set COD_ADVANCE= (empty) or 0 to turn off.
const ADV = E.UPI_ID ? (E.COD_ADVANCE === undefined ? 50 : Number(E.COD_ADVANCE) || 0) : 0;

let mailer = null;
if (E.SMTP_USER && E.SMTP_PASS) {
  try {
    mailer = require('nodemailer').createTransport({
      host: E.SMTP_HOST, port: Number(E.SMTP_PORT) || 587,
      auth: { user: E.SMTP_USER, pass: E.SMTP_PASS }
    });
  } catch (e) { console.log('Email disabled:', e.message); }
}

app.get('/api/config', (req, res) => res.json({
  store: E.STORE_NAME || 'Daisy Threads', whatsapp: E.WHATSAPP || '', upi: E.UPI_ID || '', instagram: (load().settings || {}).instagram || E.INSTAGRAM || '', coupon: COUPON, percent: PERCENT, codAdvance: ADV
}));

app.get('/api/qr', async (req, res) => {
  const data = String(req.query.data || '').slice(0, 600);
  if (!data) return res.status(400).end();
  res.type('image/svg+xml').send(await require('qrcode').toString(data, { type: 'svg', margin: 1, width: 240 }));
});

app.get('/api/products', (req, res) => res.json(load().products));

app.post('/api/orders', (req, res) => {
  const { items, name, phone, address, method, coupon } = req.body || {};
  if (!name || !phone || !address || !Array.isArray(items) || !items.length)
    return res.status(400).json({ error: 'Fill in name, phone, address and add items' });
  const db = load();
  let total = 0;
  const lines = [];
  for (const it of items) {
    const p = db.products.find(x => x.id === it.id);
    const qty = Math.max(1, parseInt(it.qty) || 1);
    if (!p) return res.status(400).json({ error: 'A product in your cart no longer exists' });
    total += p.price * qty;
    lines.push({ id: p.id, name: p.name, price: p.price, qty });
  }
  const couponOk = !!coupon && String(coupon).trim().toUpperCase() === COUPON;
  if (couponOk) total = Math.round(total * (100 - PERCENT)) / 100;
  const isUpi = method === 'upi';
  const advance = isUpi ? total : Math.min(ADV, total);
  const balance = Math.round((total - advance) * 100) / 100;
  const order = {
    id: 'SS' + Date.now().toString(36).toUpperCase(),
    date: new Date().toISOString(), name, phone, address,
    method: method === 'upi' ? 'upi' : 'cod', coupon: couponOk ? COUPON : '', items: lines, total, advance, balance, status: 'New'
  };
  db.orders.unshift(order);
  save(db);
  if (mailer && E.OWNER_EMAIL) {
    mailer.sendMail({
      from: E.MAIL_FROM || E.SMTP_USER, to: E.OWNER_EMAIL,
      subject: `New order ${order.id} - Rs ${total}`,
      text: `${name} (${phone})\n${address}\n\n` + lines.map(l => `${l.name} x${l.qty}`).join('\n') + `\n\nTotal: Rs ${total} (${order.method}). Advance expected: Rs ${advance}, balance: Rs ${balance}`
    }).catch(e => console.log('Mail failed:', e.message));
  }
  res.json({ id: order.id, total, advance, balance, method: order.method });
});

app.post('/api/admin/login', (req, res) => {
  if (E.ADMIN_PASSWORD && req.body.password === E.ADMIN_PASSWORD) return res.json({ token: token() });
  res.status(401).json({ error: 'Wrong password' });
});

app.post('/api/admin/products', admin, (req, res) => {
  const { name, price, image, category } = req.body || {};
  if (!name || !(Number(price) > 0)) return res.status(400).json({ error: 'Name and a price above 0 are required' });
  const db = load();
  db.products.push({ id: crypto.randomUUID(), name, price: Number(price), image: image || '', category: category === 'earrings' ? 'earrings' : 'clothes' });
  save(db);
  res.json({ ok: true });
});

app.delete('/api/admin/products/:id', admin, (req, res) => {
  const db = load();
  const old = db.products.find(p => p.id === req.params.id);
  if (old && /^\/uploads\/[\w.-]+$/.test(old.image || '')) fs.unlink(path.join(DATA, old.image), () => {});
  db.products = db.products.filter(p => p.id !== req.params.id);
  save(db);
  res.json({ ok: true });
});

app.post('/api/admin/upload', admin, (req, res) => {
  const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(String(req.body.data || ''));
  if (!m) return res.status(400).json({ error: 'Please choose a JPG, PNG or WEBP photo' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'Photo is too large (max 5 MB)' });
  const name = crypto.randomUUID() + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
  fs.writeFileSync(path.join(UP, name), buf);
  res.json({ url: '/uploads/' + name });
});

app.post('/api/admin/settings', admin, (req, res) => {
  const handle = String(req.body.instagram || '').trim().replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/^@/, '').split(/[\/?#]/)[0];
  if (!/^[A-Za-z0-9._]{1,30}$/.test(handle)) return res.status(400).json({ error: 'Enter a valid Instagram username or link' });
  const db = load();
  db.settings = { ...(db.settings || {}), instagram: handle };
  save(db);
  res.json({ ok: true, instagram: handle });
});

app.get('/api/admin/orders', admin, (req, res) => res.json(load().orders));

app.patch('/api/admin/orders/:id', admin, (req, res) => {
  const db = load();
  const o = db.orders.find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  o.status = req.body.status;
  save(db);
  res.json({ ok: true });
});

const port = E.PORT || 3000;
app.listen(port, () => console.log(`Running: http://localhost:${port}  |  Admin: http://localhost:${port}/admin.html`));
