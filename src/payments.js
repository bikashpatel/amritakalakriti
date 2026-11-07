'use strict';
// Razorpay integration (UPI, cards, net banking, wallets) using its REST API directly — no SDK needed.
// It switches on as soon as it has a key pair: RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET in .env, or keys pasted
// into Admin → Settings → Razorpay. Without them, development runs in demo mode (a simulated payment step, so
// the full order flow can be tried without charging anyone) and production simply hides the Razorpay option —
// the demo gateway never reaches real customers.
const crypto = require('crypto');
const config = require('./config');
const { getSecret } = require('./db');

const API = 'https://api.razorpay.com/v1';

// Keys in .env win over keys saved in the admin, so a server-level setup cannot be changed from the browser.
function keys() {
  const fromEnv = Boolean(config.razorpay.keyId && config.razorpay.keySecret);
  return {
    source: fromEnv ? 'env' : 'admin',
    keyId: fromEnv ? config.razorpay.keyId : getSecret('razorpay_key_id'),
    keySecret: fromEnv ? config.razorpay.keySecret : getSecret('razorpay_key_secret'),
    webhookSecret: config.razorpay.webhookSecret || getSecret('razorpay_webhook_secret'),
  };
}

const isConfigured = () => { const k = keys(); return Boolean(k.keyId && k.keySecret); };
const demoMode = () => !config.isProd && !isConfigured();
// Test keys take test cards and fake UPI — no real money moves, so such orders must not be shipped.
const testMode = () => isConfigured() && keys().keyId.startsWith('rzp_test_');

async function api(method, path, body, k = keys()) {
  const auth = Buffer.from(`${k.keyId}:${k.keySecret}`).toString('base64');
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(`Razorpay ${method} ${path.split('?')[0]} failed: ${data?.error?.description || res.status}`), { status: res.status });
  }
  return data;
}

async function createRazorpayOrder({ amountRupees, receipt, notes = {} }) {
  return api('POST', '/orders', { amount: Math.round(amountRupees * 100), currency: 'INR', receipt, notes }); // { id: 'order_xxx', ... }
}

// Tries a key pair before the admin saves it. Returns null when Razorpay accepts it, otherwise a message.
async function checkKeys(keyId, keySecret) {
  try {
    await api('GET', '/orders?count=1', null, { keyId, keySecret });
    return null;
  } catch (err) {
    if (err.status === 401) return 'Razorpay did not accept this Key ID and Key Secret. Copy both again from Razorpay → Account & Settings → API Keys.';
    console.error(err.message);
    return 'Could not reach Razorpay to check the keys. Please try again in a minute.';
  }
}

// A verified checkout proves the payment was authorised. Make sure it is for this order and amount, and capture
// it — on accounts set to manual capture, Razorpay refunds uncaptured payments after a few days.
// Returns 'captured'; 'unconfirmed' when Razorpay could not be reached; otherwise the problem ('mismatch',
// 'failed', 'refunded', …).
async function capturePayment(paymentId, { orderId, amountPaise }) {
  const path = `/payments/${encodeURIComponent(paymentId)}`;
  let payment;
  try { payment = await api('GET', path); } catch (err) { console.error(err.message); return 'unconfirmed'; }
  if (payment.order_id !== orderId || Number(payment.amount) !== amountPaise) return 'mismatch';
  if (payment.status !== 'authorized') return payment.status;
  try {
    await api('POST', `${path}/capture`, { amount: amountPaise, currency: 'INR' });
    return 'captured';
  } catch (err) {
    // Razorpay's own auto-capture may have got there first.
    console.error(err.message);
    try { return (await api('GET', path)).status === 'captured' ? 'captured' : 'unconfirmed'; } catch { return 'unconfirmed'; }
  }
}

function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  return ba.length === bb.length && ba.length > 0 && crypto.timingSafeEqual(ba, bb);
}

// Signature sent to the browser handler after a successful payment.
function verifyPaymentSignature({ razorpayOrderId, razorpayPaymentId, signature }) {
  const expected = crypto.createHmac('sha256', keys().keySecret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`).digest('hex');
  return safeEqualHex(expected, signature);
}

// Signature on webhook calls (X-Razorpay-Signature), computed over the raw request body.
function verifyWebhookSignature(rawBody, signature) {
  const { webhookSecret } = keys();
  if (!webhookSecret) return false;
  const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  return safeEqualHex(expected, signature);
}

module.exports = {
  keys, isConfigured, demoMode, testMode, createRazorpayOrder, checkKeys, capturePayment,
  verifyPaymentSignature, verifyWebhookSignature, keyId: () => keys().keyId,
};
