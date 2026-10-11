const Admin = require('../models/Admin');
const roleService = require('../services/roleService');

/** Express error returned for missing/invalid tokens - matches errorMiddleware. */
function unauthorized(res, message) {
  return res.status(401).json({ success: false, message });
}

/**
 * Protects every protected route. Reads the signed, HttpOnly session cookie
 * (managed by express-session), loads the user, checks the account is still
 * active, and attaches the sanitized document to req.user (req.admin is kept
 * for backward compatibility).
 */
async function protect(req, res, next) {
  try {
    if (!req.session || !req.session.adminId) {
      return unauthorized(res, 'Not authorized - please log in');
    }

    const user = await Admin.findById(req.session.adminId).select('-password').lean();
    if (!user) {
      // The session points at a deleted account - kill the stale session.
      req.session.destroy(() => {});
      return unauthorized(res, 'Not authorized - account no longer exists');
    }
    if (user.status === 'inactive') {
      return unauthorized(res, 'This account has been deactivated - contact your administrator');
    }

    // Attach the sanitized user (role + jurisdiction) for every downstream
    // controller to scope its queries.
    req.user = roleService.sanitizeUser(user);
    req.admin = req.user;
    return next();
    } catch (error) {
      return unauthorized(res, 'Not authorized - invalid session');
    }
}

/**
 * Role-based authorization: allows the request only when the signed-in user's
 * role is included in the allowed roles, otherwise returns HTTP 403.
 *
 * Usage: router.post('/', authorize('SUPER_ADMIN'), createOfficer);
 */
function authorize(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return unauthorized(res, 'Not authorized - missing token');
    }
    const allowed = allowedRoles.flat();
    if (!allowed.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: you do not have permission to perform this action',
      });
    }
    return next();
  };
}

module.exports = { protect, authorize, unauthorized, ROLES: roleService.ROLES };