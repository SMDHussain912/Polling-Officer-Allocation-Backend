const mongoose = require('mongoose');

const NOTIFICATION_STATUSES = [
  'PENDING',
  'ACCEPTED',
  'SENT',
  'DELIVERED',
  'READ',
  'FAILED',
  'SKIPPED',
  'DEMO_SENT',
];

const notificationSchema = new mongoose.Schema(
  {
    officer: { type: mongoose.Schema.Types.ObjectId, ref: 'Officer', required: true },
    officerName: { type: String, trim: true, default: '' },
    booth: { type: mongoose.Schema.Types.ObjectId, ref: 'Booth', default: null },
    mandal: { type: String, trim: true, default: '' },
    allocation: { type: mongoose.Schema.Types.ObjectId, ref: 'Allocation' },
    channel: { type: String, enum: ['sms', 'whatsapp', 'email'], default: 'sms' },
    mobileNumber: { type: String, trim: true, default: '' },
    email: { type: String, trim: true, default: '' },
    message: { type: String, required: true, trim: true },
    templateName: { type: String, default: '', trim: true },
    templateLanguage: { type: String, default: '', trim: true },
    idempotencyKey: { type: String, default: '', trim: true },
    status: {
      type: String,
      enum: NOTIFICATION_STATUSES,
      default: 'PENDING',
    },
    providerMessageId: { type: String },
    provider: { type: String, default: 'mock' },
    error: { type: String },
    errorCode: { type: String },
    retryable: { type: Boolean, default: false },
    attempts: { type: Number, default: 0 },
    sentAt: { type: Date },
    deliveredAt: { type: Date },
    readAt: { type: Date },
    lastWebhookAt: { type: Date },
  },
  { timestamps: true }
);

notificationSchema.index({ status: 1 });
notificationSchema.index({ officer: 1 });
notificationSchema.index({ channel: 1, status: 1 });
notificationSchema.index({ allocation: 1, channel: 1 });
notificationSchema.index({ providerMessageId: 1 }, { sparse: true });
notificationSchema.index({ createdAt: -1 });
// Idempotency: same allocation + channel + key can never create two rows.
notificationSchema.index(
  { allocation: 1, channel: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { allocation: { $exists: true }, idempotencyKey: { $type: 'string' } } }
);

module.exports =
  mongoose.models.Notification || mongoose.model('Notification', notificationSchema);
module.exports.NOTIFICATION_STATUSES = NOTIFICATION_STATUSES;
module.exports.NOTIFICATION_CHANNELS = ['sms', 'whatsapp', 'email'];