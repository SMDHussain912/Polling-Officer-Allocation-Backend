const express = require('express');
const { param } = require('express-validator');
const { getAllSettings, saveSetting, previewSetting, sendTest } = require('../controllers/settingsController');
const { getIdCardDesign, saveIdCardDesign, previewIdCardPdf, resetIdCardDesign, uploadIdCardAsset } = require('../controllers/idCardDesignController');
const { protect, authorize } = require('../middleware/authMiddleware');
const { ROLES } = require('../services/roleService');
const { handleValidationErrors } = require('../middleware/validationMiddleware');
const { rateLimit } = require('../middleware/rateLimitMiddleware');

const router = express.Router();
router.use(protect);
router.use(authorize(ROLES.SUPER_ADMIN, ROLES.ALLOCATION_OFFICER));

const testLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 10, message: 'Too many test messages' });

// GET /api/settings/notifications — all channels + variables + provider status
router.get('/notifications', getAllSettings);

// PUT /api/settings/notifications/:channel — save one template
router.put(
  '/notifications/:channel',
  param('channel').isIn(['email', 'sms', 'whatsapp']).withMessage('Invalid channel'),
  handleValidationErrors,
  saveSetting
);

// POST /api/settings/notifications/:channel/preview — live render
router.post(
  '/notifications/:channel/preview',
  param('channel').isIn(['email', 'sms', 'whatsapp']).withMessage('Invalid channel'),
  handleValidationErrors,
  previewSetting
);

// --- ID Card Designer (same simple style) ---
// NOTE: /idcard routes are top-level (not under /notifications/:channel) so
// Express never confuses "idcard" with a channel param.
router.get('/idcard/preview.pdf', previewIdCardPdf);
router.get('/idcard', getIdCardDesign);
router.put('/idcard', saveIdCardDesign);
router.post('/idcard/asset', uploadIdCardAsset);
router.post('/idcard/reset', resetIdCardDesign);

// POST /api/settings/notifications/test — ONE test to an admin-typed recipient
// Kept AFTER the "/notifications/:channel" route on purpose: Express matches
// top->bottom, so "/test" is only reached once we are sure the request is not
// for a channel template.
router.post(
  '/notifications/test',
  testLimiter,
  sendTest
);

module.exports = router;
