// SQLite connection helper — single synchronous connection via node:sqlite.
// Tables are created by server/migrate.js (run via `npm run migrate` or server/index.js).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function openDb(dbPath) {
  const raw = dbPath || process.env.DB_PATH || './data/ghalem-store.db';
  const file = raw === ':memory:' ? raw : resolve(process.cwd(), raw);
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}
