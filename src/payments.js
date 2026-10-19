'use strict';
// Razorpay integration (UPI, cards, net banking, wallets) using its REST API directly — no SDK needed.
// Without RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET the store runs in demo mode: checkout shows a
// simulated payment step so the full order flow can be tried without charging anyone.
const crypto = require('crypto');
const config = require('./config');

const isConfigured = () => Boolean(config.razorpay.keyId && config.razorpay.keySecret);

async function createRazorpayOrder({ amountRupees, receipt, notes = {} }) {
  const auth = Buffer.from(`${config.razorpay.keyId}:${config.razorpay.keySecret}`).toString('base64');
  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: Math.round(amountRupees * 100), currency: 'INR', receipt, notes }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Razorpay order failed: ${data?.error?.description || res.status}`);
  return data; // { id: 'order_xxx', amount, currency, ... }
}

function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  return ba.length === bb.length && ba.length > 0 && crypto.timingSafeEqual(ba, bb);
}

// Signature sent to the browser handler after a successful payment.
function verifyPaymentSignature({ razorpayOrderId, razorpayPaymentId, signature }) {
  const expected = crypto.createHmac('sha256', config.razorpay.keySecret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`).digest('hex');
  return safeEqualHex(expected, signature);
}

// Signature on webhook calls (X-Razorpay-Signature), computed over the raw request body.
function verifyWebhookSignature(rawBody, signature) {
  if (!config.razorpay.webhookSecret) return false;
  const expected = crypto.createHmac('sha256', config.razorpay.webhookSecret).update(rawBody).digest('hex');
  return safeEqualHex(expected, signature);
}

module.exports = { isConfigured, createRazorpayOrder, verifyPaymentSignature, verifyWebhookSignature, keyId: () => config.razorpay.keyId };
