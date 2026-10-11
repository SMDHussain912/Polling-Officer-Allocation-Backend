/**
 * webhookController.js
 * ====================
 * Delivery-status callbacks. NEVER trust "sent" — only these signed webhooks
 * move a message to DELIVERED / READ / FAILED.
 *
 * WhatsApp (Meta): GET verify (hub.mode/challenge/token) + POST events signed
 * with HMAC-SHA256 (X-Hub-Signature-256) using WHATSAPP_APP_SECRET.
 * SMS (MSG91/generic): POST with provider message id + status.
 */

const crypto = require('crypto');
const Notification = require('../models/Notification');

function whatsappAppSecret() {
  return (process.env.WHATSAPP_APP_SECRET || '').trim();
}

/** GET /api/webhooks/whatsapp — Meta verification handshake. */
function verifyWhatsapp(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const expected = (process.env.WHATSAPP_VERIFY_TOKEN || '').trim();
  if (mode === 'subscribe' && expected && token === expected) {
    return res.status(200).send(challenge);
  }
  return res.status(403).json({ success: false, message: 'Webhook verification failed' });
}

/** Constant-time HMAC check so a forged callback cannot flip statuses. */
function validMetaSignature(rawBody, signatureHeader) {
  const secret = whatsappAppSecret();
  if (!secret) return false; // fail closed when no secret configured
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(`sha256=${expected}`);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function mapWhatsappStatus(s) {
  const v = String(s || '').toLowerCase();
  if (v === 'delivered') return 'DELIVERED';
  if (v === 'read') return 'READ';
  if (v === 'failed' || v === 'undelivered') return 'FAILED';
  if (v === 'sent') return 'SENT';
  return null;
}

/**
 * POST /api/webhooks/whatsapp — Meta status events.
 * NOTE: requires express.raw() on this route so the signature can be checked
 * against the exact bytes Meta signed (see server.js wiring).
 */
async function whatsappEvents(req, res) {
  try {
    const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    const sig = req.headers['x-hub-signature-256'];
    if (!validMetaSignature(raw, sig)) {
      return res.status(401).json({ success: false, message: 'Invalid webhook signature' });
    }
    const payload = req.body || {};
    const entries = Array.isArray(payload.entry) ? payload.entry : [];
    let updated = 0;
    for (const entry of entries) {
      const changes = Array.isArray(entry.changes) ? entry.changes : [];
      for (const change of changes) {
        const statuses = change?.value?.statuses || [];
        for (const st of statuses) {
          const mapped = mapWhatsappStatus(st.status);
          if (!mapped || !st.id) continue;
          const patch = { lastWebhookAt: new Date() };
          if (mapped === 'DELIVERED') patch.deliveredAt = new Date(Number(st.timestamp) * 1000 || Date.now());
          if (mapped === 'READ') { patch.readAt = new Date(Number(st.timestamp) * 1000 || Date.now()); patch.deliveredAt = patch.deliveredAt || new Date(); }
          if (mapped === 'FAILED') {
            patch.error = st?.errors?.[0]?.title || st?.errors?.[0]?.message || 'delivery failed';
            patch.errorCode = String(st?.errors?.[0]?.code || 'META_DELIVERY_FAILED');
            patch.retryable = false;
          }
          const r = await Notification.updateOne(
            { channel: 'whatsapp', providerMessageId: String(st.id) },
            { $set: { ...patch, status: mapped } }
          );
          updated += r.modifiedCount || 0;
        }
      }
    }
    return res.json({ success: true, updated });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

function mapSmsStatus(s) {
  const v = String(s || '').toLowerCase();
  if (['delivered', 'delvrd', 'deliverd'].includes(v)) return 'DELIVERED';
  if (['failed', 'undelivered', 'rejected', 'blocked', 'expired'].includes(v)) return 'FAILED';
  if (['sent', 'submitted', 'accepted'].includes(v)) return 'SENT';
  return null;
}

/**
 * POST /api/webhooks/sms — generic/MSG91 delivery callback.
 * Body: { messageId | request_id, status, error? }.
 * Optional shared-secret check: header x-webhook-secret === SMS_WEBHOOK_SECRET.
 */
async function smsEvents(req, res) {
  try {
    const secret = (process.env.SMS_WEBHOOK_SECRET || '').trim();
    if (secret && req.headers['x-webhook-secret'] !== secret) {
      return res.status(401).json({ success: false, message: 'Invalid webhook secret' });
    }
    const body = req.body || {};
    const messageId = body.messageId || body.request_id || body.requestId || body.msgId;
    const mapped = mapSmsStatus(body.status || body.deliveryStatus);
    if (!messageId || !mapped) {
      return res.status(400).json({ success: false, message: 'messageId and status are required' });
    }
    const patch = { lastWebhookAt: new Date() };
    if (mapped === 'DELIVERED') patch.deliveredAt = new Date();
    if (mapped === 'FAILED') {
      patch.error = body.error || body.reason || 'delivery failed';
      patch.errorCode = String(body.errorCode || 'SMS_DELIVERY_FAILED');
      patch.retryable = false;
    }
    const r = await Notification.updateOne(
      { channel: 'sms', providerMessageId: String(messageId) },
      { $set: { ...patch, status: mapped } }
    );
    return res.json({ success: true, updated: r.modifiedCount || 0 });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = { verifyWhatsapp, whatsappEvents, smsEvents, mapWhatsappStatus, mapSmsStatus };
