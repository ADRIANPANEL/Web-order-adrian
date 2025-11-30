// server.js (CommonJS)
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const axios = require('axios');
const FormData = require('form-data');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

// simple storage file
const ORDERS_FILE = path.join(__dirname, 'orders.json');
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, '[]', 'utf8');

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

app.use(express.json());
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'change_this_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 } // 8 jam
}));

// helper: read/write orders
function readOrders(){ try { return JSON.parse(fs.readFileSync(ORDERS_FILE,'utf8')) } catch(e){ return [] } }
function writeOrders(arr){ fs.writeFileSync(ORDERS_FILE, JSON.stringify(arr, null, 2), 'utf8') }

// PUBLIC: menerima order
app.post('/api/order', upload.single('proof'), (req, res) => {
  try {
    const { name, product, note, payment } = req.body;
    if(!name || !product || !payment) return res.status(400).send('Field kurang lengkap');

    const file = req.file;
    const id = uuidv4();
    // rename file ke id (lebih mudah)
    let filename = null;
    if(file){
      const ext = path.extname(file.originalname) || '.jpg';
      filename = id + ext;
      fs.renameSync(file.path, path.join(UPLOAD_DIR, filename));
    }

    const order = {
      id,
      name,
      product,
      note,
      payment,
      proof: filename, // null jika tidak ada
      status: 'pending',
      time: new Date().toISOString()
    };

    const orders = readOrders();
    orders.unshift(order);
    writeOrders(orders);

    // Kirim notifikasi ke Telegram (jika dikonfigurasi)
    if(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID){
      sendTelegramNotification(order).catch(err=>console.error('tg send err', err));
    }

    return res.status(200).send('ok');
  } catch (err){
    console.error(err);
    return res.status(500).send('error');
  }
});

// ADMIN: login
app.post('/admin/login', (req, res) => {
  const { u, p } = req.body;
  const ADMIN_USER = process.env.ADMIN_USER || 'admin';
  const ADMIN_PASS = process.env.ADMIN_PASS || 'change_me_please';
  if(u === ADMIN_USER && p === ADMIN_PASS){
    req.session.admin = true;
    return res.status(200).send('ok');
  }
  return res.status(401).send('unauthorized');
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy(()=> res.redirect('/public/admin.html'));
});

// middleware auth
function requireAuth(req, res, next){
  if(req.session && req.session.admin) return next();
  return res.status(401).send('unauthorized');
}

// get orders (admin)
app.get('/admin/orders', requireAuth, (req, res) => {
  const orders = readOrders();
  return res.json(orders);
});

// update order status
app.post('/admin/order/:id/status', requireAuth, (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const orders = readOrders();
  const idx = orders.findIndex(o=>o.id===id);
  if(idx === -1) return res.status(404).send('not found');
  orders[idx].status = status;
  orders[idx].updated = new Date().toISOString();
  writeOrders(orders);

  // optionally: notify buyer via Telegram (not implemented: need buyer chat_id)
  return res.send('ok');
});

// helper: send to Telegram (photo + caption)
async function sendTelegramNotification(order){
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if(!token || !chatId) throw new Error('Missing TG config');

  const caption = `📦 *Order Baru*\nNama: ${order.name}\nProduk: ${order.product}\nPembayaran: ${order.payment}\nWaktu: ${new Date(order.time).toLocaleString('id-ID')}\nStatus: ${order.status}\nCatatan: ${order.note || '-'}`;

  if(order.proof){
    // kirim photo dengan multipart/form-data
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', caption);
    form.append('parse_mode', 'Markdown');
    form.append('photo', fs.createReadStream(path.join(UPLOAD_DIR, order.proof)));

    const url = `https://api.telegram.org/bot${token}/sendPhoto`;
    await axios.post(url, form, { headers: form.getHeaders() });
  } else {
    // kirim text
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    await axios.post(url, { chat_id: chatId, text: caption, parse_mode: 'Markdown' });
  }
}

app.get('/', (req,res)=> res.redirect('/public/index.html') );

app.listen(PORT, ()=> console.log(`Server running at http://localhost:${PORT}`));
