// tests/helper.js — shared harness for Ghalem Store Pro integration tests.
// Boots the REAL Express app (server/app.js) against a fresh temp SQLite DB
// file per suite. Zero extra deps: node:test + node:assert + global fetch.
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { hashPassword } from '../server/password.js';

const execFileP = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT_DIR = join(HERE, '..');
export const SERVER_DIR = join(PROJECT_DIR, 'server');
const APP_FILE = join(SERVER_DIR, 'app.js');

export { hashPassword };
export const uuid = () => randomUUID();
export const isoDaysFromNow = (d) => new Date(Date.now() + d * 864e5).toISOString();

// Run server/migrate.js / server/seed.js against the temp DB.
// Prefers an exported function (import), falls back to a child process with DB_PATH.
async function runScript(name, dbPath, exportNames) {
  const script = join(SERVER_DIR, name);
  if (!existsSync(script)) throw new Error(`BACKEND NOT BUILT: server/${name} is missing`);
  const prev = process.env.DB_PATH;
  process.env.DB_PATH = dbPath;
  try {
    let mod = null;
    try {
      mod = await import(pathToFileURL(script).href);
    } catch {
      mod = null;
    }
    if (mod) {
      const fn = exportNames.map((n) => mod[n]).find((f) => typeof f === 'function');
      if (fn) {
        if (fn.length === 0) {
          await fn();
          return;
        }
        // Backend convention: migrate(db)/seed(db) take an OPEN database
        // handle (server/db.js openDb). Open one against the temp file.
        const { openDb } = await import(pathToFileURL(join(SERVER_DIR, 'db.js')).href);
        const db = openDb(dbPath);
        try {
          await fn(db);
        } finally {
          db.close();
        }
        return;
      }
    }
  } finally {
    if (prev === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = prev;
  }
  await execFileP(process.execPath, [script], {
    cwd: PROJECT_DIR,
    env: { ...process.env, DB_PATH: dbPath },
  });
}

export function withDb(dbPath, fn) {
  const db = new DatabaseSync(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function createAdmin(dbPath, username, password) {
  withDb(dbPath, (db) => {
    db
      .prepare('INSERT INTO admins (username, pw_hash, created_at) VALUES (?, ?, ?)')
      .run(username, hashPassword(password), new Date().toISOString());
  });
}

export function insertDiscount(
  dbPath,
  { scope, package_id = null, game_id = null, percent, starts_at, ends_at, active = 1 },
) {
  return withDb(
    dbPath,
    (db) =>
      db
        .prepare(
          'INSERT INTO discounts (scope, package_id, game_id, percent, starts_at, ends_at, active) VALUES (?,?,?,?,?,?,?)',
        )
        .run(scope, package_id, game_id, percent, starts_at, ends_at, active).lastInsertRowid,
  );
}

export function listPackages(dbPath) {
  return withDb(dbPath, (db) =>
    db
      .prepare(
        `SELECT p.id, p.game_id, p.label_ar, p.price_dzd, g.name_ar AS game_name_ar
         FROM packages p JOIN games g ON g.id = p.game_id
         WHERE p.active = 1 AND g.active = 1 ORDER BY p.id`,
      )
      .all(),
  );
}

// CONTRACT §1 effective-price rule, computed from the DB's REAL discount rows.
export function effectivePrice(dbPath, packageId, gameId, base, at = new Date()) {
  const t = at.toISOString();
  return withDb(dbPath, (db) => {
    const rows = db
      .prepare(
        `SELECT percent FROM discounts WHERE active = 1 AND starts_at <= ? AND ends_at >= ?
         AND ((scope = 'package' AND package_id = ?) OR (scope = 'game' AND game_id = ?))`,
      )
      .all(t, t, packageId, gameId);
    const pct = rows.reduce((m, r) => Math.max(m, r.percent), 0);
    return Math.round((base * (1 - pct / 100)) / 50) * 50;
  });
}

export function expectedOrderTotal(dbPath, items) {
  const pkgs = new Map(listPackages(dbPath).map((p) => [p.id, p]));
  let total = 0;
  for (const it of items) {
    const p = pkgs.get(it.package_id);
    assert.ok(p, `seed package ${it.package_id} must exist`);
    total += effectivePrice(dbPath, p.id, p.game_id, p.price_dzd) * it.qty;
  }
  return total;
}

export function pickPackages(dbPath, gameIds) {
  const pkgs = listPackages(dbPath);
  const out = {};
  for (const g of gameIds) {
    const p = pkgs.find((x) => x.game_id === g);
    assert.ok(p, `seed must include an active package for game '${g}'`);
    out[g] = p;
  }
  return out;
}

export async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text.slice(0, 500) };
  }
}

// Assert an HTTP status; reads the body text ONLY on mismatch (so the body
// stays readable for readJson() on the success path).
export async function assertStatus(res, expected, label = '') {
  if (res.status !== expected) {
    const text = await res.text().catch(() => '');
    assert.fail(`${label}: expected HTTP ${expected}, got ${res.status}: ${text.slice(0, 500)}`);
  }
}

export function assertArabicError(body, note = '') {  assert.ok(
    body && typeof body.error === 'string',
    `expected {error} JSON ${note}: ${JSON.stringify(body).slice(0, 300)}`,
  );
  assert.match(body.error, /[\u0600-\u06FF]/, `error must be Arabic ${note}: ${body.error}`);
}

// Minimal HTTP client with a cookie jar (express-session needs it).
export class Client {
  constructor(base) {
    this.base = base;
    this.jar = new Map();
  }
  get cookies() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async request(method, path, { json, form } = {}) {
    const headers = {};
    const ck = this.cookies;
    if (ck) headers.cookie = ck;
    let body;
    if (form !== undefined) body = form;
    else if (json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(json);
    }
    const res = await fetch(this.base + path, { method, headers, body });
    const getSet = res.headers.getSetCookie?.bind(res.headers);
    for (const c of typeof getSet === 'function' ? getSet() : []) {
      const pair = c.split(';', 1)[0];
      const eq = pair.indexOf('=');
      if (eq > 0) {
        const name = pair.slice(0, eq).trim();
        const val = pair.slice(eq + 1).trim();
        if (val === '') this.jar.delete(name);
        else this.jar.set(name, val);
      }
    }
    return res;
  }
  get(path) {
    return this.request('GET', path);
  }
  post(path, opts) {
    return this.request('POST', path, opts);
  }
  patch(path, opts) {
    return this.request('PATCH', path, opts);
  }
  put(path, opts) {
    return this.request('PUT', path, opts);
  }
  del(path) {
    return this.request('DELETE', path);
  }
}

// Boot the real app: temp DB -> migrate -> seed -> createApp({dbPath}) -> listen(0).
export async function bootApp(opts = {}) {
  if (!existsSync(APP_FILE)) {
    throw new Error(
      'BACKEND NOT BUILT: server/app.js does not exist yet — the backend agent has not finished.',
    );
  }
  let dir = null;
  let dbPath = opts.dbPath;
  if (!dbPath) {
    dir = mkdtempSync(join(tmpdir(), 'ghalem-test-'));
    dbPath = join(dir, 'test.db');
  }
  await runScript('migrate.js', dbPath, ['migrate', 'runMigrations', 'run', 'up']);
  await runScript('seed.js', dbPath, ['seed', 'runSeed', 'run']);
  const mod = await import(pathToFileURL(APP_FILE).href);
  const createApp = mod.createApp ?? mod.default;
  assert.equal(typeof createApp, 'function', 'server/app.js must export createApp({dbPath})');
  const app = await createApp({ dbPath });
  assert.ok(app && typeof app.listen === 'function', 'createApp({dbPath}) must return an Express app');
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  return {
    dbPath,
    dir,
    app,
    server,
    port,
    client: new Client(base),
    newClient() {
      return new Client(base);
    },
    async close() {
      await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    },
  };
}

export async function loginAs(t, username, password) {
  const c = t.newClient();
  const r = await c.post('/api/admin/login', { json: { username, password } });
  await assertStatus(r, 200, `admin login for '${username}'`);
  return c;
}
