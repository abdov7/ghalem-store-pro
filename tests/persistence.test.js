// Case 8: persistence. Create an order, close the app, reopen a NEW app
// instance on the SAME db file -> the order is still there (via the API and
// via a direct read of the file on disk).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootApp, pickPackages, readJson, uuid, withDb, assertStatus } from './helper.js';

describe('persistence across restart', () => {
  it('order survives closing the app and reopening the same DB file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghalem-persist-'));
    const dbPath = join(dir, 'persist.db');

    const a1 = await bootApp({ dbPath });
    let a2 = null;
    try {
      const { freefire: ff } = pickPackages(dbPath, ['freefire']);
      const r = await a1.client.post('/api/orders', {
        json: {
          items: [{ game_id: 'freefire', package_id: ff.id, qty: 1, player_id: 'PERSIST1' }],
          payment_method: 'baridimob',
          idempotency_key: uuid(),
        },
      });
      await assertStatus(r, 201, 'create persistent order');
      const { order_no, total_dzd } = await readJson(r);
      await a1.close();

      // Direct read of the file on disk: the order must be durable without any app running
      const row = withDb(dbPath, (db) =>
        db.prepare('SELECT order_no, status, total_dzd FROM orders WHERE order_no = ?').get(order_no),
      );
      assert.ok(row, 'order must be on disk after close');
      assert.equal(row.status, 'awaiting_payment');
      assert.equal(row.total_dzd, total_dzd);

      // New app instance on the same file serves the order again
      a2 = await bootApp({ dbPath });
      const g = await a2.client.get(`/api/orders/${order_no}`);
      assert.equal(g.status, 200);
      const det = await readJson(g);
      assert.equal(det.order_no, order_no);
      assert.equal(det.status, 'awaiting_payment');
      assert.equal(det.total_dzd, total_dzd);
      assert.equal(det.items[0].player_id, 'PERSIST1');
    } finally {
      await a1.close().catch(() => {});
      if (a2) await a2.close().catch(() => {});
    }
  });
});
