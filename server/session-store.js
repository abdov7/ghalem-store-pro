// express-session store backed by the `sessions` table.
import { Store } from 'express-session';

export class SqliteSessionStore extends Store {
  constructor(db, options = {}) {
    super(options);
    this.db = db;
    this.ttlMs = options.ttlMs || 12 * 3600 * 1000;
    this.getStmt = db.prepare('SELECT sess, expire FROM sessions WHERE sid = ?');
    this.setStmt = db.prepare(
      'INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?) ' +
        'ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expire = excluded.expire',
    );
    this.destroyStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.touchStmt = db.prepare('UPDATE sessions SET expire = ? WHERE sid = ?');
    this.gcStmt = db.prepare('DELETE FROM sessions WHERE expire < ?');
  }

  _expireOf(sess) {
    const exp = sess && sess.cookie && sess.cookie.expires;
    const ms = exp ? new Date(exp).getTime() : Date.now() + this.ttlMs;
    return Number.isFinite(ms) ? ms : Date.now() + this.ttlMs;
  }

  get(sid, cb) {
    try {
      const row = this.getStmt.get(String(sid));
      if (!row || row.expire <= Date.now()) {
        if (row) this.destroyStmt.run(String(sid));
        return cb(null, null);
      }
      cb(null, JSON.parse(row.sess));
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sess, cb) {
    try {
      // Opportunistic cleanup of expired sessions on write.
      this.gcStmt.run(Date.now());
      this.setStmt.run(String(sid), JSON.stringify(sess), this._expireOf(sess));
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      this.destroyStmt.run(String(sid));
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  touch(sid, sess, cb) {
    try {
      this.touchStmt.run(this._expireOf(sess), String(sid));
      cb(null);
    } catch (err) {
      cb(err);
    }
  }
}
