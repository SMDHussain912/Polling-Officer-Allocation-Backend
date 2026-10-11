/**
 * Unit tests (no DB, no network): phone validation, template rendering,
 * WhatsApp payload building, MSG91 error mapping. Run: node tests/notify.test.js
 * Exits non-zero on failure. No real messages are ever sent.
 */
const assert = require('assert');
const { normalizePhone, toWhatsAppRecipient } = require('../services/phoneUtil');
const templateService = require('../services/templateService');
const whatsappService = require('../services/whatsappService');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}
function asyncTest(name, fn) {
  return fn()
    .then(() => { passed += 1; console.log(`  ok - ${name}`); })
    .catch((err) => { console.error(`  FAIL - ${name}: ${err.message}`); process.exitCode = 1; });
}

(async () => {
  console.log('notify.test.js');

  test('10-digit Indian mobile normalizes to +91 E.164', () => {
    const r = normalizePhone('98765 43210');
    assert.strictEqual(r.valid, true);
    assert.strictEqual(r.e164, '+919876543210');
  });
  test('91-prefixed and +91 numbers normalize', () => {
    assert.strictEqual(normalizePhone('919876543210').e164, '+919876543210');
    assert.strictEqual(normalizePhone('+919876543210').e164, '+919876543210');
  });
  test('bad numbers rejected (never retried)', () => {
    assert.strictEqual(normalizePhone('12345').valid, false);
    assert.strictEqual(normalizePhone('').valid, false);
    assert.strictEqual(normalizePhone('abcdefghij').valid, false);
  });
  test('WhatsApp recipient strips +', () => {
    assert.strictEqual(toWhatsAppRecipient({ e164: '+919876543210' }), '919876543210');
  });

  test('template renders allocation vars', () => {
    const out = templateService.renderTemplate('Dear {{officerName}}, booth {{boothNumber}} ({{boothName}}), {{mandal}}.', {
      officerName: 'Ravi', boothNumber: '12', boothName: 'ZPH School', mandal: 'Guntur East',
    });
    assert.strictEqual(out, 'Dear Ravi, booth 12 (ZPH School), Guntur East.');
  });
  test('unknown vars left untouched', () => {
    assert.strictEqual(templateService.renderTemplate('Hi {{nope}}', {}), 'Hi {{nope}}');
  });
  test('templateVars pulls officer + booth + allocation', () => {
    const v = templateService.templateVars(
      { officer: { officerName: 'Ravi' }, booth: { boothNumber: '5', boothName: 'School' }, mandal: 'East', status: 'ALLOCATED' },
      { cardUrl: 'http://x', reportingDate: '10-May' }
    );
    assert.strictEqual(v.officerName, 'Ravi');
    assert.strictEqual(v.boothNumber, '5');
    assert.strictEqual(v.reportingDate, '10-May');
  });

  test('hello_world payload matches Meta spec', () => {
    const p = whatsappService.buildHelloWorldPayload('919876543210');
    assert.deepStrictEqual(p, {
      messaging_product: 'whatsapp',
      to: '919876543210',
      type: 'template',
      template: { name: 'hello_world', language: { code: 'en_US' } },
    });
  });
  test('allocation payload maps ordered body params', () => {
    const p = whatsappService.buildAllocationPayload('919876543210', { name: 'polling_duty_allocation', language: 'en_US', bodyParams: ['officerName', 'boothNumber'] }, { officerName: 'Ravi', boothNumber: '12' });
    assert.strictEqual(p.template.name, 'polling_duty_allocation');
    assert.deepStrictEqual(p.template.components, [{ type: 'body', parameters: [{ type: 'text', text: 'Ravi' }, { type: 'text', text: '12' }] }]);
  });

  await asyncTest('invalid WhatsApp number throws INVALID_PHONE (no network)', async () => {
    try {
      await whatsappService.sendTemplate({ to: '123', templateName: 'hello_world', languageCode: 'en_US', params: [] });
      throw new Error('should have thrown');
    } catch (err) {
      assert.strictEqual(err.code, 'INVALID_PHONE');
    }
  });
  await asyncTest('missing WhatsApp credentials throw without network', async () => {
    const prevId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const prevTok = process.env.WHATSAPP_ACCESS_TOKEN;
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    try {
      await whatsappService.sendHelloWorld('9876543210');
      throw new Error('should have thrown');
    } catch (err) {
      assert.strictEqual(err.code, 'WHATSAPP_NOT_CONFIGURED');
    } finally {
      if (prevId !== undefined) process.env.WHATSAPP_PHONE_NUMBER_ID = prevId;
      if (prevTok !== undefined) process.env.WHATSAPP_ACCESS_TOKEN = prevTok;
    }
  });
  await asyncTest('MSG91 without key throws SMS_NOT_CONFIGURED (no network)', async () => {
    const prev = process.env.SMS_API_KEY;
    const prev2 = process.env.MSG91_AUTH_KEY;
    delete process.env.SMS_API_KEY;
    delete process.env.MSG91_AUTH_KEY;
    const sms = require('../services/smsService');
    try {
      await new sms.Msg91SmsProvider().send('9876543210', 'hi');
      throw new Error('should have thrown');
    } catch (err) {
      assert.strictEqual(err.code, 'SMS_NOT_CONFIGURED');
    } finally {
      if (prev !== undefined) process.env.SMS_API_KEY = prev;
      if (prev2 !== undefined) process.env.MSG91_AUTH_KEY = prev2;
    }
  });
  await asyncTest('mock SMS provider returns message id offline', async () => {
    const sms = require('../services/smsService');
    const r = await new sms.MockSmsProvider().send('9876543210', 'hi');
    assert.ok(String(r.messageId).startsWith('MOCK-'));
  });

  console.log(`\n${passed} tests passed${process.exitCode ? ' (WITH FAILURES)' : ''}`);
})();
