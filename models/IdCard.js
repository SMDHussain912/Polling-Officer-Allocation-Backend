const mongoose = require('mongoose');

/**
 * IdCard — the generated polling-duty ID card (PDF) for ONE allocation.
 *
 * Why the PDF is stored in MongoDB: the same card must be reachable from
 * three places (the admin mail attachment, the admin download endpoint and a
 * tokenised link sent by SMS to the officer's phone). Cards are small
 * (~30-80 KB) so a Buffer is fine (well under the 16 MB document limit) and
 * survives redeploys without filesystem state.
 *
 * downloadToken: random one-time-ish secret embedded in the SMS link
 * (/api/idcards/pdf/:cardId?token=...) so the public download endpoint can
 * authorise the officer's phone without a session. The admin endpoint stays
 * session-protected and never needs the token.
 */
const idCardSchema = new mongoose.Schema(
  {
    allocationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Allocation',
      required: true,
      unique: true,
      index: true,
    },
    officer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Officer',
      required: true,
      index: true,
    },
    pdf: { type: Buffer, required: true },
    filename: { type: String, required: true, default: 'ID-Card.pdf' },
    downloadToken: {
      type: String,
      required: true,
      unique: true,
      default: () => require('crypto').randomBytes(24).toString('hex'),
    },
    // "Received" tracking: the officer received the card when the tokenised
    // download link was opened for the first time (public endpoint only —
    // admin session previews never mark). Until receivedAt is set the card
    // counts as NOT received.
    receivedAt: { type: Date, default: null },
    downloadCount: { type: Number, default: 0 },
    lastDownloadedAt: { type: Date, default: null },
    generatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.models.IdCard || mongoose.model('IdCard', idCardSchema);
