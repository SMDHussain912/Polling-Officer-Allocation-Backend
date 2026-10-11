const express = require('express');
const { body } = require('express-validator');
const { login, me, logout, googleLogin } = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');
const { handleValidationErrors } = require('../middleware/validationMiddleware');
const { rateLimit } = require('../middleware/rateLimitMiddleware');

const router = express.Router();

// POST /api/auth/login - Main Admin login (public)
router.post(
  '/login',
  // Blunt credential-stuffing: 20 attempts / 15 min per IP.
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: 'Too many login attempts - try again in 15 minutes',
  }),
  [
    body('username').trim().notEmpty().withMessage('Username is required'),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  handleValidationErrors,
  login
);

// POST /api/auth/google - Firebase Google sign-in (public, allowlisted emails)
// The ONLY Google identity admitted is the one(s) in ADMIN_GOOGLE_EMAILS.
router.post(
  '/google',
  // Same credential-stuffing budget as the password login.
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: 'Too many login attempts - try again in 15 minutes',
  }),
  [body('idToken').isString().notEmpty().withMessage('Google sign-in token is required')],
  handleValidationErrors,
  googleLogin
);

// GET /api/auth/me - current session info (protected)
router.get('/me', protect, me);

// POST /api/auth/logout - destroys the server-side session (protected)
router.post('/logout', protect, logout);

// There is intentionally NO /register, NO /boot and NO user-management route.
// The Main Admin is created automatically on server start (see server.js).

module.exports = router;
