// Case 6: admin auth. Wrong password -> 401; unauthenticated admin call ->
// 401; 5 consecutive bad logins -> account locked (403); correct login works;
// logout -> subsequent admin call 401.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, createAdmin, readJson, assertArabicError, assertStatus } from './helper.js';

describe('admin auth', () => {
  let t;
  before(async () => {
    t = await bootApp();
    createAdmin(t.dbPath, 'admin', 'RightPassword123');
    createAdmin(t.dbPath, 'lockme', 'LockMePass123');
  });
  after(async () => {
    await t.close();
  });

  it('wrong password -> 401 with Arabic error', async () => {
    const c = t.newClient();
    const r = await c.post('/api/admin/login', { json: { username: 'admin', password: 'nope-wrong' } });
    assert.equal(r.status, 401);
    assertArabicError(await readJson(r), 'wrong password');
  });

  it('unauthenticated GET /api/admin/orders -> 401 with Arabic error', async () => {
    const c = t.newClient();
    const r = await c.get('/api/admin/orders');
    assert.equal(r.status, 401);
    assertArabicError(await readJson(r), 'unauthenticated admin call');
  });

  it('unauthenticated PATCH order status -> 401', async () => {
    const c = t.newClient();
    const r = await c.patch('/api/admin/orders/1/status', { json: { to: 'paid' } });
    assert.equal(r.status, 401);
    assertArabicError(await readJson(r), 'unauthenticated PATCH');
  });

  it('5 consecutive bad logins -> account locked (403), even with the right password', async () => {
    const c = t.newClient();
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const r = await c.post('/api/admin/login', { json: { username: 'lockme', password: `wrong-${i}` } });
      statuses.push(r.status);
    }
    assert.deepEqual(statuses.slice(0, 4), [401, 401, 401, 401], 'first 4 failures are 401');
    assert.ok([401, 403].includes(statuses[4]), `5th failure is 401 or 403, got ${statuses[4]}`);

    const locked = await c.post('/api/admin/login', { json: { username: 'lockme', password: 'LockMePass123' } });
    assert.equal(locked.status, 403, 'locked account must reject even the correct password');
    assertArabicError(await readJson(locked), 'locked account');
  });

  it('correct login works; failed-attempt counter resets on success', async () => {
    const c = t.newClient();
    const r = await c.post('/api/admin/login', { json: { username: 'admin', password: 'RightPassword123' } });
    await assertStatus(r, 200, 'correct login');
    assert.equal((await readJson(r)).username, 'admin');
    assert.ok(c.cookies.length > 0, 'login must set a session cookie');

    const me = await c.get('/api/admin/me');
    assert.equal(me.status, 200);
    assert.equal((await readJson(me)).username, 'admin');

    // One wrong attempt after a success is just a 401, not a lock (counter was reset)
    const bad = await c.post('/api/admin/login', { json: { username: 'admin', password: 'wrong-again' } });
    assert.equal(bad.status, 401);
  });

  it('logout -> subsequent admin call 401', async () => {
    const c = t.newClient();
    const r = await c.post('/api/admin/login', { json: { username: 'admin', password: 'RightPassword123' } });
    assert.equal(r.status, 200);
    const me1 = await c.get('/api/admin/me');
    assert.equal(me1.status, 200);

    const lo = await c.post('/api/admin/logout');
    assert.equal(lo.status, 200);

    const me2 = await c.get('/api/admin/me');
    assert.equal(me2.status, 401);
    assertArabicError(await readJson(me2), 'after logout');
  });
});
