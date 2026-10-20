// Case 1: multi-game cart -> order. Items from 3 games with INDEPENDENT
// player_ids (+extra_value for mlbb). Verifies the order is created, the total
// is server-computed, and every item keeps its own per-game player ID.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  bootApp,
  listPackages,
  pickPackages,
  effectivePrice,
  expectedOrderTotal,
  readJson,
  uuid,
  withDb,
  assertStatus,
} from './helper.js';

describe('multi-game order with independent player IDs', () => {
  let t;
  before(async () => {
    t = await bootApp();
  });
  after(async () => {
    await t.close();
  });

  it('creates one order from 3 games; each item keeps its own player_id (+extra for mlbb)', async () => {
    const { freefire: ff, pubg, mlbb } = pickPackages(t.dbPath, ['freefire', 'pubg', 'mlbb']);
    const byId = new Map(listPackages(t.dbPath).map((p) => [p.id, p]));
    const items = [
      { game_id: 'freefire', package_id: ff.id, qty: 2, player_id: 'FF_PLAYER_1' },
      { game_id: 'pubg', package_id: pubg.id, qty: 1, player_id: 'PUBG_PLAYER_9' },
      { game_id: 'mlbb', package_id: mlbb.id, qty: 1, player_id: 'MLBB_777', extra_value: 'ZONE_42' },
    ];

    const res = await t.client.post('/api/orders', {
      json: { items, payment_method: 'ccp', customer_note: 'اختبار', idempotency_key: uuid() },
    });
    await assertStatus(res, 201, 'create multi-game order');
    const body = await readJson(res);
    assert.match(body.order_no, /^GS-\d{8}-[A-Z0-9]{4}$/);
    assert.equal(body.status, 'awaiting_payment');
    assert.equal(body.total_dzd, expectedOrderTotal(t.dbPath, items));
    assert.ok(body.payment && body.payment.account_number, 'order must include payment instructions');

    // Public track view: 3 items, correct per-game player IDs, server-computed prices
    const g = await t.client.get(`/api/orders/${body.order_no}`);
    assert.equal(g.status, 200);
    const det = await readJson(g);
    assert.equal(det.items.length, 3);
    const gotByPlayer = new Map(det.items.map((i) => [i.player_id, i]));
    for (const src of items) {
      const got = gotByPlayer.get(src.player_id);
      assert.ok(got, `item for player '${src.player_id}' must be present`);
      const unit = effectivePrice(t.dbPath, src.package_id, src.game_id, byId.get(src.package_id).price_dzd);
      assert.equal(got.unit_price, unit, `unit_price for ${src.player_id}`);
      assert.equal(got.line_total, unit * src.qty, `line_total for ${src.player_id}`);
    }

    // DB rows: game_id + player_id + extra_value stored per item
    const rows = withDb(t.dbPath, (db) =>
      db
        .prepare(
          `SELECT oi.game_id, oi.player_id, oi.extra_value
           FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.order_no = ?`,
        )
        .all(body.order_no),
    );
    assert.equal(rows.length, 3);
    const byGame = new Map(rows.map((r) => [r.game_id, r]));
    assert.equal(byGame.get('freefire').player_id, 'FF_PLAYER_1');
    assert.equal(byGame.get('pubg').player_id, 'PUBG_PLAYER_9');
    assert.equal(byGame.get('mlbb').player_id, 'MLBB_777');
    assert.equal(byGame.get('mlbb').extra_value, 'ZONE_42');
  });
});
