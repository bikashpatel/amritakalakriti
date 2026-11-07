'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { db, getSettings } = require('./db');
const helpers = require('./helpers');
const payments = require('./payments');
const upi = require('./upi');

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' https://checkout.razorpay.com https://*.razorpay.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    "connect-src 'self' https://*.razorpay.com",
    "frame-src https://*.razorpay.com",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; '));
  next();
}

// Flash messages: req.flash('success' | 'error' | 'info', text) shows once on the next rendered page.
function flash(req, res, next) {
  req.flash = (type, text) => {
    req.session.flash = req.session.flash || [];
    req.session.flash.push({ type, text });
  };
  res.locals.flash = req.session.flash || [];
  delete req.session.flash;
  next();
}

// Short hash of the CSS/JS bundle, appended as ?v= so browsers and Cloudflare fetch fresh files after each deploy.
const assetVersion = (() => {
  const hash = crypto.createHash('sha1');
  for (const dir of ['css', 'js']) {
    const full = path.join(config.ROOT, 'public', dir);
    for (const f of fs.readdirSync(full).sort()) hash.update(fs.readFileSync(path.join(full, f)));
  }
  return hash.digest('hex').slice(0, 10);
})();

const loadUser = db.prepare(`SELECT id, name, email, phone, role, is_active, address_line1, address_line2, city, state, pincode
                             FROM users WHERE id = ?`);

function currentUser(req, res, next) {
  req.user = null;
  if (req.session.userId) {
    const user = loadUser.get(req.session.userId);
    if (user && user.is_active) req.user = user;
    else delete req.session.userId;
  }
  next();
}

const activeCategories = db.prepare(`SELECT c.id, c.name, c.slug, c.image,
  (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.is_active = 1) AS product_count
  FROM categories c WHERE c.is_active = 1 ORDER BY c.sort_order, c.name`);
const wishlistIds = db.prepare('SELECT product_id FROM wishlist WHERE user_id = ?');

function locals(req, res, next) {
  const cart = req.session?.cart || {};
  res.locals.user = req.user;
  res.locals.settings = getSettings();
  res.locals.navCategories = activeCategories.all();
  res.locals.cartCount = Object.values(cart).reduce((a, b) => a + b, 0);
  res.locals.wishlistIds = new Set(req.user ? wishlistIds.all(req.user.id).map((r) => r.product_id) : []);
  res.locals.currentPath = req.path;
  res.locals.query = req.query;
  res.locals.paymentsLive = payments.isConfigured();
  res.locals.paymentsDemo = payments.demoMode();
  res.locals.paymentsTest = payments.testMode();
  res.locals.upiReady = upi.isEnabled(res.locals.settings);
  res.locals.h = helpers;
  res.locals.formatINR = helpers.formatINR;
  res.locals.baseUrl = config.baseUrl;
  res.locals.assetVersion = assetVersion;
  res.locals.title = '';
  res.locals.metaDescription = '';
  next();
}

// CSRF: one random token per session, required on every state-changing request.
function csrfToken(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrfToken = req.session.csrf;
  next();
}

function tokenMatches(req) {
  const sent = (req.body && req.body._csrf) || req.get('x-csrf-token') || '';
  const expected = req.session.csrf || '';
  return sent.length === expected.length && expected.length > 0 &&
    crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected));
}

// Global check. Multipart forms are parsed later by multer, so those routes call requireCsrf themselves.
function csrfProtect(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.is('multipart/form-data')) return next();
  return requireCsrf(req, res, next);
}

function requireCsrf(req, res, next) {
  if (tokenMatches(req)) return next();
  res.status(403);
  if (req.xhr || req.accepts(['html', 'json']) === 'json') return res.json({ ok: false, error: 'Session expired. Please refresh the page.' });
  return res.render('pages/error', { title: 'Session expired', code: 403, message: 'Your session expired. Please go back, refresh the page and try again.' });
}

function requireAuth(req, res, next) {
  if (req.user) return next();
  if (req.method === 'GET') req.session.returnTo = req.originalUrl;
  req.flash('info', 'Please sign in to continue.');
  return res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  if (!req.user) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  return res.status(403).render('pages/error', { title: 'Not allowed', code: 403, message: 'This area is for store administrators only.' });
}

// The visitor's address: Cloudflare's CF-Connecting-IP when the app sits behind Cloudflare, else req.ip.
function clientIp(req) {
  return (config.behindCloudflare && req.get('cf-connecting-ip')) || req.ip;
}

// Small in-memory limiter for login / register / contact forms.
function rateLimit({ windowMs, max, key = clientIp }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    if (req.method !== 'POST') return next();
    const k = key(req);
    const now = Date.now();
    const entry = hits.get(k) || { count: 0, reset: now + windowMs };
    if (entry.reset < now) { entry.count = 0; entry.reset = now + windowMs; }
    entry.count += 1;
    hits.set(k, entry);
    if (entry.count > max) {
      req.flash('error', 'Too many attempts. Please wait a few minutes and try again.');
      return res.redirect(backUrl(req));
    }
    next();
  };
}

// The Referer path if it points at this site, otherwise the fallback. Avoids open redirects.
function backUrl(req, fallback = '/') {
  try {
    const ref = new URL(req.get('Referer') || '', `${req.protocol}://${req.get('host')}`);
    if (ref.host === req.get('host')) return ref.pathname + ref.search;
  } catch { /* ignore malformed referers */ }
  return fallback;
}

// Only allow local paths for ?next= style redirects.
function safeLocalPath(p, fallback = '/') {
  return typeof p === 'string' && /^\/(?![/\\])/.test(p) ? p : fallback;
}

module.exports = {
  securityHeaders, flash, currentUser, locals, csrfToken, csrfProtect, requireCsrf, requireAuth, requireAdmin, rateLimit,
  backUrl, safeLocalPath, clientIp,
};
