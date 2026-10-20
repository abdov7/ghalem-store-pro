// Case 5: order lifecycle.
// create -> proof upload (transfer_ref) -> under_review -> admin accept (paid)
// -> ship (shipped); a second order -> reject with note; illegal transition
// (awaiting_payment -> shipped) -> 400; history + audit rows recorded.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  bootApp,
  createAdmin,
  loginAs,
  pickPackages,
  readJson,
  uuid,
  withDb,
  assertArabicError,
  assertStatus,
} from './helper.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('order lifecycle', () => {
  let t;
  let admin;
  before(async () => {
    t = await bootApp();
    createAdmin(t.dbPath, 'owner', 'OwnerPass1234');
    admin = await loginAs(t, 'owner', 'OwnerPass1234');
  });
  after(async () => {
    if (t) await t.close();
  });

  async function createOrder(playerId) {
    const { freefire: ff } = pickPackages(t.dbPath, ['freefire']);
    const res = await t.client.post('/api/orders', {
      json: {
        items: [{ game_id: 'freefire', package_id: ff.id, qty: 1, player_id: playerId }],
        payment_method: 'ccp',
        idempotency_key: uuid(),
      },
    });
    await assertStatus(res, 201, 'create lifecycle order');
    return (await readJson(res)).order_no;
  }

  async function adminOrderId(orderNo) {
    const r = await admin.get(`/api/admin/orders?q=${encodeURIComponent(orderNo)}&per_page=100`);
    await assertStatus(r, 200, 'admin order list');
    const { orders } = await readJson(r);
    const o = (orders || []).find((x) => x.order_no === orderNo);
    assert.ok(o, `order ${orderNo} must be visible to admin`);
    return o.id;
  }

  it('create -> proof -> under_review -> paid -> shipped, with history + audit', async () => {
    const orderNo = await createOrder('LIFE_ACCEPT');

    // Customer uploads payment proof (transfer_ref + receipt image)
    const form = new FormData();
    form.append('transfer_ref', 'CCP-2026-8841');
    form.append('receipt', new Blob([PNG], { type: 'image/png' }), 'receipt.png');
    const pr = await t.client.post(`/api/orders/${orderNo}/proof`, { form });
    await assertStatus(pr, 200, 'proof upload');
    assert.equal((await readJson(pr)).status, 'under_review');

    const id = await adminOrderId(orderNo);

    // Admin can download the receipt
    const rc = await admin.get(`/api/admin/orders/${id}/receipt`);
    assert.equal(rc.status, 200, 'admin receipt download must work');
    assert.match(rc.headers.get('content-type') || '', /image\/png/);

    // Admin accepts then ships
    const acc = await admin.patch(`/api/admin/orders/${id}/status`, {
      json: { to: 'paid', note: 'تم التأكيد' },
    });
    await assertStatus(acc, 200, 'accept (paid)');
    assert.equal((await readJson(acc)).status, 'paid');

    const sh = await admin.patch(`/api/admin/orders/${id}/status`, { json: { to: 'shipped' } });
    await assertStatus(sh, 200, 'ship (shipped)');
    assert.equal((await readJson(sh)).status, 'shipped');

    // Customer-visible status + Arabic label + history timeline
    const det = await readJson(await t.client.get(`/api/orders/${orderNo}`));
    assert.equal(det.status, 'shipped');
    assert.equal(det.status_ar, 'تم الشحن');
    const seq = det.history.map((h) => h.to_status);
    assert.deepEqual(
      seq.filter((s) => ['under_review', 'paid', 'shipped'].includes(s)),
      ['under_review', 'paid', 'shipped'],
      'history must show the transitions in order',
    );

    // DB history rows record every transition with the actor.
    // (The backend also records creation as NULL -> awaiting_payment.)
    const hist = withDb(t.dbPath, (db) =>
      db
        .prepare('SELECT from_status, to_status, changed_by FROM order_history WHERE order_id = ? ORDER BY id')
        .all(id),
    );
    assert.deepEqual(
      hist.map((h) => [h.from_status, h.to_status]),
      [
        [null, 'awaiting_payment'],
        ['awaiting_payment', 'under_review'],
        ['under_review', 'paid'],
        ['paid', 'shipped'],
      ],
    );
    assert.equal(hist[2].changed_by, 'owner');
    assert.equal(hist[3].changed_by, 'owner');

    // Admin actions are audited
    const audits = withDb(t.dbPath, (db) =>
      db.prepare('SELECT action FROM audit_log WHERE entity_id = ? OR entity_id = ?').all(String(id), orderNo),
    );
    assert.ok(audits.length >= 2, 'admin status changes must appear in audit_log');
  });

  it('reject with note from awaiting_payment', async () => {
    const orderNo = await createOrder('LIFE_REJECT');
    const id = await adminOrderId(orderNo);
    const r = await admin.patch(`/api/admin/orders/${id}/status`, {
      json: { to: 'rejected', note: 'إثبات غير واضح' },
    });
    await assertStatus(r, 200, 'reject with note');
    const det = await readJson(await t.client.get(`/api/orders/${orderNo}`));
    assert.equal(det.status, 'rejected');
    assert.equal(det.status_ar, 'مرفوض');
  });

  it('illegal transition awaiting_payment -> shipped -> 400 Arabic', async () => {
    const orderNo = await createOrder('LIFE_BAD');
    const id = await adminOrderId(orderNo);
    const r = await admin.patch(`/api/admin/orders/${id}/status`, { json: { to: 'shipped' } });
    assert.equal(r.status, 400);
    assertArabicError(await readJson(r), 'illegal transition');
  });

  it('proof upload on a non-awaiting order -> 409 Arabic', async () => {
    const orderNo = await createOrder('LIFE_409');
    const id = await adminOrderId(orderNo);
    const rej = await admin.patch(`/api/admin/orders/${id}/status`, { json: { to: 'rejected', note: 'x' } });
    assert.equal(rej.status, 200);
    const form = new FormData();
    form.append('transfer_ref', 'CCP-999');
    const r = await t.client.post(`/api/orders/${orderNo}/proof`, { form });
    assert.equal(r.status, 409);
    assertArabicError(await readJson(r), 'proof on rejected order');
  });
});
