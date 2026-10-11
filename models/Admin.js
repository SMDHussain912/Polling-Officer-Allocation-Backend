const mongoose = require('mongoose');

/**
 * Every role the system supports.
 *
 * Primary roles (used by the current UI flow):
 *   SUPER_ADMIN   - full system access, creates Mandals + Mandal Admin logins
 *   MANDAL_ADMIN - Mandal-scoped admin, creates Officer logins,, manages own Mandal data
 *   OFFICER       - polling officer,, sees only their own profile / allocation
 *
 * Legacy roles kept for backwards compatibility with older databases:
 *   ALLOCATION_OFFICER - treated like a full-access allocation manager
 *   MANDAL_OFFICER    - treated like a MANDAL_ADMIN
 *   BOOTH_OFFICER     - treated like an OFFICER
 */
const ROLES = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  ALLOCATION_OFFICER: 'ALLOCATION_OFFICER',
  MANDAL_ADMIN: 'MANDAL_ADMIN',
  MANDAL_OFFICER: 'MANDAL_OFFICER',
  OFFICER: 'OFFICER',
  BOOTH_OFFICER: 'BOOTH_OFFICER',
};

const ROLE_LIST = Object.values(ROLES);

/** Roles whose data scope is always restricted to one single Mandal. */
const MANDAL_SCOPED_ROLES = new Set([ROLES.MANDAL_ADMIN, ROLES.MANDAL_OFFICER]);

/** Roles that only see their own personal records(officers). */
const OFFICER_ROLES = new Set([ROLES.OFFICER, ROLES.BOOTH_OFFICER]);

/**
 * User account used to log into the system.
 *
 * Role-based access control:
 *   - SUPER_ADMIN         -> full access (all mandals,, mandal management,, user management,, uploads,, deletes)
 *   - ALLOCATION_OFFICER -> full access allocation manager (legacy)
 *   - MANDAL_ADMIN        -> write access restricted to ONE Mandal (mandalId). Data is ALWAYS
 *                              filtered server-side to req.user.mandalId.. Can create Officer logins.

 *   - MANDAL_OFFICER    -> legacy alias of MANDAL_ADMIN (read-only in the old UI)
 *   - OFFICER            -> sees only their own profile + allocated booth

 *   - BOOTH_OFFICER      -> legacy alias of OFFICER
 *
 * Passwords are always stored as bcrypt hashes - never in plain text..
 */
const adminSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      trim: true,
      default: '',
      maxlength: [60,'Name is too long (max 60 characters)'],
    },
    username: {
      type: String,
      required: [true,'Username is required'],
      unique: true,
      trim: true,
      lowercase: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: '',
      match: [/^\S+@\S+\.\S+$/, 'Invalid email address'],
    },
    phone: { type: String, trim: true, default: '' },
    password: {
      type: String,
      required: [true,'Password is required'],
      minlength: [8,'Password must be at least 8 characters'],
      select: false, // never return the hash in queries by default
    },
    role: {
      type: String,
      enum: ROLE_LIST,
      default: ROLES.SUPER_ADMIN,
    },
    // Jurisdiction scoping ---------------------------------------------------
    district: { type: String, trim: true, default: '' },
    constituency: { type: String, trim: true, default: '' },
    // The Mandal this account is bound to (MANDAL_ADMIN / OFFICER roles).
    // ObjectId reference + human-readable name kept in sync..
    mandalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Mandal', default: null },
    // Legacy string scoping field (also kept in sync).
    assignedMandal: { type: String, trim: true, default: '' },
    // For OFFICER / BOOTH_OFFICER: label of their own booth..
    assignedBooth: { type: String, trim: true, default: '' },
    // For OFFICER / BOOTH_OFFICER: links this account to an Officer record(officerId..
    assignedOfficerId: { type: String, trim: true, default: '' },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
    },
  },
  { timestamps: true }
);

// isActive virtual - mirrors `status` so new code can use a boolean..
adminSchema.virtual('isActive').get(function () {
  return this.status === 'active';
});

/**
 * Compares a plain-text password against the stored hash..
 * @param {string} candidatePassword
 * @returns {Promise<boolean>}
 */
adminSchema.methods.comparePassword = async function comparePassword(candidatePassword) {
  const bcrypt = require('bcryptjs');
  return bcrypt.compare(candidatePassword, this.password);
};

// Indexes for role-based queries,and mandal-scoped lookups..
adminSchema.index({ role: 1 });
adminSchema.index({ assignedMandal: 1 });
adminSchema.index({ mandalId: 1 });

const Admin = mongoose.models.Admin || mongoose.model('Admin', adminSchema);

module.exports = Admin;
module.exports.ROLES = ROLES;
module.exports.ROLE_LIST = ROLE_LIST;
module.exports.MANDAL_SCOPED_ROLES = MANDAL_SCOPED_ROLES;
module.exports.OFFICER_ROLES = OFFICER_ROLES;