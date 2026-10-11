const bcrypt = require('bcryptjs');
const Admin = require('../models/Admin');
const roleService = require('../services/roleService');
const { sanitizeUser } = roleService;
const { COOKIE_NAME } = require('../config/session');

function normalizeLogin(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * POST /api/auth/login
 * The ONLY login in the system: the Main Admin.
 * Username is enough - officers and mandals do not log in.
 */
async function login(req, res, next) {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res
        .status(400)
        .json({ success: false, message: 'Username and password are required' });
    }

    const identifier = normalizeLogin(username);
    const user = await Admin.findOne({ username: identifier }).select('+password');

    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ success: false, message: 'Invalid username or password' });
    }

    // Progressive re-hash: transparently migrate legacy bcrypt-10 hashes to
    // the hardened cost factor (12) on the next successful login.
    if (user.password && bcrypt.getRounds(user.password) < 12) {
      user.password = await bcrypt.hash(password, 12);
      await user.save();
    }
    if (user.status === 'inactive') {
      return res.status(403).json({
        success: false,
        message: 'This account has been deactivated - contact your administrator',
      });
    }

    // Rotate the session id on privilege change (login) to prevent session
    // fixation, then bind the admin to the fresh session.
    req.session.regenerate((regenErr) => {
      if (regenErr) return next(new Error('[AUTH] session.regenerate failed: ' + regenErr.message));
      req.session.adminId = user._id.toString();
      req.session.save((saveErr) => {
        if (saveErr) return next(new Error('[AUTH] session.save failed: ' + saveErr.message));
        return res.json({ success: true, user: sanitizeUser(user) });
      });
    });
  } catch (error) {
    console.error('[AUTH] login() thrown:', error.message);
    console.error('[AUTH] login() stack:', error.stack);
    next(error);
  }
}

/** GET /api/auth/me - returns the currently logged-in Main Admin. */
async function me(req, res) {
  return res.json({ success: true, user: req.user });
}

/**
 * POST /api/auth/logout
 * Destroys the server-side session (stored in MongoDB - deletion is instant
 * and global) and clears the cookie. No token denylist needed: a destroyed
 * session simply no longer exists. Idempotent - logging out without a
 * session still succeeds.
 */
async function logout(req, res, next) {
  try {
    if (!req.session) {
      res.clearCookie(COOKIE_NAME, { path: '/' });
      return res.json({ success: true, message: 'Logged out - no active session' });
    }
    req.session.destroy(() => {
      res.clearCookie(COOKIE_NAME, { path: '/' });
      return res.json({ success: true, message: 'Logged out - session destroyed' });
    });
  } catch (error) {
    next(error);
  }
}

module.exports = { login, me, logout };
