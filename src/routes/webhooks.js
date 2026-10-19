'use strict';
// Razorpay webhook: confirms payments even if the customer closes the browser before returning to the site.
// In the Razorpay dashboard add  <BASE_URL>/webhooks/razorpay  with events payment.captured and order.paid,
// and put the webhook secret in RAZORPAY_WEBHOOK_SECRET.
const express = require('express');
const { db } = require('../db');
const payments = require('../payments');
const { markPaid } = require('../orders');

const router = express.Router();

router.post('/razorpay', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!payments.verifyWebhookSignature(raw, req.get('x-razorpay-signature'))) {
    return res.status(400).json({ ok: false });
  }
  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ ok: false }); }

  if (event.event === 'payment.captured' || event.event === 'order.paid') {
    const payment = event.payload?.payment?.entity;
    const rzpOrderId = payment?.order_id || event.payload?.order?.entity?.id;
    const order = rzpOrderId && db.prepare('SELECT id, total FROM orders WHERE razorpay_order_id = ?').get(rzpOrderId);
    if (order && payment && Number(payment.amount) === order.total * 100) {
      markPaid(order.id, { razorpayPaymentId: payment.id, note: 'Payment confirmed by Razorpay webhook' });
    }
  }
  res.json({ ok: true });
});

module.exports = router;
