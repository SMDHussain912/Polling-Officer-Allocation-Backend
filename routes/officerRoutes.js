const express = require('express');
const { body, param, query } = require('express-validator');
const {
  getOfficers,
  getOfficersGrouped,
  createOfficer,
  updateOfficer,
  deleteOfficer,
  deleteAllOfficers,
  registerOfficer,
} = require('../controllers/officerController');
const { protect, authorize } = require('../middleware/authMiddleware');
const { ROLES } = require('../services/roleService');
const { handleValidationErrors } = require('../middleware/validationMiddleware');
const { rateLimit } = require('../middleware/rateLimitMiddleware');

const router = express.Router();

// ---------------------------------------------------------------------------
// PUBLIC employee self-registration (NO JWT - declared BEFORE the protect
// middleware below):
//   POST /api/officers/register
// Employees fill in their details and go straight into the employees list -
// there is NO approval workflow and they never receive login credentials
// (only admins can log in). Rate-limited because it is publicly reachable.
// ---------------------------------------------------------------------------
const registerRules = [
  // isString() FIRST: object payloads (NoSQL-injection attempts like
  // {"$gt":""}) are rejected as type errors instead of being stringified.
  body('officerName').isString().trim().isLength({ min: 2, max: 80 }).withMessage('Full name must be 2-80 characters'),
  body('designation').isString().trim().isLength({ min: 2, max: 60 }).withMessage('Designation must be 2-60 characters'),
  body('mobileNumber')
    .isString()
    .trim()
    .notEmpty()
    .withMessage('Mobile Number is required')
    .matches(/^[0-9+\-\s]{10,15}$/)
    .withMessage('Invalid mobile number'),
  body('email').trim().isEmail().withMessage('A valid e-mail address is required').normalizeEmail(),
  body('mandal').isString().trim().isLength({ min: 2, max: 60 }).withMessage('Mandal is required (2-60 characters)'),
  // ALL registration fields are REQUIRED (per specification) - the public
  // self-registration form must not accept partial addresses.
  body('district').isString().trim().notEmpty().withMessage('District is required').isLength({ max: 60 }).withMessage('District is too long'),
  body('houseNo').isString().trim().notEmpty().withMessage('House No. is required').isLength({ max: 20 }).withMessage('House No. is too long'),
  body('street').isString().trim().notEmpty().withMessage('Street is required').isLength({ max: 80 }).withMessage('Street is too long'),
  body('locality').isString().trim().notEmpty().withMessage('Village/Locality is required').isLength({ max: 80 }).withMessage('Locality is too long'),
  body('ward').isString().trim().notEmpty().withMessage('Ward is required').isLength({ max: 30 }).withMessage('Ward is too long'),
  body('pinCode').isString().trim().notEmpty().withMessage('PIN Code is required').matches(/^\d{6}$/).withMessage('PIN Code must be 6 digits'),
];

router.post(
  '/register',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: 'Too many registration attempts' }),
  registerRules,
  handleValidationErrors,
  registerOfficer
);

// All remaining officer endpoints require a valid JWT.
router.use(protect);

// Roles that may create/edit officer records.
const MANAGER = [ROLES.SUPER_ADMIN, ROLES.ALLOCATION_OFFICER];
// Only the Super Admin may delete master data.
const EXECUTIVE = [ROLES.SUPER_ADMIN];

const officerBodyRules = [
  body('officerId').trim().notEmpty().withMessage('Officer ID is required'),
  body('officerName').trim().notEmpty().withMessage('Officer Name is required'),
  body('designation').trim().notEmpty().withMessage('Designation is required'),
  body('mobileNumber')
    .trim()
    .notEmpty()
    .withMessage('Mobile Number is required')
    .matches(/^[0-9+\-\s]{10,15}$/)
    .withMessage('Invalid mobile number'),
  body('email').optional({ values: 'falsy' }).isEmail().withMessage('Invalid email'),
  body('pinCode')
    .optional({ values: 'falsy' })
    .matches(/^\d{6}$/)
    .withMessage('PIN Code must be 6 digits'),
  body('mandal').trim().notEmpty().withMessage('Mandal is required'),
];

// GET /api/officers/grouped - officers grouped per Mandal (separate sections)
router.get('/grouped', getOfficersGrouped);

// GET /api/officers
router.get('/', getOfficers);

// POST /api/officers - create officer (Super Admin / Allocation Officer only)
router.post('/', officerBodyRules, handleValidationErrors, authorize(...MANAGER), createOfficer);

/**
 * DELETE /api/officers/all[?mandal=X] - Super Admin only.
 * Deletes EVERY officer (optionally only one Mandal's uploaded file data)
 * together with their allocations, notifications and cleared upload records.
 * Declared BEFORE '/:id' so "all" is never treated as an officer id.
 */
router.delete(
  '/all',
  [query('mandal').optional({ checkFalsy: true }).isString().trim()],
  handleValidationErrors,
  authorize(...EXECUTIVE),
  deleteAllOfficers
);

// PUT /api/officers/:id - update officer (Super Admin / Allocation Officer only)
router.put(
  '/:id',
  [param('id').isMongoId().withMessage('Invalid officer id'), ...officerBodyRules],
  handleValidationErrors,
  authorize(...MANAGER),
  updateOfficer
);

// DELETE /api/officers/:id - Super Admin only
router.delete(
  '/:id',
  param('id').isMongoId().withMessage('Invalid officer id'),
  handleValidationErrors,
  authorize(...EXECUTIVE),
  deleteOfficer
);

module.exports = router;