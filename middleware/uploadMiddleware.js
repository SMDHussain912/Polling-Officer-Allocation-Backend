const multer = require('multer');
const path = require('path');

const ALLOWED_EXTENSIONS = ['.xlsx', '.xls', '.csv'];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

/**
 * Multer configuration: uploads are kept in memory (no disk writes) because
 * the Excel contents are validated and saved into MongoDB immediately.
 */
const storage = multer.memoryStorage();

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    const error = new Error(
      `Unsupported file type '${ext}'. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`
    );
    error.statusCode = 400;
    return cb(error, false);
  }
  return cb(null, true);
}

const uploadSingleExcel = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter,
}).single('file');

module.exports = { uploadSingleExcel, ALLOWED_EXTENSIONS, MAX_FILE_SIZE };