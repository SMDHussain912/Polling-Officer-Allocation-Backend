const express = require('express');
const { verifyWhatsapp, whatsappEvents, smsEvents } = require('../controllers/webhookController');

const router = express.Router();

// Meta verification handshake (no auth — Meta calls this, token-checked inside).
router.get('/whatsapp', verifyWhatsapp);

// Meta status events. Raw body preserved in server.js for signature check.
router.post('/whatsapp', express.raw({ type: '*/*' }), (req, res, next) => {
  req.rawBody = req.body;
  try {
    req.body = req.body && req.body.length ? JSON.parse(req.body.toString('utf8')) : {};
  } catch {
    return res.status(400).json({ success: false, message: 'Invalid JSON' });
  }
  return whatsappEvents(req, res, next);
});

// SMS provider delivery callbacks (JSON, optional shared secret inside).
router.post('/sms', express.json(), smsEvents);

module.exports = router;
