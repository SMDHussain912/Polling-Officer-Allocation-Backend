/**
 * User model
 * ===========
 * The application's login account model. The Admin collection is the single
 * source of truth for every user account (SUPER_ADMIN, MANDAL_ADMIN, OFFICER
 * and the legacy roles). This module is a thin, backwards-compatible alias so
 * code that prefers `User` can require it while sharing the exact same
 * collection and schema as `Admin`.
 *
 * Required fields (per specification):
 *   name, username, password (bcrypt hashed), role, mandalId, phone, email,
 *   isActive, createdAt, updatedAt
 */

module.exports = require('./Admin');