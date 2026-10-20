// Customer order flow: create, track, attach payment proof.
import { Router } from 'express';
import multer from 'multer';
import { randomBytes, randomInt } from 'node:crypto';
import { mkdirSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { currentMaxDiscount, effectivePrice } from '../pricing.js';
import {
  STATUS_AR,
  isValidCustomerNote,
  isValidExtraValue,
  isValidOrderNo,
  isValidPaymentMethod,
  isValidPlayerId,
  isValidQty,
  isValidTransferRef,
  isValidUuidV4,
} from '../middleware/validate.js';

const UPLOAD_DIR = resolve(process.cwd(), process.env.UPLOAD_DIR || './data/uploads');

const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const map = {};
  for (const r of rows) map[r.key] = r.value;
  return map;
}

function paymentBlock(settings, method) {
  if (method === 'ccp') {
    return {
      method,
      instructions: settings.payment_instructions_ar || '',
      account_label: settings.pay_ccp_label || '',
      account_number: settings.pay_ccp_number || '',
    };
  }
  return {
    method,
    instructions: settings.payment_instructions_ar || '',
    account_label: settings.pay_baridimob_label || '',
    account_number: settings.pay_baridimob_number || '',
  };
}

function generateOrderNo(db) {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  for (let attempt = 0; attempt < 10; attempt++) {
    let suffix = '';
    for (let i = 0; i < 4; i++) suffix += chars[randomInt(0, chars.length)];
    const orderNo = `GS-${date}-${suffix}`;
    const exists = db.prepare('SELECT 1 FROM orders WHERE order_no = ?').get(orderNo);
    if (!exists) return orderNo;
  }
  throw new Error('order number collision');
}

// Full server-side validation of POST /api/orders body.
// Returns {error} (Arabic) or {data} with normalized fields.
function validateOrderBody(body) {
  if (!body || typeof body !== 'object') return { error: 'بيانات الطلب غير صالحة' };
  const { items, payment_method, customer_note, idempotency_key } = body;

  if (!Array.isArray(items) || items.length < 1 || items.length > 20) {
    return { error: 'يجب أن يحتوي الطلب على منتج واحد على الأقل (20 كحد أقصى)' };
  }
  if (!isValidPaymentMethod(payment_method)) return { error: 'طريقة الدفع غير صالحة' };
  if (!isValidCustomerNote(customer_note)) return { error: 'الملاحظة طويلة جداً (500 حرف كحد أقصى)' };
  if (!isValidUuidV4(idempotency_key)) return { error: 'مفتاح عدم التكرار غير صالح' };

  const clean = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || typeof it !== 'object') return { error: `المنتج رقم ${i + 1} غير صالح` };
    if (typeof it.game_id !== 'string' || !it.game_id) return { error: `المنتج رقم ${i + 1}: اللعبة غير صالحة` };
    if (!Number.isInteger(it.package_id)) return { error: `المنتج رقم ${i + 1}: الباقة غير صالحة` };
    if (!isValidQty(it.qty)) return { error: `المنتج رقم ${i + 1}: الكمية يجب أن تكون بين 1 و 10` };
    if (!isValidPlayerId(it.player_id)) {
      return { error: `المنتج رقم ${i + 1}: معرّف اللاعب غير صالح (3 أحرف على الأقل)` };
    }
    if (!isValidExtraValue(it.extra_value)) {
      return { error: `المنتج رقم ${i + 1}: القيمة الإضافية غير صالحة` };
    }
    clean.push({
      game_id: it.game_id,
      package_id: it.package_id,
      qty: it.qty,
      player_id: it.player_id,
      extra_value: it.extra_value || null,
    });
  }
  return { data: { items: clean, payment_method, customer_note: customer_note || null, idempotency_key } };
}

// 201/200 payload for a created (or replayed) order.
function orderPayload(db, orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC').all(orderId);
  const settings = getSettings(db);
  return {
    order_no: order.order_no,
    status: order.status,
    total_dzd: order.total_dzd,
    items: items.map((i) => ({
      game_id: i.game_id,
      package_id: i.package_id,
      label_ar: i.label_snapshot,
      unit_price: i.unit_price_snapshot,
      qty: i.qty,
      line_total: i.line_total,
      player_id: i.player_id,
      extra_value: i.extra_value,
    })),
    payment: paymentBlock(settings, order.payment_method),
    created_at: order.created_at,
  };
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    mkdirSync(UPLOAD_DIR, { recursive: true });
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const ext = EXT_BY_MIME[file.mimetype] || '.bin';
    cb(null, `${req.params.order_no}-${randomBytes(8).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (EXT_BY_MIME[file.mimetype]) cb(null, true);
    else cb(new Error('INVALID_FILE_TYPE'));
  },
});

function uploadSingle(req, res, next) {
  upload.single('receipt')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'حجم الصورة يجب أن لا يتجاوز 3MB' });
    }
    return res.status(400).json({ error: 'نوع الملف غير مدعوم — JPEG أو PNG أو WebP فقط' });
  });
}

export function ordersRouter(db, { createLimiter } = {}) {
  const r = Router();

  // POST /api/orders — create an order. Server recomputes ALL prices from the DB.
  const createMiddlewares = [];
  if (createLimiter) createMiddlewares.push(createLimiter);
  r.post('/', ...createMiddlewares, (req, res) => {
    const v = validateOrderBody(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const { items, payment_method, customer_note, idempotency_key } = v.data;

    // Idempotency: replay of a known key returns the ORIGINAL order, no new row.
    const replay = db.prepare('SELECT order_id FROM idempotency_keys WHERE key = ?').get(idempotency_key);
    if (replay) return res.status(200).json(orderPayload(db, replay.order_id));

    const nowIso = new Date().toISOString();

    // Resolve every line against the DB (browser-sent prices are ignored entirely).
    const lines = [];
    for (const it of items) {
      const game = db.prepare('SELECT * FROM games WHERE id = ? AND active = 1').get(it.game_id);
      if (!game) return res.status(400).json({ error: 'إحدى الألعاب غير موجودة أو غير متاحة' });
      const pkg = db
        .prepare('SELECT * FROM packages WHERE id = ? AND game_id = ? AND active = 1')
        .get(it.package_id, it.game_id);
      if (!pkg) return res.status(400).json({ error: 'إحدى الباقات غير موجودة أو غير متاحة' });
      const pct = currentMaxDiscount(db, it.game_id, it.package_id, nowIso);
      const unitPrice = effectivePrice(pkg.price_dzd, pct);
      lines.push({
        ...it,
        label_snapshot: pkg.label_ar,
        unit_price_snapshot: unitPrice,
        line_total: unitPrice * it.qty,
      });
    }
    const total = lines.reduce((s, l) => s + l.line_total, 0);

    let orderNo;
    try {
      orderNo = generateOrderNo(db);
    } catch {
      return res.status(500).json({ error: 'خطأ داخلي في الخادم' });
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      // Re-check inside the transaction in case of a concurrent race.
      const raced = db.prepare('SELECT order_id FROM idempotency_keys WHERE key = ?').get(idempotency_key);
      if (raced) {
        db.exec('ROLLBACK');
        return res.status(200).json(orderPayload(db, raced.order_id));
      }
      const info = db
        .prepare(
          `INSERT INTO orders (order_no, status, total_dzd, payment_method, customer_note, created_at, updated_at)
           VALUES (?, 'awaiting_payment', ?, ?, ?, ?, ?)`,
        )
        .run(orderNo, total, payment_method, customer_note, nowIso, nowIso);
      const orderId = Number(info.lastInsertRowid);
      const insItem = db.prepare(
        `INSERT INTO order_items (order_id, game_id, package_id, label_snapshot, unit_price_snapshot,
          qty, line_total, player_id, extra_value)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const l of lines) {
        insItem.run(
          orderId, l.game_id, l.package_id, l.label_snapshot, l.unit_price_snapshot,
          l.qty, l.line_total, l.player_id, l.extra_value,
        );
      }
      db.prepare(
        `INSERT INTO order_history (order_id, from_status, to_status, changed_by, note, created_at)
         VALUES (?, NULL, 'awaiting_payment', 'customer', NULL, ?)`,
      ).run(orderId, nowIso);
      db.prepare('INSERT INTO idempotency_keys (key, order_id, created_at) VALUES (?, ?, ?)')
        .run(idempotency_key, orderId, nowIso);
      db.exec('COMMIT');
      return res.status(201).json(orderPayload(db, orderId));
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch { /* already rolled back */ }
      const raced = db.prepare('SELECT order_id FROM idempotency_keys WHERE key = ?').get(idempotency_key);
      if (raced) return res.status(200).json(orderPayload(db, raced.order_id));
      throw err;
    }
  });

  // GET /api/orders/:order_no — public order tracking.
  r.get('/:order_no', (req, res) => {
    if (!isValidOrderNo(req.params.order_no)) {
      return res.status(404).json({ error: 'الطلب غير موجود' });
    }
    const order = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(req.params.order_no);
    if (!order) return res.status(404).json({ error: 'الطلب غير موجود' });

    const items = db
      .prepare(
        `SELECT oi.*, g.name_ar AS game_name_ar
         FROM order_items oi LEFT JOIN games g ON g.id = oi.game_id
         WHERE oi.order_id = ? ORDER BY oi.id ASC`,
      )
      .all(order.id);
    const history = db
      .prepare('SELECT * FROM order_history WHERE order_id = ? ORDER BY id ASC')
      .all(order.id);

    res.json({
      order_no: order.order_no,
      status: order.status,
      status_ar: STATUS_AR[order.status] || order.status,
      total_dzd: order.total_dzd,
      items: items.map((i) => ({
        game_name_ar: i.game_name_ar || i.game_id,
        package_label: i.label_snapshot,
        qty: i.qty,
        unit_price: i.unit_price_snapshot,
        line_total: i.line_total,
        player_id: i.player_id,
      })),
      payment_method: order.payment_method,
      transfer_ref_set: order.transfer_ref != null && order.transfer_ref !== '',
      created_at: order.created_at,
      updated_at: order.updated_at,
      history: history.map((h) => ({
        to_status: h.to_status,
        to_status_ar: STATUS_AR[h.to_status] || h.to_status,
        at: h.created_at,
      })),
    });
  });

  // POST /api/orders/:order_no/proof — transfer ref + optional receipt image.
  const loadAwaitingOrder = (req, res, next) => {
    if (!isValidOrderNo(req.params.order_no)) {
      return res.status(404).json({ error: 'الطلب غير موجود' });
    }
    const order = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(req.params.order_no);
    if (!order) return res.status(404).json({ error: 'الطلب غير موجود' });
    if (order.status !== 'awaiting_payment') {
      return res.status(409).json({ error: 'لا يمكن إرفاق إثبات الدفع لهذا الطلب الآن' });
    }
    req.orderRow = order;
    next();
  };

  r.post('/:order_no/proof', loadAwaitingOrder, uploadSingle, (req, res) => {
    const transferRef = req.body && req.body.transfer_ref;
    if (!isValidTransferRef(transferRef)) {
      if (req.file) {
        try {
          unlinkSync(req.file.path);
        } catch { /* ignore */ }
      }
      return res.status(400).json({ error: 'مرجع التحويل غير صالح (4 أحرف على الأقل)' });
    }

    const nowIso = new Date().toISOString();
    const receiptPath = req.file ? req.file.filename : null;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        `UPDATE orders SET transfer_ref = ?, receipt_path = ?, status = 'under_review',
          updated_at = ? WHERE id = ?`,
      ).run(transferRef, receiptPath, nowIso, req.orderRow.id);
      db.prepare(
        `INSERT INTO order_history (order_id, from_status, to_status, changed_by, note, created_at)
         VALUES (?, 'awaiting_payment', 'under_review', 'customer', NULL, ?)`,
      ).run(req.orderRow.id, nowIso);
      db.exec('COMMIT');
    } catch {
      try {
        db.exec('ROLLBACK');
      } catch { /* ignore */ }
      if (req.file) {
        try {
          unlinkSync(req.file.path);
        } catch { /* ignore */ }
      }
      return res.status(500).json({ error: 'خطأ داخلي في الخادم' });
    }
    res.json({ ok: true, status: 'under_review' });
  });

  return r;
}
