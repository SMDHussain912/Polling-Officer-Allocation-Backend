const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const Admin = require('../models/Admin');
const roleService = require('../services/roleService');
const { sanitizeUser, ROLES } = roleService;
const { COOKIE_NAME } = require('../config/session');
const { verifyFirebaseIdToken } = require('../services/googleAuthService');

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

/**
 * POST /api/auth/google
 * Firebase Google sign-in for the admin. The browser completes the Google
 * popup and sends the resulting Firebase ID token. The token is verified
 * SERVER-SIDE (signature, project, issuer, expiry, verified email - see
 * googleAuthService) and the email is then matched against the
 * ADMIN_GOOGLE_EMAILS allowlist. Any other account is declined with 403 -
 * exactly one configured Google identity can ever hold an admin session.
 *
 * On success the admin document is looked up by email/username (provisioned
 * once on first Google login, with an unguessable random password so the
 * account cannot be brute-forced through /login) and the session cookie is
 * issued exactly like the password login.
 */
async function googleLogin(req, res, next) {
  try {
    const allowlist = (process.env.ADMIN_GOOGLE_EMAILS || '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);

    // Fail closed: without a configured allowlist the endpoint admits nobody.
    if (!allowlist.length) {
      return res.status(403).json({
        success: false,
        message: 'Google sign-in is not enabled for this deployment',
      });
    }

    const { idToken } = req.body || {};
    const result = await verifyFirebaseIdToken(idToken, {
      projectId: process.env.FIREBASE_PROJECT_ID,
    });

    if (!result.valid) {
      if (result.reason === 'malformed') {
        return res
          .status(400)
          .json({ success: false, message: 'Google sign-in token is missing or malformed' });
      }
      // Invalid/expired/wrong-project tokens are all "unauthenticated".
      return res.status(401).json({
        success: false,
        message: `Google sign-in failed: ${result.reason}`,
      });
    }

    const email = String(result.claims.email || '').trim().toLowerCase();
    if (!allowlist.includes(email)) {
      // Deliberately generic - the response must not leak which emails exist.
      return res.status(403).json({
        success: false,
        message: 'This Google account is not authorized for admin access',
      });
    }

    // Find (or provision once) the admin account bound to this Google email.
    let admin = await Admin.findOne({ $or: [{ email }, { username: email }] });
    if (!admin) {
      const unguessable = crypto.randomBytes(24).toString('hex');
      admin = await Admin.create({
        name: result.claims.name || email,
        username: email,
        email,
        password: await bcrypt.hash(unguessable, 12),
        role: ROLES.SUPER_ADMIN,
        status: 'active',
      });
    } else if (admin.status === 'inactive') {
      return res.status(403).json({
        success: false,
        message: 'This account has been deactivated - contact your administrator',
      });
    }

    // Identical session issuance to the password login (anti-fixation rotate).
    req.session.regenerate((regenErr) => {
      if (regenErr) return next(regenErr);
      req.session.adminId = admin._id.toString();
      req.session.save((saveErr) => {
        if (saveErr) return next(saveErr);
        return res.json({ success: true, user: sanitizeUser(admin) });
      });
    });
  } catch (error) {
    next(error);
  }
}

module.exports = { login, me, logout, googleLogin };
