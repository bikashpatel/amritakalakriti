'use strict';
// Direct UPI payments: the customer pays the store's own UPI ID from any UPI app (QR code on a computer,
// app link on a phone) and sends back the UPI reference number. Nothing confirms the payment automatically —
// the store checks its bank or UPI app and marks the order paid from the admin.
const qrcode = require('qrcode-generator');

// name@handle, e.g. amritakalakriti@ybl or 9876543210@paytm
const isValidId = (v) => /^[a-z0-9._-]{2,256}@[a-z][a-z0-9.-]{1,63}$/i.test(String(v || ''));
const isEnabled = (settings) => settings.upi_enabled === '1' && isValidId(settings.upi_id);

// The 12-digit reference every UPI app shows (called UPI Ref No., UTR or UPI transaction ID). Null if invalid.
function normalizeRef(v) {
  const digits = String(v || '').replace(/[\s-]/g, '');
  return /^\d{12}$/.test(digits) ? digits : null;
}

// upi://pay link understood by every UPI app. The UPI ID is validated, so it goes in unencoded —
// some apps fail to read an encoded "@". No merchant "tr" reference: apps reject it for non-merchant IDs.
function payLink({ upiId, payee, amount, note }) {
  return `upi://pay?pa=${upiId}&pn=${encodeURIComponent(payee)}&am=${Number(amount).toFixed(2)}&cu=INR&tn=${encodeURIComponent(note)}`;
}

// QR code as a compact inline SVG: one path, with runs of dark modules merged into rectangles.
function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c)) continue;
      let end = c;
      while (end + 1 < n && qr.isDark(r, end + 1)) end++;
      d += `M${c + quiet} ${r + quiet}h${end - c + 1}v1h-${end - c + 1}z`;
      c = end;
    }
  }
  const size = n + quiet * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="UPI payment QR code" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#fff"/><path fill="#1d1209" d="${d}"/></svg>`;
}

// Payment details for an order, or null when UPI is switched off or has no UPI ID yet.
function forOrder(settings, order) {
  if (!isEnabled(settings)) return null;
  const payee = settings.upi_payee_name || settings.store_name;
  const link = payLink({ upiId: settings.upi_id, payee, amount: order.total, note: `Order ${order.order_number}` });
  return { id: settings.upi_id, payee, link, qr: qrSvg(link) };
}

module.exports = { isValidId, isEnabled, normalizeRef, forOrder };
