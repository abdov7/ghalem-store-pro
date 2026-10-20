// Case 9: public settings. /api/settings/public must expose placeholders
// ONLY — no real-looking digit runs (RIP/CCP numbers, phone numbers).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, readJson } from './helper.js';

describe('public settings placeholders', () => {
  let t;
  before(async () => {
    t = await bootApp();
  });
  after(async () => {
    await t.close();
  });

  it('/api/settings/public contains no real digits (placeholders only)', async () => {
    const res = await t.client.get('/api/settings/public');
    assert.equal(res.status, 200);
    const b = await readJson(res);

    for (const k of ['store_name', 'whatsapp_number', 'support_text']) {
      assert.ok(k in b, `public settings must include '${k}'`);
    }
    // Payment account numbers must NOT be public
    assert.ok(!('pay_ccp_number' in b), 'CCP number must not be public');
    assert.ok(!('pay_baridimob_number' in b), 'BaridiMob number must not be public');

    const blob = [b.store_name, b.whatsapp_number, b.support_text].filter(Boolean).join(' | ');
    assert.ok(
      !/\d{6,}/.test(blob),
      `no run of 6+ digits allowed in public settings, got: ${blob.slice(0, 120)}`,
    );
    assert.ok(
      /X/.test(String(b.whatsapp_number)),
      `whatsapp_number must be a masked placeholder, got: ${b.whatsapp_number}`,
    );
  });
});
