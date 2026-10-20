// Express app factory. Exports createApp({dbPath}) -> Express app (no listen).
// Used by server/index.js and by the test suite with a temp DB.
import express from 'express';
import session from 'express-session';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { openDb } from './db.js';
import { SqliteSessionStore } from './session-store.js';
import { securityHeaders } from './middleware/securityHeaders.js';
import { publicRouter } from './routes/public.js';
import { ordersRouter } from './routes/orders.js';
import { adminRouter } from './routes/admin.js';
import { logger } from './logger.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const ADMIN_INDEX = path.join(PUBLIC_DIR, 'admin', 'index.html');
const SITE_INDEX = path.join(PUBLIC_DIR, 'index.html');

function tooManyJson(message) {
  return (req, res) => res.status(429).json({ error: message });
}

export function createApp({ dbPath } = {}) {
  const db = openDb(dbPath);
  const app = express();

  app.set('trust proxy', 1);

  app.use(securityHeaders);
  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false }));

  // Sessions: SQLite-backed, 12h cookie.
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret && process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET is required in production');
  }
  if (!sessionSecret) {
    logger.warn('SESSION_SECRET is not set — using an insecure dev default. Set a long random value!');
  }
  app.use(
    session({
      name: 'gspro.sid',
      store: new SqliteSessionStore(db),
      secret: sessionSecret || 'dev-insecure-secret-change-me',
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: 'auto', // HTTPS only when the request is secure / behind TLS proxy
        maxAge: 12 * 3600 * 1000,
      },
    }),
  );

  // Rate limits (in-memory per IP per route-group).
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: tooManyJson('عدد كبير من الطلبات — حاول مرة أخرى لاحقاً'),
  });
  const orderCreateLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: tooManyJson('عدد كبير من الطلبات — حاول مرة أخرى لاحقاً'),
  });
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: tooManyJson('محاولات دخول كثيرة — حاول بعد 15 دقيقة'),
  });

  // API routes (before static files).
  app.use('/api', apiLimiter);
  app.use('/api', publicRouter(db));
  app.use('/api/orders', ordersRouter(db, { createLimiter: orderCreateLimiter }));
  app.use('/api/admin', adminRouter(db, { loginLimiter }));

  // Static storefront (built by the frontend agent).
  app.use(express.static(PUBLIC_DIR));

  // Admin SPA entry — the file may not exist yet; never crash.
  app.get(['/admin', '/admin/'], (req, res) => {
    if (existsSync(ADMIN_INDEX)) return res.sendFile(ADMIN_INDEX);
    res.status(503).send(
      '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>لوحة الإدارة</title></head>' +
        '<body><h1>لوحة الإدارة غير متوفرة بعد</h1><p>واجهة الإدارة قيد الإنشاء.</p></body></html>',
    );
  });

  // Unknown /api/* -> JSON 404.
  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'غير موجود' });
  });

  // SPA fallback for the storefront (only if index.html exists).
  app.get('*', (req, res) => {
    if (existsSync(SITE_INDEX)) return res.sendFile(SITE_INDEX);
    res.status(404).json({ error: 'غير موجود' });
  });

  // Central error handler: Arabic message, no stack/SQL leaks.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logger.error(`request failed: ${req.method} ${req.path} -> ${err && err.message ? err.message : 'unknown'}`);
    if (res.headersSent) return next(err);
    const status = err && Number.isInteger(err.status) ? err.status : 500;
    res.status(status).json({ error: 'خطأ داخلي في الخادم' });
  });

  return app;
}
