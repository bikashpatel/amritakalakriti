'use strict';
const express = require('express');
const { db } = require('../db');
const config = require('../config');
const payments = require('../payments');
const { getCart } = require('../cart');
const { createOrder, markPaid, releaseUserPendingOrders, OrderError } = require('../orders');
const { INDIAN_STATES } = require('../helpers');
const { requireAuth } = require('../middleware');

const router = express.Router();

function paymentOptions(settings) {
  const online = settings.online_payments_enabled === '1';
  const cod = settings.cod_enabled === '1';
  return { online, cod, onlineMethod: payments.isConfigured() ? 'razorpay' : 'demo' };
}

function addressFrom(body, user) {
  return {
    name: String(body.name || '').trim().slice(0, 100),
    phone: String(body.phone || '').replace(/[^\d+]/g, '').slice(0, 15),
    email: String(body.email || user.email).trim().toLowerCase().slice(0, 160),
    line1: String(body.line1 || '').trim().slice(0, 160),
    line2: String(body.line2 || '').trim().slice(0, 160),
    city: String(body.city || '').trim().slice(0, 80),
    state: String(body.state || '').trim(),
    pincode: String(body.pincode || '').replace(/\D/g, '').slice(0, 6),
  };
}

function validateAddress(a) {
  const errors = [];
  if (a.name.length < 2) errors.push('Please enter the recipient’s full name.');
  if (!/^(\+?91)?[6-9]\d{9}$/.test(a.phone)) errors.push('Please enter a valid 10-digit mobile number for delivery updates.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(a.email)) errors.push('Please enter a valid email address.');
  if (a.line1.length < 4) errors.push('Please enter your house / flat and street.');
  if (a.city.length < 2) errors.push('Please enter your city.');
  if (!INDIAN_STATES.includes(a.state)) errors.push('Please choose your state.');
  if (!/^[1-9]\d{5}$/.test(a.pincode)) errors.push('Please enter a valid 6-digit PIN code.');
  return errors;
}

function loadMyOrder(req, orderNumber) {
  return db.prepare('SELECT * FROM orders WHERE order_number = ? AND user_id = ?').get(orderNumber, req.user.id);
}

router.get('/checkout', requireAuth, (req, res) => {
  releaseUserPendingOrders(req.user.id);
  const cart = getCart(req);
  if (!cart.lines.length) {
    cart.notices.forEach((n) => req.flash('info', n));
    return res.redirect('/cart');
  }
  const u = req.user;
  const form = { name: u.name, phone: u.phone || '', email: u.email, line1: u.address_line1 || '', line2: u.address_line2 || '',
    city: u.city || '', state: u.state || '', pincode: u.pincode || '', payment: '' };
  res.render('checkout/checkout', { title: 'Checkout', cart, form, options: paymentOptions(res.locals.settings), states: INDIAN_STATES });
});

router.post('/checkout', requireAuth, (req, res) => {
  releaseUserPendingOrders(req.user.id);
  const cart = getCart(req);
  if (!cart.lines.length) return res.redirect('/cart');
  const options = paymentOptions(res.locals.settings);
  const address = addressFrom(req.body, req.user);
  const note = String(req.body.note || '').trim().slice(0, 500);
  const choice = req.body.payment === 'cod' ? 'cod' : 'online';
  const errors = validateAddress(address);
  if (choice === 'cod' && !options.cod) errors.push('Cash on delivery is not available right now.');
  if (choice === 'online' && !options.online) errors.push('Online payment is not available right now.');
  if (cart.notices.length) errors.push(...cart.notices);

  const rerender = (errs) => res.status(422).render('checkout/checkout', {
    title: 'Checkout', cart: getCart(req), form: { ...address, note, payment: choice, save_address: req.body.save_address }, options, states: INDIAN_STATES, errors: errs,
  });
  if (errors.length) return rerender(errors);

  let order;
  try {
    order = createOrder({ userId: req.user.id, cart, address, note, paymentMethod: choice === 'cod' ? 'cod' : options.onlineMethod });
  } catch (err) {
    if (err instanceof OrderError) return rerender([err.message]);
    throw err;
  }

  if (req.body.save_address) {
    db.prepare(`UPDATE users SET phone = coalesce(nullif(phone, ''), ?), address_line1 = ?, address_line2 = ?, city = ?, state = ?, pincode = ? WHERE id = ?`)
      .run(address.phone, address.line1, address.line2 || null, address.city, address.state, address.pincode, req.user.id);
  }

  if (order.payment_method === 'cod') {
    req.session.cart = {};
    return res.redirect(`/order/${order.order_number}/success`);
  }
  res.redirect(`/checkout/pay/${order.order_number}`);
});

router.get('/checkout/pay/:orderNumber', requireAuth, async (req, res, next) => {
  const order = loadMyOrder(req, req.params.orderNumber);
  if (!order) return next();
  if (order.payment_status === 'paid') return res.redirect(`/order/${order.order_number}/success`);
  if (order.status !== 'pending') {
    req.flash('info', 'This order is no longer awaiting payment. Your cart is ready for a fresh checkout.');
    return res.redirect('/cart');
  }
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);

  if (order.payment_method === 'razorpay') {
    if (!payments.isConfigured()) {
      req.flash('error', 'Online payments are temporarily unavailable. Please try again shortly.');
      return res.redirect('/cart');
    }
    let rzpOrderId = order.razorpay_order_id;
    if (!rzpOrderId) {
      try {
        const rzp = await payments.createRazorpayOrder({ amountRupees: order.total, receipt: order.order_number, notes: { order_number: order.order_number } });
        rzpOrderId = rzp.id;
        db.prepare('UPDATE orders SET razorpay_order_id = ? WHERE id = ?').run(rzpOrderId, order.id);
      } catch (err) {
        console.error(err);
        req.flash('error', 'We could not reach the payment gateway. Please try again in a moment.');
        return res.redirect('/cart');
      }
    }
    return res.render('checkout/pay', {
      title: 'Complete your payment', order, items, mode: 'razorpay',
      rzp: { key: payments.keyId(), orderId: rzpOrderId, amount: order.total * 100 },
      expiresMinutes: config.pendingOrderTtlMinutes,
    });
  }
  res.render('checkout/pay', { title: 'Complete your payment', order, items, mode: 'demo', expiresMinutes: config.pendingOrderTtlMinutes });
});

// Razorpay Checkout posts here (via a hidden form) after the customer pays.
router.post('/checkout/verify', requireAuth, (req, res, next) => {
  const order = loadMyOrder(req, String(req.body.order_number || ''));
  if (!order) return next();
  const valid = order.payment_method === 'razorpay' && payments.isConfigured() &&
    String(req.body.razorpay_order_id) === order.razorpay_order_id &&
    payments.verifyPaymentSignature({
      razorpayOrderId: order.razorpay_order_id,
      razorpayPaymentId: String(req.body.razorpay_payment_id || ''),
      signature: String(req.body.razorpay_signature || ''),
    });
  if (!valid) {
    db.prepare("INSERT INTO order_history (order_id, status, note) VALUES (?, ?, 'Payment verification failed')").run(order.id, order.status);
    req.flash('error', 'We could not verify that payment. If money was deducted, it will be refunded automatically — or contact us with your order number.');
    return res.redirect(`/checkout/pay/${order.order_number}`);
  }
  markPaid(order.id, { razorpayPaymentId: String(req.body.razorpay_payment_id), note: 'Paid online via Razorpay' });
  req.session.cart = {};
  res.redirect(`/order/${order.order_number}/success`);
});

// Demo gateway — only active when no Razorpay keys are configured.
router.post('/checkout/demo-pay/:orderNumber', requireAuth, (req, res, next) => {
  const order = loadMyOrder(req, req.params.orderNumber);
  if (!order || order.payment_method !== 'demo' || payments.isConfigured()) return next();
  if (req.body.outcome === 'fail') {
    db.prepare("INSERT INTO order_history (order_id, status, note) VALUES (?, 'pending', 'Demo payment declined')").run(order.id);
    req.flash('error', 'The (demo) payment was declined. You can try again — nothing was charged.');
    return res.redirect(`/checkout/pay/${order.order_number}`);
  }
  markPaid(order.id, { note: 'Demo payment — no money was charged' });
  req.session.cart = {};
  res.redirect(`/order/${order.order_number}/success`);
});

router.get('/order/:orderNumber/success', requireAuth, (req, res, next) => {
  const order = loadMyOrder(req, req.params.orderNumber);
  if (!order) return next();
  if (order.status === 'pending' && order.payment_status !== 'paid') return res.redirect(`/checkout/pay/${order.order_number}`);
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
  res.render('checkout/success', { title: 'Thank you for your order', order, items });
});

module.exports = router;
