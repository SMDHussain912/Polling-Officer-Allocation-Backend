/**
 * smsService.js
 * ==============
 * Reusable SMS service with a provider-abstraction layer.
 *
 *   SMS_PROVIDER=mock   -> MockSmsProvider (default; simulates delivery)
 *   SMS_PROVIDER=http   -> HttpSmsProvider (generic JSON POST gateway)
 *   SMS_PROVIDER=msg91  -> Msg91SmsProvider (MSG91 Flow/SMS API, India DLT-ready)
 *
 * Credentials ONLY from env — never hardcoded, never sent to React.
 */

const crypto = require('crypto');
const Notification = require('../models/Notification');
const { normalizePhone } = require('./phoneUtil');

const STATUS = {
  PENDING: 'PENDING',
  SENT: 'SENT',
  DELIVERED: 'DELIVERED',
  FAILED: 'FAILED',
  DEMO_SENT: 'DEMO_SENT',
};

const DEFAULT_PROVIDER_ID = 'mock';

// ---------------------------------------------------------------------------
// Provider abstraction
// ---------------------------------------------------------------------------

class SmsProvider {
  /** @returns {Promise<{ messageId: string, delivered: boolean }>} */
  async send(phone, message) {
    throw new Error('send() must be implemented by the concrete provider');
  }
}

/**
 * Mock provider - used during development/demo. Simulates delivery locally
 * (no external gateway, no real SMS claimed): the persisted Notification
 * record moves PENDING -> SENT so the full lifecycle can be observed.
 */
class MockSmsProvider extends SmsProvider {
  constructor() {
    super();
    this.name = 'mock';
  }

  async send(phone, message) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    return {
      messageId: `MOCK-${crypto.randomBytes(6).toString('hex')}`,
      delivered: true,
    };
  }
}

/**
 * HTTP provider adapter. Sends a generic JSON payload so any gateway that
 * accepts a POST can be wired up by mapping fields at the gateway side:
 *   { to, message, senderId, apiKey }
 * Configure via .env: SMS_PROVIDER_API_URL, SMS_API_KEY, SMS_SENDER_ID.
 */
class HttpSmsProvider extends SmsProvider {
  constructor() {
    super();
    this.name = 'http';
    this.apiUrl = process.env.SMS_PROVIDER_API_URL;
    this.apiKey = process.env.SMS_API_KEY;
    this.senderId = process.env.SMS_SENDER_ID;
    this.dltTemplateId = process.env.SMS_DLT_TEMPLATE_ID;
    this.timeoutMs = Number(process.env.SMS_TIMEOUT_MS) || 15000;
    this.extraHeaders = this._parseExtraHeaders(process.env.SMS_EXTRA_HEADERS);
  }

  _parseExtraHeaders(raw) {
    const result = {};
    if (!raw) return result;
    try {
      Object.assign(result, JSON.parse(raw));
    } catch {
      // ignore malformed headers; provider may not need them
    }
    return result;
  }

  async send(phone, message, opts = {}) {
    if (!this.apiUrl) {
      throw Object.assign(new Error('SMS_PROVIDER_API_URL is not configured in .env'), {
        statusCode: 503, code: 'SMS_NOT_CONFIGURED', retryable: false,
      });
    }
    const norm = normalizePhone(phone);
    if (!norm.valid) {
      throw Object.assign(new Error(norm.reason || 'invalid phone number'), {
        statusCode: 400, code: 'INVALID_PHONE', retryable: false,
      });
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let response;
    try {
      response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.extraHeaders },
        body: JSON.stringify({
          to: norm.e164,
          message,
          senderId: this.senderId,
          dltTemplateId: opts.dltTemplateId || this.dltTemplateId || undefined,
        }),
        signal: ctrl.signal,
      });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw Object.assign(new Error(`SMS gateway timed out after ${this.timeoutMs}ms`), {
          statusCode: 504, code: 'SMS_TIMEOUT', retryable: true,
        });
      }
      throw Object.assign(new Error(`SMS gateway unreachable: ${err.message}`), {
        statusCode: 502, code: 'SMS_NETWORK', retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const err = new Error(`SMS gateway returned HTTP ${response.status}`);
      err.statusCode = response.status >= 500 ? 502 : response.status;
      err.code = `SMS_HTTP_${response.status}`;
      err.retryable = response.status === 429 || response.status >= 500;
      throw err;
    }
    const data = await response.json().catch(() => ({}));
    return {
      messageId:
        data.messageId || data.id || data.requestId || `HTTP-${Date.now()}`,
      accepted: true,
      raw: data,
    };
  }
}

/**
 * MSG91 provider (India, DLT-ready).
 * Flow API when MSG91_FLOW_ID is set, else plain SMS API.
 */
class Msg91SmsProvider extends SmsProvider {
  constructor() {
    super();
    this.name = 'msg91';
    this.authKey = process.env.SMS_API_KEY || process.env.MSG91_AUTH_KEY;
    this.senderId = process.env.SMS_SENDER_ID;
    this.flowId = process.env.MSG91_FLOW_ID;
    this.dltTemplateId = process.env.SMS_DLT_TEMPLATE_ID;
    this.timeoutMs = Number(process.env.SMS_TIMEOUT_MS) || 15000;
    this.baseUrl = (process.env.MSG91_BASE_URL || 'https://control.msg91.com/api/v5').replace(/\/+$/, '');
  }

  async send(phone, message, opts = {}) {
    if (!this.authKey) {
      throw Object.assign(new Error('SMS_API_KEY (MSG91 authkey) is not configured'), {
        statusCode: 503, code: 'SMS_NOT_CONFIGURED', retryable: false,
      });
    }
    const norm = normalizePhone(phone);
    if (!norm.valid) {
      throw Object.assign(new Error(norm.reason || 'invalid phone number'), {
        statusCode: 400, code: 'INVALID_PHONE', retryable: false,
      });
    }
    const mobile = norm.e164.replace(/^\+/, '');
    const flowId = opts.flowId || this.flowId;
    const url = flowId ? `${this.baseUrl}/flow/` : `${this.baseUrl}/sms/`;
    const dlt = opts.dltTemplateId || this.dltTemplateId;
    const body = flowId
      ? { flow_id: flowId, sender: this.senderId, mobiles: mobile, message, ...(dlt ? { DLT_TE_ID: dlt } : {}), ...(opts.flowVars || {}) }
      : { sender: this.senderId, route: '4', country: '91', sms: [{ message, to: [mobile] }], ...(dlt ? { DLT_TE_ID: dlt } : {}) };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let response;
    try {
      response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', authkey: this.authKey }, body: JSON.stringify(body), signal: ctrl.signal });
    } catch (err) {
      throw Object.assign(new Error(`MSG91 unreachable: ${err.message}`), {
        statusCode: 502, code: 'SMS_NETWORK', retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.type === 'error') {
      const err = new Error(`MSG91 error: ${data.message || `HTTP ${response.status}`}`);
      err.statusCode = response.status >= 500 ? 502 : 400;
      err.code = `MSG91_${data.code || response.status}`;
      err.retryable = response.status === 429 || response.status >= 500;
      throw err;
    }
    return { messageId: String(data.request_id || data.message || `MSG91-${Date.now()}`), accepted: true, raw: data };
  }
}

/** Factory: instantiate the provider selected by the SMS_PROVIDER env var. */
function createProvider(providerName) {
  const name = (providerName || process.env.SMS_PROVIDER || DEFAULT_PROVIDER_ID).toLowerCase();
  if (name === 'msg91') return new Msg91SmsProvider();
  if (name === 'http') return new HttpSmsProvider();
  return new MockSmsProvider();
}

/** Readiness summary for the admin settings page (no secrets). */
function providerStatus() {
  const provider = createProvider();
  if (provider.name === 'mock') return { provider: 'mock', configured: true, mode: 'demo — no real SMS sent' };
  if (provider.name === 'msg91') {
    return {
      provider: 'msg91',
      configured: Boolean(provider.authKey),
      mode: provider.flowId ? 'MSG91 Flow API' : 'MSG91 SMS API',
      senderId: provider.senderId || '(not set)',
      dltTemplate: provider.dltTemplateId ? 'set' : '(not set — required for India transactional SMS)',
    };
  }
  return { provider: 'http', configured: Boolean(provider.apiUrl), apiUrl: provider.apiUrl || '(SMS_PROVIDER_API_URL not set)' };
}
// ---------------------------------------------------------------------------
// Message templates
// ---------------------------------------------------------------------------

/**
 * Builds the polling-duty SMS body. Mirrors the exact wording required by
 * the specification:
 *   Dear {Name}, You have been allocated for Polling Duty.
 *   Booth Number / Booth Name / Booth Address / Mandal ...
 */
function buildAllocationMessage(officer, booth, options = {}) {
  const b = booth || {};
  const o = officer || {};
  const lines = [
    `Dear ${o.officerName || o.name || 'Officer'},`,
    '',
    'You have been allocated for election duty.',
    '',
    `Booth Number: ${b.boothNumber || ''}`,
    `Booth Name: ${b.boothName || ''}`,
    `Building: ${b.buildingName || ''}`,
    `Booth Locality: ${b.locality || ''}`,
    `Mandal: ${b.mandal || o.mandal || ''}`,
    '',
    'Please report as instructed by the Election Administration.',
    '',
    'Thank you.',
  ];
  // The officer's ID card is generated (and cached) when the notification is
  // sent; the tokenised download link lets the officer open the PDF on a phone.
  if (options.cardUrl) {
    lines.push('', `Polling duty ID Card (PDF): ${options.cardUrl}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Sending + persistence
// ---------------------------------------------------------------------------

/**
 * Sends an SMS and persists it as a channel:'sms' Notification row.
 * Idempotent: same (allocation, idempotencyKey) reuses the existing row.
 * Returns the notification doc ({ reused: true } when deduped).
 */
async function sendSms({ officer, allocation = null, message, providerName, idempotencyKey = '', sendOpts = {} }) {
  const provider = createProvider(providerName);
  const key = String(idempotencyKey || `alloc:${allocation ? allocation._id : 'na'}:${Date.now()}`);
  const norm = normalizePhone(officer.mobileNumber);

  const base = {
    officer: officer._id,
    officerName: officer.officerName || officer.name || '',
    booth: allocation && allocation.booth ? allocation.booth : undefined,
    mandal: (allocation && allocation.mandal) || officer.mandal || '',
    allocation: allocation ? allocation._id : undefined,
    channel: 'sms',
    mobileNumber: officer.mobileNumber,
    message,
    status: STATUS.PENDING,
    provider: provider.name,
    idempotencyKey: key,
  };

  let notification;
  try {
    notification = await Notification.create(base);
  } catch (err) {
    if (err && err.code === 11000 && allocation) {
      const existing = await Notification.findOne({ allocation: allocation._id, channel: 'sms', idempotencyKey: key });
      if (existing) return { ...existing.toObject(), reused: true, _doc: existing };
    }
    throw err;
  }

  // Invalid number: permanent failure, never retried.
  if (!norm.valid) {
    notification.status = STATUS.FAILED;
    notification.error = norm.reason || 'invalid phone number';
    notification.errorCode = 'INVALID_PHONE';
    notification.retryable = false;
    notification.attempts = 1;
    await notification.save();
    return notification;
  }

  try {
    const result = await provider.send(officer.mobileNumber, message, sendOpts);
    notification.status = provider.name === 'mock' ? STATUS.DEMO_SENT : STATUS.SENT;
    notification.providerMessageId = result.messageId;
    notification.sentAt = new Date();
    notification.attempts = (notification.attempts || 0) + 1;
    notification.retryable = false;
    await notification.save();
    return notification;
  } catch (error) {
    notification.status = STATUS.FAILED;
    notification.error = error.message;
    notification.errorCode = error.code || '';
    notification.retryable = error.retryable !== false && error.statusCode !== 400;
    notification.attempts = (notification.attempts || 0) + 1;
    await notification.save();
    return notification;
  }
}

/**
 * Retry a FAILED sms notification (bounded: max 3 attempts, only retryable).
 * Creates a fresh provider attempt against the same row — no duplicate row.
 */
async function retrySms(notificationId) {
  const notification = await Notification.findById(notificationId).populate('officer');
  if (!notification) throw Object.assign(new Error('Notification not found'), { statusCode: 404 });
  if (notification.channel !== 'sms') throw Object.assign(new Error('Not an SMS notification'), { statusCode: 400 });
  if (notification.status !== 'FAILED') throw Object.assign(new Error('Only FAILED notifications can be retried'), { statusCode: 400 });
  if (!notification.retryable) throw Object.assign(new Error('This failure is permanent and cannot be retried'), { statusCode: 400 });
  if ((notification.attempts || 0) >= 3) throw Object.assign(new Error('Retry limit reached (3 attempts)'), { statusCode: 400 });
  const provider = createProvider();
  try {
    const result = await provider.send(notification.mobileNumber, notification.message);
    notification.status = provider.name === 'mock' ? STATUS.DEMO_SENT : STATUS.SENT;
    notification.providerMessageId = result.messageId;
    notification.sentAt = new Date();
    notification.error = undefined;
    notification.errorCode = undefined;
    notification.retryable = false;
    notification.attempts = (notification.attempts || 0) + 1;
    await notification.save();
    return notification;
  } catch (error) {
    notification.error = error.message;
    notification.errorCode = error.code || '';
    notification.retryable = error.retryable !== false && error.statusCode !== 400;
    notification.attempts = (notification.attempts || 0) + 1;
    await notification.save();
    throw error;
  }
}

module.exports = {
  STATUS,
  SmsProvider,
  MockSmsProvider,
  HttpSmsProvider,
  Msg91SmsProvider,
  createProvider,
  providerStatus,
  buildAllocationMessage,
  sendSms,
  retrySms,
};