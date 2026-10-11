/**
 * whatsappService.js
 * ==================
 * Official Meta WhatsApp Business Platform Cloud API sender.
 * Endpoint: POST https://graph.facebook.com/{VERSION}/{PHONE_NUMBER_ID}/messages
 *
 * - Credentials live ONLY in backend env (never logged, never sent to React).
 * - Supports the `hello_world` verification template + configurable
 *   approved allocation templates with body parameters.
 * - Timeouts via AbortController; Meta errors mapped to friendly messages.
 * - Never claims delivery: a 200 only means "accepted by Meta" (wamid).
 */

const { normalizePhone, toWhatsAppRecipient } = require('./phoneUtil');

const DEFAULT_VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v25.0';

function config() {
  return {
    version: (process.env.WHATSAPP_GRAPH_VERSION || DEFAULT_VERSION).trim() || 'v25.0',
    phoneNumberId: (process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim(),
    token: (process.env.WHATSAPP_ACCESS_TOKEN || '').trim(),
    timeoutMs: Number(process.env.WHATSAPP_TIMEOUT_MS) || 15000,
  };
}

function isConfigured() {
  const c = config();
  return Boolean(c.phoneNumberId && c.token);
}

function endpoint() {
  const c = config();
  return `https://graph.facebook.com/${c.version}/${c.phoneNumberId}/messages`;
}

/** Build a template payload. params = ordered body parameter strings. */
function buildTemplatePayload(to, templateName, languageCode = 'en_US', params = []) {
  const template = { name: templateName, language: { code: languageCode } };
  if (params && params.length) {
    template.components = [
      { type: 'body', parameters: params.map((t) => ({ type: 'text', text: String(t ?? '') })) },
    ];
  }
  return { messaging_product: 'whatsapp', to, type: 'template', template };
}

/** The integration-verification template required by the task. */
function buildHelloWorldPayload(to) {
  return buildTemplatePayload(to, 'hello_world', 'en_US', []);
}

/**
 * Allocation template payload from admin settings:
 * { name, language, bodyParams: ['officerName','boothNumber',...] }
 */
function buildAllocationPayload(to, tpl, vars) {
  const params = (tpl.bodyParams || []).map((key) => vars[key] ?? '');
  return buildTemplatePayload(to, tpl.name, tpl.language || 'en_US', params);
}

async function postToMeta(payload) {
  const c = config();
  if (!c.phoneNumberId) throw Object.assign(new Error('WHATSAPP_PHONE_NUMBER_ID is not configured'), { statusCode: 503, code: 'WHATSAPP_NOT_CONFIGURED' });
  if (!c.token) throw Object.assign(new Error('WHATSAPP_ACCESS_TOKEN is not configured'), { statusCode: 503, code: 'WHATSAPP_NOT_CONFIGURED' });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), c.timeoutMs);
  let res;
  try {
    res = await fetch(endpoint(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw Object.assign(new Error(`WhatsApp request timed out after ${c.timeoutMs}ms`), { statusCode: 504, code: 'WHATSAPP_TIMEOUT', retryable: true });
    }
    throw Object.assign(new Error(`WhatsApp request failed: ${err.message}`), { statusCode: 502, code: 'WHATSAPP_NETWORK', retryable: true });
  } finally {
    clearTimeout(timer);
  }

  let data = {};
  try { data = await res.json(); } catch { data = {}; }

  if (!res.ok) {
    const metaErr = data?.error || {};
    const msg = metaErr.error_data?.details
      || metaErr.message
      || `Meta API returned HTTP ${res.status}`;
    const err = new Error(`WhatsApp send failed: ${msg}`);
    err.statusCode = res.status >= 500 ? 502 : res.status;
    err.code = `META_${metaErr.code || res.status}`;
    err.meta = { type: metaErr.type, fbtrace_id: metaErr.fbtrace_id };
    // 5xx + 429 + unknown are retryable; auth/template errors are permanent.
    err.retryable = res.status === 429 || res.status >= 500;
    throw err;
  }

  const msg = (data.messages && data.messages[0]) || {};
  return { messageId: msg.id || '', raw: data };
}

/** Send a template message. Returns { messageId }. Throws on invalid number / Meta error. */
async function sendTemplate({ to, templateName, languageCode, params }) {
  const norm = normalizePhone(to);
  if (!norm.valid) throw Object.assign(new Error(norm.reason || 'invalid phone number'), { statusCode: 400, code: 'INVALID_PHONE', retryable: false });
  const recipient = toWhatsAppRecipient(norm);
  const payload = buildTemplatePayload(recipient, templateName, languageCode, params);
  return postToMeta(payload);
}

/** Verify `hello_world` integration for one recipient (admin test button). */
async function sendHelloWorld(to) {
  const norm = normalizePhone(to);
  if (!norm.valid) throw Object.assign(new Error(norm.reason || 'invalid phone number'), { statusCode: 400, code: 'INVALID_PHONE', retryable: false });
  return postToMeta(buildHelloWorldPayload(toWhatsAppRecipient(norm)));
}

module.exports = {
  config,
  isConfigured,
  endpoint,
  buildTemplatePayload,
  buildHelloWorldPayload,
  buildAllocationPayload,
  sendTemplate,
  sendHelloWorld,
  postToMeta,
};
