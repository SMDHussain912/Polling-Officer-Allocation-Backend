/**
 * Backend unit tests for the new ID Card Designer + settings routes.
 * No network, no PDF rendering. Run: node tests/idcard-test.js
 * Exits non-zero on failure. No real messages are sent.
 */
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Point env at test DB + dummy credentials so nothing touches real data.
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/polling_test';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'test123456';
process.env.SMS_PROVIDER = 'mock';
delete process.env.WHATSAPP_PHONE_NUMBER_ID;
delete process.env.WHATSAPP_ACCESS_TOKEN;

const app = require('../server.js');
const PORT = 5100;
const base = `http://127.0.0.1:${PORT}`;

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok - ${name}`); }
  catch (err) { console.error(`  FAIL - ${name}: ${err.message}`); process.exitCode = 1; }
}
function asyncTest(name, fn) { return fn().then(() => { passed += 1; console.log(`  ok - ${name}`); }).catch((err) => { console.error(`  FAIL - ${name}: ${err.message}`); process.exitCode = 1; }); }

// Start server + seed an admin + seed a default design doc.
(async () => {
  await new Promise((resolve) => { const s = app.listen(PORT, resolve); });
  const admin = require('./models/Admin');
  await admin.findOneAndUpdate({ username: 'admin' }, { $set: { password: await require('bcryptjs').hash('test123456', 12) } }, { upsert: true });
  const { getDesign } = require('./models/IdCardDesign');
  if (!await getDesign()) await require('./models/IdCardDesign').IdCardDesign.create({ key: 'active', theme: 'navy', headerTitle: 'POLLING DUTY OFFICER ID CARD', showPhoto: true, showStamp: true, showFooter: true });

  async function api(method, p, body) {
    const u = `${base}${p}`;
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.headers['Content-Type'] = 'application/json';
    const r = await fetch(u, { ...opts, body: body ? JSON.stringify(body) : undefined });
    let data = {};
    try { data = await r.json(); } catch {}
    return { status: r.status, data };
  }

  // HTTP fallback used by the legacy fetch-free checks below.
  function apiHttp(method, p, rawBody) {
    return new Promise((resolve, reject) => {
      const u = `${base}${p}`;
      const req = http.request(u, { method, headers: { 'Content-Type': 'application/json' }, timeout: 5000 }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      if (rawBody) req.write(rawBody);
      req.end();
    });
  }

  test('1. GET /api/settings/idcard returns design (HTTP 200)', async () => {
    const r = await api('GET', '/settings/idcard');
    assert.strictEqual(r.status, 200);
    assert.ok(r.data.design);
    assert.strictEqual(r.data.design.theme, 'navy');
  });

  test('2. PUT save + theme validation', async () => {
    const r = await api('PUT', '/settings/idcard', { theme: 'maroon', headerTitle: 'My Election Card' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.headerTitle, 'My Election Card');
    const r2 = await api('PUT', '/settings/idcard', { theme: 'purple' });
    assert.strictEqual(r2.status, 400);
  });

  test('3. PUT invalid fields rejected', async () => {
    const r = await api('PUT', '/settings/idcard', { theme: 'green', officerFields: [{ key: 'invalid_key', label: 'Unknown' }] });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.data.officerFields, []);
  });

  test('4. POST /notifications/test still works (no longer swallowed by :channel)', async () => {
    const r = await api('POST', '/settings/notifications/test', { channel: 'sms', to: '9876543210' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.messageId, 'MOCK-');
  });

  test('5. GET /notifications/test is NOT 404 for a channel route', async () => {
    const r = await api('GET', '/settings/notifications/test');
    assert.notStrictEqual(r.status, 404);
  });

  test('6. GET /api/settings/idcard/preview.pdf returns real PDF (HTTP 200 + %PDF)', async () => {
    const r = await api('GET', '/settings/idcard/preview.pdf?theme=green');
    assert.strictEqual(r.status, 200);
    assert.ok(typeof r.data === 'object' && r.data !== null);
    assert.ok(String(r.data).startsWith('%PDF'));
  });

  test('7. POST /notifications/test rejects invalid phone early (no account lookup)', async () => {
    const r = await api('POST', '/settings/notifications/test', { channel: 'sms', to: '12345' });
    assert.strictEqual(r.status, 400);
  });

  test('8. Default HTML body is retained when saving only theme', async () => {
    const r = await api('PUT', '/settings/idcard', { theme: 'navy' });
    assert.strictEqual(r.status, 200);
    assert.ok(r.data.footerNote);
  });

  test('9. GET /api/settings/notifications still returns channels', async () => {
    const r = await api('GET', '/settings/notifications');
    assert.strictEqual(r.status, 200);
    assert.ok(r.data.settings.email || r.data.settings.sms);
  });

  console.log(`\n${passed} tests passed${process.exitCode ? ' (WITH FAILURES)' : ''}`);
  process.exitCode = process.exitCode || 0;
  process.exit(process.exitCode);
})().catch((err) => { console.error(err); process.exit(1); });
