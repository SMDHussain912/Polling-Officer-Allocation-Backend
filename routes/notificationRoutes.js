const express = require('express');
const { param, body } = require('express-validator');
const {
  sendAllocationNotification,
  getNotifications,
  sendAllNotifications,
  retryNotification,
  getNotificationSummary,
} = require('../controllers/notificationController');
const { protect, authorize } = require('../middleware/authMiddleware');
const { ROLES } = require('../services/roleService');
const { handleValidationErrors } = require('../middleware/validationMiddleware');
const { rateLimit } = require('../middleware/rateLimitMiddleware');

const router = express.Router();
router.use(protect); // all notification endpoints require a valid session

// Bulk sends are the dangerous surface: tight per-admin limit.
const bulkLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 10, message: 'Too many bulk notifications' });
const sendLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, message: 'Too many send requests' });

// POST /api/notifications/send/:allocationId — channels: sms/whatsapp/email
router.post(
  '/send/:allocationId',
  sendLimiter,
  param('allocationId').isMongoId().withMessage('Invalid allocation id'),
  body('channels').optional().isArray().withMessage('channels must be an array'),
  handleValidationErrors,
  authorize(ROLES.SUPER_ADMIN, ROLES.ALLOCATION_OFFICER),
  sendAllocationNotification
);

// POST /api/notifications/send-all — bulk, max 100, explicit UI confirmation
router.post(
  '/send-all',
  bulkLimiter,
  authorize(ROLES.SUPER_ADMIN, ROLES.ALLOCATION_OFFICER),
  sendAllNotifications
);

// POST /api/notifications/retry/:notificationId — manual retry, failed only
router.post(
  '/retry/:notificationId',
  sendLimiter,
  param('notificationId').isMongoId().withMessage('Invalid notification id'),
  handleValidationErrors,
  authorize(ROLES.SUPER_ADMIN, ROLES.ALLOCATION_OFFICER),
  retryNotification
);

// GET /api/notifications/summary — per-channel counts + provider readiness
router.get('/summary', getNotificationSummary);

// GET /api/notifications (server-scoped for Mandal Officers)
router.get('/', getNotifications);

module.exports = router;