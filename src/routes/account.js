'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { cancelOrder } = require('../orders');
const { INDIAN_STATES, toInt } = require('../helpers');
const { requireAuth, backUrl } = require('../middleware');

const router = express.Router();
const wantsJson = (req) => req.get('accept')?.includes('application/json');

// Wishlist toggling is used from product cards by signed-out visitors too, so it answers JSON before requireAuth.
router.post('/wishlist/toggle', (req, res, next) => {
  if (!req.user) {
    if (wantsJson(req)) return res.status(401).json({ ok: false, login: '/login', error: 'Please sign in to save artworks to your wishlist.' });
    return next();
  }
  const productId = toInt(req.body.product_id);
  const exists = db.prepare('SELECT 1 FROM wishlist WHERE user_id = ? AND product_id = ?').get(req.user.id, productId);
  let saved;
  if (exists) {
    db.prepare('DELETE FROM wishlist WHERE user_id = ? AND product_id = ?').run(req.user.id, productId);
    saved = false;
  } else if (db.prepare('SELECT 1 FROM products WHERE id = ? AND is_active = 1').get(productId)) {
    db.prepare('INSERT INTO wishlist (user_id, product_id) VALUES (?, ?)').run(req.user.id, productId);
    saved = true;
  }
  const count = db.prepare('SELECT COUNT(*) AS n FROM wishlist WHERE user_id = ?').get(req.user.id).n;
  if (wantsJson(req)) return res.json({ ok: true, saved, count });
  req.flash('success', saved ? 'Saved to your wishlist.' : 'Removed from your wishlist.');
  res.redirect(backUrl(req, '/account/wishlist'));
});

router.use(requireAuth);

const nav = (active) => ({ accountNav: active });

router.get('/', (req, res) => res.redirect('/account/orders'));

router.get('/orders', (req, res) => {
  const orders = db.prepare(`SELECT o.*, (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) AS item_count,
      (SELECT image FROM order_items WHERE order_id = o.id ORDER BY id LIMIT 1) AS thumb
    FROM orders o WHERE o.user_id = ? ORDER BY o.created_at DESC, o.id DESC`).all(req.user.id);
  res.render('account/orders', { title: 'My orders', orders, ...nav('orders') });
});

router.get('/orders/:orderNumber', (req, res, next) => {
  const order = db.prepare('SELECT * FROM orders WHERE order_number = ? AND user_id = ?').get(req.params.orderNumber, req.user.id);
  if (!order) return next();
  const items = db.prepare(`SELECT oi.*, p.slug FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?`).all(order.id);
  const history = db.prepare('SELECT * FROM order_history WHERE order_id = ? ORDER BY created_at, id').all(order.id);
  const canCancel = order.status === 'pending' || (order.status === 'confirmed' && order.payment_status !== 'paid');
  res.render('account/order', { title: `Order ${order.order_number}`, order, items, history, canCancel, ...nav('orders') });
});

router.post('/orders/:orderNumber/cancel', (req, res, next) => {
  const order = db.prepare('SELECT * FROM orders WHERE order_number = ? AND user_id = ?').get(req.params.orderNumber, req.user.id);
  if (!order) return next();
  const canCancel = order.status === 'pending' || (order.status === 'confirmed' && order.payment_status !== 'paid');
  if (!canCancel) {
    req.flash('error', 'This order can no longer be cancelled online. Please contact us and we will help.');
  } else {
    cancelOrder(order.id, 'Cancelled by customer');
    req.flash('success', `Order ${order.order_number} has been cancelled.`);
  }
  res.redirect(`/account/orders/${order.order_number}`);
});

router.get('/wishlist', (req, res) => {
  const products = db.prepare(`SELECT p.*, c.name AS category_name FROM wishlist w
    JOIN products p ON p.id = w.product_id LEFT JOIN categories c ON c.id = p.category_id
    WHERE w.user_id = ? AND p.is_active = 1 ORDER BY w.created_at DESC`).all(req.user.id);
  res.render('account/wishlist', { title: 'My wishlist', products, ...nav('wishlist') });
});

router.get('/profile', (req, res) => {
  res.render('account/profile', { title: 'Profile & address', form: req.user, states: INDIAN_STATES, ...nav('profile') });
});

router.post('/profile', (req, res) => {
  const form = {
    name: String(req.body.name || '').trim().slice(0, 80),
    phone: String(req.body.phone || '').replace(/[^\d+]/g, '').slice(0, 15),
    address_line1: String(req.body.address_line1 || '').trim().slice(0, 160),
    address_line2: String(req.body.address_line2 || '').trim().slice(0, 160),
    city: String(req.body.city || '').trim().slice(0, 80),
    state: String(req.body.state || '').trim(),
    pincode: String(req.body.pincode || '').replace(/\D/g, '').slice(0, 6),
  };
  const errors = [];
  if (form.name.length < 2) errors.push('Please enter your name.');
  if (form.phone && !/^(\+?91)?[6-9]\d{9}$/.test(form.phone)) errors.push('Please enter a valid 10-digit mobile number.');
  if (form.state && !INDIAN_STATES.includes(form.state)) errors.push('Please choose a valid state.');
  if (form.pincode && !/^[1-9]\d{5}$/.test(form.pincode)) errors.push('Please enter a valid 6-digit PIN code.');
  if (errors.length) {
    return res.status(422).render('account/profile', { title: 'Profile & address', form: { ...req.user, ...form }, states: INDIAN_STATES, errors, ...nav('profile') });
  }
  db.prepare(`UPDATE users SET name = ?, phone = ?, address_line1 = ?, address_line2 = ?, city = ?, state = ?, pincode = ? WHERE id = ?`)
    .run(form.name, form.phone || null, form.address_line1 || null, form.address_line2 || null, form.city || null, form.state || null, form.pincode || null, req.user.id);
  req.flash('success', 'Your profile has been updated.');
  res.redirect('/account/profile');
});

router.post('/password', async (req, res) => {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  const current = String(req.body.current_password || '');
  const next = String(req.body.new_password || '');
  if (!(await bcrypt.compare(current, row.password_hash))) {
    req.flash('error', 'Your current password is not correct.');
  } else if (next.length < 8) {
    req.flash('error', 'Your new password needs at least 8 characters.');
  } else if (next !== String(req.body.new_password_confirm || '')) {
    req.flash('error', 'The new passwords do not match.');
  } else {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await bcrypt.hash(next, 12), req.user.id);
    req.flash('success', 'Your password has been changed.');
  }
  res.redirect('/account/profile#password');
});

module.exports = router;
