const { validationResult } = require('express-validator');

/**
 * Middleware that runs after express-validator chain(s): collects validation
 * errors and returns a meaningful 400 response, otherwise continues.
 */
function handleValidationErrors(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const messages = errors.array().map((e) => e.msg);
    return res.status(400).json({
      success: false,
      message: messages.join('; '),
      errors: errors.array(),
    });
  }
  return next();
}

module.exports = { handleValidationErrors };