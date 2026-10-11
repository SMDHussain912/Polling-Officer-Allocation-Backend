/**
 * mailService — Gmail (OAuth) sending + the polling-duty allocation mail.
 *
 * Extracted from server.js so BOTH the admin mail endpoints (server.js) and
 * the notification flow (notificationController) send the same SHORT mail:
 * "allocated to <Mandal> mandal" + the tokenised ID-card DOWNLOAD LINK.
 * No PDF is attached any more — the officer downloads the card through the
 * link, and that first click marks the card as "received"
 * (see idCardController.downloadByToken / models/IdCard.js).
 *
 * server.js injects the shared OAuth client once at boot (initMail); this
 * module then builds/verifies the message and talks to the Gmail API.
 */
const { google } = require('googleapis');
const idCardService = require('./idCardService');

let oauth2Client = null;

/** Called once from server.js after the OAuth client + saved tokens load. */
function initMail({ oauth2Client: client } = {}) {
  if (client) oauth2Client = client;
}

/** Throws the same 401 (+ authUrl hint) server.js used to throw. */
function requireConnectedClient() {
  if (!oauth2Client) {
    throw Object.assign(new Error('Mail service is not initialised'), {
      statusCode: 500,
    });
  }
  const credentials = oauth2Client.credentials || {};
  if (!credentials.access_token && !credentials.refresh_token) {
    throw Object.assign(new Error('Google account is not authenticated'), {
      statusCode: 401,
      authUrl: `http://localhost:${process.env.PORT || 5002}/auth/google`,
    });
  }
  return oauth2Client;
}

/**
 * Builds the raw MIME message string. Pure (no network) so it can be tested
 * offline: with attachments -> multipart/mixed (text part + base64 parts),
 * without -> the original simple text/plain message.
 */
function buildMimeMessage({ to, subject, text, attachments = [] }) {
  if (!attachments || !attachments.length) {
    return [
      'MIME-Version: 1.0',
      `To: ${to}`,
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset=UTF-8',
      '',
      text,
    ].join('\r\n');
  }

  const boundary = `polling_officer_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const parts = [
    'MIME-Version: 1.0',
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    text,
  ];

  for (const att of attachments) {
    if (!att || !att.buffer) continue;
    const filename = String(att.filename || 'attachment').replace(/["\\\r\n]/g, '');
    parts.push(
      `--${boundary}`,
      `Content-Type: ${att.contentType || 'application/pdf'}; name="${filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${filename}"`,
      '',
      Buffer.from(att.buffer).toString('base64').replace(/(.{76})/g, '$1\r\n')
    );
  }

  parts.push(`--${boundary}--`);
  return parts.join('\r\n');
}

/**
 * Sends an e-mail through the connected Gmail account (OAuth).
 * Optional attachments: [{ filename, buffer, contentType }].
 */
async function sendGmailMessage({ to, subject, text, attachments = [] }) {
  if (!to) throw Object.assign(new Error("Missing 'to'"), { statusCode: 400 });
  if (!subject) throw Object.assign(new Error("Missing 'subject'"), { statusCode: 400 });
  if (!text) throw Object.assign(new Error("Missing 'text'"), { statusCode: 400 });

  const client = requireConnectedClient();
  const gmail = google.gmail({ version: 'v1', auth: client });

  const message = buildMimeMessage({ to, subject, text, attachments });
  const raw = Buffer.from(message).toString('base64url');

  console.log(`[MAIL] Sending email to ${to}${attachments.length ? ` (${attachments.length} attachment(s))` : ''}`);

  const response = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });

  console.log('[MAIL] Email sent successfully:', response.data.id);
  return response.data.id;
}

/** Uniform JSON error response for the mail endpoints. */
function mailErrorResponse(res, error) {
  res.status(error.statusCode || 500).json({
    success: false,
    message: error.message,
    auth: error.authUrl || undefined,
    googleError: error.response?.data || null,
  });
}

/** Mandal of an allocation: allocation snapshot -> booth -> officer. */
function allocationMandal(allocation) {
  return String(
    allocation?.mandal || allocation?.booth?.mandal || allocation?.officer?.mandal || ''
  ).trim();
}

/**
 * Builds the SHORT polling-duty mail body from an allocation (populated
 * officer + booth): the officer is told they were allocated to a Mandal and
 * gets the tokenised download link for their ID card. No duty details — the
 * card itself carries those, and opening the link marks the card "received".
 */
function buildAllocationLetter(allocation, { cardUrl } = {}) {
  const o = allocation.officer || {};
  const mandal = allocationMandal(allocation);
  const lines = [
    `Dear ${o.officerName || o.name || 'Officer'},`,
    '',
    mandal
      ? `You have been allocated for election (polling) duty in ${mandal} mandal.`
      : 'You have been allocated for election (polling) duty.',
    '',
  ];
  if (cardUrl) {
    lines.push(
      'Download your Polling Duty ID Card (PDF):',
      cardUrl,
      '',
      'Please download the card and carry a printed copy on duty.',
      ''
    );
  } else {
    lines.push(
      'Your Polling Duty ID Card download link will be shared with you shortly.',
      ''
    );
  }
  lines.push('Thank you.', 'Election Administration');
  return lines.join('\n');
}

/**
 * Sends the SHORT allocation mail for ONE allocation: "allocated to <Mandal>
 * mandal" + the tokenised ID-card download link. NO PDF attachment any more —
 * the officer downloads the card through the link, and that first click marks
 * the card as "received". The card is generated (or fetched from cache) FIRST
 * so the link exists; when the card cannot be produced the mail is skipped.
 * Returns { status: 'sent' | 'failed' | 'skipped', reason?, messageId?, idCard? }.
 */
async function sendAllocationLetter(allocation) {
  const officer = allocation.officer;
  if (!officer || !officer.email) {
    return { status: 'skipped', reason: 'no email address' };
  }
  try {
    const card = await idCardService.getOrCreateCard(allocation._id);
    const cardUrl = idCardService.publicCardUrl(card);
    const mandal = allocationMandal(allocation);
    const messageId = await sendGmailMessage({
      to: officer.email,
      subject: `Polling Duty ID Card${mandal ? ` - ${mandal} Mandal` : ''}`,
      text: buildAllocationLetter(allocation, { cardUrl }),
    });
    return {
      status: 'sent',
      messageId,
      idCard: { id: card._id, filename: card.filename, url: cardUrl },
    };
  } catch (error) {
    console.error('[MAIL] sendAllocationLetter failed:', error.message);
    return { status: 'failed', reason: error.message };
  }
}

module.exports = {
  initMail,
  buildMimeMessage,
  sendGmailMessage,
  mailErrorResponse,
  buildAllocationLetter,
  sendAllocationLetter,
};
