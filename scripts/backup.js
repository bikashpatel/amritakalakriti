'use strict';
// Safe online backup of the store database (works while the site is running).
//   npm run backup                                   (local)
//   docker compose exec app node scripts/backup.js   (Docker)
// Writes <data dir>/backups/store-YYYY-MM-DD-HHMM.db and keeps the newest 14.
// Uploaded photos are in <data dir>/uploads — copy that folder along with the backups.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../src/config');

const KEEP = 14;
const dir = path.join(path.dirname(config.dbFile), 'backups');
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
const target = path.join(dir, `store-${stamp}.db`);

const db = new Database(config.dbFile, { readonly: true });
db.backup(target)
  .then(() => {
    db.close();
    const old = fs.readdirSync(dir).filter((f) => /^store-.*\.db$/.test(f)).sort().slice(0, -KEEP);
    old.forEach((f) => fs.rmSync(path.join(dir, f)));
    console.log(`Backup written: ${target}${old.length ? ` (removed ${old.length} old)` : ''}`);
  })
  .catch((err) => {
    console.error('Backup failed:', err.message);
    process.exit(1);
  });
