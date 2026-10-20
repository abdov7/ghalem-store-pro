// Case 2: price tampering. A smuggled unit_price (or fake totals) must be
// ignored — the server recomputes every line from DB prices. Unknown or
// mismatched package_id -> 400 with an Arabic error.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  bootApp,
  pickPackages,
  effectivePrice,
  readJson,
  uuid,
  withDb,
  assertArabicError,
  assertStatus,
} from './helper.js';

describe('price tampering', () => {
  let t;
  before(async () => {
    t = await bootApp();
  });
  after(async () => {
    await t.close();
  });

  it('ignores a smuggled unit_price; total is recomputed from DB prices', async () => {
    const { freefire: ff } = pickPackages(t.dbPath, ['freefire']);
    const res = await t.client.post('/api/orders', {
      json: {
        items: [
          {
            game_id: 'freefire',
            package_id: ff.id,
            qty: 3,
            player_id: 'HACKER1',
            unit_price: 1, // smuggled fake price — must be ignored
            line_total: 3,
          },
        ],
        payment_method: 'baridimob',
        idempotency_key: uuid(),
      },
    });
    await assertStatus(res, 201, 'tampered-price order');
    const body = await readJson(res);
    const unit = effectivePrice(t.dbPath, ff.id, 'freefire', ff.price_dzd);
    const expected = unit * 3;
    assert.equal(body.total_dzd, expected, 'server total must win over the tampered price');
    assert.ok(expected > 3, 'real total must dwarf the tampered 1 DZD');

    const stored = withDb(t.dbPath, (db) =>
      db
        .prepare(
          `SELECT oi.unit_price_snapshot, oi.line_total FROM order_items oi
           JOIN orders o ON o.id = oi.order_id WHERE o.order_no = ?`,
        )
        .get(body.order_no),
    );
    assert.equal(stored.unit_price_snapshot, unit);
    assert.equal(stored.line_total, expected);
  });

  it('unknown package_id -> 400 with Arabic error', async () => {
    const res = await t.client.post('/api/orders', {
      json: {
        items: [{ game_id: 'freefire', package_id: 999999, qty: 1, player_id: 'ABC123' }],
        payment_method: 'ccp',
        idempotency_key: uuid(),
      },
    });
    assert.equal(res.status, 400);
    assertArabicError(await readJson(res), 'unknown package_id');
  });

  it('package_id belonging to another game -> 400 with Arabic error', async () => {
    const { freefire: ff } = pickPackages(t.dbPath, ['freefire']);
    const res = await t.client.post('/api/orders', {
      json: {
        items: [{ game_id: 'pubg', package_id: ff.id, qty: 1, player_id: 'ABC123' }],
        payment_method: 'ccp',
        idempotency_key: uuid(),
      },
    });
    assert.equal(res.status, 400);
    assertArabicError(await readJson(res), 'package/game mismatch');
  });
});
