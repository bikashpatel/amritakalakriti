'use strict';
const path = require('path');
const express = require('express');
const session = require('express-session');
const multer = require('multer');

const config = require('./src/config');
const { db, getSettings } = require('./src/db');
const SqliteStore = require('./src/session-store');
const payments = require('./src/payments');
const mw = require('./src/middleware');
const { seedIfEmpty } = require('./src/seed');
const { expireStalePendingOrders } = require('./src/orders');

seedIfEmpty();

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', config.trustProxy); // so req.secure / req.ip are right behind Cloudflare or a load balancer
app.disable('x-powered-by');

// Health check for Docker / load balancers — answered before sessions so probes don't create any.
app.get('/healthz', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.type('text/plain').send('ok');
  } catch {
    res.status(503).type('text/plain').send('database unavailable');
  }
});

app.use(mw.securityHeaders);
// Uploaded artwork photos live in the data volume, not inside the image.
app.use('/uploads', express.static(config.uploadDir, { maxAge: config.isProd ? '30d' : 0 }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: config.isProd ? '7d' : 0 }));

// Razorpay webhooks need the raw body for signature checks, so they are mounted before the body parsers.
app.use('/webhooks', require('./src/routes/webhooks'));

app.use(express.urlencoded({ extended: false, limit: '200kb' }));
app.use(express.json({ limit: '200kb' }));
app.use(session({
  name: 'ak.sid',
  store: new SqliteStore(db),
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  // 'auto' marks the cookie Secure whenever the request arrived over HTTPS (via X-Forwarded-Proto behind a proxy).
  cookie: { httpOnly: true, sameSite: 'lax', secure: config.isProd ? 'auto' : false, maxAge: 1000 * 60 * 60 * 24 * 14 },
}));
app.use(mw.flash);
app.use(mw.currentUser);
app.use(mw.csrfToken);
app.use(mw.locals);
app.use(mw.csrfProtect);

app.use('/', require('./src/routes/auth'));
app.use('/', require('./src/routes/shop'));
app.use('/cart', require('./src/routes/cart'));
app.use('/', require('./src/routes/checkout'));
app.use('/account', require('./src/routes/account'));
app.use('/admin', mw.requireAdmin, require('./src/routes/admin'));

app.use((req, res) => {
  res.status(404).render('pages/error', { title: 'Page not found', code: 404, message: 'We could not find that page. It may have moved, or the artwork may have found a new home.' });
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof multer.MulterError) {
    req.flash?.('error', err.code === 'LIMIT_FILE_SIZE' ? 'Each image must be under 8 MB.' : `Upload failed: ${err.message}`);
    return res.redirect(mw.backUrl(req, '/admin'));
  }
  console.error(err);
  if (!res.locals.h) { try { mw.locals(req, res, () => {}); } catch { /* render with what we have */ } }
  res.locals.csrfToken = res.locals.csrfToken || '';
  res.status(500).render('pages/error', { title: 'Something went wrong', code: 500, message: 'Something went wrong on our side. Please try again in a moment.' });
});

setInterval(() => {
  try { expireStalePendingOrders(); } catch (e) { console.error('expire pending orders:', e); }
}, 60 * 1000).unref();

const server = app.listen(config.port, () => {
  console.log(`\n  AmritaKalakriti is running → ${config.baseUrl}`);
  console.log(`  Admin panel               → ${config.baseUrl}/admin`);
  const { upi_enabled: upiOn, upi_id: upiId } = getSettings();
  const rzp = payments.isConfigured() ? (config.razorpay.keyId.startsWith('rzp_test_') ? 'TEST keys' : 'LIVE keys')
    : payments.demoMode() ? 'DEMO mode (add keys to .env)' : 'off (add keys to .env to switch it on)';
  console.log(`  UPI payments              → ${upiOn === '1' && upiId ? upiId : 'not set up (Admin → Settings → Payments)'}`);
  console.log(`  Razorpay                  → ${rzp}\n`);
});

// `docker stop` sends SIGTERM: finish in-flight requests, then close the database cleanly.
function shutdown(signal) {
  console.log(`${signal} received — shutting down`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
