'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
const db = new Database(config.dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// 'verifying' = the customer paid by direct UPI and sent the reference number (upi_ref); the store checks it arrived.
const ORDERS_COLUMNS = `
  id                  INTEGER PRIMARY KEY,
  order_number        TEXT NOT NULL UNIQUE,
  user_id             INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','verifying','confirmed','processing','shipped','delivered','cancelled')),
  payment_method      TEXT NOT NULL CHECK (payment_method IN ('upi','razorpay','demo','cod')),
  payment_status      TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','paid','failed','refunded')),
  razorpay_order_id   TEXT,
  razorpay_payment_id TEXT,
  upi_ref             TEXT,
  subtotal            INTEGER NOT NULL,
  shipping            INTEGER NOT NULL DEFAULT 0,
  total               INTEGER NOT NULL,
  ship_name TEXT NOT NULL, ship_phone TEXT NOT NULL, ship_email TEXT NOT NULL,
  ship_line1 TEXT NOT NULL, ship_line2 TEXT, ship_city TEXT NOT NULL, ship_state TEXT NOT NULL, ship_pincode TEXT NOT NULL,
  customer_note       TEXT,
  admin_note          TEXT,
  courier             TEXT,
  tracking_number     TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
`;

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone         TEXT,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','admin')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  address_line1 TEXT, address_line2 TEXT, city TEXT, state TEXT, pincode TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  tagline     TEXT,
  description TEXT,
  image       TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id                INTEGER PRIMARY KEY,
  category_id       INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  title             TEXT NOT NULL,
  slug              TEXT NOT NULL UNIQUE,
  short_description TEXT,
  description       TEXT,
  artist            TEXT,
  medium            TEXT,
  dimensions        TEXT,
  year              TEXT,
  sku               TEXT,
  price             INTEGER NOT NULL CHECK (price >= 0),          -- whole rupees
  compare_at_price  INTEGER,                                        -- optional "was" price
  stock             INTEGER NOT NULL DEFAULT 1 CHECK (stock >= 0),
  image             TEXT,                                           -- main image path
  is_featured       INTEGER NOT NULL DEFAULT 0,
  is_active         INTEGER NOT NULL DEFAULT 1,
  views             INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);

CREATE TABLE IF NOT EXISTS product_images (
  id         INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (${ORDERS_COLUMNS});

CREATE TABLE IF NOT EXISTS order_items (
  id         INTEGER PRIMARY KEY,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  title      TEXT NOT NULL,
  image      TEXT,
  price      INTEGER NOT NULL,
  quantity   INTEGER NOT NULL CHECK (quantity > 0)
);

CREATE TABLE IF NOT EXISTS order_history (
  id         INTEGER PRIMARY KEY,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status     TEXT NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS wishlist (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, product_id)
);

CREATE TABLE IF NOT EXISTS reviews (
  id          INTEGER PRIMARY KEY,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating      INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     TEXT,
  is_approved INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (product_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  phone      TEXT,
  subject    TEXT,
  message    TEXT NOT NULL,
  is_read    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subscribers (
  id         INTEGER PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pages (
  slug       TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  sid     TEXT PRIMARY KEY,
  sess    TEXT NOT NULL,
  expires INTEGER NOT NULL
);
`);

// Stores created before UPI payments have older CHECK constraints on orders, which SQLite cannot alter in place,
// so the table is rebuilt once (https://www.sqlite.org/lang_altertable.html#otheralter). Foreign keys must be off
// while the old table is dropped, or its order_items and order_history rows would be deleted with it.
if (!db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'orders'").get().sql.includes("'upi'")) {
  const cols = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name).join(', ');
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`CREATE TABLE orders_new (${ORDERS_COLUMNS});
             INSERT INTO orders_new (${cols}) SELECT ${cols} FROM orders;
             DROP TABLE orders;
             ALTER TABLE orders_new RENAME TO orders;`);
    if (db.pragma('foreign_key_check').length) throw new Error('Orders upgrade failed its foreign key check.');
  })();
  db.pragma('foreign_keys = ON');
  console.log('  Upgraded the orders table for UPI payments.');
}
db.exec(`
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_upi_ref ON orders(upi_ref) WHERE upi_ref IS NOT NULL;
`);

// Defaults — admins change these from Admin → Settings. INSERT OR IGNORE keeps edited values.
const DEFAULT_SETTINGS = {
  store_name: 'AmritaKalakriti',
  store_tagline: 'Every Creation Tells a Story.',
  store_email: 'hello@amritakalakriti.com',
  store_phone: '+91 98765 43210',
  store_whatsapp: '919876543210',
  store_address: 'India',
  announcement: 'Free shipping across India on orders above ₹2,999 · Every piece is handmade & one of a kind',
  hero_title: 'Handmade art, painted with soul',
  hero_subtitle: 'Original canvas paintings, watercolours, Pattachitra, Madhubani and folk art — each one created by hand and shipped with a certificate of authenticity.',
  about_short: 'AmritaKalakriti began with a simple belief: art should carry the warmth of the hand that made it. Every painting here is created slowly, with natural pigments, fine brushes and stories from India’s living traditions — from the temple scrolls of Odisha to the mud walls of Mithila.',
  shipping_fee: '150',
  free_shipping_min: '2999',
  upi_enabled: '1',
  upi_id: '',
  upi_payee_name: '',
  cod_enabled: '1',
  online_payments_enabled: '1',
  instagram_url: 'https://instagram.com/',
  facebook_url: 'https://facebook.com/',
  youtube_url: 'https://youtube.com/',
};
const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, v);

const DEFAULT_PAGES = require('./default-pages');
const insertPage = db.prepare('INSERT OR IGNORE INTO pages (slug, title, body) VALUES (?, ?, ?)');
for (const p of DEFAULT_PAGES) insertPage.run(p.slug, p.title, p.body);

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value ?? '']));
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

module.exports = { db, getSettings, setSetting, DEFAULT_SETTINGS };
