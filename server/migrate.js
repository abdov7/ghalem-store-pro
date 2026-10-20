// Idempotent migrations — creates EXACTLY the tables in CONTRACT.md §1.
// Safe to run repeatedly. Also runnable as a CLI: `node server/migrate.js`.
import { openDb } from './db.js';

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS games(
    id TEXT PRIMARY KEY,
    name_ar TEXT NOT NULL,
    name_en TEXT NOT NULL,
    short TEXT NOT NULL,
    unit_ar TEXT NOT NULL,
    id_label TEXT NOT NULL,
    extra_label TEXT,
    cover_file TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS packages(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id TEXT NOT NULL REFERENCES games(id),
    label_ar TEXT NOT NULL,
    amount_label TEXT NOT NULL,
    price_dzd INTEGER NOT NULL,
    is_hot INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS discounts(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL CHECK(scope IN ('package','game')),
    package_id INTEGER REFERENCES packages(id),
    game_id TEXT REFERENCES games(id),
    percent INTEGER NOT NULL CHECK(percent BETWEEN 1 AND 90),
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS orders(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_no TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'awaiting_payment'
      CHECK(status IN ('awaiting_payment','under_review','paid','shipped','rejected')),
    total_dzd INTEGER NOT NULL,
    payment_method TEXT NOT NULL CHECK(payment_method IN ('ccp','baridimob')),
    transfer_ref TEXT,
    receipt_path TEXT,
    customer_note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS order_items(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    game_id TEXT NOT NULL,
    package_id INTEGER NOT NULL,
    label_snapshot TEXT NOT NULL,
    unit_price_snapshot INTEGER NOT NULL,
    qty INTEGER NOT NULL,
    line_total INTEGER NOT NULL,
    player_id TEXT NOT NULL,
    extra_value TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS order_history(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    from_status TEXT,
    to_status TEXT NOT NULL,
    changed_by TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS admins(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    pw_hash TEXT NOT NULL,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS idempotency_keys(
    key TEXT PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS settings(
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS audit_log(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER,
    action TEXT NOT NULL,
    entity TEXT,
    entity_id TEXT,
    detail TEXT,
    ip TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions(
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expire INTEGER NOT NULL
  )`,
];

export function migrate(db) {
  for (const sql of MIGRATIONS) db.exec(sql);
  return MIGRATIONS.length;
}

// CLI: `node server/migrate.js`
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = openDb();
  const n = migrate(db);
  db.close();
  console.log(`migrate: ok (${n} tables ensured)`);
}
