// Case 7: discounts. A discount row inserted directly in the DB (active,
// 20%, valid now) must surface in GET /api/games (old_price_dzd +
// discount_pct) and the order must use the discounted total. An expired
// discount must have no effect.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  bootApp,
  insertDiscount,
  isoDaysFromNow,
  listPackages,
  readJson,
  uuid,
  assertStatus,
} from './helper.js';

const eff = (base, pct) => Math.round((base * (1 - pct / 100)) / 50) * 50;

describe('discounts', () => {
  let t;
  after(async () => {
    if (t) await t.close();
  });

  it('active game discount shows old_price_dzd + discount_pct and order uses the discounted total', async () => {
    t = await bootApp();
    try {
      const seedPkgs = listPackages(t.dbPath).filter((p) => p.game_id === 'freefire');
      assert.ok(seedPkgs.length > 0, 'seed must include freefire packages');

      insertDiscount(t.dbPath, {
        scope: 'game',
        game_id: 'freefire',
        percent: 20,
        starts_at: isoDaysFromNow(-1),
        ends_at: isoDaysFromNow(1),
      });

      const res = await t.client.get('/api/games');
      assert.equal(res.status, 200);
      const games = await readJson(res);
      const g = games.find((x) => x.id === 'freefire');
      assert.ok(g, 'freefire must be listed');
      assert.ok(g.packages.length > 0);
      for (const p of g.packages) {
        const base = seedPkgs.find((s) => s.id === p.id).price_dzd;
        assert.equal(p.old_price_dzd, base, `package ${p.id}: old_price_dzd must be the base price`);
        assert.equal(p.discount_pct, 20, `package ${p.id}: discount_pct`);
        assert.equal(p.price_dzd, eff(base, 20), `package ${p.id}: discounted price`);
      }

      // Order total uses the discounted price
      const item = { game_id: 'freefire', package_id: seedPkgs[0].id, qty: 2, player_id: 'DISC1' };
      const or = await t.client.post('/api/orders', {
        json: { items: [item], payment_method: 'ccp', idempotency_key: uuid() },
      });
      await assertStatus(or, 201, 'discounted order');
      assert.equal((await readJson(or)).total_dzd, eff(seedPkgs[0].price_dzd, 20) * 2);
    } finally {
      await t.close();
      t = null;
    }
  });

  it('active package-scoped discount applies only to that package', async () => {
    t = await bootApp();
    try {
      const seedPkgs = listPackages(t.dbPath).filter((p) => p.game_id === 'freefire');
      const target = seedPkgs[0];
      insertDiscount(t.dbPath, {
        scope: 'package',
        package_id: target.id,
        percent: 10,
        starts_at: isoDaysFromNow(-1),
        ends_at: isoDaysFromNow(1),
      });

      const g = (await readJson(await t.client.get('/api/games'))).find((x) => x.id === 'freefire');
      for (const p of g.packages) {
        const base = seedPkgs.find((s) => s.id === p.id).price_dzd;
        if (p.id === target.id) {
          assert.equal(p.discount_pct, 10);
          assert.equal(p.old_price_dzd, base);
          assert.equal(p.price_dzd, eff(base, 10));
        } else {
          assert.equal(p.discount_pct, null, `package ${p.id} must have no discount`);
          assert.equal(p.old_price_dzd, null, `package ${p.id} must have no old price`);
          assert.equal(p.price_dzd, base);
        }
      }
    } finally {
      await t.close();
      t = null;
    }
  });

  it('expired discount is not applied anywhere', async () => {
    t = await bootApp();
    try {
      const seedPkgs = listPackages(t.dbPath).filter((p) => p.game_id === 'freefire');
      insertDiscount(t.dbPath, {
        scope: 'game',
        game_id: 'freefire',
        percent: 20,
        starts_at: isoDaysFromNow(-10),
        ends_at: isoDaysFromNow(-1), // ended yesterday
      });

      const g = (await readJson(await t.client.get('/api/games'))).find((x) => x.id === 'freefire');
      for (const p of g.packages) {
        const base = seedPkgs.find((s) => s.id === p.id).price_dzd;
        assert.equal(p.old_price_dzd, null, `package ${p.id}: no old price when discount expired`);
        assert.equal(p.discount_pct, null, `package ${p.id}: no discount_pct when expired`);
        assert.equal(p.price_dzd, base);
      }

      const item = { game_id: 'freefire', package_id: seedPkgs[0].id, qty: 1, player_id: 'DISC2' };
      const or = await t.client.post('/api/orders', {
        json: { items: [item], payment_method: 'ccp', idempotency_key: uuid() },
      });
      assert.equal(or.status, 201);
      assert.equal((await readJson(or)).total_dzd, seedPkgs[0].price_dzd, 'full price when discount expired');
    } finally {
      await t.close();
      t = null;
    }
  });

  it('no discount rows seeded -> no discount fields on any package', async () => {
    t = await bootApp();
    try {
      const games = await readJson(await t.client.get('/api/games'));
      for (const g of games) {
        for (const p of g.packages) {
          assert.equal(p.old_price_dzd, null, `${g.id}/${p.id}: old_price_dzd must be null without discounts`);
          assert.equal(p.discount_pct, null, `${g.id}/${p.id}: discount_pct must be null without discounts`);
        }
      }
    } finally {
      await t.close();
      t = null;
    }
  });
});
