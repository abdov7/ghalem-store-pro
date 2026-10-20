// Case 4: double-submit. The same idempotency_key twice -> exactly ONE order
// in the DB; the second response returns the ORIGINAL order_no.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, pickPackages, readJson, uuid, withDb, assertStatus } from './helper.js';

describe('idempotent order submission', () => {
  let t;
  before(async () => {
    t = await bootApp();
  });
  after(async () => {
    await t.close();
  });

  it('same idempotency_key twice -> one order; second returns the original order_no', async () => {
    const { freefire: ff } = pickPackages(t.dbPath, ['freefire']);
    const key = uuid();
    const payload = () => ({
      items: [{ game_id: 'freefire', package_id: ff.id, qty: 2, player_id: 'IDEMP1' }],
      payment_method: 'ccp',
      idempotency_key: key,
    });

    const r1 = await t.client.post('/api/orders', { json: payload() });
    await assertStatus(r1, 201, 'first submit');
    const b1 = await readJson(r1);

    const r2 = await t.client.post('/api/orders', { json: payload() });
    await assertStatus(r2, 200, 'second submit (idempotent replay)');
    const b2 = await readJson(r2);

    assert.equal(b2.order_no, b1.order_no, 'second response must return the ORIGINAL order_no');
    assert.equal(b2.total_dzd, b1.total_dzd);

    const n = withDb(t.dbPath, (db) => db.prepare('SELECT COUNT(*) c FROM orders').get().c);
    assert.equal(n, 1, 'exactly one order must exist in the DB');

    const keys = withDb(t.dbPath, (db) =>
      db.prepare('SELECT COUNT(*) c FROM idempotency_keys WHERE key = ?').get(key).c,
    );
    assert.equal(keys, 1);
  });
});
