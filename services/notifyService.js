/**
 * notifyService.js (part 1)
 * Orchestrates per-channel allocation notifications (sms | whatsapp | email).
 * One Notification row per (allocation × channel), guarded by idempotency keys.
 */

const Notification = require('../models/Notification');
const { getSetting } = require('../models/NotificationSetting');
const smsService = require('./smsService');
const whatsappService = require('./whatsappService');
const mailService = require('./mailService');
const idCardService = require('./idCardService');
const templateService = require('./templateService');
const { normalizePhone } = require('./phoneUtil');

function htmlToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}

async function ensureCard(allocationId) {
  try {
    const card = await idCardService.getOrCreateCard(allocationId);
    return { card, cardUrl: idCardService.publicCardUrl(card), issued: true };
  } catch (err) {
    return { card: null, cardUrl: null, issued: false, error: err.message };
  }
}

function varsFor(allocation, extra = {}) {
  return templateService.templateVars(allocation, extra);
}

/** Send SMS channel for one allocation. */
async function sendSmsChannel(allocation, { cardUrl, idempotencyKey }) {
  const setting = await getSetting('sms');
  if (setting && setting.enabled === false) {
    return { skipped: true, reason: 'SMS channel disabled in settings' };
  }
  const officer = allocation.officer;
  if (!officer || !officer.mobileNumber) return { skipped: true, reason: 'no mobile number' };
  const vars = varsFor(allocation, { cardUrl });
  const fallback = smsService.buildAllocationMessage(officer, allocation.booth, { cardUrl });
  const message = setting?.textBody
    ? templateService.renderTemplate(setting.textBody, vars)
    : templateService.renderTemplate(fallback, vars);
  const notification = await smsService.sendSms({
    officer,
    allocation,
    message,
    idempotencyKey: idempotencyKey || `sms:${allocation._id}`,
    sendOpts: { dltTemplateId: setting?.dltTemplateId, flowId: process.env.MSG91_FLOW_ID },
  });
  return { notification };
}

/** Send WhatsApp channel for one allocation. */
async function sendWhatsappChannel(allocation, { cardUrl, idempotencyKey }) {
  const setting = await getSetting('whatsapp');
  if (setting && setting.enabled === false) {
    return { skipped: true, reason: 'WhatsApp channel disabled in settings' };
  }
  const officer = allocation.officer;
  if (!officer || !officer.mobileNumber) return { skipped: true, reason: 'no mobile number' };
  const norm = normalizePhone(officer.mobileNumber);
  const vars = varsFor(allocation, { cardUrl });
  const templateName = (setting?.templateName || 'polling_duty_allocation').trim();
  const language = (setting?.templateLanguage || 'en_US').trim();
  const bodyParams = Array.isArray(setting?.bodyParams) && setting.bodyParams.length
    ? setting.bodyParams
    : ['officerName', 'boothNumber', 'boothName', 'mandal', 'reportingDate'];
  const preview = setting?.textBody
    ? templateService.renderTemplate(setting.textBody, vars)
    : `WhatsApp template "${templateName}" (${language})`;
  const key = String(idempotencyKey || `whatsapp:${allocation._id}`);
  let notification;
  try {
    notification = await Notification.create({
      officer: officer._id,
      officerName: officer.officerName || officer.name || '',
      booth: allocation?.booth?._id || allocation?.booth || undefined,
      mandal: allocation?.mandal || officer.mandal || '',
      allocation: allocation._id,
      channel: 'whatsapp',
      mobileNumber: officer.mobileNumber,
      message: preview,
      templateName,
      templateLanguage: language,
      status: 'PENDING',
      provider: 'whatsapp-cloud',
      idempotencyKey: key,
    });
  } catch (err) {
    if (err && err.code === 11000) {
      const existing = await Notification.findOne({ allocation: allocation._id, channel: 'whatsapp', idempotencyKey: key });
      if (existing) return { notification: { ...existing.toObject(), reused: true } };
    }
    throw err;
  }
  if (!norm.valid) {
    notification.status = 'FAILED';
    notification.error = norm.reason || 'invalid phone number';
    notification.errorCode = 'INVALID_PHONE';
    notification.retryable = false;
    notification.attempts = 1;
    await notification.save();
    return { notification };
  }
  try {
    const params = bodyParams.map((k) => vars[k] ?? '');
    const { messageId } = await whatsappService.sendTemplate({
      to: officer.mobileNumber,
      templateName,
      languageCode: language,
      params,
    });
    notification.status = 'ACCEPTED';
    notification.providerMessageId = messageId;
    notification.sentAt = new Date();
    notification.attempts = (notification.attempts || 0) + 1;
    await notification.save();
    return { notification };
  } catch (error) {
    notification.status = 'FAILED';
    notification.error = error.message;
    notification.errorCode = error.code || '';
    notification.retryable = error.retryable === true;
    notification.attempts = (notification.attempts || 0) + 1;
    await notification.save();
    return { notification };
  }
}

/** Send Email channel for one allocation (existing mailService, preserved). */
async function sendEmailChannel(allocation, { cardUrl } = {}) {
  const setting = await getSetting('email');
  if (setting && setting.enabled === false) {
    return { skipped: true, reason: 'Email channel disabled in settings' };
  }
  const officer = allocation.officer;
  if (!officer || !officer.email) return { skipped: true, reason: 'no email address' };
  try {
    const vars = varsFor(allocation, { cardUrl });
    let result;
    if (setting?.htmlBody || setting?.subject) {
      const subject = setting.subject
        ? templateService.renderTemplate(setting.subject, vars)
        : `Polling Duty ID Card${vars.mandal ? ` - ${vars.mandal} Mandal` : ''}`;
      const text = setting.htmlBody
        ? htmlToText(templateService.renderTemplate(setting.htmlBody, vars))
        : mailService.buildAllocationLetter(allocation, { cardUrl });
      const messageId = await mailService.sendGmailMessage({ to: officer.email, subject, text });
      result = { status: 'sent', messageId };
    } else {
      result = await mailService.sendAllocationLetter(allocation);
    }
    let record = null;
    try {
      record = await Notification.create({
        officer: officer._id,
        officerName: officer.officerName || officer.name || '',
        booth: allocation?.booth?._id || allocation?.booth || undefined,
        mandal: allocation?.mandal || officer.mandal || '',
        allocation: allocation._id,
        channel: 'email',
        email: officer.email,
        mobileNumber: officer.mobileNumber || '',
        message: `Email to ${officer.email}`,
        status: result.status === 'sent' ? 'SENT' : result.status === 'skipped' ? 'SKIPPED' : 'FAILED',
        provider: 'gmail',
        providerMessageId: result.messageId || undefined,
        error: result.reason || undefined,
        idempotencyKey: `email:${allocation._id}:${Date.now()}`,
        sentAt: result.status === 'sent' ? new Date() : undefined,
      });
    } catch { /* email audit row is best-effort */ }
    return { result, record };
  } catch (error) {
    return { result: { status: 'failed', reason: error.message } };
  }
}

/**
 * Send all requested channels for one allocation.
 * channels: subset of ['sms','whatsapp','email'] (default all).
 */
async function sendAllocationNotifications(allocation, { channels = ['sms', 'whatsapp', 'email'], idempotencyPrefix = '' } = {}) {
  const { cardUrl, issued } = await ensureCard(allocation._id);
  const out = { cardUrl, cardIssued: issued, channels: {} };
  const stamp = idempotencyPrefix || String(Date.now());
  if (channels.includes('sms')) {
    out.channels.sms = await sendSmsChannel(allocation, { cardUrl, idempotencyKey: `sms:${allocation._id}:${stamp}` });
  }
  if (channels.includes('whatsapp')) {
    out.channels.whatsapp = await sendWhatsappChannel(allocation, { cardUrl, idempotencyKey: `whatsapp:${allocation._id}:${stamp}` });
  }
  if (channels.includes('email')) {
    out.channels.email = await sendEmailChannel(allocation, { cardUrl });
  }
  return out;
}

module.exports = {
  sendSmsChannel,
  sendWhatsappChannel,
  sendEmailChannel,
  sendAllocationNotifications,
  ensureCard,
  htmlToText,
  varsFor,
};
