'use strict';
// The cart lives in the session as { [productId]: quantity }. Prices and stock always come from the database.
const { db, getSettings } = require('./db');

const loadProducts = (ids) => ids.length
  ? db.prepare(`SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id
                WHERE p.id IN (${ids.map(() => '?').join(',')})`).all(...ids)
  : [];

function shippingFor(subtotal, settings = getSettings()) {
  if (subtotal <= 0) return 0;
  const freeMin = Number(settings.free_shipping_min) || 0;
  if (freeMin > 0 && subtotal >= freeMin) return 0;
  return Number(settings.shipping_fee) || 0;
}

// Builds the priced cart and silently fixes quantities that exceed stock or point at removed items.
function getCart(req) {
  const raw = req.session.cart || {};
  const ids = Object.keys(raw).map(Number).filter(Boolean);
  const products = new Map(loadProducts(ids).map((p) => [p.id, p]));
  const lines = [];
  const notices = [];
  const cleaned = {};
  for (const id of ids) {
    const product = products.get(id);
    if (!product || !product.is_active || product.stock <= 0) {
      notices.push(`${product ? `“${product.title}”` : 'An item'} is no longer available and was removed from your cart.`);
      continue;
    }
    let quantity = Math.max(1, Number(raw[id]) || 1);
    if (quantity > product.stock) {
      quantity = product.stock;
      notices.push(`Only ${product.stock} of “${product.title}” available — quantity updated.`);
    }
    cleaned[id] = quantity;
    lines.push({ product, quantity, lineTotal: product.price * quantity });
  }
  req.session.cart = cleaned;
  const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  const settings = getSettings();
  const shipping = shippingFor(subtotal, settings);
  const freeMin = Number(settings.free_shipping_min) || 0;
  return {
    lines,
    notices,
    subtotal,
    shipping,
    total: subtotal + shipping,
    count: lines.reduce((s, l) => s + l.quantity, 0),
    freeShippingGap: freeMin > 0 && subtotal > 0 && subtotal < freeMin ? freeMin - subtotal : 0,
  };
}

function addToCart(req, productId, qty = 1) {
  const product = db.prepare('SELECT id, title, stock, is_active FROM products WHERE id = ?').get(productId);
  if (!product || !product.is_active) return { ok: false, error: 'This artwork is not available.' };
  if (product.stock <= 0) return { ok: false, error: 'Sorry, this artwork has just been sold.' };
  const cart = req.session.cart || {};
  const current = cart[productId] || 0;
  const next = Math.min(product.stock, current + Math.max(1, qty));
  if (next === current) return { ok: false, error: `All ${product.stock} available ${product.stock === 1 ? 'piece is' : 'pieces are'} already in your cart.` };
  cart[productId] = next;
  req.session.cart = cart;
  return { ok: true, product, count: Object.values(cart).reduce((a, b) => a + b, 0) };
}

module.exports = { getCart, addToCart, shippingFor };
