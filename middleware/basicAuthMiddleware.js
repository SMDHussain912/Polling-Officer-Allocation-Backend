/**
 * basicAuthMiddleware.js
 * ======================
 * Dedicated HTTP Basic-Auth login for the API documentation (Swagger).
 *
 * Deliberately SEPARATE from the admin JWT:
 *   - this login guards only /api-docs* (+ /swagger.json) and grants no API
 *     access;
 *   - conversely, a valid admin JWT does NOT open the docs.
 *
 * Credentials come from SWAGGER_USERNAME / SWAGGER_PASSWORD in backend/.env.
 * If SWAGGER_PASSWORD is not set, a strong random password is generated once
 * per boot and printed to the console (zero-config, never a weak default).
 */
const crypto = require('crypto');

/** Length-safe string comparison: hash both sides, then timing-safe compare. */
function timingSafeEqualStr(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** 16-char password from an alphabet without look-alike characters. */
function generatePassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(16);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

const swaggerUsername = (process.env.SWAGGER_USERNAME || 'swagger').trim() || 'swagger';
let swaggerPassword = (process.env.SWAGGER_PASSWORD || '').trim();
if (!swaggerPassword) {
  swaggerPassword = generatePassword();
  console.log('[SWAGGER] SWAGGER_PASSWORD not set - generated for THIS boot:');
  console.log(`[SWAGGER]   docs login: ${swaggerUsername} / ${swaggerPassword}`);
  console.log('[SWAGGER]   set SWAGGER_PASSWORD in backend/.env for a fixed password.');
} else if (swaggerPassword === 'admin123' || swaggerPassword.length < 8) {
  console.warn('[SWAGGER] SWAGGER_PASSWORD is weak (min 8 chars) - set a stronger one.');
}

/**
 * Basic-Auth guard for the documentation endpoints. On failure it answers
 * 401 + WWW-Authenticate so the browser shows its native login dialog.
 */
function swaggerDocsAuth(req, res, next) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      const username = idx === -1 ? decoded : decoded.slice(0, idx);
      const password = idx === -1 ? '' : decoded.slice(idx + 1);
      if (
        timingSafeEqualStr(username, swaggerUsername) &&
        timingSafeEqualStr(password, swaggerPassword)
      ) {
        return next();
      }
    } catch {
      /* malformed header - fall through to the 401 below */
    }
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="Polling Officer API Docs", charset="UTF-8"');
  return res.status(401).type('text').send('401 - Documentation login required');
}

module.exports = { swaggerDocsAuth, timingSafeEqualStr };