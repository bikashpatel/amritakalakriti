'use strict';
const express = require('express');
const { db } = require('../db');
const config = require('../config');
const { renderText, toInt, escapeHtml } = require('../helpers');
const { requireAuth, rateLimit, backUrl } = require('../middleware');

const router = express.Router();

const PRODUCT_SELECT = `SELECT p.*, c.name AS category_name, c.slug AS category_slug
  FROM products p LEFT JOIN categories c ON c.id = p.category_id`;
const VISIBLE = 'p.is_active = 1 AND (c.id IS NULL OR c.is_active = 1)';

const PRICE_BANDS = [
  { key: 'under-2000', label: 'Under ₹2,000', min: 0, max: 1999 },
  { key: '2000-5000', label: '₹2,000 – ₹5,000', min: 2000, max: 5000 },
  { key: '5000-10000', label: '₹5,000 – ₹10,000', min: 5001, max: 10000 },
  { key: 'above-10000', label: 'Above ₹10,000', min: 10001, max: null },
];
const SORTS = {
  featured: { label: 'Featured', sql: 'p.is_featured DESC, (p.stock > 0) DESC, p.created_at DESC, p.id DESC' },
  newest: { label: 'Newest first', sql: 'p.created_at DESC, p.id DESC' },
  price_asc: { label: 'Price: low to high', sql: 'p.price ASC' },
  price_desc: { label: 'Price: high to low', sql: 'p.price DESC' },
  popular: { label: 'Most viewed', sql: 'p.views DESC, p.id DESC' },
};
const PER_PAGE = 12;

router.get('/', (req, res) => {
  const featured = db.prepare(`${PRODUCT_SELECT} WHERE ${VISIBLE} AND p.is_featured = 1
    ORDER BY (p.stock > 0) DESC, p.created_at DESC, p.id DESC LIMIT 8`).all();
  const newest = db.prepare(`${PRODUCT_SELECT} WHERE ${VISIBLE} AND p.stock > 0
    ORDER BY p.created_at DESC, p.id DESC LIMIT 4`).all();
  const heroArt = db.prepare(`${PRODUCT_SELECT} WHERE ${VISIBLE} AND p.is_featured = 1 AND p.image IS NOT NULL
    ORDER BY p.price DESC LIMIT 3`).all();
  const counts = db.prepare(`SELECT COUNT(*) AS artworks, COUNT(DISTINCT category_id) AS forms FROM products WHERE is_active = 1`).get();
  res.render('shop/home', { featured, newest, heroArt, counts });
});

function listProducts(req, res, category) {
  const where = [VISIBLE];
  const params = {};
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (category) { where.push('p.category_id = @categoryId'); params.categoryId = category.id; }
  if (q) {
    where.push('(p.title LIKE @q OR p.short_description LIKE @q OR p.medium LIKE @q OR c.name LIKE @q OR p.sku LIKE @q)');
    params.q = `%${q.replace(/[%_]/g, '')}%`;
  }
  const band = PRICE_BANDS.find((b) => b.key === req.query.price);
  if (band) {
    where.push('p.price >= @min'); params.min = band.min;
    if (band.max != null) { where.push('p.price <= @max'); params.max = band.max; }
  }
  const inStock = req.query.available === '1';
  if (inStock) where.push('p.stock > 0');
  const sortKey = SORTS[req.query.sort] ? req.query.sort : 'featured';

  const whereSql = where.join(' AND ');
  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE ${whereSql}`).get(params);
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const page = Math.min(Math.max(1, toInt(req.query.page, 1)), pages);
  const products = db.prepare(`${PRODUCT_SELECT} WHERE ${whereSql} ORDER BY ${SORTS[sortKey].sql} LIMIT ${PER_PAGE} OFFSET ${(page - 1) * PER_PAGE}`).all(params);

  // Builds a URL that keeps the current filters but changes some of them.
  const base = category ? `/shop/${category.slug}` : '/shop';
  const urlWith = (changes) => {
    const next = { q: q || undefined, price: band?.key, available: inStock ? '1' : undefined, sort: sortKey !== 'featured' ? sortKey : undefined, page: undefined, ...changes };
    const qs = new URLSearchParams(Object.entries(next).filter(([, v]) => v !== undefined && v !== '' && v !== null)).toString();
    return qs ? `${base}?${qs}` : base;
  };

  res.render('shop/list', {
    title: category ? category.name : q ? `Search: ${q}` : 'Shop all artworks',
    metaDescription: category?.description || undefined,
    category, products, total, page, pages, q, band, inStock, sortKey, SORTS, PRICE_BANDS, urlWith,
  });
}

router.get('/shop', (req, res) => {
  if (req.query.category) return res.redirect(301, `/shop/${encodeURIComponent(req.query.category)}`);
  listProducts(req, res, null);
});

router.get('/shop/:slug', (req, res, next) => {
  const category = db.prepare('SELECT * FROM categories WHERE slug = ? AND is_active = 1').get(req.params.slug);
  if (!category) return next();
  listProducts(req, res, category);
});

router.get('/art/:slug', (req, res, next) => {
  const product = db.prepare(`${PRODUCT_SELECT} WHERE p.slug = ? AND ${VISIBLE}`).get(req.params.slug);
  if (!product) return next();
  db.prepare('UPDATE products SET views = views + 1 WHERE id = ?').run(product.id);

  const gallery = [product.image, ...db.prepare('SELECT path FROM product_images WHERE product_id = ? ORDER BY sort_order, id').all(product.id).map((r) => r.path)]
    .filter((v, i, a) => v && a.indexOf(v) === i);
  const reviews = db.prepare(`SELECT r.*, u.name AS user_name,
      EXISTS (SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id
              WHERE oi.product_id = r.product_id AND o.user_id = r.user_id AND o.payment_status = 'paid') AS verified
    FROM reviews r JOIN users u ON u.id = r.user_id
    WHERE r.product_id = ? AND r.is_approved = 1 ORDER BY r.created_at DESC`).all(product.id);
  const rating = reviews.length ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length : 0;
  const myReview = req.user ? db.prepare('SELECT * FROM reviews WHERE product_id = ? AND user_id = ?').get(product.id, req.user.id) : null;
  let related = db.prepare(`${PRODUCT_SELECT} WHERE ${VISIBLE} AND p.category_id IS ? AND p.id != ? ORDER BY (p.stock > 0) DESC, RANDOM() LIMIT 4`)
    .all(product.category_id, product.id);
  if (related.length < 4) {
    const ids = [product.id, ...related.map((r) => r.id)];
    related = related.concat(db.prepare(`${PRODUCT_SELECT} WHERE ${VISIBLE} AND p.stock > 0 AND p.id NOT IN (${ids.map(() => '?').join(',')})
      ORDER BY p.is_featured DESC, RANDOM() LIMIT ?`).all(...ids, 4 - related.length));
  }
  const inCart = (req.session.cart || {})[product.id] || 0;

  res.render('shop/product', {
    title: product.title,
    metaDescription: product.short_description,
    ogImage: product.image,
    product, gallery, reviews, rating, myReview, related, inCart,
  });
});

router.post('/art/:slug/review', requireAuth, (req, res, next) => {
  const product = db.prepare('SELECT id, slug FROM products WHERE slug = ? AND is_active = 1').get(req.params.slug);
  if (!product) return next();
  const rating = toInt(req.body.rating, 0);
  const comment = String(req.body.comment || '').trim().slice(0, 1200);
  if (rating < 1 || rating > 5) {
    req.flash('error', 'Please choose a star rating.');
  } else {
    db.prepare(`INSERT INTO reviews (product_id, user_id, rating, comment) VALUES (?, ?, ?, ?)
                ON CONFLICT(product_id, user_id) DO UPDATE SET rating = excluded.rating, comment = excluded.comment, created_at = datetime('now')`)
      .run(product.id, req.user.id, rating, comment || null);
    req.flash('success', 'Thank you — your review has been saved.');
  }
  res.redirect(`/art/${product.slug}#reviews`);
});

function renderPage(slug, view) {
  return (req, res, next) => {
    const page = db.prepare('SELECT * FROM pages WHERE slug = ?').get(slug || req.params.slug);
    if (!page) return next();
    res.render(view, { title: page.title, page, html: renderText(page.body) });
  };
}
router.get('/about', renderPage('about', 'pages/about'));
router.get('/pages/about', (req, res) => res.redirect(301, '/about'));
router.get('/pages/:slug', renderPage(null, 'pages/page'));

router.get('/contact', (req, res) => {
  res.render('pages/contact', { title: 'Contact us', form: { subject: req.query.subject || '' } });
});

router.post('/contact', rateLimit({ windowMs: 15 * 60 * 1000, max: 5 }), (req, res) => {
  const form = {
    name: String(req.body.name || '').trim().slice(0, 100),
    email: String(req.body.email || '').trim().slice(0, 160),
    phone: String(req.body.phone || '').trim().slice(0, 20),
    subject: String(req.body.subject || '').trim().slice(0, 160),
    message: String(req.body.message || '').trim().slice(0, 4000),
  };
  const errors = [];
  if (form.name.length < 2) errors.push('Please tell us your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) errors.push('Please enter a valid email address.');
  if (form.message.length < 10) errors.push('Please write a slightly longer message.');
  if (String(req.body.website || '')) errors.push('Spam check failed.'); // honeypot field
  if (errors.length) {
    return res.status(422).render('pages/contact', { title: 'Contact us', form, errors });
  }
  db.prepare('INSERT INTO messages (name, email, phone, subject, message) VALUES (?, ?, ?, ?, ?)')
    .run(form.name, form.email, form.phone || null, form.subject || null, form.message);
  req.flash('success', 'Thank you for writing to us! We usually reply within one working day.');
  res.redirect('/contact');
});

router.post('/subscribe', rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }), (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 160);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    req.flash('error', 'Please enter a valid email address.');
  } else {
    db.prepare('INSERT OR IGNORE INTO subscribers (email) VALUES (?)').run(email);
    req.flash('success', 'Welcome to our circle! Look out for our next letter.');
  }
  res.redirect(backUrl(req));
});

router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nDisallow: /admin\nDisallow: /account\nDisallow: /checkout\nDisallow: /cart\n\nSitemap: ${config.baseUrl}/sitemap.xml\n`);
});

router.get('/sitemap.xml', (req, res) => {
  const urls = ['/', '/shop', '/about', '/contact'];
  db.prepare('SELECT slug FROM categories WHERE is_active = 1').all().forEach((c) => urls.push(`/shop/${c.slug}`));
  db.prepare("SELECT slug FROM pages WHERE slug != 'about'").all().forEach((p) => urls.push(`/pages/${p.slug}`));
  const products = db.prepare('SELECT slug, updated_at FROM products WHERE is_active = 1').all();
  const loc = (u) => escapeHtml(config.baseUrl + u);
  const xml = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((u) => `<url><loc>${loc(u)}</loc></url>`),
    ...products.map((p) => `<url><loc>${loc(`/art/${p.slug}`)}</loc><lastmod>${String(p.updated_at).slice(0, 10)}</lastmod></url>`),
    '</urlset>'].join('\n');
  res.type('application/xml').send(xml);
});

module.exports = router;
