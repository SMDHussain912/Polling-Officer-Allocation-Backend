const Allocation = require('../models/Allocation');
const Notification = require('../models/Notification');
const IdCard = require('../models/IdCard');
const smsService = require('../services/smsService');
const whatsappService = require('../services/whatsappService');
const notifyService = require('../services/notifyService');
const { notificationScopeFilter } = require('../services/roleService');

const VALID_CHANNELS = ['sms', 'whatsapp', 'email'];

function parseChannels(body) {
  if (!body || body.channels === undefined) return [...VALID_CHANNELS];
  const list = Array.isArray(body.channels) ? body.channels : [body.channels];
  const clean = list.map((c) => String(c || '').toLowerCase()).filter((c) => VALID_CHANNELS.includes(c));
  return clean.length ? [...new Set(clean)] : [...VALID_CHANNELS];
}

async function loadAllocatable(req, allocationId) {
  const allocation = await Allocation.findById(allocationId)
    .populate('officer')
    .populate('booth');
  if (!allocation) return { error: { status: 404, message: 'Allocation not found' } };
  if (!allocation.booth) {
    return { error: { status: 400, message: 'This officer has no booth allocation - cannot send a notification' } };
  }
  if (allocation.status !== 'ALLOCATED') {
    return { error: { status: 400, message: 'Notification can only be sent for an ALLOCATED allocation' } };
  }
  if (!allocation.officer) {
    return { error: { status: 404, message: 'Officer record missing' } };
  }
  return { allocation };
}

/**
 * POST /api/notifications/send/:allocationId
 * Body (optional): { channels: ['sms','whatsapp','email'] }
 * Sends only the requested channels. Idempotent per request key so a double
 * tap / retry never sends twice.
 */
async function sendAllocationNotification(req, res, next) {
  try {
    const { allocation, error } = await loadAllocatable(req, req.params.allocationId);
    if (error) return res.status(error.status).json({ success: false, message: error.message });
    const channels = parseChannels(req.body);
    const stamp = String(req.body?.idempotencyKey || req.headers['x-idempotency-key'] || Date.now());

    const out = await notifyService.sendAllocationNotifications(allocation, {
      channels,
      idempotencyPrefix: stamp,
    });

    const parts = [];
    if (out.channels.sms?.notification) parts.push(`SMS ${out.channels.sms.notification.status}`);
    if (out.channels.sms?.skipped) parts.push(`SMS skipped (${out.channels.sms.reason})`);
    if (out.channels.whatsapp?.notification) parts.push(`WhatsApp ${out.channels.whatsapp.notification.status}`);
    if (out.channels.whatsapp?.skipped) parts.push(`WhatsApp skipped (${out.channels.whatsapp.reason})`);
    if (out.channels.email?.result) parts.push(`Email ${out.channels.email.result.status}`);
    if (out.channels.email?.skipped) parts.push(`Email skipped (${out.channels.email.reason})`);

    return res.status(200).json({
      success: true,
      message: parts.length ? parts.join(' · ') : 'No channels sent',
      data: out.channels.sms?.notification || out.channels.whatsapp?.notification || null,
      channels: {
        sms: out.channels.sms?.notification || out.channels.sms || null,
        whatsapp: out.channels.whatsapp?.notification || out.channels.whatsapp || null,
        email: out.channels.email?.result || out.channels.email || null,
      },
      idCard: { issued: out.cardIssued, url: out.cardUrl, received: false },
    });
  } catch (error) {
    next(error);
  }
}

async function getNotifications(req, res, next) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.channel) filter.channel = String(req.query.channel).toLowerCase();
    const notifScope = await notificationScopeFilter(req.user);
    Object.assign(filter, notifScope);

    // Optional exact-Mandal filter (?mandal=NAME): matches the notification's
    // Mandal snapshot OR the linked officer's current Mandal (safe fallback
    // for older records). Combined with the role scope above via $and.
    const mandal = String(req.query.mandal || '').trim();
    if (mandal) {
      const re = new RegExp(`^${mandal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
      const Officer = require('../models/Officer');
      const officers = await Officer.find({ mandal: re }).select('_id').lean();
      const mandalOr = [{ mandal: re }];
      if (officers.length) mandalOr.push({ officer: { $in: officers.map((o) => o._id) } });
      const base = { ...filter };
      Object.keys(base).forEach((k) => delete filter[k]);
      Object.assign(filter, { $and: [base, { $or: mandalOr }] });
    }

    const query = Notification.find(filter).populate('officer').populate('booth').populate({ path: 'allocation', populate: { path: 'booth' } }).sort({ createdAt: -1 });

    const [data, total] = await Promise.all([
      query.skip((page - 1) * limit).limit(limit).lean(),
      Notification.countDocuments(filter),
    ]);

    // Embed the CURRENT ID-card "received" state per row (not a snapshot):
    // the officer received the card when the tokenised download link was
    // opened for the first time (idCardController.downloadByToken).
    const allocIds = [
      ...new Set(
        data
          .map((n) => (n.allocation ? String(n.allocation._id || n.allocation) : null))
          .filter(Boolean)
      ),
    ];
    let cardsByAllocation = new Map();
    if (allocIds.length) {
      const cards = await IdCard.find({ allocationId: { $in: allocIds } })
        .select('allocationId receivedAt downloadCount lastDownloadedAt filename')
        .lean();
      cardsByAllocation = new Map(cards.map((c) => [String(c.allocationId), c]));
    }
    const rows = data.map((n) => {
      const allocId = n.allocation ? String(n.allocation._id || n.allocation) : null;
      const card = allocId ? cardsByAllocation.get(allocId) : null;
      return {
        ...n,
        idCard: card
          ? {
              issued: true,
              filename: card.filename || '',
              receivedAt: card.receivedAt || null,
              lastDownloadedAt: card.lastDownloadedAt || null,
              downloadCount: card.downloadCount || 0,
            }
          : {
              issued: false,
              filename: '',
              receivedAt: null,
              lastDownloadedAt: null,
              downloadCount: 0,
            },
      };
    });

    return res.json({
      success: true,
      data: rows,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/notifications/send-all
 * Bulk variant across requested channels (default all).
 * Body: { allocationIds?, mandal?, channels?, limit? } — max 100 per run,
 * explicit admin confirmation happens in the UI (ConfirmModal).
 */
async function sendAllNotifications(req, res, next) {
  try {
    const max = Math.min(100, Math.max(1, parseInt(req.body?.limit, 10) || 100));
    const filter = { status: 'ALLOCATED' };

    const body = req.body || {};
    const channels = parseChannels(body);
    const allocationIds = Array.isArray(body.allocationIds) ? body.allocationIds : [];
    const mandal = String(body.mandal || '').trim();

    if (allocationIds.length) {
      filter._id = { $in: allocationIds };
    } else if (mandal) {
      const re = new RegExp(`^${mandal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
      filter.$or = [{ mandal: re }, { 'officer.mandal': re }];
    }

    const allocations = await Allocation.find(filter)
      .populate('officer')
      .populate('booth')
      .limit(max);

    if (!allocations.length) {
      return res.status(404).json({
        success: false,
        message: 'No ALLOCATED allocations match the request',
      });
    }

    const summary = { sms: { sent: 0, failed: 0, skipped: 0 }, whatsapp: { sent: 0, failed: 0, skipped: 0 }, email: { sent: 0, failed: 0, skipped: 0 } };
    let skipped = 0;
    let cardsIssued = 0;
    const failures = [];
    const stamp = String(body.idempotencyKey || Date.now());

    for (const allocation of allocations) {
      if (!allocation.booth || !allocation.officer) {
        skipped += 1;
        continue;
      }
      try {
        const out = await notifyService.sendAllocationNotifications(allocation, {
          channels,
          idempotencyPrefix: stamp,
        });
        if (out.cardIssued) cardsIssued += 1;
        for (const ch of channels) {
          const r = out.channels[ch];
          if (!r) continue;
          if (r.skipped) { summary[ch].skipped += 1; continue; }
          if (ch === 'email') {
            if (r.result?.status === 'sent') summary.email.sent += 1;
            else if (r.result?.status === 'skipped') summary.email.skipped += 1;
            else {
              summary.email.failed += 1;
              failures.push({ allocationId: allocation._id, officer: allocation.officer?.officerName || '', channel: ch, reason: r.result?.reason || 'email failure' });
            }
            continue;
          }
          const n = r.notification;
          if (!n) { summary[ch].skipped += 1; continue; }
          if (n.status === 'FAILED') {
            summary[ch].failed += 1;
            failures.push({ allocationId: allocation._id, officer: allocation.officer?.officerName || '', channel: ch, reason: n.error || 'provider failure' });
          } else {
            summary[ch].sent += 1;
          }
        }
      } catch (error) {
        failures.push({
          allocationId: allocation._id,
          officer: allocation.officer?.officerName || '',
          reason: error.message,
        });
      }
    }

    const sentTotal = summary.sms.sent + summary.whatsapp.sent + summary.email.sent;
    const failedTotal = summary.sms.failed + summary.whatsapp.failed + summary.email.failed;
    return res.status(200).json({
      success: true,
      message: `Processed ${allocations.length}: SMS ${summary.sms.sent}/${summary.sms.failed}/${summary.sms.skipped} (sent/failed/skipped), WhatsApp ${summary.whatsapp.sent}/${summary.whatsapp.failed}/${summary.whatsapp.skipped}, Email ${summary.email.sent}/${summary.email.failed}/${summary.email.skipped}. Cards: ${cardsIssued}.`,
      data: { total: allocations.length, sent: sentTotal, failed: failedTotal, skipped, cardsIssued, byChannel: summary, failures },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/notifications/retry/:notificationId
 * Manual retry for FAILED retryable SMS / WhatsApp rows (max 3 attempts).
 */
async function retryNotification(req, res, next) {
  try {
    const notification = await Notification.findById(req.params.notificationId);
    if (!notification) return res.status(404).json({ success: false, message: 'Notification not found' });
    if (notification.channel === 'email') {
      return res.status(400).json({ success: false, message: 'Email retries use the Send Mail button on the Allocation page' });
    }
    if (notification.status !== 'FAILED') return res.status(400).json({ success: false, message: 'Only FAILED notifications can be retried' });
    if (!notification.retryable) return res.status(400).json({ success: false, message: 'This failure is permanent and cannot be retried' });
    if ((notification.attempts || 0) >= 3) return res.status(400).json({ success: false, message: 'Retry limit reached (3 attempts)' });
    if (notification.channel === 'whatsapp') {
      try {
        const allocation = await Allocation.findById(notification.allocation).populate('officer').populate('booth');
        if (!allocation) return res.status(404).json({ success: false, message: 'Original allocation no longer exists' });
        const setting = await require('../models/NotificationSetting').getSetting('whatsapp');
        const vars = notifyService.varsFor(allocation, {});
        const keys = (setting?.bodyParams?.length ? setting.bodyParams : ['officerName', 'boothNumber', 'boothName', 'mandal', 'reportingDate']);
        const { messageId } = await whatsappService.sendTemplate({
          to: notification.mobileNumber,
          templateName: notification.templateName || setting?.templateName || 'polling_duty_allocation',
          languageCode: notification.templateLanguage || setting?.templateLanguage || 'en_US',
          params: keys.map((k) => vars[k] ?? ''),
        });
        notification.status = 'ACCEPTED';
        notification.providerMessageId = messageId;
        notification.sentAt = new Date();
        notification.error = undefined;
        notification.retryable = false;
        notification.attempts = (notification.attempts || 0) + 1;
        await notification.save();
        return res.json({ success: true, message: 'WhatsApp retry accepted by Meta', data: notification });
      } catch (err) {
        notification.error = err.message;
        notification.errorCode = err.code || '';
        notification.retryable = err.retryable === true;
        notification.attempts = (notification.attempts || 0) + 1;
        await notification.save();
        return res.status(err.statusCode || 502).json({ success: false, message: err.message });
      }
    }
    try {
      const retried = await smsService.retrySms(notification._id);
      return res.json({ success: true, message: `SMS retry ${retried.status}`, data: retried });
    } catch (err) {
      return res.status(err.statusCode || 400).json({ success: false, message: err.message });
    }
  } catch (error) {
    next(error);
  }
}

/** GET /api/notifications/summary — per-channel counts + provider readiness. */
async function getNotificationSummary(req, res, next) {
  try {
    const notifScope = await notificationScopeFilter(req.user);
    const base = { ...notifScope };
    if (req.query.mandal) {
      const m = String(req.query.mandal).trim();
      base.mandal = new RegExp(`^${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    }
    const rows = await Notification.aggregate([
      { $match: base },
      { $group: { _id: { channel: { $ifNull: ['$channel', 'sms'] }, status: '$status' }, count: { $sum: 1 } } },
    ]);
    const summary = { sms: {}, whatsapp: {}, email: {} };
    for (const r of rows) {
      const ch = r._id.channel || 'sms';
      if (!summary[ch]) summary[ch] = {};
      summary[ch][r._id.status] = r.count;
    }
    res.json({
      success: true,
      data: {
        byChannel: summary,
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

module.exports = { sendAllocationNotification, getNotifications, sendAllNotifications, retryNotification, getNotificationSummary };