// Server entry point: loads env, migrates, seeds, then listens.
// Run: `npm start` (PORT / SESSION_SECRET / DB_PATH / UPLOAD_DIR / NODE_ENV via env or .env)
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb } from './db.js';
import { migrate } from './migrate.js';
import { seed } from './seed.js';
import { createApp } from './app.js';
import { logger } from './logger.js';

function loadDotEnv() {
  const file = resolve(process.cwd(), '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  logger.error('Invalid PORT');
  process.exit(1);
}

mkdirSync(resolve(process.cwd(), process.env.UPLOAD_DIR || './data/uploads'), { recursive: true });

const dbPath = process.env.DB_PATH || './data/ghalem-store.db';
const setupDb = openDb(dbPath);
migrate(setupDb);
seed(setupDb);
setupDb.close();

const app = createApp({ dbPath });
app.listen(PORT, () => {
  logger.info(`Ghalem Store Pro listening on port ${PORT} (env=${process.env.NODE_ENV || 'development'})`);
});
