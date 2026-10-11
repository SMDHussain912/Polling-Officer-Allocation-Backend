const multer = require('multer');
const mongoose = require('mongoose');

/** Express 404 fallback. */
function notFound(req, res, next) {
  res.status(404);
  next(new Error(`Route not found: ${req.method} ${req.originalUrl}`));
}

/**
 * Centralised error handler. Every controller/middleware error ends up here
 * and is converted into a meaningful JSON response.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(error, req, res, next) {
  // NOTE: Express initialises res.statusCode to 200, so it can never be the
  // fallback for plain Errors - otherwise business errors would be returned
  // as HTTP 200. Trust res.statusCode only when a controller explicitly set
  // a >= 400 status before calling next(error).
  let statusCode =
    error.statusCode || (res.statusCode >= 400 ? res.statusCode : 500) || 500;
  let message = error.message || 'Server Error';

  // Multer file errors
  if (error instanceof multer.MulterError) {
    statusCode = 400;
    message = error.code === 'LIMIT_FILE_SIZE' ? 'File is too large (max 5 MB)' : error.message;
  }

  // Mongoose validation failures
  if (error instanceof mongoose.Error.ValidationError) {
    statusCode = 400;
    message = Object.values(error.errors)
      .map((e) => e.message)
      .join('; ');
  }

  // Mongoose duplicate key (unique index) - e.g. Officer ID / Booth ID
  if (error.name === 'MongoServerError' && error.code === 11000) {
    statusCode = 409;
    const field = Object.keys(error.keyPattern || {})[0] || 'field';
    message = `Duplicate value for '${field}' - record already exists`;
  }

  // Bad ObjectIds passed in URLs
  if (error.name === 'CastError') {
    statusCode = 400;
    message = `Invalid value for ${error.path}`;
  }

  if (statusCode >= 500) console.error('[ERROR]', error.stack || error);

  res.status(statusCode).json({
    success: false,
    message,
    stack: process.env.NODE_ENV === 'development' && statusCode >= 500 ? error.stack : undefined,
  });
}

module.exports = { notFound, errorHandler };