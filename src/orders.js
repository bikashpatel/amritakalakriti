'use strict';
const { db } = require('./db');
const config = require('./config');
const { newOrderNumber } = require('./helpers');
const { shippingFor } = require('./cart');

const q = {
  product: db.prepare('SELECT id, title, price, stock, image, is_active FROM products WHERE id = ?'),
  takeStock: db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?'),
  giveStock: db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?'),
  insertOrder: db.prepare(`INSERT INTO orders (order_number, user_id, status, payment_method, subtotal, shipping, total,
      ship_name, ship_phone, ship_email, ship_line1, ship_line2, ship_city, ship_state, ship_pincode, customer_note)
    VALUES (@order_number, @user_id, @status, @payment_method, @subtotal, @shipping, @total,
      @ship_name, @ship_phone, @ship_email, @ship_line1, @ship_line2, @ship_city, @ship_state, @ship_pincode, @customer_note)`),
  insertItem: db.prepare('INSERT INTO order_items (order_id, product_id, title, image, price, quantity) VALUES (?, ?, ?, ?, ?, ?)'),
  history: db.prepare('INSERT INTO order_history (order_id, status, note) VALUES (?, ?, ?)'),
  items: db.prepare('SELECT * FROM order_items WHERE order_id = ?'),
  byId: db.prepare('SELECT * FROM orders WHERE id = ?'),
  setStatus: db.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?"),
};

class OrderError extends Error {}

// Creates the order and reserves stock in one transaction, so two buyers can never both get a one-of-a-kind piece.
const createOrder = db.transaction(({ userId, cart, address, paymentMethod, note }) => {
  if (!cart.lines.length) throw new OrderError('Your cart is empty.');
  let subtotal = 0;
  const items = [];
  for (const line of cart.lines) {
    const p = q.product.get(line.product.id);
    if (!p || !p.is_active) throw new OrderError(`“${line.product.title}” is no longer available.`);
    if (q.takeStock.run(line.quantity, p.id, line.quantity).changes !== 1) {
      throw new OrderError(`Sorry — “${p.title}” was just purchased by someone else.`);
    }
    subtotal += p.price * line.quantity;
    items.push({ p, quantity: line.quantity });
  }
  const shipping = shippingFor(subtotal);
  const order = {
    order_number: newOrderNumber(),
    user_id: userId,
    status: paymentMethod === 'cod' ? 'confirmed' : 'pending',
    payment_method: paymentMethod,
    subtotal,
    shipping,
    total: subtotal + shipping,
    ship_name: address.name, ship_phone: address.phone, ship_email: address.email,
    ship_line1: address.line1, ship_line2: address.line2 || null, ship_city: address.city,
    ship_state: address.state, ship_pincode: address.pincode,
    customer_note: note || null,
  };
  const { lastInsertRowid: orderId } = q.insertOrder.run(order);
  for (const { p, quantity } of items) q.insertItem.run(orderId, p.id, p.title, p.image, p.price, quantity);
  q.history.run(orderId, order.status, paymentMethod === 'cod' ? 'Order placed — cash on delivery' : 'Order placed — awaiting payment');
  return { id: Number(orderId), ...order };
});

const markPaid = db.transaction((orderId, { razorpayPaymentId = null, note = 'Payment received' } = {}) => {
  const order = q.byId.get(orderId);
  if (!order || order.payment_status === 'paid') return order;
  if (order.status === 'cancelled') {
    // Payment arrived after the reservation expired: re-reserve the stock if every item is still available.
    const items = q.items.all(orderId).filter((i) => i.product_id);
    const available = items.every((i) => (q.product.get(i.product_id)?.stock ?? 0) >= i.quantity);
    if (!available) {
      db.prepare(`UPDATE orders SET payment_status = 'paid', razorpay_payment_id = ?,
                  admin_note = trim(coalesce(admin_note, '') || ' Paid after expiry — item unavailable, refund needed.'),
                  updated_at = datetime('now') WHERE id = ?`).run(razorpayPaymentId, orderId);
      q.history.run(orderId, 'cancelled', 'Payment received after expiry — item unavailable, refund due');
      return q.byId.get(orderId);
    }
    for (const i of items) q.takeStock.run(i.quantity, i.product_id, i.quantity);
  }
  db.prepare(`UPDATE orders SET payment_status = 'paid', razorpay_payment_id = coalesce(?, razorpay_payment_id),
              status = CASE WHEN status IN ('pending','verifying','cancelled') THEN 'confirmed' ELSE status END,
              updated_at = datetime('now') WHERE id = ?`).run(razorpayPaymentId, orderId);
  const updated = q.byId.get(orderId);
  q.history.run(orderId, updated.status, note);
  return updated;
});

// Direct UPI: the customer says they have paid and sends the reference number. The order then waits in 'verifying'
// (never auto-released) until the store checks the money arrived. If the reservation had already lapsed, the
// reference is still recorded so the store can find the payment and refund it.
const submitUpiRef = db.transaction((orderId, ref) => {
  const lapsed = q.byId.get(orderId).status === 'cancelled';
  db.prepare(`UPDATE orders SET upi_ref = ?, status = ?, updated_at = datetime('now'),
              admin_note = CASE WHEN ? THEN trim(coalesce(admin_note, '') || ' UPI reference sent after cancellation — refund the payment if it arrived.')
                           ELSE admin_note END WHERE id = ?`)
    .run(ref, lapsed ? 'cancelled' : 'verifying', lapsed ? 1 : 0, orderId);
  q.history.run(orderId, lapsed ? 'cancelled' : 'verifying', lapsed
    ? `UPI reference ${ref} sent after the order was cancelled — refund due if the payment arrived`
    : `UPI payment sent — reference ${ref}`);
  return q.byId.get(orderId);
});

const cancelOrder = db.transaction((orderId, note = 'Order cancelled') => {
  const order = q.byId.get(orderId);
  if (!order || order.status === 'cancelled') return order;
  for (const item of q.items.all(orderId)) {
    if (item.product_id) q.giveStock.run(item.quantity, item.product_id);
  }
  q.setStatus.run('cancelled', orderId);
  q.history.run(orderId, 'cancelled', note);
  return q.byId.get(orderId);
});

// Admin status changes. Cancelling restocks the items; a cancelled order stays cancelled.
function updateStatus(orderId, status, note) {
  const order = q.byId.get(orderId);
  if (!order) throw new OrderError('Order not found.');
  if (order.status === status) {
    if (note) q.history.run(orderId, status, note);
    return order;
  }
  if (order.status === 'cancelled') throw new OrderError('Cancelled orders cannot be reopened. Ask the customer to place a new order.');
  if (status === 'cancelled') return cancelOrder(orderId, note || 'Cancelled by store');
  q.setStatus.run(status, orderId);
  q.history.run(orderId, status, note || null);
  return q.byId.get(orderId);
}

// Releases stock held by online orders whose payment was never completed.
function expireStalePendingOrders() {
  const stale = db.prepare(`SELECT id FROM orders WHERE status = 'pending' AND payment_status != 'paid'
                            AND payment_method IN ('upi','razorpay','demo') AND created_at <= datetime('now', ?)`)
    .all(`-${config.pendingOrderTtlMinutes} minutes`);
  for (const { id } of stale) cancelOrder(id, 'Payment not completed in time — reservation released');
  return stale.length;
}

// When a shopper goes back to their cart or checks out again, release the stock held by their own
// unpaid online orders so those items show as available to them again.
function releaseUserPendingOrders(userId) {
  if (!userId) return 0;
  const mine = db.prepare(`SELECT id FROM orders WHERE user_id = ? AND status = 'pending' AND payment_status != 'paid'
                           AND payment_method IN ('upi','razorpay','demo')`).all(userId);
  for (const { id } of mine) cancelOrder(id, 'Customer returned to cart before paying');
  return mine.length;
}

module.exports = { createOrder, markPaid, submitUpiRef, cancelOrder, updateStatus, expireStalePendingOrders, releaseUserPendingOrders, OrderError };
