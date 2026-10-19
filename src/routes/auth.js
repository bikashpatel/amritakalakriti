'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { rateLimit, safeLocalPath } = require('../middleware');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const perAccount = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, key: (req) => `${req.ip}|${String(req.body?.email || '').toLowerCase()}` });
const perIp = rateLimit({ windowMs: 15 * 60 * 1000, max: 40 });
const authLimiter = [perIp, perAccount];
// Compared against when the email is unknown, so response time does not reveal which emails have accounts.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

// Starts a fresh session (prevents session fixation) while keeping the visitor's cart.
function signIn(req, user) {
  const { cart, returnTo } = req.session;
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = user.id;
      if (cart) req.session.cart = cart;
      db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
      resolve(safeLocalPath(returnTo, user.role === 'admin' ? '/admin' : '/account'));
    });
  });
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(req.user.role === 'admin' ? '/admin' : '/account');
  if (req.query.next) req.session.returnTo = safeLocalPath(req.query.next);
  res.render('auth/login', { title: 'Sign in', form: {} });
});

router.post('/login', authLimiter, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const matches = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !matches) {
    return res.status(401).render('auth/login', { title: 'Sign in', form: { email }, errors: ['That email and password do not match our records.'] });
  }
  if (!user.is_active) {
    return res.status(403).render('auth/login', { title: 'Sign in', form: { email }, errors: ['This account has been disabled. Please contact us for help.'] });
  }
  const to = await signIn(req, user);
  req.flash('success', `Welcome back, ${user.name.split(' ')[0]}!`);
  res.redirect(to);
});

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/account');
  res.render('auth/register', { title: 'Create your account', form: {} });
});

router.post('/register', authLimiter, async (req, res) => {
  const form = {
    name: String(req.body.name || '').trim().slice(0, 80),
    email: String(req.body.email || '').trim().toLowerCase().slice(0, 160),
    phone: String(req.body.phone || '').replace(/[^\d+]/g, '').slice(0, 15),
  };
  const password = String(req.body.password || '');
  const errors = [];
  if (form.name.length < 2) errors.push('Please enter your full name.');
  if (!EMAIL_RE.test(form.email)) errors.push('Please enter a valid email address.');
  if (form.phone && !/^(\+91)?[6-9]\d{9}$/.test(form.phone)) errors.push('Please enter a valid 10-digit Indian mobile number.');
  if (password.length < 8) errors.push('Your password needs at least 8 characters.');
  if (password !== String(req.body.password_confirm || '')) errors.push('The two passwords do not match.');
  if (!errors.length && db.prepare('SELECT 1 FROM users WHERE email = ?').get(form.email)) {
    errors.push('An account with this email already exists. Try signing in instead.');
  }
  if (errors.length) return res.status(422).render('auth/register', { title: 'Create your account', form, errors });

  const hash = await bcrypt.hash(password, 12);
  const { lastInsertRowid } = db.prepare('INSERT INTO users (name, email, phone, password_hash) VALUES (?, ?, ?, ?)')
    .run(form.name, form.email, form.phone || null, hash);
  const to = await signIn(req, { id: Number(lastInsertRowid), role: 'customer' });
  req.flash('success', `Welcome to AmritaKalakriti, ${form.name.split(' ')[0]}!`);
  res.redirect(to === '/account' ? '/shop' : to);
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('ak.sid');
    res.redirect('/');
  });
});

module.exports = router;
