'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;

module.exports = {
  ROOT,
  isProd: env.NODE_ENV === 'production',
  port: Number(env.PORT) || 3000,
  baseUrl: (env.BASE_URL || `http://localhost:${Number(env.PORT) || 3000}`).replace(/\/$/, ''),
  sessionSecret: env.SESSION_SECRET || 'dev-only-secret-change-me',
  dbFile: env.DB_FILE || path.join(ROOT, 'data', 'store.db'),
  uploadDir: path.join(ROOT, 'public', 'uploads'),
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
