'use strict';
const express = require('express');
const { db } = require('../db');
const { getCart, addToCart } = require('../cart');
const { releaseUserPendingOrders } = require('../orders');
const { toInt } = require('../helpers');
const { backUrl } = require('../middleware');

const router = express.Router();
const wantsJson = (req) => req.get('accept')?.includes('application/json');

router.get('/', (req, res) => {
  if (req.user) releaseUserPendingOrders(req.user.id);
  const cart = getCart(req);
  cart.notices.forEach((n) => res.locals.flash.push({ type: 'info', text: n }));
  const suggestions = db.prepare(`SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.is_active = 1 AND p.stock > 0 ${cart.lines.length ? `AND p.id NOT IN (${cart.lines.map(() => '?').join(',')})` : ''}
    ORDER BY p.is_featured DESC, RANDOM() LIMIT 4`).all(...cart.lines.map((l) => l.product.id));
  res.locals.cartCount = cart.count;
  res.render('shop/cart', { title: 'Your cart', cart, suggestions });
});

router.post('/add', (req, res) => {
  const result = addToCart(req, toInt(req.body.product_id), Math.min(10, Math.max(1, toInt(req.body.qty, 1))));
  if (wantsJson(req)) {
    return res.status(result.ok ? 200 : 409).json(result.ok
      ? { ok: true, count: result.count, message: `“${result.product.title}” added to your cart.` }
      : { ok: false, error: result.error });
  }
  if (result.ok) {
    if (req.body.buy_now) return res.redirect('/checkout');
    req.flash('success', `“${result.product.title}” added to your cart.`);
  } else {
    req.flash('error', result.error);
  }
  res.redirect(backUrl(req, '/cart'));
});

router.post('/update', (req, res) => {
  const id = toInt(req.body.product_id);
  const qty = toInt(req.body.qty, 1);
  const cart = req.session.cart || {};
  if (cart[id] !== undefined) {
    if (qty <= 0) delete cart[id];
    else {
      const p = db.prepare('SELECT stock FROM products WHERE id = ?').get(id);
      cart[id] = Math.min(qty, p ? p.stock : 0) || 1;
    }
    req.session.cart = cart;
  }
  res.redirect('/cart');
});

router.post('/remove', (req, res) => {
  const cart = req.session.cart || {};
  delete cart[toInt(req.body.product_id)];
  req.session.cart = cart;
  req.flash('info', 'Item removed from your cart.');
  res.redirect('/cart');
});

module.exports = router;
