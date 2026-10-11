/**
 * googleAuthService.js
 * ====================
 * Server-side verification of Firebase ID tokens - WITHOUT firebase-admin.
 *
 * The browser signs the user in with Firebase (Google popup) and hands the
 * resulting ID token to POST /api/auth/google. Before an admin session is
 * ever created the token must be proven to be:
 *   - correctly signed by Google's Firebase token key (RS256, JWKS-fetched)
 *   - issued for THIS Firebase project (aud === FIREBASE_PROJECT_ID)
 *   - issued by the right issuer (https://securetoken.google.com/<project>)
 *   - unexpired (exp in the future, iat not far in the future)
 *   - carrying a VERIFIED email address (email_verified === true)
 *
 * Only after all of that is the email matched against the ADMIN_GOOGLE_EMAILS
 * allowlist (in authController) - every other account is declined. No trust
 * is ever placed in data sent by the client.
 */
const crypto = require('crypto');

// Public keys Google uses to sign Firebase Auth ID tokens.
const JWKS_URL =
  'https://www.googleapis.com/robot/v1/metadata/jwk/securetoken@system.gserviceaccount.com';
const JWKS_TTL_MS = 60 * 60 * 1000; // keys rotate rarely; refetch hourly / on unknown kid

let jwksCache = { keys: [], fetchedAt: 0 };

async function fetchJwks() {
  const res = await fetch(JWKS_URL, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`JWKS fetch failed: HTTP ${res.status}`);
  const body = await res.json();
  jwksCache = { keys: Array.isArray(body.keys) ? body.keys : [], fetchedAt: Date.now() };
  return jwksCache.keys;
}

/** Resolves the JWK matching a token's kid (cache first, single refetch on miss). */
async function getSigningKey(kid) {
  const now = Date.now();
  if (!jwksCache.keys.length || now - jwksCache.fetchedAt > JWKS_TTL_MS) {
    await fetchJwks();
  }
  let key = jwksCache.keys.find((k) => k.kid === kid);
  if (!key) {
    // Unknown kid -> Google may have rotated keys since the cache was filled.
    await fetchJwks();
    key = jwksCache.keys.find((k) => k.kid === kid);
  }
  return key || null;
}

function decodeSegment(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

/**
 * Verifies a Firebase ID token.
 * @param {string} idToken raw JWT from the Firebase client SDK
 * @param {{projectId: string, jwksOverride?: Array}} opts projectId is required;
 *        jwksOverride lets the offline test script inject its own keys.
 * @returns {{valid: boolean, reason: string|null, claims: object}}
 *   reason: malformed | bad-alg | unknown-key | keys-unavailable | bad-key |
 *           bad-signature | wrong-audience | wrong-issuer | expired |
 *           issued-in-future | missing-subject | unverified-email
 */
async function verifyFirebaseIdToken(idToken, { projectId, jwksOverride } = {}) {
  const claims = {};
  if (!idToken || typeof idToken !== 'string') {
    return { valid: false, reason: 'malformed', claims };
  }
  const parts = idToken.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'malformed', claims };

  let header;
  let payload;
  try {
    header = decodeSegment(parts[0]);
    payload = decodeSegment(parts[1]);
  } catch {
    return { valid: false, reason: 'malformed', claims };
  }

  // Keep the interesting claims for callers / logging.
  claims.aud = payload.aud;
  claims.iss = payload.iss;
  claims.exp = payload.exp;
  claims.iat = payload.iat;
  claims.email = payload.email;
  claims.email_verified = payload.email_verified;
  claims.name = payload.name;
  claims.uid = payload.sub || payload.user_id;

  if (!header || header.alg !== 'RS256') return { valid: false, reason: 'bad-alg', claims };
  if (!header.kid) return { valid: false, reason: 'malformed', claims };

  // --- Signature -------------------------------------------------------------
  let jwk = null;
  if (Array.isArray(jwksOverride)) {
    jwk = jwksOverride.find((k) => k.kid === header.kid) || null;
  } else {
    try {
      jwk = await getSigningKey(header.kid);
    } catch {
      return { valid: false, reason: 'keys-unavailable', claims };
    }
  }
  if (!jwk) return { valid: false, reason: 'unknown-key', claims };

  let publicKey;
  try {
    publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    return { valid: false, reason: 'bad-key', claims };
  }
  const signedInput = `${parts[0]}.${parts[1]}`;
  const signature = Buffer.from(parts[2], 'base64url');
  const signatureOk = crypto.verify(
    'RSA-SHA256',
    Buffer.from(signedInput),
    publicKey,
    signature
  );
  if (!signatureOk) return { valid: false, reason: 'bad-signature', claims };

  // --- Claims -----------------------------------------------------------------
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== projectId) return { valid: false, reason: 'wrong-audience', claims };
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) {
    return { valid: false, reason: 'wrong-issuer', claims };
  }
  if (!payload.exp || payload.exp <= now) return { valid: false, reason: 'expired', claims };
  if (payload.iat && payload.iat > now + 60) {
    return { valid: false, reason: 'issued-in-future', claims };
  }
  if (!payload.sub && !payload.user_id) {
    return { valid: false, reason: 'missing-subject', claims };
  }
  if (!payload.email || payload.email_verified !== true) {
    return { valid: false, reason: 'unverified-email', claims };
  }

  return { valid: true, reason: null, claims };
}

module.exports = { verifyFirebaseIdToken, fetchJwks };
