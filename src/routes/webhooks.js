'use strict';
// Razorpay webhook: confirms payments even if the customer closes the browser before returning to the site.
// In the Razorpay dashboard add  <BASE_URL>/webhooks/razorpay  with the events payment.authorized,
// payment.captured, payment.failed and order.paid, and enter the same webhook secret in Admin → Settings →
// Razorpay (or RAZORPAY_WEBHOOK_SECRET in .env).
const express = require('express');
const { db } = require('../db');
const payments = require('../payments');
const { markPaid } = require('../orders');

const router = express.Router();

router.post('/razorpay', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!payments.verifyWebhookSignature(raw, req.get('x-razorpay-signature'))) {
    return res.status(400).json({ ok: false });
  }
  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ ok: false }); }
  // Answer straight away: Razorpay retries webhooks that take more than a few seconds.
  res.json({ ok: true });

  const payment = event.payload?.payment?.entity;
  const rzpOrderId = payment?.order_id || event.payload?.order?.entity?.id;
  const order = rzpOrderId && db.prepare('SELECT id, status, total, payment_status FROM orders WHERE razorpay_order_id = ?').get(rzpOrderId);
  if (!order || !payment || Number(payment.amount) !== order.total * 100) return;
  const test = payments.testMode() ? ' (TEST mode — no real money)' : '';

  if (event.event === 'payment.captured' || event.event === 'order.paid') {
    markPaid(order.id, { razorpayPaymentId: payment.id, note: `Payment confirmed by Razorpay webhook${test}` });
  } else if (event.event === 'payment.authorized' && order.payment_status !== 'paid') {
    // Accounts on manual capture: capture it here. Razorpay then sends payment.captured, which marks it paid.
    const outcome = await payments.capturePayment(payment.id, { orderId: rzpOrderId, amountPaise: order.total * 100 });
    if (outcome === 'captured') markPaid(order.id, { razorpayPaymentId: payment.id, note: `Payment captured after Razorpay webhook${test}` });
  } else if (event.event === 'payment.failed' && order.payment_status !== 'paid') {
    const reason = String(payment.error_description || 'no reason given').slice(0, 200);
    db.prepare('INSERT INTO order_history (order_id, status, note) VALUES (?, ?, ?)').run(order.id, order.status, `Razorpay payment attempt failed: ${reason}`);
  }
});

module.exports = router;
