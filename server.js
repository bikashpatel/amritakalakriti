'use strict';
const path = require('path');
const express = require('express');
const session = require('express-session');
const multer = require('multer');

const config = require('./src/config');
const { db } = require('./src/db');
const SqliteStore = require('./src/session-store');
const mw = require('./src/middleware');
const { seedIfEmpty } = require('./src/seed');
const { expireStalePendingOrders } = require('./src/orders');

seedIfEmpty();

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1); // behind Nginx / a hosting proxy, so secure cookies and req.ip work
app.disable('x-powered-by');

app.use(mw.securityHeaders);
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
  cookie: { httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: 1000 * 60 * 60 * 24 * 14 },
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

app.listen(config.port, () => {
  console.log(`\n  AmritaKalakriti is running → ${config.baseUrl}`);
  console.log(`  Admin panel               → ${config.baseUrl}/admin`);
  const rzpMode = config.razorpay.keyId.startsWith('rzp_test_') ? 'Razorpay TEST keys' : 'Razorpay LIVE keys';
  console.log(`  Payments                  → ${require('./src/payments').isConfigured() ? rzpMode : 'DEMO mode (add Razorpay keys to .env)'}\n`);
});
