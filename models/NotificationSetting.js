const mongoose = require('mongoose');

/**
 * NotificationSetting — ONE document per channel (email | sms | whatsapp).
 * Edited ONLY by the admin Settings editor (big buttons, click-to-insert
 * variables, live preview). Loaded by the send pipeline with safe fallbacks
 * so notifications still work before the admin ever opens Settings.
 *
 * - email: rich HTML body (simple editor) + subject.
 * - sms: plain-text body (160-306 char friendly) + DLT fields.
 * - whatsapp: approved Meta template name + language + ordered body params.
 */

const CHANNELS = ['email', 'sms', 'whatsapp'];

const notificationSettingSchema = new mongoose.Schema(
  {
    channel: { type: String, enum: CHANNELS, required: true, unique: true },
    enabled: { type: Boolean, default: true },
    // Email
    subject: { type: String, default: '' },
    htmlBody: { type: String, default: '' },
    // SMS / WhatsApp shared text fallback + WhatsApp template mapping
    textBody: { type: String, default: '' },
    templateName: { type: String, default: '', trim: true },
    templateLanguage: { type: String, default: 'en_US', trim: true },
    bodyParams: { type: [String], default: [] },
    headerDocumentUrl: { type: String, default: '', trim: true },
    buttonUrl: { type: String, default: '', trim: true },
    // India DLT (SMS)
    dltTemplateId: { type: String, default: '', trim: true },
    dltSenderId: { type: String, default: '', trim: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  },
  { timestamps: true }
);

const NotificationSetting =
  mongoose.models.NotificationSetting ||
  mongoose.model('NotificationSetting', notificationSettingSchema);

const DEFAULTS = {
  email: {
    channel: 'email',
    enabled: true,
    subject: 'Polling Duty ID Card — {{mandal}} Mandal',
    htmlBody: [
      '<p>Dear {{officerName}},</p>',
      '<p>You have been allocated for election (polling) duty in <b>{{mandal}}</b> mandal.</p>',
      '<table border="1" cellpadding="6" cellspacing="0">',
      '<tr><td><b>Booth Number</b></td><td>{{boothNumber}}</td></tr>',
      '<tr><td><b>Booth Name</b></td><td>{{boothName}}</td></tr>',
      '<tr><td><b>Mandal</b></td><td>{{mandal}}</td></tr>',
      '<tr><td><b>Reporting Date</b></td><td>{{reportingDate}}</td></tr>',
      '</table>',
      '<p><a href="{{cardUrl}}">Download your Polling Duty ID Card (PDF)</a></p>',
      '<p>Please carry a printed copy on duty.<br/>Thank you.<br/>Election Administration</p>',
    ].join('\n'),
    textBody: '',
    templateName: '',
    templateLanguage: 'en_US',
    bodyParams: [],
  },
  sms: {
    channel: 'sms',
    enabled: true,
    subject: '',
    htmlBody: '',
    textBody: [
      'Dear {{officerName}}, You have been allocated for polling duty.',
      'Booth {{boothNumber}} ({{boothName}}), {{mandal}} mandal.',
      'Report: {{reportingDate}}. Card: {{cardUrl}} - Election Admin',
    ].join(' '),
    templateName: '',
    templateLanguage: 'en_US',
    bodyParams: [],
    dltTemplateId: '',
    dltSenderId: '',
  },
  whatsapp: {
    channel: 'whatsapp',
    enabled: true,
    subject: '',
    htmlBody: '',
    textBody: 'Dear {{officerName}}, you are allocated to booth {{boothNumber}} ({{boothName}}), {{mandal}} mandal. Report: {{reportingDate}}. Card: {{cardUrl}}',
    templateName: 'polling_duty_allocation',
    templateLanguage: 'en_US',
    bodyParams: ['officerName', 'boothNumber', 'boothName', 'mandal', 'reportingDate'],
    headerDocumentUrl: '',
    buttonUrl: '{{cardUrl}}',
  },
};

async function getSettings() {
  const docs = await NotificationSetting.find({}).lean();
  const byChannel = {};
  for (const d of docs) byChannel[d.channel] = d;
  // Fill missing channels with defaults (not yet saved).
  for (const ch of CHANNELS) {
    if (!byChannel[ch]) byChannel[ch] = { ...DEFAULTS[ch] };
  }
  return byChannel;
}

async function getSetting(channel) {
  const doc = await NotificationSetting.findOne({ channel }).lean();
  return doc || { ...DEFAULTS[channel] };
}

module.exports = {
  NotificationSetting,
  CHANNELS,
  DEFAULTS,
  getSettings,
  getSetting,
};
