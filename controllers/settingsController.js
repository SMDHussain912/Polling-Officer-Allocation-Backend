/**
 * settingsController.js (part 1)
 * Admin-only notification template settings (the "simple editor" backend).
 */

const { NotificationSetting, DEFAULTS, getSettings } = require('../models/NotificationSetting');
const templateService = require('../services/templateService');
const smsService = require('../services/smsService');
const whatsappService = require('../services/whatsappService');
const { normalizePhone } = require('../services/phoneUtil');

const CHANNELS = ['email', 'sms', 'whatsapp'];

/** Variables the editor offers as click-to-insert buttons. */
const EDITOR_VARIABLES = [
  { key: 'officerName', label: 'Officer Name', example: 'Ravi Kumar' },
  { key: 'boothNumber', label: 'Booth Number', example: '123' },
  { key: 'boothName', label: 'Booth Name', example: 'ZPH School' },
  { key: 'mandal', label: 'Mandal', example: 'Guntur East' },
  { key: 'allocationStatus', label: 'Allocation Status', example: 'ALLOCATED' },
  { key: 'reportingDate', label: 'Reporting Date', example: '2026-05-10 7:00 AM' },
  { key: 'cardUrl', label: 'ID Card Link', example: 'https://…/api/idcards/pdf/…' },
  { key: 'electionName', label: 'Election Name', example: 'General Elections' },
  { key: 'votingHours', label: 'Voting Hours', example: '7:00 AM - 6:00 PM' },
  { key: 'helpline', label: 'Helpline', example: '1800-xxx-xxxx' },
];

function sampleVars() {
  return {
    officerName: 'Ravi Kumar',
    officerId: 'OFF001',
    designation: 'Teacher',
    boothNumber: '123',
    boothName: 'ZPH School, Room 2',
    building: 'ZPH School',
    locality: 'Main Road',
    mandal: 'Guntur East',
    district: 'Guntur',
    allocationStatus: 'ALLOCATED',
    reportingDate: '10-May-2026, 7:00 AM',
    cardUrl: 'https://example.gov/id-card-preview',
    electionName: 'General Elections',
    votingHours: '7:00 AM - 6:00 PM',
    helpline: '1800-xxx-xxxx',
  };
}

async function getAllSettings(req, res, next) {
  try {
    const settings = await getSettings();
    res.json({
      success: true,
      data: {
        settings,
        variables: EDITOR_VARIABLES,
        preview: sampleVars(),
        smsProvider: smsService.providerStatus(),
        whatsapp: whatsappService.isConfigured()
          ? { configured: true, version: whatsappService.config().version }
          : { configured: false, version: whatsappService.config().version },
      },
    });
  } catch (error) {
    next(error);
  }
}

async function saveSetting(req, res, next) {
  try {
    const channel = String(req.params.channel || '').toLowerCase();
    if (!CHANNELS.includes(channel)) {
      return res.status(400).json({ success: false, message: 'channel must be email, sms or whatsapp' });
    }
    const b = req.body || {};
    const patch = { enabled: b.enabled !== false, updatedBy: req.user?.id || null };
    if (channel === 'email') {
      patch.subject = String(b.subject || '').slice(0, 200);
      patch.htmlBody = String(b.htmlBody || '').slice(0, 20000);
    } else if (channel === 'sms') {
      patch.textBody = String(b.textBody || '').slice(0, 2000);
      patch.dltTemplateId = String(b.dltTemplateId || '').trim().slice(0, 100);
      patch.dltSenderId = String(b.dltSenderId || '').trim().slice(0, 30);
    } else {
      patch.textBody = String(b.textBody || '').slice(0, 2000);
      patch.templateName = String(b.templateName || '').trim().slice(0, 100);
      patch.templateLanguage = String(b.templateLanguage || 'en_US').trim().slice(0, 20) || 'en_US';
      patch.bodyParams = Array.isArray(b.bodyParams)
        ? b.bodyParams.map((k) => String(k).trim()).filter(Boolean).slice(0, 10)
        : [];
      patch.headerDocumentUrl = String(b.headerDocumentUrl || '').trim().slice(0, 500);
      patch.buttonUrl = String(b.buttonUrl || '').trim().slice(0, 500);
      if (!patch.templateName) {
        return res.status(400).json({ success: false, message: 'WhatsApp template name is required (must be Meta-approved)' });
      }
    }
    const saved = await NotificationSetting.findOneAndUpdate(
      { channel },
      { $set: patch, $setOnInsert: { channel } },
      { upsert: true, new: true, runValidators: true }
    );
    res.json({ success: true, message: `${channel} template saved`, data: saved });
  } catch (error) {
    next(error);
  }
}

/** Render a channel template against sample data for the live preview. */
async function previewSetting(req, res, next) {
  try {
    const channel = String(req.params.channel || '').toLowerCase();
    if (!CHANNELS.includes(channel)) {
      return res.status(400).json({ success: false, message: 'channel must be email, sms or whatsapp' });
    }
    const b = req.body || {};
    const vars = { ...sampleVars(), ...(b.vars || {}) };
    if (channel === 'email') {
      res.json({
        success: true,
        data: {
          subject: templateService.renderTemplate(b.subject ?? DEFAULTS.email.subject, vars),
          html: templateService.renderTemplate(b.htmlBody ?? DEFAULTS.email.htmlBody, vars),
        },
      });
    } else if (channel === 'sms') {
      const text = templateService.renderTemplate(b.textBody ?? DEFAULTS.sms.textBody, vars);
      res.json({ success: true, data: { text, length: text.length, segments: Math.ceil(text.length / 160) } });
    } else {
      const name = String(b.templateName || DEFAULTS.whatsapp.templateName);
      const keys = Array.isArray(b.bodyParams) ? b.bodyParams : DEFAULTS.whatsapp.bodyParams;
      res.json({ success: true, data: { templateName: name, language: b.templateLanguage || 'en_US', params: keys.map((k) => vars[k] ?? '') } });
    }
  } catch (error) {
    next(error);
  }
}

module.exports = { getAllSettings, saveSetting, previewSetting, sendTest, EDITOR_VARIABLES };/**
 * POST /api/settings/notifications/test — one test message to an admin-typed
 * number/address. Rate-limited. Never loops over officers.
 */
async function sendTest(req, res, next) {
  try {
    const channel = String(req.body?.channel || '').toLowerCase();
    if (!CHANNELS.includes(channel)) {
      return res.status(400).json({ success: false, message: 'channel must be email, sms or whatsapp' });
    }
    const vars = { ...sampleVars(), reportingDate: 'TEST — please ignore' };
    if (channel === 'sms') {
      const to = String(req.body?.to || '');
      const norm = normalizePhone(to);
      if (!norm.valid) return res.status(400).json({ success: false, message: norm.reason || 'invalid phone number' });
      const setting = await require('../models/NotificationSetting').getSetting('sms');
      const text = `[TEST] ${templateService.renderTemplate(req.body?.textBody ?? setting?.textBody ?? DEFAULTS.sms.textBody, vars)}`;
      try {
        const r = await smsService.createProvider().send(norm.e164, text);
        return res.json({ success: true, message: 'Test SMS accepted', data: { messageId: r.messageId } });
      } catch (err) {
        return res.status(err.statusCode || 502).json({ success: false, message: err.message });
      }
    }
    if (channel === 'whatsapp') {
      const to = String(req.body?.to || '');
      if (req.body?.useHelloWorld) {
        try {
          const r = await whatsappService.sendHelloWorld(to);
          return res.json({ success: true, message: 'hello_world accepted by Meta', data: { messageId: r.messageId } });
        } catch (err) {
          return res.status(err.statusCode || 502).json({ success: false, message: err.message });
        }
      }
      const setting = await require('../models/NotificationSetting').getSetting('whatsapp');
      const name = String(req.body?.templateName || setting?.templateName || 'polling_duty_allocation');
      const language = String(req.body?.templateLanguage || setting?.templateLanguage || 'en_US');
      const keys = Array.isArray(req.body?.bodyParams) ? req.body.bodyParams : (setting?.bodyParams?.length ? setting.bodyParams : DEFAULTS.whatsapp.bodyParams);
      try {
        const r = await whatsappService.sendTemplate({ to, templateName: name, languageCode: language, params: keys.map((k) => `[TEST] ${vars[k] ?? ''}`) });
        return res.json({ success: true, message: `Test WhatsApp accepted by Meta (${name})`, data: { messageId: r.messageId } });
      } catch (err) {
        return res.status(err.statusCode || 502).json({ success: false, message: err.message });
      }
    }
    const to = String(req.body?.to || '').trim();
    if (!/^\S+@\S+\.\S+$/.test(to)) return res.status(400).json({ success: false, message: 'valid email address required' });
    try {
      const mailService = require('../services/mailService');
      const messageId = await mailService.sendGmailMessage({
        to,
        subject: '[TEST] Polling notification template',
        text: `Template test — Dear ${vars.officerName}, booth ${vars.boothNumber} (${vars.boothName}), ${vars.mandal} mandal. Please ignore.`,
      });
      return res.json({ success: true, message: 'Test email sent', data: { messageId } });
    } catch (err) {
      return res.status(err.statusCode || 502).json({ success: false, message: err.message });
    }
  } catch (error) {
    next(error);
  }
}

module.exports.sendTest = sendTest;