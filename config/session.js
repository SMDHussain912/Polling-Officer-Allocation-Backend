/**
 * session.js
 * ==========
 * Express-session configuration backed by MongoDB (connect-mongo).
 *
 * Why sessions instead of JWTs for this app: a single admin, a single server
 * process and a browser-only client - the "stateless token" advantages of JWT
 * buy nothing here, while an HttpOnly cookie session gives us:
 *   - HttpOnly: JavaScript cannot read the credential (XSS cannot steal it)
 *   - native logout: req.session.destroy() replaces the JWT denylist entirely
 *   - rolling 7-day sessions: no forced re-login every few hours
 *   - sessions survive server restarts (MongoDB store, not memory)
 *   - instant global revocation (delete the session record)
 */
const expressSession = require('express-session');
const { MongoStore } = require('connect-mongo');

const COOKIE_NAME = 'po.sid';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, renewed on activity

function buildSessionMiddleware() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    // Fail closed: a weak/absent secret would let anyone forge session cookies.
    throw new Error(
      '[SECURITY] SESSION_SECRET missing or too short - set a 32+ char random value in backend/.env'
    );
  }

  const store = MongoStore.create({
    mongoUrl: process.env.MONGODB_URI,
    collectionName: 'sessions',
    ttl: SESSION_TTL_MS / 1000, // Mongo TTL index auto-purges expired sessions
    crypto: { secret }, // session contents are encrypted at rest in Mongo
  });

  return expressSession({
    name: COOKIE_NAME,
    secret,
    store,
    resave: false,
    saveUninitialized: false,
    rolling: true, // maxAge is refreshed on every request => stays logged in while active
    cookie: {
      httpOnly: true, // invisible to JavaScript (XSS defence)
      // Cross-domain deploy (Vercel frontend + Render backend) needs
      // SameSite=None or the cookie is never sent on cross-site requests, and
      // the session appears to "not stick" (instant bounce to /login). Same-
      // origin (local dev proxy) keeps the stricter 'lax'. None REQUIRES
      // Secure (https), which we already force in production. The Origin-check
      // middleware in server.js remains the CSRF backstop.
      sameSite: (process.env.SESSION_SAMESITE || (process.env.NODE_ENV === 'production' ? 'none' : 'lax')).toLowerCase(),
      secure: process.env.NODE_ENV === 'production', // https-only behind the tunnel
      maxAge: SESSION_TTL_MS,
      path: '/',
    },
  });
}

module.exports = { buildSessionMiddleware, COOKIE_NAME };
