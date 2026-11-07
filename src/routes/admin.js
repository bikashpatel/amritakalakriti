'use strict';
// Admin back office. Mounted by server.js at /admin behind requireAdmin, after the global CSRF check
// (multipart routes call requireCsrf themselves once multer has parsed the body).
const express = require('express');
const bcrypt = require('bcryptjs');
const { db, getSecret, setSetting, DEFAULT_SETTINGS } = require('../db');
const h = require('../helpers');
const { requireCsrf, backUrl } = require('../middleware');
const { updateStatus, markPaid, OrderError } = require('../orders');
const { upload, saveImages, removeImage, MAX_MB } = require('../uploads');
const payments = require('../payments');
const upi = require('../upi');
const config = require('../config');

const router = express.Router();
const { ORDER_STATUSES, ORDER_STATUS_LABELS, PAYMENT_STATUSES, PAYMENT_METHOD_LABELS } = h;

/* ---------------------------------------------------------------- utilities */

const PER_PAGE = 20;
const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const text = (v, max = 10000) => String(v ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
const checked = (v) => (v === '1' || v === 'on' || v === 'true' ? 1 : 0);
const wholeRupees = (v) => {
  const s = String(v ?? '').replace(/[,\s₹]/g, '');
  return /^\d{1,9}$/.test(s) ? Number(s) : NaN;
};
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const like = (s) => `%${s.replace(/[\\%_]/g, '\\$&')}%`;
const idOf = (v) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};

function paginate(total, pageParam, perPage = PER_PAGE) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(pages, Math.max(1, h.toInt(pageParam, 1)));
  return { page, pages, total, perPage, offset: (page - 1) * perPage };
}

// Builds "/admin/x?a=1&b=2", dropping empty values (and page=1).
function urlWith(base, params, overrides = {}) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...params, ...overrides })) {
    if (v === '' || v == null || (k === 'page' && Number(v) === 1)) continue;
    sp.set(k, v);
  }
  const s = sp.toString();
  return s ? `${base}?${s}` : base;
}

// "₹12K", "₹1.5L", "₹2Cr" for chart axes.
function compactINR(n) {
  const one = (x) => String(Math.round(x * 10) / 10);
  if (n >= 1e7) return `₹${one(n / 1e7)}Cr`;
  if (n >= 1e5) return `₹${one(n / 1e5)}L`;
  if (n >= 1e3) return `₹${one(n / 1e3)}K`;
  return `₹${Math.round(n)}`;
}

function niceScale(max, count = 4) {
  if (!(max > 0)) return { top: 1000, ticks: [0, 250, 500, 750, 1000] };
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v));
  return { top, ticks };
}

// CSV with formula-injection guarding (OWASP) and a BOM so Excel reads ₹ and Indic names correctly.
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function sendCsv(res, filename, rows) {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  res.attachment(filename);
  res.send('﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n');
}

function notFound(res, what = 'page') {
  return res.status(404).render('pages/error', {
    title: 'Not found', code: 404, message: `We could not find that ${what} in the admin. It may have been deleted.`,
  });
}

// Only delete an uploaded file when nothing in the database points at it any more
// (order_items keep the image a customer bought, so their history stays intact).
const imageRefs = db.prepare(`SELECT
  (SELECT COUNT(*) FROM products WHERE image = @p) + (SELECT COUNT(*) FROM product_images WHERE path = @p) +
  (SELECT COUNT(*) FROM categories WHERE image = @p) + (SELECT COUNT(*) FROM order_items WHERE image = @p) AS n`);
function discardImage(p) {
  if (p && imageRefs.get({ p }).n === 0) removeImage(p);
}

function flashRejected(req, rejected) {
  if (rejected.length) {
    req.flash('error', `Skipped ${rejected.join(', ')} — only JPG, PNG, WebP, GIF or AVIF images (up to ${MAX_MB} MB) can be uploaded.`);
  }
}

/* ------------------------------------------------------- shared admin locals */

const navCounts = db.prepare(`SELECT
  (SELECT COUNT(*) FROM orders WHERE status IN ('confirmed','processing')) AS toFulfil,
  (SELECT COUNT(*) FROM orders WHERE status = 'verifying') AS toVerify,
  (SELECT COUNT(*) FROM messages WHERE is_read = 0) AS unread`);

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.locals.adminCounts = navCounts.get();
  res.locals.section = '';
  res.locals.back = null;
  res.locals.compactINR = compactINR;
  res.locals.ORDER_STATUSES = ORDER_STATUSES;
  res.locals.ORDER_STATUS_LABELS = ORDER_STATUS_LABELS;
  res.locals.PAYMENT_STATUSES = PAYMENT_STATUSES;
  res.locals.PAYMENT_METHOD_LABELS = PAYMENT_METHOD_LABELS;
  next();
});

/* ---------------------------------------------------------------- dashboard */

const PAID = "payment_status = 'paid' AND status != 'cancelled'";
const THIS_MONTH = "strftime('%Y-%m', created_at, '+330 minutes') = strftime('%Y-%m', 'now', '+330 minutes')";
const dash = {
  kpis: db.prepare(`SELECT
    (SELECT COALESCE(SUM(total), 0) FROM orders WHERE ${PAID} AND ${THIS_MONTH}) AS revenueMonth,
    (SELECT COALESCE(SUM(total), 0) FROM orders WHERE ${PAID}) AS revenueAll,
    (SELECT COUNT(*) FROM orders WHERE status != 'cancelled' AND ${THIS_MONTH}) AS ordersMonth,
    (SELECT COUNT(*) FROM orders WHERE status != 'cancelled') AS ordersAll,
    (SELECT COUNT(*) FROM orders WHERE status IN ('confirmed','processing')) AS toFulfil,
    (SELECT COUNT(*) FROM orders WHERE status = 'pending') AS awaitingPayment,
    (SELECT COUNT(*) FROM orders WHERE status = 'verifying') AS toVerify,
    (SELECT COUNT(*) FROM users WHERE role = 'customer') AS customers,
    (SELECT COUNT(*) FROM users WHERE role = 'customer' AND ${THIS_MONTH}) AS customersMonth,
    (SELECT COUNT(*) FROM products WHERE is_active = 1) AS activeProducts,
    (SELECT COUNT(*) FROM products) AS allProducts,
    (SELECT COUNT(*) FROM products WHERE stock = 0) AS soldOut,
    (SELECT COUNT(*) FROM messages WHERE is_read = 0) AS unread,
    (SELECT COUNT(*) FROM subscribers) AS subscribers`),
  daily: db.prepare(`SELECT date(created_at, '+330 minutes') AS d, SUM(total) AS revenue, COUNT(*) AS orders
    FROM orders WHERE ${PAID} AND date(created_at, '+330 minutes') >= date('now', '+330 minutes', '-29 days')
    GROUP BY d`),
  recent: db.prepare(`SELECT o.id, o.order_number, o.ship_name, o.ship_city, o.total, o.status, o.payment_status, o.payment_method, o.created_at,
      (SELECT COALESCE(SUM(quantity), 0) FROM order_items WHERE order_id = o.id) AS item_count
    FROM orders o ORDER BY o.created_at DESC, o.id DESC LIMIT 10`),
  top: db.prepare(`SELECT oi.product_id, MAX(oi.title) AS title, COALESCE(MAX(p.image), MAX(oi.image)) AS image,
      SUM(oi.quantity) AS qty, SUM(oi.quantity * oi.price) AS revenue, MAX(p.stock) AS stock
    FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN products p ON p.id = oi.product_id
    WHERE o.status != 'cancelled'
    GROUP BY COALESCE(CAST(oi.product_id AS TEXT), 'title:' || oi.title)
    ORDER BY qty DESC, revenue DESC LIMIT 5`),
};

function last30Days() {
  const byDay = new Map(dash.daily.all().map((r) => [r.d, r]));
  const todayIST = new Date(Date.now() + 330 * 60 * 1000);
  const base = Date.UTC(todayIST.getUTCFullYear(), todayIST.getUTCMonth(), todayIST.getUTCDate());
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const dt = new Date(base - i * 86400000);
    const key = dt.toISOString().slice(0, 10);
    const row = byDay.get(key);
    days.push({
      key,
      label: dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }),
      long: dt.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }),
      revenue: row ? row.revenue : 0,
      orders: row ? row.orders : 0,
    });
  }
  const total = days.reduce((s, d) => s + d.revenue, 0);
  const orders = days.reduce((s, d) => s + d.orders, 0);
  const peak = days.reduce((best, d) => (d.revenue > best.revenue ? d : best), days[0]);
  const { top, ticks } = niceScale(peak.revenue);
  for (const d of days) {
    d.isPeak = d === peak && d.revenue > 0;
    d.pct = d.revenue > 0 ? Math.max(1.5, (d.revenue / top) * 100) : 0;
  }
  return { days, total, orders, peak, top, ticks };
}

router.get('/', (req, res) => {
  res.render('admin/dashboard', {
    title: 'Dashboard',
    section: 'dashboard',
    k: dash.kpis.get(),
    chart: last30Days(),
    recent: dash.recent.all(),
    topSellers: dash.top.all(),
  });
});

/* ----------------------------------------------------------------- artworks */

const prod = {
  byId: db.prepare('SELECT * FROM products WHERE id = ?'),
  images: db.prepare('SELECT * FROM product_images WHERE product_id = ? ORDER BY sort_order, id'),
  image: db.prepare('SELECT * FROM product_images WHERE id = ? AND product_id = ?'),
  maxSort: db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS n FROM product_images WHERE product_id = ?'),
  addImage: db.prepare('INSERT INTO product_images (product_id, path, sort_order) VALUES (?, ?, ?)'),
  delImage: db.prepare('DELETE FROM product_images WHERE id = ?'),
  setMain: db.prepare("UPDATE products SET image = ?, updated_at = datetime('now') WHERE id = ?"),
  skuTaken: db.prepare('SELECT id FROM products WHERE sku = ? AND id != ? LIMIT 1'),
  sold: db.prepare(`SELECT COALESCE(SUM(oi.quantity), 0) AS qty FROM order_items oi JOIN orders o ON o.id = oi.order_id
                    WHERE oi.product_id = ? AND o.status != 'cancelled'`),
  insert: db.prepare(`INSERT INTO products (category_id, title, slug, short_description, description, artist, medium, dimensions, year, sku,
      price, compare_at_price, stock, image, is_featured, is_active)
    VALUES (@category_id, @title, @slug, @short_description, @description, @artist, @medium, @dimensions, @year, @sku,
      @price, @compare_at_price, @stock, @image, @is_featured, @is_active)`),
  update: db.prepare(`UPDATE products SET category_id = @category_id, title = @title, slug = @slug, short_description = @short_description,
      description = @description, artist = @artist, medium = @medium, dimensions = @dimensions, year = @year, sku = @sku,
      price = @price, compare_at_price = @compare_at_price, stock = @stock, is_featured = @is_featured, is_active = @is_active,
      updated_at = datetime('now') WHERE id = @id`),
};
const categoryOptions = db.prepare('SELECT id, name FROM categories ORDER BY sort_order, name');
const categoryExists = db.prepare('SELECT id FROM categories WHERE id = ?');

const PRODUCT_STATUS_FILTERS = {
  active: 'p.is_active = 1',
  inactive: 'p.is_active = 0',
  soldout: 'p.stock = 0',
  featured: 'p.is_featured = 1',
};

router.get('/products', (req, res) => {
  const f = { q: str(req.query.q, 100), category: str(req.query.category, 12), status: str(req.query.status, 20) };
  const where = [];
  const params = {};
  if (f.q) { where.push("(p.title LIKE @q ESCAPE '\\' OR p.sku LIKE @q ESCAPE '\\')"); params.q = like(f.q); }
  if (f.category === 'none') where.push('p.category_id IS NULL');
  else if (idOf(f.category)) { where.push('p.category_id = @cat'); params.cat = idOf(f.category); } else f.category = '';
  if (PRODUCT_STATUS_FILTERS[f.status]) where.push(PRODUCT_STATUS_FILTERS[f.status]); else f.status = '';
  const W = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM products p ${W}`).get(params).n;
  const pg = paginate(total, req.query.page);
  const products = db.prepare(`SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id
    ${W} ORDER BY p.id DESC LIMIT @limit OFFSET @offset`).all({ ...params, limit: pg.perPage, offset: pg.offset });
  const summary = db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(is_active), 0) AS live,
    COALESCE(SUM(stock = 0), 0) AS soldOut FROM products`).get();
  res.render('admin/products', {
    title: 'Artworks', section: 'products', products, categories: categoryOptions.all(), f, pg, summary,
    filtered: Boolean(f.q || f.category || f.status),
    pageUrl: (p) => urlWith('/admin/products', f, { page: p }),
  });
});

const BLANK_PRODUCT = {
  id: null, title: '', slug: '', category_id: '', short_description: '', description: '', artist: '', medium: '',
  dimensions: '', year: String(new Date().getFullYear()), sku: '', price: '', compare_at_price: '', stock: '1',
  is_featured: 0, is_active: 1, image: null,
};

function renderProductForm(res, { product, form, errors = {}, status = 200 }) {
  const images = product ? prod.images.all(product.id) : [];
  res.status(status).render('admin/product-form', {
    title: product ? `Edit · ${product.title}` : 'Add artwork',
    section: 'products',
    back: { href: '/admin/products', label: 'All artworks' },
    product, images, form, errors,
    categories: categoryOptions.all(),
    soldCount: product ? prod.sold.get(product.id).qty : 0,
  });
}

function readProduct(body, currentId = 0) {
  const form = {
    title: str(body.title, 200),
    slug: str(body.slug, 100),
    category_id: str(body.category_id, 12),
    short_description: str(body.short_description, 300),
    description: text(body.description, 10000),
    artist: str(body.artist, 120),
    medium: str(body.medium, 160),
    dimensions: str(body.dimensions, 80),
    year: str(body.year, 20),
    sku: str(body.sku, 60),
    price: str(body.price, 20),
    compare_at_price: str(body.compare_at_price, 20),
    stock: str(body.stock, 20),
    is_featured: checked(body.is_featured),
    is_active: checked(body.is_active),
  };
  const errors = {};
  if (!form.title) errors.title = 'Give the artwork a title.';
  const price = wholeRupees(form.price);
  if (!Number.isInteger(price)) errors.price = 'Enter the price in whole rupees, e.g. 4500.';
  let compareAt = null;
  if (form.compare_at_price) {
    compareAt = wholeRupees(form.compare_at_price);
    if (!Number.isInteger(compareAt)) errors.compare_at_price = 'Whole rupees only — or leave it blank.';
    else if (Number.isInteger(price) && compareAt <= price) errors.compare_at_price = 'Should be higher than the price — or leave it blank.';
  }
  const stock = wholeRupees(form.stock);
  if (!Number.isInteger(stock)) errors.stock = 'Enter how many are available (0 or more).';
  let categoryId = null;
  if (form.category_id) {
    categoryId = idOf(form.category_id);
    if (!categoryId || !categoryExists.get(categoryId)) errors.category_id = 'Choose an art form from the list.';
  }
  if (form.sku && prod.skuTaken.get(form.sku, currentId)) errors.sku = 'Another artwork already uses this SKU.';
  const values = {
    title: form.title, category_id: categoryId,
    short_description: form.short_description || null, description: form.description || null,
    artist: form.artist || null, medium: form.medium || null, dimensions: form.dimensions || null,
    year: form.year || null, sku: form.sku || null,
    price, compare_at_price: compareAt, stock,
    is_featured: form.is_featured, is_active: form.is_active,
  };
  return { form, values, errors };
}

// Adds uploaded files to a product: the first becomes the main image if it has none.
function attachImages(productId, paths) {
  if (!paths.length) return;
  const product = prod.byId.get(productId);
  let rest = paths;
  if (!product.image) {
    prod.setMain.run(paths[0], productId);
    rest = paths.slice(1);
  }
  let sort = prod.maxSort.get(productId).n;
  for (const p of rest) prod.addImage.run(productId, p, ++sort);
}

router.get('/products/new', (req, res) => {
  renderProductForm(res, { product: null, form: { ...BLANK_PRODUCT } });
});

router.post('/products', upload.array('images', 10), requireCsrf, (req, res) => {
  const { form, values, errors } = readProduct(req.body || {});
  if (Object.keys(errors).length) {
    if (req.files?.length) errors._images = 'Your images were not saved — please choose them again.';
    return renderProductForm(res, { product: null, form, errors, status: 422 });
  }
  const { saved, rejected } = saveImages(req.files);
  const id = db.transaction(() => {
    const newId = Number(prod.insert.run({
      ...values, slug: h.uniqueSlug(db, 'products', form.slug || form.title), image: null,
    }).lastInsertRowid);
    attachImages(newId, saved);
    return newId;
  })();
  flashRejected(req, rejected);
  req.flash('success', `“${values.title}” has been added${values.is_active ? ' and is live on the store' : ' (hidden from the store)'}.`);
  res.redirect(`/admin/products/${id}/edit`);
});

router.get('/products/:id/edit', (req, res) => {
  const product = prod.byId.get(idOf(req.params.id));
  if (!product) return notFound(res, 'artwork');
  renderProductForm(res, { product, form: { ...product, compare_at_price: product.compare_at_price ?? '' } });
});

router.post('/products/:id', upload.array('images', 10), requireCsrf, (req, res) => {
  const product = prod.byId.get(idOf(req.params.id));
  if (!product) return notFound(res, 'artwork');
  const { form, values, errors } = readProduct(req.body || {}, product.id);
  if (Object.keys(errors).length) {
    if (req.files?.length) errors._images = 'Your new images were not saved — please choose them again.';
    return renderProductForm(res, { product, form, errors, status: 422 });
  }
  const slug = form.slug && h.slugify(form.slug) !== product.slug
    ? h.uniqueSlug(db, 'products', form.slug, product.id)
    : product.slug;
  const { saved, rejected } = saveImages(req.files);
  db.transaction(() => {
    prod.update.run({ ...values, slug, id: product.id });
    attachImages(product.id, saved);
  })();
  flashRejected(req, rejected);
  const added = saved.length ? ` ${saved.length} image${saved.length === 1 ? '' : 's'} uploaded.` : '';
  req.flash('success', `Saved “${values.title}”.${added}`);
  res.redirect(`/admin/products/${product.id}/edit`);
});

router.post('/products/:id/toggle', (req, res) => {
  const product = prod.byId.get(idOf(req.params.id));
  if (!product) return notFound(res, 'artwork');
  const field = { is_active: 'is_active', is_featured: 'is_featured' }[req.body?.field];
  if (field) {
    const next = product[field] ? 0 : 1;
    db.prepare(`UPDATE products SET ${field} = ?, updated_at = datetime('now') WHERE id = ?`).run(next, product.id);
    const msg = field === 'is_active'
      ? (next ? `“${product.title}” is now live on the store.` : `“${product.title}” is now hidden from the store.`)
      : (next ? `“${product.title}” will be featured on the homepage.` : `“${product.title}” is no longer featured.`);
    req.flash('success', msg);
  }
  res.redirect(backUrl(req, '/admin/products'));
});

router.post('/products/:id/delete', (req, res) => {
  const product = prod.byId.get(idOf(req.params.id));
  if (!product) return notFound(res, 'artwork');
  const paths = [product.image, ...prod.images.all(product.id).map((i) => i.path)];
  db.prepare('DELETE FROM products WHERE id = ?').run(product.id);
  paths.forEach(discardImage);
  req.flash('success', `“${product.title}” was deleted. Past orders still show it.`);
  res.redirect('/admin/products');
});

router.post('/products/:id/images/main', (req, res) => {
  const product = prod.byId.get(idOf(req.params.id));
  if (!product) return notFound(res, 'artwork');
  const img = prod.image.get(idOf(req.body?.image), product.id);
  if (img) {
    db.transaction(() => {
      prod.setMain.run(img.path, product.id);
      prod.delImage.run(img.id);
      if (product.image) prod.addImage.run(product.id, product.image, img.sort_order);
    })();
    req.flash('success', 'Main image updated.');
  }
  res.redirect(`/admin/products/${product.id}/edit#images`);
});

router.post('/products/:id/images/delete', (req, res) => {
  const product = prod.byId.get(idOf(req.params.id));
  if (!product) return notFound(res, 'artwork');
  if (req.body?.image === 'main' && product.image) {
    const [promote] = prod.images.all(product.id);
    db.transaction(() => {
      prod.setMain.run(promote ? promote.path : null, product.id);
      if (promote) prod.delImage.run(promote.id);
    })();
    discardImage(product.image);
    req.flash('success', promote ? 'Image removed — the next image is now the main one.' : 'Image removed. This artwork has no image now.');
  } else {
    const img = prod.image.get(idOf(req.body?.image), product.id);
    if (img) {
      prod.delImage.run(img.id);
      db.prepare("UPDATE products SET updated_at = datetime('now') WHERE id = ?").run(product.id);
      discardImage(img.path);
      req.flash('success', 'Image removed.');
    }
  }
  res.redirect(`/admin/products/${product.id}/edit#images`);
});

/* --------------------------------------------------------------- art forms */

const cat = {
  list: db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS product_count,
      (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.is_active = 1) AS live_count
    FROM categories c ORDER BY c.sort_order, c.name`),
  byId: db.prepare('SELECT * FROM categories WHERE id = ?'),
  count: db.prepare('SELECT COUNT(*) AS n FROM products WHERE category_id = ?'),
  uncategorised: db.prepare('SELECT COUNT(*) AS n FROM products WHERE category_id IS NULL'),
  nextSort: db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM categories'),
  insert: db.prepare(`INSERT INTO categories (name, slug, tagline, description, image, sort_order, is_active)
    VALUES (@name, @slug, @tagline, @description, @image, @sort_order, @is_active)`),
  update: db.prepare(`UPDATE categories SET name = @name, slug = @slug, tagline = @tagline, description = @description,
    image = @image, sort_order = @sort_order, is_active = @is_active WHERE id = @id`),
};

router.get('/categories', (req, res) => {
  res.render('admin/categories', {
    title: 'Art forms', section: 'categories', categories: cat.list.all(), uncategorised: cat.uncategorised.get().n,
  });
});

function renderCategoryForm(res, { category, form, errors = {}, status = 200 }) {
  res.status(status).render('admin/category-form', {
    title: category ? `Edit · ${category.name}` : 'Add art form',
    section: 'categories',
    back: { href: '/admin/categories', label: 'All art forms' },
    category, form, errors,
    productCount: category ? cat.count.get(category.id).n : 0,
  });
}

function readCategory(body) {
  const form = {
    name: str(body.name, 100),
    slug: str(body.slug, 100),
    tagline: str(body.tagline, 160),
    description: text(body.description, 3000),
    sort_order: str(body.sort_order, 6),
    is_active: checked(body.is_active),
    remove_image: checked(body.remove_image),
  };
  const errors = {};
  if (!form.name) errors.name = 'Give the art form a name.';
  const sort = form.sort_order === '' ? 0 : Number(form.sort_order);
  if (!Number.isInteger(sort) || sort < 0 || sort > 9999) errors.sort_order = 'Use a whole number from 0 to 9999.';
  return { form, errors, values: { name: form.name, tagline: form.tagline || null, description: form.description || null, sort_order: sort, is_active: form.is_active } };
}

router.get('/categories/new', (req, res) => {
  renderCategoryForm(res, {
    category: null,
    form: { name: '', slug: '', tagline: '', description: '', sort_order: String(cat.nextSort.get().n), is_active: 1 },
  });
});

router.post('/categories', upload.single('image'), requireCsrf, (req, res) => {
  const { form, values, errors } = readCategory(req.body || {});
  if (Object.keys(errors).length) {
    if (req.file) errors._image = 'Your image was not saved — please choose it again.';
    return renderCategoryForm(res, { category: null, form, errors, status: 422 });
  }
  const { saved, rejected } = saveImages(req.file ? [req.file] : []);
  cat.insert.run({ ...values, slug: h.uniqueSlug(db, 'categories', form.slug || form.name), image: saved[0] || null });
  flashRejected(req, rejected);
  req.flash('success', `Art form “${values.name}” added.`);
  res.redirect('/admin/categories');
});

router.get('/categories/:id/edit', (req, res) => {
  const category = cat.byId.get(idOf(req.params.id));
  if (!category) return notFound(res, 'art form');
  renderCategoryForm(res, { category, form: { ...category, sort_order: String(category.sort_order) } });
});

router.post('/categories/:id', upload.single('image'), requireCsrf, (req, res) => {
  const category = cat.byId.get(idOf(req.params.id));
  if (!category) return notFound(res, 'art form');
  const { form, values, errors } = readCategory(req.body || {});
  if (Object.keys(errors).length) {
    if (req.file) errors._image = 'Your image was not saved — please choose it again.';
    return renderCategoryForm(res, { category, form, errors, status: 422 });
  }
  const slug = form.slug && h.slugify(form.slug) !== category.slug
    ? h.uniqueSlug(db, 'categories', form.slug, category.id)
    : category.slug;
  const { saved, rejected } = saveImages(req.file ? [req.file] : []);
  let image = category.image;
  if (saved[0]) image = saved[0];
  else if (form.remove_image) image = null;
  cat.update.run({ ...values, slug, image, id: category.id });
  if (image !== category.image) discardImage(category.image);
  flashRejected(req, rejected);
  req.flash('success', `Saved “${values.name}”.`);
  res.redirect(`/admin/categories/${category.id}/edit`);
});

router.post('/categories/:id/delete', (req, res) => {
  const category = cat.byId.get(idOf(req.params.id));
  if (!category) return notFound(res, 'art form');
  const n = cat.count.get(category.id).n;
  db.prepare('DELETE FROM categories WHERE id = ?').run(category.id);
  discardImage(category.image);
  req.flash('success', `Art form “${category.name}” deleted.${n ? ` ${n} artwork${n === 1 ? ' is' : 's are'} now uncategorised.` : ''}`);
  res.redirect('/admin/categories');
});

/* ------------------------------------------------------------------- orders */

function orderFilter(query) {
  const f = {
    q: str(query.q, 100),
    status: ORDER_STATUSES.includes(query.status) || query.status === 'open' ? query.status : '',
    payment: PAYMENT_STATUSES.includes(query.payment) ? query.payment : '',
    from: isDate(query.from) ? query.from : '',
    to: isDate(query.to) ? query.to : '',
  };
  const where = [];
  const params = {};
  if (f.status === 'open') where.push("o.status IN ('confirmed','processing')");
  else if (f.status) { where.push('o.status = @status'); params.status = f.status; }
  if (f.payment) { where.push('o.payment_status = @payment'); params.payment = f.payment; }
  if (f.q) {
    where.push(`(o.order_number LIKE @q ESCAPE '\\' OR o.ship_name LIKE @q ESCAPE '\\'
      OR o.ship_email LIKE @q ESCAPE '\\' OR o.ship_phone LIKE @q ESCAPE '\\')`);
    params.q = like(f.q);
  }
  if (f.from) { where.push("date(o.created_at, '+330 minutes') >= @from"); params.from = f.from; }
  if (f.to) { where.push("date(o.created_at, '+330 minutes') <= @to"); params.to = f.to; }
  return { f, W: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

router.get('/orders', (req, res) => {
  const { f, W, params } = orderFilter(req.query);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM orders o ${W}`).get(params).n;
  const pg = paginate(total, req.query.page);
  const orders = db.prepare(`SELECT o.*, (SELECT COALESCE(SUM(quantity), 0) FROM order_items WHERE order_id = o.id) AS item_count
    FROM orders o ${W} ORDER BY o.created_at DESC, o.id DESC LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: pg.perPage, offset: pg.offset });
  const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').all().map((r) => [r.status, r.n]));
  counts.all = Object.values(counts).reduce((a, b) => a + b, 0);
  counts.open = (counts.confirmed || 0) + (counts.processing || 0);
  res.render('admin/orders', {
    title: 'Orders', section: 'orders', orders, f, pg, counts,
    filtered: Boolean(f.q || f.payment || f.from || f.to),
    pageUrl: (p) => urlWith('/admin/orders', f, { page: p }),
    tabUrl: (status) => urlWith('/admin/orders', f, { status, page: 1 }),
    exportUrl: urlWith('/admin/orders/export.csv', f),
  });
});

router.get('/orders/export.csv', (req, res) => {
  const { W, params } = orderFilter(req.query);
  const rows = db.prepare(`SELECT o.*, strftime('%Y-%m-%d %H:%M', o.created_at, '+330 minutes') AS placed_ist,
      (SELECT GROUP_CONCAT(title || ' x ' || quantity, '; ') FROM order_items WHERE order_id = o.id) AS items,
      (SELECT COALESCE(SUM(quantity), 0) FROM order_items WHERE order_id = o.id) AS item_count
    FROM orders o ${W} ORDER BY o.created_at DESC, o.id DESC`).all(params);
  const header = ['Order number', 'Placed (IST)', 'Status', 'Payment status', 'Payment method', 'Customer name', 'Email', 'Phone',
    'Address line 1', 'Address line 2', 'City', 'State', 'Pincode', 'Items', 'Item count', 'Subtotal (INR)', 'Shipping (INR)', 'Total (INR)',
    'Courier', 'Tracking number', 'UPI reference', 'Razorpay order ID', 'Razorpay payment ID', 'Customer note', 'Admin note'];
  const data = rows.map((o) => [o.order_number, o.placed_ist, ORDER_STATUS_LABELS[o.status] || o.status, o.payment_status,
    PAYMENT_METHOD_LABELS[o.payment_method] || o.payment_method, o.ship_name, o.ship_email, o.ship_phone,
    o.ship_line1, o.ship_line2, o.ship_city, o.ship_state, o.ship_pincode, o.items, o.item_count, o.subtotal, o.shipping, o.total,
    o.courier, o.tracking_number, o.upi_ref, o.razorpay_order_id, o.razorpay_payment_id, o.customer_note, o.admin_note]);
  const stamp = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  sendCsv(res, `amritakalakriti-orders-${stamp}.csv`, [header, ...data]);
});

const ord = {
  byId: db.prepare('SELECT * FROM orders WHERE id = ?'),
  items: db.prepare(`SELECT oi.*, p.slug AS product_slug, p.image AS product_image, p.sku AS product_sku
    FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ? ORDER BY oi.id`),
  history: db.prepare('SELECT * FROM order_history WHERE order_id = ? ORDER BY created_at, id'),
  customer: db.prepare(`SELECT id, name, email, phone, role, is_active, created_at,
      (SELECT COUNT(*) FROM orders WHERE user_id = users.id) AS order_count FROM users WHERE id = ?`),
  addHistory: db.prepare('INSERT INTO order_history (order_id, status, note) VALUES (?, ?, ?)'),
};

function loadOrder(req, res) {
  const order = ord.byId.get(idOf(req.params.id));
  if (!order) notFound(res, 'order');
  return order;
}

router.get('/orders/:id', (req, res) => {
  const order = loadOrder(req, res);
  if (!order) return;
  res.render('admin/order', {
    title: `Order ${order.order_number}`,
    section: 'orders',
    back: { href: '/admin/orders', label: 'All orders' },
    order,
    items: ord.items.all(order.id),
    history: ord.history.all(order.id).reverse(),
    customer: order.user_id ? ord.customer.get(order.user_id) : null,
  });
});

router.get('/orders/:id/invoice', (req, res) => {
  const order = loadOrder(req, res);
  if (!order) return;
  const slip = req.query.type === 'slip';
  res.render('admin/invoice', {
    title: `${slip ? 'Packing slip' : 'Invoice'} ${order.order_number}`,
    order, slip,
    items: ord.items.all(order.id),
    customer: order.user_id ? ord.customer.get(order.user_id) : null,
  });
});

router.post('/orders/:id/status', (req, res) => {
  const order = loadOrder(req, res);
  if (!order) return;
  const b = req.body || {};
  const status = String(b.status || '');
  if (!ORDER_STATUSES.includes(status)) {
    req.flash('error', 'Choose a valid order status.');
    return res.redirect(`/admin/orders/${order.id}`);
  }
  const courier = str(b.courier, 80);
  const tracking = str(b.tracking_number, 80);
  let note = str(b.note, 500);
  if (status === 'shipped' && order.status !== 'shipped' && !note && (courier || tracking)) {
    note = `Shipped${courier ? ` via ${courier}` : ''}${tracking ? ` · tracking ${tracking}` : ''}`;
  }
  try {
    db.transaction(() => {
      updateStatus(order.id, status, note || null);
      if (status === 'shipped') {
        db.prepare("UPDATE orders SET courier = ?, tracking_number = ?, updated_at = datetime('now') WHERE id = ?")
          .run(courier || null, tracking || null, order.id);
      }
    })();
    if (status === order.status) {
      req.flash('success', status === 'shipped' ? 'Shipping details saved.' : (note ? 'Note added to the timeline.' : 'Nothing changed — the order already has that status.'));
    } else {
      req.flash('success', `Order ${order.order_number} is now “${ORDER_STATUS_LABELS[status]}”.${status === 'cancelled' ? ' Stock has been returned.' : ''}`);
    }
  } catch (err) {
    if (!(err instanceof OrderError)) throw err;
    req.flash('error', err.message);
  }
  res.redirect(`/admin/orders/${order.id}`);
});

router.post('/orders/:id/payment', (req, res) => {
  const order = loadOrder(req, res);
  if (!order) return;
  const action = String(req.body?.payment_status || '');
  const note = str(req.body?.note, 300);
  if (!['paid', 'refunded', 'failed'].includes(action)) {
    req.flash('error', 'Choose a valid payment status.');
  } else if (order.payment_status === action) {
    req.flash('info', `Payment is already marked as ${action}.`);
  } else if (action === 'paid' && order.status === 'cancelled') {
    // markPaid() would re-reserve stock and reopen the order; from the admin that must stay a new order.
    req.flash('error', 'This order is cancelled, so it cannot be marked as paid. Ask the customer to place a new order.');
  } else if (action === 'paid') {
    const updated = markPaid(order.id, { note: note || 'Payment marked as received by the store' });
    req.flash('success', updated.status === 'cancelled'
      ? 'Payment recorded, but the items are no longer in stock — the order stays cancelled and needs a refund.'
      : `Payment for ${order.order_number} marked as received.`);
  } else {
    db.transaction(() => {
      db.prepare("UPDATE orders SET payment_status = ?, updated_at = datetime('now') WHERE id = ?").run(action, order.id);
      ord.addHistory.run(order.id, order.status, note || (action === 'refunded' ? 'Payment refunded' : 'Payment marked as failed'));
    })();
    req.flash('success', `Payment for ${order.order_number} marked as ${action}.`);
  }
  res.redirect(`/admin/orders/${order.id}`);
});

router.post('/orders/:id/note', (req, res) => {
  const order = loadOrder(req, res);
  if (!order) return;
  const note = text(req.body?.admin_note, 2000);
  db.prepare("UPDATE orders SET admin_note = ?, updated_at = datetime('now') WHERE id = ?").run(note || null, order.id);
  req.flash('success', 'Private note saved.');
  res.redirect(`/admin/orders/${order.id}#note`);
});

/* ---------------------------------------------------------------- customers */

const SPENT = `COALESCE((SELECT SUM(total) FROM orders o WHERE o.user_id = u.id AND o.payment_status = 'paid' AND o.status != 'cancelled'), 0)`;
const usr = {
  byId: db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS order_count, ${SPENT} AS spent
    FROM users u WHERE u.id = ?`),
  orders: db.prepare(`SELECT o.*, (SELECT COALESCE(SUM(quantity), 0) FROM order_items WHERE order_id = o.id) AS item_count
    FROM orders o WHERE o.user_id = ? ORDER BY o.created_at DESC, o.id DESC`),
  reviews: db.prepare(`SELECT r.*, p.title AS product_title, p.id AS product_id FROM reviews r JOIN products p ON p.id = r.product_id
    WHERE r.user_id = ? ORDER BY r.created_at DESC`),
};

router.get('/customers', (req, res) => {
  const f = { q: str(req.query.q, 100), role: ['customer', 'admin'].includes(req.query.role) ? req.query.role : '' };
  const where = [];
  const params = {};
  if (f.q) { where.push("(u.name LIKE @q ESCAPE '\\' OR u.email LIKE @q ESCAPE '\\' OR u.phone LIKE @q ESCAPE '\\')"); params.q = like(f.q); }
  if (f.role) { where.push('u.role = @role'); params.role = f.role; }
  const W = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM users u ${W}`).get(params).n;
  const pg = paginate(total, req.query.page);
  const customers = db.prepare(`SELECT u.id, u.name, u.email, u.phone, u.role, u.is_active, u.created_at, u.last_login_at, u.city, u.state,
      (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS order_count, ${SPENT} AS spent
    FROM users u ${W} ORDER BY u.created_at DESC, u.id DESC LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: pg.perPage, offset: pg.offset });
  res.render('admin/customers', {
    title: 'Customers', section: 'customers', customers, f, pg,
    filtered: Boolean(f.q || f.role),
    pageUrl: (p) => urlWith('/admin/customers', f, { page: p }),
  });
});

router.get('/customers/:id', (req, res) => {
  const person = usr.byId.get(idOf(req.params.id));
  if (!person) return notFound(res, 'customer');
  res.render('admin/customer', {
    title: person.name,
    section: 'customers',
    back: { href: '/admin/customers', label: 'All customers' },
    person,
    orders: usr.orders.all(person.id),
    reviews: usr.reviews.all(person.id),
    isSelf: person.id === req.user.id,
  });
});

router.post('/customers/:id/active', (req, res) => {
  const person = usr.byId.get(idOf(req.params.id));
  if (!person) return notFound(res, 'customer');
  if (person.id === req.user.id) {
    req.flash('error', 'You cannot deactivate your own account.');
  } else {
    const next = person.is_active ? 0 : 1;
    db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(next, person.id);
    req.flash('success', next ? `${person.name} can sign in again.` : `${person.name} has been deactivated and can no longer sign in.`);
  }
  res.redirect(backUrl(req, `/admin/customers/${person.id}`));
});

router.post('/customers/:id/role', (req, res) => {
  const person = usr.byId.get(idOf(req.params.id));
  if (!person) return notFound(res, 'customer');
  const role = req.body?.role === 'admin' ? 'admin' : 'customer';
  if (person.id === req.user.id) {
    req.flash('error', 'You cannot change your own role.');
  } else if (role !== person.role) {
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, person.id);
    req.flash('success', role === 'admin' ? `${person.name} is now an administrator.` : `${person.name} is now a customer (no admin access).`);
  }
  res.redirect(`/admin/customers/${person.id}`);
});

function passwordProblem(pw, confirm) {
  if (pw.length < 8) return 'The new password must be at least 8 characters.';
  if (Buffer.byteLength(pw) > 72) return 'The new password is too long (72 characters at most).';
  if (confirm !== undefined && pw !== confirm) return 'The two new passwords do not match.';
  return null;
}

router.post('/customers/:id/password', async (req, res) => {
  const person = usr.byId.get(idOf(req.params.id));
  if (!person) return notFound(res, 'customer');
  const pw = String(req.body?.password || '');
  const problem = passwordProblem(pw, String(req.body?.password_confirm ?? pw));
  if (problem) {
    req.flash('error', problem);
  } else {
    const hash = await bcrypt.hash(pw, 12);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, person.id);
    req.flash('success', `New password set for ${person.name}. Share it with them securely.`);
  }
  res.redirect(`/admin/customers/${person.id}#password`);
});

/* ------------------------------------------------------------------ reviews */

router.get('/reviews', (req, res) => {
  const f = { q: str(req.query.q, 100), visible: ['1', '0'].includes(req.query.visible) ? req.query.visible : '' };
  const where = [];
  const params = {};
  if (f.q) {
    where.push("(p.title LIKE @q ESCAPE '\\' OR u.name LIKE @q ESCAPE '\\' OR u.email LIKE @q ESCAPE '\\' OR r.comment LIKE @q ESCAPE '\\')");
    params.q = like(f.q);
  }
  if (f.visible) { where.push('r.is_approved = @vis'); params.vis = Number(f.visible); }
  const W = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const FROM = 'FROM reviews r JOIN products p ON p.id = r.product_id JOIN users u ON u.id = r.user_id';
  const total = db.prepare(`SELECT COUNT(*) AS n ${FROM} ${W}`).get(params).n;
  const pg = paginate(total, req.query.page);
  const reviews = db.prepare(`SELECT r.*, p.title AS product_title, p.slug AS product_slug, p.image AS product_image,
      u.name AS user_name, u.email AS user_email ${FROM} ${W} ORDER BY r.created_at DESC, r.id DESC LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: pg.perPage, offset: pg.offset });
  const stats = db.prepare('SELECT COUNT(*) AS n, ROUND(AVG(rating), 1) AS avg, COALESCE(SUM(is_approved = 0), 0) AS hidden FROM reviews').get();
  res.render('admin/reviews', {
    title: 'Reviews', section: 'reviews', reviews, f, pg, stats,
    filtered: Boolean(f.q || f.visible),
    pageUrl: (p) => urlWith('/admin/reviews', f, { page: p }),
  });
});

router.post('/reviews/:id/toggle', (req, res) => {
  const review = db.prepare('SELECT * FROM reviews WHERE id = ?').get(idOf(req.params.id));
  if (!review) return notFound(res, 'review');
  db.prepare('UPDATE reviews SET is_approved = ? WHERE id = ?').run(review.is_approved ? 0 : 1, review.id);
  req.flash('success', review.is_approved ? 'Review hidden from the store.' : 'Review is visible on the store again.');
  res.redirect(backUrl(req, '/admin/reviews'));
});

router.post('/reviews/:id/delete', (req, res) => {
  const { changes } = db.prepare('DELETE FROM reviews WHERE id = ?').run(idOf(req.params.id));
  if (!changes) return notFound(res, 'review');
  req.flash('success', 'Review deleted.');
  res.redirect(backUrl(req, '/admin/reviews'));
});

/* ----------------------------------------------------------------- messages */

router.get('/messages', (req, res) => {
  const f = { q: str(req.query.q, 100), show: req.query.show === 'unread' ? 'unread' : '' };
  const where = [];
  const params = {};
  if (f.show) where.push('is_read = 0');
  if (f.q) {
    where.push("(name LIKE @q ESCAPE '\\' OR email LIKE @q ESCAPE '\\' OR subject LIKE @q ESCAPE '\\' OR message LIKE @q ESCAPE '\\')");
    params.q = like(f.q);
  }
  const W = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM messages ${W}`).get(params).n;
  const pg = paginate(total, req.query.page);
  const messages = db.prepare(`SELECT * FROM messages ${W} ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: pg.perPage, offset: pg.offset });
  const all = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
  res.render('admin/messages', {
    title: 'Messages', section: 'messages', messages, f, pg, all,
    filtered: Boolean(f.q),
    pageUrl: (p) => urlWith('/admin/messages', f, { page: p }),
    open: idOf(req.query.open),
  });
});

router.post('/messages/:id/read', (req, res) => {
  const msg = db.prepare('SELECT id FROM messages WHERE id = ?').get(idOf(req.params.id));
  if (!msg) {
    if (req.xhr) return res.status(404).json({ ok: false });
    return notFound(res, 'message');
  }
  const read = req.body?.read === '0' ? 0 : 1;
  db.prepare('UPDATE messages SET is_read = ? WHERE id = ?').run(read, msg.id);
  if (req.xhr) return res.json({ ok: true, read, unread: navCounts.get().unread });
  req.flash('success', read ? 'Marked as read.' : 'Marked as unread.');
  res.redirect(backUrl(req, '/admin/messages'));
});

router.post('/messages/:id/delete', (req, res) => {
  const { changes } = db.prepare('DELETE FROM messages WHERE id = ?').run(idOf(req.params.id));
  if (!changes) return notFound(res, 'message');
  req.flash('success', 'Message deleted.');
  res.redirect(backUrl(req, '/admin/messages'));
});

/* -------------------------------------------------------------- subscribers */

function subscriberFilter(query) {
  const f = { q: str(query.q, 100) };
  return f.q
    ? { f, W: "WHERE email LIKE @q ESCAPE '\\'", params: { q: like(f.q) } }
    : { f, W: '', params: {} };
}

router.get('/subscribers', (req, res) => {
  const { f, W, params } = subscriberFilter(req.query);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM subscribers ${W}`).get(params).n;
  const pg = paginate(total, req.query.page, 50);
  const subscribers = db.prepare(`SELECT * FROM subscribers ${W} ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: pg.perPage, offset: pg.offset });
  const all = db.prepare('SELECT COUNT(*) AS n FROM subscribers').get().n;
  res.render('admin/subscribers', {
    title: 'Subscribers', section: 'subscribers', subscribers, f, pg, all,
    filtered: Boolean(f.q),
    pageUrl: (p) => urlWith('/admin/subscribers', f, { page: p }),
    exportUrl: urlWith('/admin/subscribers/export.csv', f),
  });
});

router.get('/subscribers/export.csv', (req, res) => {
  const { W, params } = subscriberFilter(req.query);
  const rows = db.prepare(`SELECT email, strftime('%Y-%m-%d %H:%M', created_at, '+330 minutes') AS joined
    FROM subscribers ${W} ORDER BY created_at DESC, id DESC`).all(params);
  const stamp = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  sendCsv(res, `amritakalakriti-subscribers-${stamp}.csv`, [['Email', 'Subscribed (IST)'], ...rows.map((r) => [r.email, r.joined])]);
});

router.post('/subscribers/:id/delete', (req, res) => {
  const { changes } = db.prepare('DELETE FROM subscribers WHERE id = ?').run(idOf(req.params.id));
  if (!changes) return notFound(res, 'subscriber');
  req.flash('success', 'Subscriber removed.');
  res.redirect(backUrl(req, '/admin/subscribers'));
});

/* -------------------------------------------------------------------- pages */

const pageUrlFor = (slug) => (slug === 'about' ? '/about' : `/pages/${slug}`);
const pageBySlug = db.prepare('SELECT * FROM pages WHERE slug = ?');

router.get('/pages', (req, res) => {
  const pages = db.prepare('SELECT slug, title, updated_at, body FROM pages ORDER BY title').all()
    .map(({ body, ...p }) => ({ ...p, words: (body.match(/\S+/g) || []).length }));
  res.render('admin/pages', { title: 'Pages', section: 'pages', pages, pageUrlFor });
});

router.get('/pages/:slug/edit', (req, res) => {
  const page = pageBySlug.get(String(req.params.slug));
  if (!page) return notFound(res, 'page');
  res.render('admin/page-form', {
    title: `Edit · ${page.title}`, section: 'pages', back: { href: '/admin/pages', label: 'All pages' },
    page, form: page, errors: {}, publicUrl: pageUrlFor(page.slug),
  });
});

router.post('/pages/:slug', (req, res) => {
  const page = pageBySlug.get(String(req.params.slug));
  if (!page) return notFound(res, 'page');
  const form = { title: str(req.body?.title, 150), body: text(req.body?.body, 60000) };
  const errors = {};
  if (!form.title) errors.title = 'The page needs a title.';
  if (Object.keys(errors).length) {
    return res.status(422).render('admin/page-form', {
      title: `Edit · ${page.title}`, section: 'pages', back: { href: '/admin/pages', label: 'All pages' },
      page, form, errors, publicUrl: pageUrlFor(page.slug),
    });
  }
  db.prepare("UPDATE pages SET title = ?, body = ?, updated_at = datetime('now') WHERE slug = ?").run(form.title, form.body, page.slug);
  req.flash('success', `“${form.title}” saved and live on the store.`);
  res.redirect(`/admin/pages/${encodeURIComponent(page.slug)}/edit`);
});

/* ----------------------------------------------------------------- settings */

// Every editable key, with how to validate it. Grouped for display in views/admin/settings.ejs.
const SETTING_RULES = {
  store_name: { max: 80, required: true },
  store_tagline: { max: 160 },
  store_email: { max: 120, email: true, required: true },
  store_phone: { max: 40 },
  store_whatsapp: { max: 20, digits: true },
  store_address: { max: 500, multiline: true },
  gstin: { max: 15, gstin: true },
  announcement: { max: 240 },
  hero_title: { max: 140 },
  hero_subtitle: { max: 500, multiline: true },
  hero_art_main: { max: 100, artwork: true },
  hero_art_round: { max: 100, artwork: true },
  hero_art_card: { max: 100, artwork: true },
  about_short: { max: 2000, multiline: true },
  shipping_fee: { int: true },
  free_shipping_min: { int: true },
  upi_enabled: { bool: true },
  upi_id: { max: 100, upi: true },
  upi_payee_name: { max: 50 },
  cod_enabled: { bool: true },
  online_payments_enabled: { bool: true },
  instagram_url: { url: true },
  facebook_url: { url: true },
  youtube_url: { url: true },
};
for (const key of Object.keys(DEFAULT_SETTINGS)) if (!SETTING_RULES[key]) SETTING_RULES[key] = { max: 500 };

function renderSettings(res, { form, errors = {}, pwErrors = {}, rzpErrors = {}, rzpKeyId, status = 200 }) {
  const k = payments.keys();
  res.status(status).render('admin/settings', {
    title: 'Settings', section: 'settings', form, errors, pwErrors, rzpErrors,
    razorpay: {
      live: payments.isConfigured(),
      demo: payments.demoMode(),
      test: payments.testMode(),
      fromEnv: k.source === 'env',
      keyId: rzpKeyId ?? k.keyId, // the Key ID is public (every checkout page carries it); the secrets are never shown
      hasSecret: Boolean(k.keySecret),
      webhook: Boolean(k.webhookSecret),
      webhookUrl: `${config.baseUrl}/webhooks/razorpay`,
    },
    heroChoices: heroChoices.all(),
    extraKeys: Object.keys(DEFAULT_SETTINGS).filter((k) => !SETTING_GROUPED.has(k)),
  });
}
// Artworks that can be pinned to a homepage hero frame (they need a photo).
const heroChoices = db.prepare('SELECT slug, title FROM products WHERE is_active = 1 AND image IS NOT NULL ORDER BY title COLLATE NOCASE');
const SETTING_GROUPED = new Set(['store_name', 'store_tagline', 'store_email', 'store_phone', 'store_whatsapp', 'store_address', 'gstin',
  'announcement', 'hero_title', 'hero_subtitle', 'hero_art_main', 'hero_art_round', 'hero_art_card', 'about_short', 'shipping_fee', 'free_shipping_min', 'cod_enabled',
  'online_payments_enabled', 'upi_enabled', 'upi_id', 'upi_payee_name', 'instagram_url', 'facebook_url', 'youtube_url']);

router.get('/settings', (req, res) => {
  renderSettings(res, { form: { ...res.locals.settings } });
});

router.post('/settings', (req, res) => {
  const b = req.body || {};
  const form = {};
  const errors = {};
  for (const [key, rule] of Object.entries(SETTING_RULES)) {
    if (rule.bool) { form[key] = checked(b[key]) ? '1' : '0'; continue; }
    let v = rule.multiline ? text(b[key], rule.max || 500) : str(b[key], rule.max || 500);
    if (rule.int) {
      const n = wholeRupees(v);
      if (!Number.isInteger(n)) errors[key] = 'Enter a whole number of rupees (0 or more).';
      else v = String(n);
    }
    if (rule.required && !v) errors[key] = 'This is required.';
    else if (rule.email && v && !isEmail(v)) errors[key] = 'Enter a valid email address.';
    else if (rule.digits && v && !/^\d{10,15}$/.test(v.replace(/[\s+-]/g, ''))) errors[key] = 'Digits only, with country code — e.g. 919876543210.';
    else if (rule.url && v && !/^https?:\/\/\S+$/i.test(v)) errors[key] = 'Use a full link starting with https://';
    else if (rule.gstin && v && !/^[0-9]{2}[A-Z0-9]{13}$/.test(v.toUpperCase())) errors[key] = 'A GSTIN is 15 characters, e.g. 21ABCDE1234F1Z5 — or leave blank.';
    else if (rule.upi && v && !upi.isValidId(v)) errors[key] = 'A UPI ID looks like name@bank, e.g. amritakalakriti@ybl — or leave blank.';
    else if (rule.artwork && v && !heroChoices.all().some((a) => a.slug === v)) errors[key] = 'Choose an artwork from the list, or Automatic.';
    if (rule.digits) v = v.replace(/[\s+-]/g, '');
    if (rule.gstin) v = v.toUpperCase();
    form[key] = v;
  }
  // UPI is only offered once it has a UPI ID, and Razorpay only with keys (or demo mode, outside production).
  const razorpayUsable = payments.isConfigured() || payments.demoMode();
  if (form.cod_enabled === '0' && !upi.isEnabled(form) && !(form.online_payments_enabled === '1' && razorpayUsable)) {
    errors.payments = 'Keep at least one payment method switched on, or customers cannot check out.';
  }
  if (Object.keys(errors).length) return renderSettings(res, { form, errors, status: 422 });
  db.transaction(() => { for (const [k, v] of Object.entries(form)) setSetting(k, v); })();
  req.flash('success', 'Settings saved. The storefront is already showing the changes.');
  res.redirect('/admin/settings');
});

// Razorpay keys get their own form so the secrets are not sent back with every settings save. A blank secret
// field keeps the saved one. Keys are tried against Razorpay before they are stored.
const RAZORPAY_KEY_ID = /^rzp_(test|live)_[A-Za-z0-9]{8,32}$/;
router.post('/settings/razorpay', async (req, res) => {
  const b = req.body || {};
  if (payments.keys().source === 'env') {
    req.flash('error', 'Razorpay keys are set in the server’s .env file, so they can only be changed there.');
    return res.redirect('/admin/settings#razorpay');
  }
  const pendingOrders = db.prepare(`UPDATE orders SET razorpay_order_id = NULL
    WHERE payment_method = 'razorpay' AND status = 'pending' AND payment_status != 'paid'`);
  if (b.action === 'disconnect') {
    db.transaction(() => {
      for (const key of ['razorpay_key_id', 'razorpay_key_secret', 'razorpay_webhook_secret']) setSetting(key, '');
    })();
    req.flash('success', 'Razorpay disconnected. Customers can no longer choose it at checkout.');
    return res.redirect('/admin/settings#razorpay');
  }
  const keyId = str(b.razorpay_key_id, 60);
  const keySecret = str(b.razorpay_key_secret, 100) || getSecret('razorpay_key_secret');
  const webhookSecret = str(b.razorpay_webhook_secret, 200) || getSecret('razorpay_webhook_secret');
  const rzpErrors = {};
  if (!RAZORPAY_KEY_ID.test(keyId)) rzpErrors.razorpay_key_id = 'Paste the Key ID from Razorpay — it starts with rzp_test_ or rzp_live_.';
  if (!keySecret) rzpErrors.razorpay_key_secret = 'Paste the Key Secret Razorpay showed when you generated the key.';
  if (!Object.keys(rzpErrors).length) {
    const problem = await payments.checkKeys(keyId, keySecret);
    if (problem) rzpErrors.razorpay_key_secret = problem;
  }
  if (Object.keys(rzpErrors).length) {
    return renderSettings(res, { form: { ...res.locals.settings }, rzpErrors, rzpKeyId: keyId, status: 422 });
  }
  const switched = keyId !== payments.keys().keyId;
  db.transaction(() => {
    setSetting('razorpay_key_id', keyId);
    setSetting('razorpay_key_secret', keySecret);
    setSetting('razorpay_webhook_secret', webhookSecret);
    // Razorpay orders belong to one account: unpaid checkouts start a fresh one under the new keys.
    if (switched) pendingOrders.run();
  })();
  const test = keyId.startsWith('rzp_test_');
  req.flash('success', [
    `Razorpay connected with ${test ? 'TEST' : 'LIVE'} keys.`,
    test ? 'Place a test order to try it — no real money moves. Switch to live keys before launch.' : 'Customers can now pay by card, UPI, net banking and wallets.',
    webhookSecret ? '' : 'Next, add the webhook below so payments are confirmed even when a customer closes the page early.',
  ].filter(Boolean).join(' '));
  res.redirect('/admin/settings#razorpay');
});

router.post('/settings/password', async (req, res) => {
  const b = req.body || {};
  const current = String(b.current_password || '');
  const pw = String(b.new_password || '');
  const pwErrors = {};
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!current || !row || !(await bcrypt.compare(current, row.password_hash))) pwErrors.current_password = 'That is not your current password.';
  const problem = passwordProblem(pw, String(b.confirm_password || ''));
  if (problem) pwErrors[problem.includes('match') ? 'confirm_password' : 'new_password'] = problem;
  if (Object.keys(pwErrors).length) {
    return renderSettings(res, { form: { ...res.locals.settings }, pwErrors, status: 422 });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await bcrypt.hash(pw, 12), req.user.id);
  req.flash('success', 'Your password has been changed.');
  res.redirect('/admin/settings#password');
});

/* ---------------------------------------------------------------- not found */

router.use((req, res) => notFound(res));

module.exports = router;
