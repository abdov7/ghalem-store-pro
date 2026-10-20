// Admin API: auth, orders management, catalog, discounts, settings, audit log.
// All routes except POST /login require an admin session (requireAdmin).
import { Router } from 'express';
import { existsSync } from 'node:fs';
import { resolve, normalize } from 'node:path';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { hashPassword, verifyPassword } from '../password.js';
import {
  STATUS_AR,
  ORDER_STATUSES,
  SETTING_KEYS,
  canTransition,
  escapeLike,
  isIsoDateString,
  isValidGameId,
} from '../middleware/validate.js';

const UPLOAD_DIR = resolve(process.cwd(), process.env.UPLOAD_DIR || './data/uploads');
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
// Dummy hash so failed logins for unknown usernames take ~the same time.
const DUMMY_HASH = 'scrypt$16384$8$1$' + '00'.repeat(16) + '$' + '00'.repeat(64);

function audit(db, { admin_id, action, entity, entity_id, detail, ip }) {
  db.prepare(
    `INSERT INTO audit_log (admin_id, action, entity, entity_id, detail, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    admin_id ?? null,
    action,
    entity ?? null,
    entity_id != null ? String(entity_id) : null,
    detail ?? null,
    ip ?? null,
    new Date().toISOString(),
  );
}

function clientIp(req) {
  return req.ip || (req.socket && req.socket.remoteAddress) || '';
}

function paginate(req, def = 20, max = 100) {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const perPage = Math.min(max, Math.max(1, Number.parseInt(req.query.per_page, 10) || def));
  return { page, perPage, offset: (page - 1) * perPage };
}

export function adminRouter(db, { loginLimiter } = {}) {
  const r = Router();

  // ---------- Auth ----------
  const loginMiddlewares = [];
  if (loginLimiter) loginMiddlewares.push(loginLimiter);

  r.post('/login', ...loginMiddlewares, (req, res) => {
    const { username, password } = req.body || {};
    const ip = clientIp(req);
    if (typeof username !== 'string' || !username || typeof password !== 'string' || !password) {
      audit(db, { admin_id: null, action: 'admin.login', entity: 'admin', entity_id: username || '?', detail: 'فشل: بيانات ناقصة', ip });
      return res.status(400).json({ error: 'اسم المستخدم وكلمة المرور مطلوبان' });
    }
    const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
    const nowIso = new Date().toISOString();

    if (admin && admin.locked_until && admin.locked_until > nowIso) {
      audit(db, { admin_id: admin.id, action: 'admin.login', entity: 'admin', entity_id: username, detail: 'فشل: الحساب مقفل', ip });
      return res.status(403).json({ error: 'الحساب مقفل مؤقتاً بسبب محاولات فاشلة — حاول بعد 15 دقيقة' });
    }

    const ok = verifyPassword(password, admin ? admin.pw_hash : DUMMY_HASH) && Boolean(admin);
    if (!ok) {
      if (admin) {
        const failed = (admin.failed_attempts || 0) + 1;
        const lockedUntil = failed >= MAX_FAILED
          ? new Date(Date.now() + LOCK_MINUTES * 60 * 1000).toISOString()
          : null;
        db.prepare('UPDATE admins SET failed_attempts = ?, locked_until = ? WHERE id = ?')
          .run(failed, lockedUntil, admin.id);
        audit(db, { admin_id: admin.id, action: 'admin.login', entity: 'admin', entity_id: username, detail: 'فشل: كلمة مرور خاطئة', ip });
      } else {
        audit(db, { admin_id: null, action: 'admin.login', entity: 'admin', entity_id: username, detail: 'فشل: مستخدم غير موجود', ip });
      }
      return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
    }

    db.prepare('UPDATE admins SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(admin.id);
    req.session.regenerate((regenErr) => {
      if (regenErr) return res.status(500).json({ error: 'خطأ داخلي في الخادم' });
      req.session.adminId = admin.id;
      req.session.adminUsername = admin.username;
      req.session.save((saveErr) => {
        if (saveErr) return res.status(500).json({ error: 'خطأ داخلي في الخادم' });
        audit(db, { admin_id: admin.id, action: 'admin.login', entity: 'admin', entity_id: username, detail: 'نجاح', ip });
        res.json({ ok: true, username: admin.username });
      });
    });
  });

  // Everything below requires a logged-in admin.
  r.use(requireAdmin);

  r.post('/logout', (req, res) => {
    const username = req.session.adminUsername;
    req.session.destroy((err) => {
      if (err) return res.status(500).json({ error: 'خطأ داخلي في الخادم' });
      res.clearCookie('gspro.sid');
      res.json({ ok: true, username });
    });
  });

  r.get('/me', (req, res) => {
    res.json({ username: req.session.adminUsername });
  });

  r.post('/password', (req, res) => {
    const { current, new: next } = req.body || {};
    if (typeof current !== 'string' || typeof next !== 'string') {
      return res.status(400).json({ error: 'كلمة المرور الحالية والجديدة مطلوبتان' });
    }
    if (next.length < 10) {
      return res.status(400).json({ error: 'كلمة المرور الجديدة يجب أن تكون 10 أحرف على الأقل' });
    }
    const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.session.adminId);
    if (!admin || !verifyPassword(current, admin.pw_hash)) {
      return res.status(401).json({ error: 'كلمة المرور الحالية غير صحيحة' });
    }
    db.prepare('UPDATE admins SET pw_hash = ? WHERE id = ?').run(hashPassword(next), admin.id);
    audit(db, { admin_id: admin.id, action: 'admin.password', entity: 'admin', entity_id: admin.username, detail: 'تغيير كلمة المرور', ip: clientIp(req) });
    res.json({ ok: true });
  });

  // ---------- Orders ----------
  r.get('/orders', (req, res) => {
    const { status, q, from, to } = req.query;
    if (status !== undefined && !ORDER_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'حالة الطلب غير صالحة' });
    }
    if (from !== undefined && !isIsoDateString(from)) {
      return res.status(400).json({ error: 'تاريخ البداية غير صالح' });
    }
    if (to !== undefined && !isIsoDateString(to)) {
      return res.status(400).json({ error: 'تاريخ النهاية غير صالح' });
    }
    const { page, perPage, offset } = paginate(req);
    const where = [];
    const params = [];
    if (status) {
      where.push('status = ?');
      params.push(status);
    }
    if (q) {
      where.push("(order_no LIKE ? ESCAPE '\\' OR transfer_ref LIKE ? ESCAPE '\\')");
      const like = `%${escapeLike(q)}%`;
      params.push(like, like);
    }
    if (from) {
      where.push('created_at >= ?');
      params.push(from);
    }
    if (to) {
      where.push('created_at <= ?');
      params.push(to);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS c FROM orders ${clause}`).get(...params).c;
    const orders = db
      .prepare(
        `SELECT id, order_no, status, total_dzd, payment_method, created_at
         FROM orders ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, perPage, offset);
    res.json({ orders, page, per_page: perPage, total });
  });

  r.get('/orders/:id', (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'الطلب غير موجود' });
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!order) return res.status(404).json({ error: 'الطلب غير موجود' });
    const items = db
      .prepare(
        `SELECT oi.*, g.name_ar AS game_name_ar
         FROM order_items oi LEFT JOIN games g ON g.id = oi.game_id
         WHERE oi.order_id = ? ORDER BY oi.id ASC`,
      )
      .all(id);
    const history = db.prepare('SELECT * FROM order_history WHERE order_id = ? ORDER BY id ASC').all(id);
    const auditEntries = db
      .prepare("SELECT * FROM audit_log WHERE entity = 'order' AND entity_id = ? ORDER BY id DESC LIMIT 50")
      .all(String(id));
    res.json({
      id: order.id,
      order_no: order.order_no,
      status: order.status,
      status_ar: STATUS_AR[order.status] || order.status,
      total_dzd: order.total_dzd,
      payment_method: order.payment_method,
      transfer_ref: order.transfer_ref,
      receipt_available: order.receipt_path != null,
      customer_note: order.customer_note,
      created_at: order.created_at,
      updated_at: order.updated_at,
      items: items.map((i) => ({
        id: i.id,
        game_id: i.game_id,
        game_name_ar: i.game_name_ar || i.game_id,
        package_id: i.package_id,
        label_snapshot: i.label_snapshot,
        unit_price_snapshot: i.unit_price_snapshot,
        qty: i.qty,
        line_total: i.line_total,
        player_id: i.player_id,
        extra_value: i.extra_value,
      })),
      history: history.map((h) => ({
        id: h.id,
        from_status: h.from_status,
        to_status: h.to_status,
        to_status_ar: STATUS_AR[h.to_status] || h.to_status,
        changed_by: h.changed_by,
        note: h.note,
        at: h.created_at,
      })),
      audit: auditEntries.map((a) => ({
        id: a.id,
        action: a.action,
        detail: a.detail,
        ip: a.ip,
        at: a.created_at,
      })),
    });
  });

  r.get('/orders/:id/receipt', (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'الطلب غير موجود' });
    const order = db.prepare('SELECT receipt_path, order_no FROM orders WHERE id = ?').get(id);
    if (!order || !order.receipt_path) {
      return res.status(404).json({ error: 'لا يوجد إيصال لهذا الطلب' });
    }
    const abs = normalize(resolve(UPLOAD_DIR, order.receipt_path));
    if (!abs.startsWith(UPLOAD_DIR + '/') && abs !== UPLOAD_DIR) {
      return res.status(404).json({ error: 'لا يوجد إيصال لهذا الطلب' });
    }
    if (!existsSync(abs)) return res.status(404).json({ error: 'ملف الإيصال غير موجود' });
    res.download(abs, `receipt-${order.order_no}${abs.slice(abs.lastIndexOf('.'))}`);
  });

  r.patch('/orders/:id/status', (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'الطلب غير موجود' });
    const { to, note } = req.body || {};
    if (!ORDER_STATUSES.includes(to)) {
      return res.status(400).json({ error: 'الحالة المطلوبة غير صالحة' });
    }
    if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > 500)) {
      return res.status(400).json({ error: 'الملاحظة طويلة جداً (500 حرف كحد أقصى)' });
    }
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!order) return res.status(404).json({ error: 'الطلب غير موجود' });
    if (!canTransition(order.status, to)) {
      return res.status(400).json({ error: `لا يمكن الانتقال من "${STATUS_AR[order.status]}" إلى "${STATUS_AR[to]}"` });
    }
    const nowIso = new Date().toISOString();
    const changedBy = req.session.adminUsername || 'admin';
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(to, nowIso, id);
      db.prepare(
        `INSERT INTO order_history (order_id, from_status, to_status, changed_by, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, order.status, to, changedBy, note || null, nowIso);
      db.exec('COMMIT');
    } catch {
      try {
        db.exec('ROLLBACK');
      } catch { /* ignore */ }
      return res.status(500).json({ error: 'خطأ داخلي في الخادم' });
    }
    audit(db, {
      admin_id: req.session.adminId,
      action: 'order.status',
      entity: 'order',
      entity_id: id,
      detail: `${order.status} -> ${to}`,
      ip: clientIp(req),
    });
    res.json({ ok: true, status: to });
  });

  // ---------- Games ----------
  r.get('/games', (req, res) => {
    const games = db.prepare('SELECT * FROM games ORDER BY sort_order ASC, id ASC').all();
    const counts = db.prepare('SELECT game_id, COUNT(*) AS c FROM packages GROUP BY game_id').all();
    const countMap = Object.fromEntries(counts.map((c) => [c.game_id, c.c]));
    res.json(games.map((g) => ({ ...g, active: g.active === 1, package_count: countMap[g.id] || 0 })));
  });

  r.post('/games', (req, res) => {
    const b = req.body || {};
    if (!isValidGameId(b.id)) return res.status(400).json({ error: 'معرّف اللعبة غير صالح (أحرف لاتينية صغيرة وأرقام)' });
    for (const f of ['name_ar', 'name_en', 'short', 'unit_ar', 'id_label', 'cover_file']) {
      if (typeof b[f] !== 'string' || !b[f].trim()) {
        return res.status(400).json({ error: `الحقل "${f}" مطلوب` });
      }
    }
    if (db.prepare('SELECT 1 FROM games WHERE id = ?').get(b.id)) {
      return res.status(409).json({ error: 'معرّف اللعبة موجود مسبقاً' });
    }
    const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM games').get().m;
    db.prepare(
      `INSERT INTO games (id, name_ar, name_en, short, unit_ar, id_label, extra_label,
        cover_file, sort_order, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      b.id, b.name_ar, b.name_en, b.short, b.unit_ar, b.id_label,
      b.extra_label || null, b.cover_file,
      Number.isInteger(b.sort_order) ? b.sort_order : maxSort + 1,
      b.active === undefined ? 1 : (b.active ? 1 : 0),
    );
    audit(db, { admin_id: req.session.adminId, action: 'game.create', entity: 'game', entity_id: b.id, detail: b.name_ar, ip: clientIp(req) });
    res.status(201).json(db.prepare('SELECT * FROM games WHERE id = ?').get(b.id));
  });

  const GAME_UPDATABLE = ['name_ar', 'name_en', 'short', 'unit_ar', 'id_label', 'extra_label', 'cover_file', 'sort_order', 'active'];

  r.put('/games/:id', (req, res) => {
    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(req.params.id);
    if (!game) return res.status(404).json({ error: 'اللعبة غير موجودة' });
    const b = req.body || {};
    const sets = [];
    const params = [];
    for (const f of GAME_UPDATABLE) {
      if (b[f] === undefined) continue;
      if (f === 'sort_order' && !Number.isInteger(b[f])) {
        return res.status(400).json({ error: 'ترتيب العرض يجب أن يكون رقماً صحيحاً' });
      }
      if (f === 'active') {
        sets.push('active = ?');
        params.push(b[f] ? 1 : 0);
      } else {
        sets.push(`${f} = ?`);
        params.push(b[f] === null ? null : b[f]);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'لا توجد حقول للتحديث' });
    params.push(req.params.id);
    db.prepare(`UPDATE games SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    audit(db, { admin_id: req.session.adminId, action: 'game.update', entity: 'game', entity_id: req.params.id, detail: sets.map((s) => s.split(' ')[0]).join(','), ip: clientIp(req) });
    res.json(db.prepare('SELECT * FROM games WHERE id = ?').get(req.params.id));
  });

  // ---------- Packages ----------
  r.get('/packages', (req, res) => {
    const { game_id } = req.query;
    let rows;
    if (game_id) {
      rows = db.prepare('SELECT * FROM packages WHERE game_id = ? ORDER BY sort_order ASC, id ASC').all(game_id);
    } else {
      rows = db.prepare('SELECT * FROM packages ORDER BY game_id ASC, sort_order ASC, id ASC').all();
    }
    res.json(rows);
  });

  function validatePackageBody(b) {
    if (typeof b.game_id !== 'string' || !b.game_id) return 'اللعبة مطلوبة';
    if (typeof b.label_ar !== 'string' || !b.label_ar.trim()) return 'اسم الباقة مطلوب';
    if (typeof b.amount_label !== 'string' || !b.amount_label.trim()) return 'مسمى الكمية مطلوب';
    if (!Number.isInteger(b.price_dzd) || b.price_dzd < 0) return 'السعر يجب أن يكون رقماً صحيحاً موجباً';
    if (b.is_hot !== undefined && !(b.is_hot === 0 || b.is_hot === 1 || b.is_hot === true || b.is_hot === false)) {
      return 'قيمة is_hot غير صالحة';
    }
    if (b.sort_order !== undefined && !Number.isInteger(b.sort_order)) return 'ترتيب العرض يجب أن يكون رقماً صحيحاً';
    return null;
  }

  r.post('/packages', (req, res) => {
    const err = validatePackageBody(req.body || {});
    if (err) return res.status(400).json({ error: err });
    const b = req.body;
    if (!db.prepare('SELECT 1 FROM games WHERE id = ?').get(b.game_id)) {
      return res.status(400).json({ error: 'اللعبة غير موجودة' });
    }
    const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM packages WHERE game_id = ?').get(b.game_id).m;
    const info = db.prepare(
      `INSERT INTO packages (game_id, label_ar, amount_label, price_dzd, is_hot, sort_order, active)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      b.game_id, b.label_ar, b.amount_label, b.price_dzd,
      b.is_hot ? 1 : 0,
      Number.isInteger(b.sort_order) ? b.sort_order : maxSort + 1,
      b.active === undefined ? 1 : (b.active ? 1 : 0),
    );
    audit(db, { admin_id: req.session.adminId, action: 'package.create', entity: 'package', entity_id: info.lastInsertRowid, detail: `${b.game_id}:${b.label_ar}`, ip: clientIp(req) });
    res.status(201).json(db.prepare('SELECT * FROM packages WHERE id = ?').get(info.lastInsertRowid));
  });

  const PKG_UPDATABLE = ['game_id', 'label_ar', 'amount_label', 'price_dzd', 'is_hot', 'sort_order', 'active'];

  r.put('/packages/:id', (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'الباقة غير موجودة' });
    const pkg = db.prepare('SELECT * FROM packages WHERE id = ?').get(id);
    if (!pkg) return res.status(404).json({ error: 'الباقة غير موجودة' });
    const b = req.body || {};
    if (b.game_id !== undefined && !db.prepare('SELECT 1 FROM games WHERE id = ?').get(b.game_id)) {
      return res.status(400).json({ error: 'اللعبة غير موجودة' });
    }
    if (b.price_dzd !== undefined && (!Number.isInteger(b.price_dzd) || b.price_dzd < 0)) {
      return res.status(400).json({ error: 'السعر يجب أن يكون رقماً صحيحاً موجباً' });
    }
    const sets = [];
    const params = [];
    for (const f of PKG_UPDATABLE) {
      if (b[f] === undefined) continue;
      if (f === 'is_hot' || f === 'active') {
        sets.push(`${f} = ?`);
        params.push(b[f] ? 1 : 0);
      } else {
        sets.push(`${f} = ?`);
        params.push(b[f]);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'لا توجد حقول للتحديث' });
    params.push(id);
    db.prepare(`UPDATE packages SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    audit(db, { admin_id: req.session.adminId, action: 'package.update', entity: 'package', entity_id: id, detail: sets.map((s) => s.split(' ')[0]).join(','), ip: clientIp(req) });
    res.json(db.prepare('SELECT * FROM packages WHERE id = ?').get(id));
  });

  // ---------- Discounts ----------
  function discountRow(id) {
    return db
      .prepare(
        `SELECT d.*, g.name_ar AS game_name_ar, p.label_ar AS package_label_ar
         FROM discounts d
         LEFT JOIN games g ON g.id = d.game_id
         LEFT JOIN packages p ON p.id = d.package_id
         WHERE d.id = ?`,
      )
      .get(id);
  }

  r.get('/discounts', (req, res) => {
    const rows = db
      .prepare(
        `SELECT d.*, g.name_ar AS game_name_ar, p.label_ar AS package_label_ar
         FROM discounts d
         LEFT JOIN games g ON g.id = d.game_id
         LEFT JOIN packages p ON p.id = d.package_id
         ORDER BY d.id DESC`,
      )
      .all();
    res.json(rows);
  });

  function validateDiscountBody(b, partial = false) {
    if (!partial || b.scope !== undefined) {
      if (b.scope !== 'package' && b.scope !== 'game') return 'نطاق الخصم غير صالح';
    }
    const scope = b.scope;
    if (scope === 'package' && (!partial || b.package_id !== undefined)) {
      if (!Number.isInteger(b.package_id)) return 'الباقة مطلوبة لهذا النطاق';
    }
    if (scope === 'game' && (!partial || b.game_id !== undefined)) {
      if (typeof b.game_id !== 'string' || !b.game_id) return 'اللعبة مطلوبة لهذا النطاق';
    }
    if (b.percent !== undefined && (!Number.isInteger(b.percent) || b.percent < 1 || b.percent > 90)) {
      return 'نسبة الخصم يجب أن تكون بين 1 و 90';
    }
    if (b.starts_at !== undefined && !isIsoDateString(b.starts_at)) return 'تاريخ البداية غير صالح';
    if (b.ends_at !== undefined && !isIsoDateString(b.ends_at)) return 'تاريخ النهاية غير صالح';
    const starts = b.starts_at !== undefined ? b.starts_at : null;
    const ends = b.ends_at !== undefined ? b.ends_at : null;
    if (starts && ends && Date.parse(ends) <= Date.parse(starts)) {
      return 'تاريخ النهاية يجب أن يكون بعد تاريخ البداية';
    }
    return null;
  }

  r.post('/discounts', (req, res) => {
    const b = req.body || {};
    const err = validateDiscountBody(b);
    if (err) return res.status(400).json({ error: err });
    if (b.percent === undefined || b.starts_at === undefined || b.ends_at === undefined) {
      return res.status(400).json({ error: 'النسبة وتاريخا البداية والنهاية مطلوبة' });
    }
    let package_id = null;
    let game_id = null;
    if (b.scope === 'package') {
      if (!db.prepare('SELECT game_id FROM packages WHERE id = ?').get(b.package_id)) {
        return res.status(400).json({ error: 'الباقة غير موجودة' });
      }
      package_id = b.package_id;
    } else {
      if (!db.prepare('SELECT 1 FROM games WHERE id = ?').get(b.game_id)) {
        return res.status(400).json({ error: 'اللعبة غير موجودة' });
      }
      game_id = b.game_id;
    }
    const info = db.prepare(
      `INSERT INTO discounts (scope, package_id, game_id, percent, starts_at, ends_at, active)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(b.scope, package_id, game_id, b.percent, b.starts_at, b.ends_at, b.active === undefined ? 1 : (b.active ? 1 : 0));
    audit(db, { admin_id: req.session.adminId, action: 'discount.create', entity: 'discount', entity_id: info.lastInsertRowid, detail: `${b.scope}:${b.percent}%`, ip: clientIp(req) });
    res.status(201).json(discountRow(info.lastInsertRowid));
  });

  r.put('/discounts/:id', (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'الخصم غير موجود' });
    const disc = db.prepare('SELECT * FROM discounts WHERE id = ?').get(id);
    if (!disc) return res.status(404).json({ error: 'الخصم غير موجود' });
    const b = req.body || {};
    const err = validateDiscountBody(b, true);
    if (err) return res.status(400).json({ error: err });

    // Determine the effective scope/target after the update.
    const scope = b.scope !== undefined ? b.scope : disc.scope;
    let package_id = b.package_id !== undefined ? b.package_id : disc.package_id;
    let game_id = b.game_id !== undefined ? b.game_id : disc.game_id;
    if (b.scope !== undefined) {
      // Switching scope resets the other target.
      if (scope === 'package') {
        game_id = null;
        if (b.package_id === undefined) return res.status(400).json({ error: 'الباقة مطلوبة لهذا النطاق' });
      } else {
        package_id = null;
        if (b.game_id === undefined) return res.status(400).json({ error: 'اللعبة مطلوبة لهذا النطاق' });
      }
    }
    if (scope === 'package' && !db.prepare('SELECT 1 FROM packages WHERE id = ?').get(package_id)) {
      return res.status(400).json({ error: 'الباقة غير موجودة' });
    }
    if (scope === 'game' && !db.prepare('SELECT 1 FROM games WHERE id = ?').get(game_id)) {
      return res.status(400).json({ error: 'اللعبة غير موجودة' });
    }
    // Validate date ordering against the merged row.
    const starts = b.starts_at !== undefined ? b.starts_at : disc.starts_at;
    const ends = b.ends_at !== undefined ? b.ends_at : disc.ends_at;
    if (Date.parse(ends) <= Date.parse(starts)) {
      return res.status(400).json({ error: 'تاريخ النهاية يجب أن يكون بعد تاريخ البداية' });
    }

    db.prepare(
      `UPDATE discounts SET scope = ?, package_id = ?, game_id = ?,
        percent = ?, starts_at = ?, ends_at = ?, active = ? WHERE id = ?`,
    ).run(
      scope, package_id, game_id,
      b.percent !== undefined ? b.percent : disc.percent,
      starts, ends,
      b.active !== undefined ? (b.active ? 1 : 0) : disc.active,
      id,
    );
    audit(db, { admin_id: req.session.adminId, action: 'discount.update', entity: 'discount', entity_id: id, detail: scope, ip: clientIp(req) });
    res.json(discountRow(id));
  });

  r.delete('/discounts/:id', (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'الخصم غير موجود' });
    const disc = db.prepare('SELECT * FROM discounts WHERE id = ?').get(id);
    if (!disc) return res.status(404).json({ error: 'الخصم غير موجود' });
    db.prepare('DELETE FROM discounts WHERE id = ?').run(id);
    audit(db, { admin_id: req.session.adminId, action: 'discount.delete', entity: 'discount', entity_id: id, detail: `${disc.scope}:${disc.percent}%`, ip: clientIp(req) });
    res.json({ ok: true });
  });

  // ---------- Settings ----------
  r.get('/settings', (req, res) => {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const out = {};
    for (const row of rows) out[row.key] = row.value;
    res.json(out);
  });

  r.put('/settings', (req, res) => {
    const b = req.body || {};
    if (typeof b !== 'object' || Array.isArray(b)) {
      return res.status(400).json({ error: 'بيانات الإعدادات غير صالحة' });
    }
    const changed = [];
    const upsert = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    for (const key of SETTING_KEYS) {
      if (b[key] === undefined) continue;
      if (typeof b[key] !== 'string' || b[key].length > 2000) {
        return res.status(400).json({ error: `قيمة الإعداد "${key}" غير صالحة` });
      }
      upsert.run(key, b[key]);
      changed.push(key);
    }
    if (!changed.length) return res.status(400).json({ error: 'لا توجد إعدادات صالحة للتحديث' });
    // NOTE: values are never written to the audit detail (they may contain secrets).
    audit(db, { admin_id: req.session.adminId, action: 'settings.update', entity: 'settings', entity_id: changed.join(','), detail: 'تحديث الإعدادات', ip: clientIp(req) });
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const out = {};
    for (const row of rows) out[row.key] = row.value;
    res.json(out);
  });

  // ---------- Audit log ----------
  r.get('/audit-log', (req, res) => {
    const { page, perPage, offset } = paginate(req, 50, 100);
    const total = db.prepare('SELECT COUNT(*) AS c FROM audit_log').get().c;
    const entries = db
      .prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?')
      .all(perPage, offset);
    res.json({
      entries: entries.map((e) => ({
        id: e.id,
        admin_id: e.admin_id,
        action: e.action,
        entity: e.entity,
        entity_id: e.entity_id,
        detail: e.detail,
        ip: e.ip,
        at: e.created_at,
      })),
      page,
      per_page: perPage,
      total,
    });
  });

  return r;
}
