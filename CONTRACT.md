# Ghalem Store Pro — Integration Contract

This file is the single source of truth for the full-stack rebuild. Backend, frontend,
and tests MUST follow it exactly. If a conflict arises, this file wins; the coordinator
resolves anything it does not cover.

## 0. Non-negotiable rules

- **ZERO real secrets in code/seeds/docs.** No real WhatsApp numbers, no real RIP/CCP
  numbers, no real passwords. Seeds use clearly-marked placeholders
  (e.g. `213XXXXXXXXX`, `RIP-PLACEHOLDER`). The owner enters real values via the
  admin panel after deployment.
- **Server is the authority on money.** Every total is recomputed server-side from DB
  prices. Browser-sent prices are ignored.
- **No fake data, ever.** No fake discounts, no fake ratings, no fake sales counts,
  no fake reviews. Discounts exist only as DB rows with real start/end dates.
- **Arabic-first.** All user-facing messages in Arabic (Algerian-friendly). RTL layout.
- Language/runtime: Node.js ≥ 22. DB: built-in `node:sqlite` (zero native deps).

## 1. Database (SQLite, file: `data/ghalem-store.db`)

Migrations in `server/migrate.js`, idempotent (CREATE TABLE IF NOT EXISTS).
Seeds in `server/seed.js`, idempotent (INSERT OR IGNORE / check-then-insert).

```sql
CREATE TABLE games(
  id TEXT PRIMARY KEY,            -- 'freefire' | 'pubg' | 'codm' | 'mlbb' | 'efootball' | 'roblox' | 'fortnite' | 'valorant'
  name_ar TEXT NOT NULL, name_en TEXT NOT NULL, short TEXT NOT NULL,
  unit_ar TEXT NOT NULL,          -- 'جوهرة' | 'UC' | ...
  id_label TEXT NOT NULL,         -- 'معرّف اللاعب (UID)' | 'اسم المستخدم (Username)' | 'Riot ID' ...
  extra_label TEXT,               -- NULL or e.g. 'معرّف المنطقة (Zone ID)'
  cover_file TEXT NOT NULL,       -- 'freefire.webp' (under /assets/covers/)
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE packages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL REFERENCES games(id),
  label_ar TEXT NOT NULL,          -- '310 جوهرة'
  amount_label TEXT NOT NULL,      -- '310'
  price_dzd INTEGER NOT NULL,      -- integer dinars, no decimals
  is_hot INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE discounts(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL CHECK(scope IN ('package','game')),
  package_id INTEGER REFERENCES packages(id),   -- set when scope='package'
  game_id TEXT REFERENCES games(id),            -- set when scope='game'
  percent INTEGER NOT NULL CHECK(percent BETWEEN 1 AND 90),
  starts_at TEXT NOT NULL,        -- ISO 8601 UTC
  ends_at TEXT NOT NULL,          -- ISO 8601 UTC
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT NOT NULL UNIQUE,  -- 'GS-YYYYMMDD-XXXX' (XXXX = 4 upper alnum, crypto random; retry on collision)
  status TEXT NOT NULL DEFAULT 'awaiting_payment'
    CHECK(status IN ('awaiting_payment','under_review','paid','shipped','rejected')),
  total_dzd INTEGER NOT NULL,
  payment_method TEXT NOT NULL CHECK(payment_method IN ('ccp','baridimob')),
  transfer_ref TEXT,
  receipt_path TEXT,              -- relative path under data/uploads, NULL until uploaded
  customer_note TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL  -- ISO 8601 UTC
);

CREATE TABLE order_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  game_id TEXT NOT NULL, package_id INTEGER NOT NULL,
  label_snapshot TEXT NOT NULL,        -- denormalized at order time
  unit_price_snapshot INTEGER NOT NULL, -- effective price paid (after discount)
  qty INTEGER NOT NULL,
  line_total INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  extra_value TEXT
);

CREATE TABLE order_history(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status TEXT, to_status TEXT NOT NULL,
  changed_by TEXT NOT NULL,       -- admin username or 'customer' or 'system'
  note TEXT, created_at TEXT NOT NULL
);

CREATE TABLE admins(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  pw_hash TEXT NOT NULL,          -- 'scrypt$N$r$p$saltHex$keyHex' via node:crypto scrypt
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,              -- ISO 8601 UTC or NULL
  created_at TEXT NOT NULL
);

CREATE TABLE idempotency_keys(
  key TEXT PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id),
  created_at TEXT NOT NULL
);

CREATE TABLE settings(
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
-- keys: store_name, whatsapp_number, support_text,
--       pay_ccp_label, pay_ccp_number, pay_baridimob_label, pay_baridimob_number,
--       payment_instructions_ar
-- ALL seeded with PLACEHOLDERS, e.g. whatsapp_number='213XXXXXXXXX'

CREATE TABLE audit_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER, action TEXT NOT NULL, entity TEXT, entity_id TEXT,
  detail TEXT, ip TEXT, created_at TEXT NOT NULL
);

CREATE TABLE sessions(
  sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expire INTEGER NOT NULL
);  -- express-session custom SQLite store
```

### Effective price rule (single implementation, server-side)
For a package at time T: candidates = active discounts where
(scope='package' AND package_id=?) OR (scope='game' AND game_id=?),
starts_at <= T <= ends_at. Take MAX(percent), default 0.
`effective = Math.round(base * (1 - pct/100) / 50) * 50` (round to nearest 50 DZD).

### Order status transitions (enforced server-side)
```
awaiting_payment -> under_review | rejected
under_review     -> paid | rejected | awaiting_payment
paid             -> shipped
shipped          -> (terminal)
rejected         -> (terminal)
```
Every transition writes `order_history` + `audit_log` (admin actions).

## 2. HTTP API (JSON; errors: `{ "error": "<Arabic message>" }`)

### Public (`/api/...`, rate limit 120 req/min/IP)
- `GET /api/health` → `{"ok":true,"now":"<iso>"}`
- `GET /api/games` → `[{id,name_ar,name_en,short,unit_ar,id_label,extra_label,cover_url,
  packages:[{id,label_ar,amount_label,price_dzd,old_price_dzd|null,discount_pct|null,is_hot}]}]`
  Only `active=1` games/packages. `old_price_dzd`/`discount_pct` present ONLY when a
  real discount row applies now; otherwise null. No ratings, no sold counts.
- `GET /api/games/:id` → same shape, single game. 404 `{error:'اللعبة غير موجودة'}`.
- `GET /api/settings/public` → `{store_name, whatsapp_number, support_text}`.
- `POST /api/orders` — body:
  `{items:[{game_id,package_id,qty,player_id,extra_value?}], payment_method, customer_note?, idempotency_key}`
  Rules: 1–20 items; qty int 1–10; package must exist, be active, and belong to
  game_id; player_id required, 3–64 chars, `/^[\p{L}\p{N} _\-#.,@]{3,64}$/u`;
  extra_value optional ≤64 same charset; payment_method ∈ ccp|baridimob;
  customer_note ≤500; idempotency_key = UUID v4.
  Server recomputes every line total from DB (effective prices). On duplicate
  idempotency_key → `200` with the ORIGINAL order (no new order).
  Success `201`: `{order_no,status:'awaiting_payment',total_dzd,items:[...],
  payment:{method,instructions,account_label,account_number},created_at}`.
  Validation failure → `400 {error:'...'}` in Arabic. Rate limit 20/min/IP.
- `GET /api/orders/:order_no` → `{order_no,status,status_ar,total_dzd,
  items:[{game_name_ar,package_label,qty,unit_price,line_total,player_id}],
  payment_method,transfer_ref_set:bool,created_at,updated_at,
  history:[{to_status,to_status_ar,at}]}`. 404 for unknown. No admin notes exposed.
- `POST /api/orders/:order_no/proof` (multipart/form-data) —
  fields: `transfer_ref` (4–64 chars, required), `receipt` (optional file:
  image/jpeg|png|webp, ≤3MB). Only when status=`awaiting_payment`,
  else `409 {error:'لا يمكن إرفاق إثبات الدفع لهذا الطلب الآن'}`.
  Sets status `under_review`, stores receipt at
  `data/uploads/<order_no>-<random>.ext` (NOT under public/). → `{ok:true,status:'under_review'}`.

`status_ar` map: awaiting_payment='بانتظار الدفع', under_review='قيد مراجعة الدفع',
paid='تم الدفع', shipped='تم الشحن', rejected='مرفوض'.

### Admin (`/api/admin/...`, require session; else `401 {error:'غير مصرح — سجل الدخول أولاً'}`)
- `POST /api/admin/login` {username,password} → `{ok:true,username}` + session cookie.
  Rate limit 10 attempts/15min per IP. Wrong credentials → `401 {error:'بيانات الدخول غير صحيحة'}`.
  5 consecutive failures on an account → lock 15 min (`403 {error:'الحساب مقفل مؤقتاً...'}`).
  Successful login resets counters. Every attempt → audit_log.
- `POST /api/admin/logout` → destroys session.
- `GET /api/admin/me` → `{username}`.
- `POST /api/admin/password` {current,new} — new ≥ 10 chars → `{ok:true}`.
- `GET /api/admin/orders?status=&q=&from=&to=&page=&per_page=` (per_page ≤100)
  → `{orders:[{id,order_no,status,total_dzd,payment_method,created_at}],page,total}`.
  q matches order_no or transfer_ref (LIKE, escaped).
- `GET /api/admin/orders/:id` → full order incl. items with player_ids,
  receipt availability flag, history, audit entries for this order.
- `GET /api/admin/orders/:id/receipt` → file download (admin only). 404 if none.
- `PATCH /api/admin/orders/:id/status` {to,note?} — validates transition map;
  records history + audit with admin username + timestamp. → `{ok:true,status}`.
- `GET/POST /api/admin/games` · `PUT /api/admin/games/:id` (incl. active toggle)
- `GET/POST /api/admin/packages` · `PUT /api/admin/packages/:id`
- `GET/POST /api/admin/discounts` · `PUT /api/admin/discounts/:id` · `DELETE /api/admin/discounts/:id`
- `GET /api/admin/settings` → `{key:value}` all · `PUT /api/admin/settings` {key:value...} (whitelist keys)
- `GET /api/admin/audit-log?page=` → entries desc.

All admin mutations → audit_log (admin_id, action, entity, entity_id, ip).

## 3. Security middleware (server/middleware/)
- `securityHeaders`: X-Content-Type-Options: nosniff; X-Frame-Options: DENY;
  Referrer-Policy: no-referrer; basic CSP for self.
- `rateLimit`: in-memory token bucket per IP per route-group.
- `requireAdmin`: session check → 401 JSON.
- `validate`: shared validators (playerId, qty, etc.) used by routes.
- Sessions: express-session + custom SQLite store (server/session-store.js);
  cookie httpOnly, SameSite=Lax, Secure=auto (on when req.secure / trust proxy),
  maxAge 12h. `SESSION_SECRET` from env (fail fast if missing in production).

## 4. Conventions
- Time: ISO 8601 UTC strings in DB/API.
- Money: integer DZD everywhere.
- Errors: `{error:'<Arabic>'}`; never leak stack traces or SQL to clients.
- Logging: `server/logger.js` — timestamped lines to stdout; never log passwords,
  hashes, session ids, or full settings values.
- Env (`process.env`): PORT, SESSION_SECRET, DB_PATH (default ./data/ghalem-store.db),
  UPLOAD_DIR, ADMIN_RATE_LIMIT_*, NODE_ENV. `.env.example` lists names only.

## 5. Frontend expectations (public/)
Single-page app: views home / games / game / deals / checkout / track / help.
- Catalog ONLY from `GET /api/games` (never hardcoded prices).
- Cart: `localStorage 'gspro-cart'` = `[{game_id,package_id,qty}]` — NO player IDs stored.
  Qty +/−, remove, clear. Totals shown are estimates; server total is authoritative.
- Checkout: group items by game; one player_id (+extra) input PER GAME;
  validate client-side, re-validated server-side. Double-submit protection:
  disable button + UUID idempotency_key per attempt.
- After order: show payment instructions + account number from order response;
  transfer_ref + receipt upload form → POST proof.
- Track page: order_no input → GET /api/orders/:order_no → status timeline.
- Keep visual identity: light clean theme, orange brand, Arabic RTL, game cards
  with covers, Layla mascot (simplified: corner float + blink + tips + help panel
  + voice clips on user gesture + occasional walk), WebAudio UI sounds + mute.
- NEVER innerHTML with customer/order data — use textContent / escape helper.

## 6. Admin SPA (public/admin/)
Login → tabs: الطلبات (table + filters + detail drawer + status actions),
المنتجات (games/packages CRUD), الخصومات (CRUD with dates), الإعدادات (settings form),
سجل التدقيق. All fetch with `credentials:'same-origin'`. Escape all rendered data.

## 7. Tests (tests/, node:test, zero extra deps)
Must cover: multi-game cart w/ independent player IDs; price-tampering rejection
(send wrong totals → server total wins / 400); invalid input rejection; double-submit
(idempotency_key twice → one order); order lifecycle incl. manual accept/reject;
admin auth (wrong pw 401, unauthenticated /api/admin/* 401, locked account 403);
session logout; persistence across restart (reopen DB file). Tests boot the real
Express app with a temp DB file and use fetch().
