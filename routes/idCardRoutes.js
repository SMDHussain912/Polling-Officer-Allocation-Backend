const express = require('express');
const { param, query } = require('express-validator');
const { getAllocationCard, downloadByToken } = require('../controllers/idCardController');
const { protect } = require('../middleware/authMiddleware');
const { handleValidationErrors } = require('../middleware/validationMiddleware');

const router = express.Router();

// GET /api/idcards/allocation/:allocationId
// Admin preview/download of the polling-duty ID card (JWT session required).
// The PDF is generated on first request and cached in the IdCard collection.
router.get(
  '/allocation/:allocationId',
  protect,
  param('allocationId').isMongoId().withMessage('Invalid allocation id'),
  handleValidationErrors,
  getAllocationCard
);

// GET /api/idcards/pdf/:cardId?token=...
// Token-gated PUBLIC download - this is the link embedded in the officer's
// SMS (phones have no admin session). Wrong/missing token -> 403.
router.get(
  '/pdf/:cardId',
  param('cardId').isMongoId().withMessage('Invalid card id'),
  query('token')
    .isString()
    .trim()
    .isLength({ min: 16, max: 128 })
    .withMessage('Invalid or missing ID card token'),
  handleValidationErrors,
  downloadByToken
);

module.exports = router;
