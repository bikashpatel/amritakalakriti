'use strict';
const session = require('express-session');

// Persists express-session data in the same SQLite database, so sign-ins and carts survive restarts.
class SqliteStore extends session.Store {
  constructor(db, { ttlMs = 1000 * 60 * 60 * 24 * 14 } = {}) {
    super();
    this.ttlMs = ttlMs;
    this.q = {
      get: db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expires > ?'),
      set: db.prepare(`INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
                       ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires`),
      touch: db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?'),
      destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
      prune: db.prepare('DELETE FROM sessions WHERE expires <= ?'),
    };
    setInterval(() => this.q.prune.run(Date.now()), 1000 * 60 * 30).unref();
  }

  expiry(sess) {
    const exp = sess?.cookie?.expires;
    return exp ? new Date(exp).getTime() : Date.now() + this.ttlMs;
  }

  get(sid, cb) {
    try {
      const row = this.q.get.get(sid, Date.now());
      cb(null, row ? JSON.parse(row.sess) : null);
    } catch (err) { cb(err); }
  }

  set(sid, sess, cb) {
    try { this.q.set.run(sid, JSON.stringify(sess), this.expiry(sess)); cb?.(null); } catch (err) { cb?.(err); }
  }

  touch(sid, sess, cb) {
    try { this.q.touch.run(this.expiry(sess), sid); cb?.(null); } catch (err) { cb?.(err); }
  }

  destroy(sid, cb) {
    try { this.q.destroy.run(sid); cb?.(null); } catch (err) { cb?.(err); }
  }
}

module.exports = SqliteStore;
