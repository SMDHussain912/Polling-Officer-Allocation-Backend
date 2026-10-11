const express = require('express');
const { body, param, query } = require('express-validator');
const {
  getBooths,
  getBoothsGrouped,
  createBooth,
  updateBooth,
  deleteBooth,
  deleteAllBooths,
} = require('../controllers/boothController');
const { protect, authorize } = require('../middleware/authMiddleware');
const { ROLES } = require('../services/roleService');
const { handleValidationErrors } = require('../middleware/validationMiddleware');

const router = express.Router();
router.use(protect); // all booth endpoints require a valid JWT

// Roles that may create/edit booth records.
const MANAGER = [ROLES.SUPER_ADMIN, ROLES.ALLOCATION_OFFICER];
// Only the Super Admin may delete master data.
const EXECUTIVE = [ROLES.SUPER_ADMIN];

const boothBodyRules = [
  body('boothId').trim().notEmpty().withMessage('Booth ID is required'),
  body('boothNumber').trim().notEmpty().withMessage('Booth Number is required'),
  body('boothName').trim().notEmpty().withMessage('Booth Name is required'),
  body('pinCode')
    .optional({ values: 'falsy' })
    .matches(/^\d{6}$/)
    .withMessage('PIN Code must be 6 digits'),
  body('requiredOfficers')
    .isInt({ min: 0 })
    .withMessage('Required Officers must be a non-negative integer'),
  body('mandal').trim().notEmpty().withMessage('Mandal is required'),
];

// GET /api/booths/grouped - booths grouped per Mandal (separate sections)
router.get('/grouped', getBoothsGrouped);

// GET /api/booths
router.get('/', getBooths);

// POST /api/booths - create booth (Super Admin / Allocation Officer only)
router.post('/', boothBodyRules, handleValidationErrors, authorize(...MANAGER), createBooth);

/**
 * DELETE /api/booths/all[?mandal=X] - Super Admin only.
 * Deletes EVERY booth (optionally only one Mandal's uploaded file data)
 * together with any allocations pointing at those booths.
 * Declared BEFORE '/:id' so "all" is never treated as a booth id.
 */
router.delete(
  '/all',
  [query('mandal').optional({ checkFalsy: true }).isString().trim()],
  handleValidationErrors,
  authorize(...EXECUTIVE),
  deleteAllBooths
);

// PUT /api/booths/:id - update booth (Super Admin / Allocation Officer only)
router.put(
  '/:id',
  [param('id').isMongoId().withMessage('Invalid booth id'), ...boothBodyRules],
  handleValidationErrors,
  authorize(...MANAGER),
  updateBooth
);

// DELETE /api/booths/:id - Super Admin only
router.delete(
  '/:id',
  param('id').isMongoId().withMessage('Invalid booth id'),
  handleValidationErrors,
  authorize(...EXECUTIVE),
  deleteBooth
);

module.exports = router;