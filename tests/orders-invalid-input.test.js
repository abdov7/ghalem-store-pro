// Case 3: invalid input -> 400 with an Arabic error, and no order is created.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  bootApp,
  pickPackages,
  readJson,
  uuid,
  withDb,
  assertArabicError,
  assertStatus,
} from './helper.js';

describe('invalid order input', () => {
  let t;
  let ff;
  before(async () => {
    t = await bootApp();
    ({ freefire: ff } = pickPackages(t.dbPath, ['freefire']));
  });
  after(async () => {
    await t.close();
  });

  const baseBody = () => ({
    items: [{ game_id: 'freefire', package_id: ff.id, qty: 1, player_id: 'VALID123' }],
    payment_method: 'ccp',
    idempotency_key: uuid(),
  });

  const CASES = [
    ['empty player_id', (b) => { b.items[0].player_id = ''; }],
    ['player_id too short', (b) => { b.items[0].player_id = 'ab'; }],
    ['player_id too long (65 chars)', (b) => { b.items[0].player_id = 'x'.repeat(65); }],
    ['player_id illegal chars', (b) => { b.items[0].player_id = 'HACK$%!'; }],
    ['qty 0', (b) => { b.items[0].qty = 0; }],
    ['qty 99 (over max 10)', (b) => { b.items[0].qty = 99; }],
    ['qty non-integer', (b) => { b.items[0].qty = 2.5; }],
    ['empty items array', (b) => { b.items = []; }],
    ['21 items (over max 20)', (b) => {
      b.items = Array.from({ length: 21 }, (_, i) => ({
        game_id: 'freefire', package_id: ff.id, qty: 1,
        player_id: `P${String(i).padStart(3, '0')}`,
      }));
    }],
    ['bad payment_method', (b) => { b.payment_method = 'cash'; }],
    ['bad idempotency_key', (b) => { b.idempotency_key = 'not-a-uuid'; }],
    ['customer_note over 500 chars', (b) => { b.customer_note = 'n'.repeat(501); }],
  ];

  for (const [name, mutate] of CASES) {
    it(`${name} -> 400 Arabic error`, async () => {
      const body = baseBody();
      mutate(body);
      const res = await t.client.post('/api/orders', { json: body });
      await assertStatus(res, 400, name);
      assertArabicError(await readJson(res), name);
    });
  }

  it('no order was persisted by any invalid attempt', async () => {
    const n = withDb(t.dbPath, (db) => db.prepare('SELECT COUNT(*) c FROM orders').get().c);
    assert.equal(n, 0, 'invalid attempts must not create orders');
  });
});
