const express = require('express');
const { param, body } = require('express-validator');
const {
  runAllocation,
  getAllocations,
  getAllocationMandals,
  getSuitableBooths,
  manualAllocateAction,
  reallocateAllocation,
  cancelAllocationAction,
  getDashboardStats,
  deleteAllAllocations,
  deleteAllocationsByMandal,
} = require('../controllers/allocationController');
const { protect } = require('../middleware/authMiddleware');
const { handleValidationErrors } = require('../middleware/validationMiddleware');

const router = express.Router();
router.use(protect);

router.post(
  '/run',
  [
    body('maxAllocations')
      .optional({ values: 'null' })
      .isInt({ min: 1 })
      .withMessage('maxAllocations must be a positive integer'),
  ],
  handleValidationErrors,
  runAllocation
);

router.get('/mandals', getAllocationMandals);

router.get('/', getAllocations);

router.get('/suitable-booths/:officerId', getSuitableBooths);

router.post(
  '/manual',
  [
    body('officerId').isString().trim().notEmpty().withMessage('officerId is required'),
    body('boothId').isString().trim().notEmpty().withMessage('boothId is required'),
  ],
  handleValidationErrors,
  manualAllocateAction
);

router.delete('/all', deleteAllAllocations);

router.delete(
  '/mandal/:name',
  [param('name').isString().trim().notEmpty().withMessage('Mandal name is required')],
  handleValidationErrors,
  deleteAllocationsByMandal
);

router.post(
  '/:id/reallocate',
  [param('id').isMongoId().withMessage('Invalid allocation id')],
  handleValidationErrors,
  reallocateAllocation
);

router.post(
  '/:id/cancel',
  [param('id').isMongoId().withMessage('Invalid allocation id')],
  handleValidationErrors,
  cancelAllocationAction
);

module.exports = { router, getDashboardStats };
