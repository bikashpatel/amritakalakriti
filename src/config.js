'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;
const isProd = env.NODE_ENV === 'production';

// Everything the store writes (database + uploaded photos) lives under DATA_DIR when it is set —
// in Docker that is the /app/data volume. Locally it defaults to ./data and ./public/uploads.
const dataDir = env.DATA_DIR ? path.resolve(env.DATA_DIR) : null;

// "1" = one proxy in front (Cloudflare Tunnel, Nginx, a cloud load balancer); "false" = none.
const trustProxy = /^\d+$/.test(env.TRUST_PROXY || '') ? Number(env.TRUST_PROXY)
  : env.TRUST_PROXY === 'false' ? false : env.TRUST_PROXY || 1;

const sessionSecret = env.SESSION_SECRET || '';
if (isProd && (sessionSecret.length < 32 || sessionSecret === 'change-me')) {
  throw new Error('SESSION_SECRET must be set to a random string of at least 32 characters in production.');
}

module.exports = {
  ROOT,
  isProd,
  port: Number(env.PORT) || 3000,
  baseUrl: (env.BASE_URL || `http://localhost:${Number(env.PORT) || 3000}`).replace(/\/$/, ''),
  sessionSecret: sessionSecret || 'dev-only-secret-change-me',
  dbFile: env.DB_FILE || path.join(dataDir || path.join(ROOT, 'data'), 'store.db'),
  uploadDir: env.UPLOAD_DIR || (dataDir ? path.join(dataDir, 'uploads') : path.join(ROOT, 'public', 'uploads')),
  trustProxy,
  // Only enable when every request reaches the app through Cloudflare (e.g. a Cloudflare Tunnel);
  // otherwise visitors could fake the header to dodge sign-in rate limits.
  behindCloudflare: env.BEHIND_CLOUDFLARE === '1' || env.BEHIND_CLOUDFLARE === 'true',
  admin: {
    email: env.ADMIN_EMAIL || 'admin@amritakalakriti.com',
    password: env.ADMIN_PASSWORD || '',
    name: env.ADMIN_NAME || 'Store Admin',
  },
  razorpay: {
    keyId: env.RAZORPAY_KEY_ID || '',
    keySecret: env.RAZORPAY_KEY_SECRET || '',
    webhookSecret: env.RAZORPAY_WEBHOOK_SECRET || '',
  },
  // Unpaid online orders release their reserved stock after this many minutes.
  pendingOrderTtlMinutes: Number(env.PENDING_ORDER_TTL_MINUTES) || 30,
};
