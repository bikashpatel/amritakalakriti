'use strict';
const crypto = require('crypto');

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const formatINR = (n) => inr.format(Number(n) || 0);

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

// Returns a slug that is not yet used in `table`, appending -2, -3… if needed.
function uniqueSlug(db, table, base, excludeId = null) {
  const root = slugify(base);
  let slug = root;
  for (let i = 2; ; i++) {
    const row = db.prepare(`SELECT id FROM ${table} WHERE slug = ?`).get(slug);
    if (!row || row.id === excludeId) return slug;
    slug = `${root}-${i}`;
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Renders the simple page format (## headings, - lists, blank-line paragraphs) to safe HTML.
function renderText(src) {
  const blocks = String(src || '').replace(/\r\n/g, '\n').split(/\n{2,}/);
  return blocks.map((block) => {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) return '';
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      return '<ul>' + lines.map((l) => `<li>${escapeHtml(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('') + '</ul>';
    }
    if (lines.length === 1 && /^###?\s+/.test(lines[0])) {
      const level = lines[0].startsWith('###') ? 'h3' : 'h2';
      return `<${level}>${escapeHtml(lines[0].replace(/^#+\s+/, ''))}</${level}>`;
    }
    return `<p>${lines.map(escapeHtml).join('<br>')}</p>`;
  }).join('\n');
}

function newOrderNumber() {
  const d = new Date();
  const ymd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `AK${ymd}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

const ORDER_STATUSES = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'];
const ORDER_STATUS_LABELS = {
  pending: 'Awaiting payment',
  confirmed: 'Confirmed',
  processing: 'Being packed',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};
const PAYMENT_STATUSES = ['unpaid', 'paid', 'failed', 'refunded'];
const PAYMENT_METHOD_LABELS = { razorpay: 'Online (Razorpay)', demo: 'Online (demo mode)', cod: 'Cash on delivery' };

// "2026-10-19 08:30:00" (UTC, as stored by SQLite) → "19 Oct 2026"
function formatDate(s, withTime = false) {
  if (!s) return '';
  const d = new Date(String(s).replace(' ', 'T') + (String(s).endsWith('Z') ? '' : 'Z'));
  const opts = { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' };
  if (withTime) Object.assign(opts, { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleString('en-IN', opts);
}

const INDIAN_STATES = [
  'Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh', 'Chhattisgarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir',
  'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya',
  'Mizoram', 'Nagaland', 'Odisha', 'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura',
  'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
];

const toInt = (v, def = 0) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
};

module.exports = {
  formatINR, slugify, uniqueSlug, escapeHtml, renderText, newOrderNumber, formatDate, toInt,
  ORDER_STATUSES, ORDER_STATUS_LABELS, PAYMENT_STATUSES, PAYMENT_METHOD_LABELS, INDIAN_STATES,
};
