/**
 * idCardController — serves the generated polling-duty ID card PDF.
 *
 * Two endpoints (see routes/idCardRoutes.js):
 *  - GET /api/idcards/allocation/:allocationId  (admin, JWT session)
 *      Generates the card on first use, then streams it inline so the UI can
 *      preview/download it.
 *  - GET /api/idcards/pdf/:cardId?token=...     (public, token-gated)
 *      The link embedded in the officer's SMS / e-mail. The token is a
 *      per-card random secret checked in constant time; without a valid token
 *      nobody can pull a card, with it no session is needed. Every download
 *      bumps downloadCount; the FIRST download sets receivedAt — the officer
 *      "received" the card the moment they open this link.
 */
const crypto = require('crypto');
const IdCard = require('../models/IdCard');
const idCardService = require('../services/idCardService');

function sendPdf(res, card, disposition) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${disposition}; filename="${card.filename}"`);
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  res.setHeader('Cache-Control', 'no-store');
  return res.send(card.pdf);
}

/** GET /api/idcards/allocation/:allocationId (protect) */
async function getAllocationCard(req, res, next) {
  try {
    const card = await idCardService.getOrCreateCard(req.params.allocationId);
    return sendPdf(res, card, 'inline');
  } catch (error) {
    return next(error);
  }
}

/** GET /api/idcards/pdf/:cardId?token=... (public SMS / e-mail link) */
async function downloadByToken(req, res, next) {
  try {
    const card = await IdCard.findById(req.params.cardId);
    if (!card) {
      return res.status(404).json({ success: false, message: 'ID card not found' });
    }
    const provided = Buffer.from(String(req.query.token || ''));
    const expected = Buffer.from(String(card.downloadToken || ''));
    const valid =
      provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
    if (!valid) {
      return res
        .status(403)
        .json({ success: false, message: 'Invalid or expired ID card link' });
    }

    // Opening the link with a valid token = the officer RECEIVED the card.
    // Atomic pipeline update: receivedAt keeps the FIRST download time,
    // downloadCount / lastDownloadedAt track every download. Admin session
    // previews (getAllocationCard) never mark the card as received.
    let fresh = card;
    try {
      fresh =
        (await IdCard.findOneAndUpdate(
          { _id: card._id },
          [
            {
              $set: {
                receivedAt: { $ifNull: ['$receivedAt', '$$NOW'] },
                lastDownloadedAt: '$$NOW',
                downloadCount: { $add: [{ $ifNull: ['$downloadCount', 0] }, 1] },
              },
            },
          ],
          { new: true }
        )) || card;
    } catch (markError) {
      // Marking must never block the download itself.
      console.error('[IDCARD] received-marking failed:', markError.message);
    }

    return sendPdf(res, fresh, 'attachment');
  } catch (error) {
    return next(error);
  }
}

module.exports = { getAllocationCard, downloadByToken };
