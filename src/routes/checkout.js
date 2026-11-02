'use strict';
const express = require('express');
const { db } = require('../db');
const config = require('../config');
const payments = require('../payments');
const upi = require('../upi');
const { getCart } = require('../cart');
const { createOrder, markPaid, submitUpiRef, releaseUserPendingOrders, OrderError } = require('../orders');
const { INDIAN_STATES } = require('../helpers');
const { requireAuth, rateLimit } = require('../middleware');

const router = express.Router();

// Direct UPI needs a UPI ID in Admin → Settings; Razorpay needs keys in .env (or demo mode, outside production).
function paymentOptions(settings) {
  const onlineMethod = payments.isConfigured() ? 'razorpay' : payments.demoMode() ? 'demo' : null;
  return {
    upi: upi.isEnabled(settings),
    online: settings.online_payments_enabled === '1' && Boolean(onlineMethod),
    cod: settings.cod_enabled === '1',
    onlineMethod,
  };
}

const UNAVAILABLE = {
  upi: 'UPI payment is not available right now.',
  online: 'Online payment is not available right now.',
  cod: 'Cash on delivery is not available right now.',
};

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
  const choice = Object.hasOwn(UNAVAILABLE, req.body.payment) ? req.body.payment : '';
  const errors = validateAddress(address);
  if (!choice) errors.push('Please choose how you would like to pay.');
  else if (!options[choice]) errors.push(UNAVAILABLE[choice]);
  if (cart.notices.length) errors.push(...cart.notices);

  const rerender = (errs) => res.status(422).render('checkout/checkout', {
    title: 'Checkout', cart: getCart(req), form: { ...address, note, payment: choice, save_address: req.body.save_address }, options, states: INDIAN_STATES, errors: errs,
  });
  if (errors.length) return rerender(errors);

  let order;
  try {
    order = createOrder({ userId: req.user.id, cart, address, note, paymentMethod: choice === 'online' ? options.onlineMethod : choice });
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
  if (order.payment_status === 'paid' || order.status === 'verifying') return res.redirect(`/order/${order.order_number}/success`);
  if (order.status !== 'pending') {
    req.flash('info', 'This order is no longer awaiting payment. Your cart is ready for a fresh checkout.');
    return res.redirect('/cart');
  }
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);

  if (order.payment_method === 'upi') {
    const details = upi.forOrder(res.locals.settings, order);
    if (!details) {
      req.flash('error', 'UPI payments are temporarily unavailable. Please choose another way to pay.');
      return res.redirect('/cart');
    }
    return res.render('checkout/pay', { title: 'Complete your payment', order, items, mode: 'upi', upi: details, expiresMinutes: config.pendingOrderTtlMinutes });
  }

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
  if (!payments.demoMode()) {
    req.flash('error', 'Online payments are temporarily unavailable. Please try again shortly.');
    return res.redirect('/cart');
  }
  res.render('checkout/pay', { title: 'Complete your payment', order, items, mode: 'demo', expiresMinutes: config.pendingOrderTtlMinutes });
});

// Direct UPI: after paying in their UPI app, the customer sends the 12-digit reference so the store can match the payment.
router.post('/checkout/upi/:orderNumber', requireAuth, rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }), (req, res, next) => {
  const order = loadMyOrder(req, req.params.orderNumber);
  if (!order || order.payment_method !== 'upi') return next();
  if (order.upi_ref || order.payment_status === 'paid') {
    return res.redirect(order.status === 'cancelled' ? `/account/orders/${order.order_number}` : `/order/${order.order_number}/success`);
  }
  const ref = upi.normalizeRef(req.body.upi_ref);
  if (!ref) {
    req.flash('error', 'Please enter the 12-digit UPI reference number shown in your UPI app after paying.');
    return res.redirect(`/checkout/pay/${order.order_number}`);
  }
  if (db.prepare('SELECT 1 FROM orders WHERE upi_ref = ? AND id != ?').get(ref, order.id)) {
    req.flash('error', 'That UPI reference number is already linked to another order. Please check it and try again.');
    return res.redirect(`/checkout/pay/${order.order_number}`);
  }
  if (submitUpiRef(order.id, ref).status === 'cancelled') {
    req.flash('info', 'This order was cancelled before your payment reference reached us. We have noted it — if the money left your account, we will refund it in full.');
    return res.redirect(`/account/orders/${order.order_number}`);
  }
  req.session.cart = {};
  res.redirect(`/order/${order.order_number}/success`);
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

// Demo gateway — only active in development, when no Razorpay keys are configured.
router.post('/checkout/demo-pay/:orderNumber', requireAuth, (req, res, next) => {
  const order = loadMyOrder(req, req.params.orderNumber);
  if (!order || order.payment_method !== 'demo' || !payments.demoMode()) return next();
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
