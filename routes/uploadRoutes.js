const express = require('express');
const { param } = require('express-validator');
const {
  uploadOfficers,
  uploadBooths,
  downloadTemplate,
  getUploadHistory,
  deleteUploadBatch,
  deleteAllUploads,
} = require('../controllers/uploadController');
const { protect, authorize } = require('../middleware/authMiddleware');
const { ROLES } = require('../services/roleService');
const { uploadSingleExcel } = require('../middleware/uploadMiddleware');
const { handleValidationErrors } = require('../middleware/validationMiddleware');

const router = express.Router();
// Excel uploads import master data - only the Super Admin may upload files.
router.use(protect, authorize(ROLES.SUPER_ADMIN));

// GET /api/upload/history - list every committed upload (must be before /:id)
router.get('/history', getUploadHistory);

// DELETE /api/upload/all - wipe EVERY uploaded file and ALL its data
// (must be registered before /:id so 'all' is not treated as an id)
router.delete('/all', deleteAllUploads);

// DELETE /api/upload/:id - remove the upload record AND its imported data
router.delete(
  '/:id',
  param('id').isMongoId().withMessage('Invalid upload id'),
  handleValidationErrors,
  deleteUploadBatch
);

// POST /api/upload/officers?mode=preview|commit
router.post('/officers', uploadSingleExcel, uploadOfficers);

// POST /api/upload/booths?mode=preview|commit
router.post('/booths', uploadSingleExcel, uploadBooths);

// GET /api/upload/templates/officers  |  /booths  (sample .xlsx download)
router.get(
  '/templates/:kind',
  param('kind').isIn(['officers', 'booths']).withMessage('Invalid template kind'),
  handleValidationErrors,
  downloadTemplate
);

module.exports = router;