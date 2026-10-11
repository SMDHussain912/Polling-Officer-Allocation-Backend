/**
 * verify-google-login.js
 * ======================
 * OFFLINE verification of the Firebase ID-token verifier used by
 * POST /api/auth/google (no network, no Firebase account needed).
 *
 * It mints its own RSA keypair and crafts real RS256 JWTs shaped exactly like
 * Firebase ID tokens, then checks the happy path plus every reject reason:
 * expired, wrong audience, wrong issuer, bad signature, unverified email,
 * missing email, garbage input.
 *
 * Run: node scripts/verify-google-login.js
 */
const crypto = require('crypto');
const { verifyFirebaseIdToken } = require('../services/googleAuthService');

const PROJECT = 'polling-system-feeee';

function b64urlJson(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

/** Mints an RS256 JWT (Firebase-ID-token shaped) with the given private key. */
function mintToken(header, payload, privateKey) {
  const input = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(input), privateKey);
  return `${input}.${signature.toString('base64url')}`;
}

(async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const jwks = [
    { ...publicKey.export({ format: 'jwk' }), kid: 'test-key-1', alg: 'RS256', use: 'sig' },
  ];

  const now = Math.floor(Date.now() / 1000);
  const HEADER = { alg: 'RS256', kid: 'test-key-1', typ: 'JWT' };
  const BASE = {
    iss: `https://securetoken.google.com/${PROJECT}`,
    aud: PROJECT,
    sub: 'uid-123456',
    email: 'boss@example.com',
    email_verified: true,
    name: 'The Boss',
    iat: now - 60,
    exp: now + 3600,
  };

  const wrongSigner = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;

  const cases = [
    ['valid token accepted', mintToken(HEADER, BASE, privateKey), true, null],
    ['expired token rejected', mintToken(HEADER, { ...BASE, exp: now - 10 }, privateKey), false, 'expired'],
    ['wrong audience rejected', mintToken(HEADER, { ...BASE, aud: 'someone-elses-project' }, privateKey), false, 'wrong-audience'],
    ['wrong issuer rejected', mintToken(HEADER, { ...BASE, iss: 'https://securetoken.google.com/evil' }, privateKey), false, 'wrong-issuer'],
    ['forged signature rejected', mintToken(HEADER, BASE, wrongSigner), false, 'bad-signature'],
    ['unverified email rejected', mintToken(HEADER, { ...BASE, email_verified: false }, privateKey), false, 'unverified-email'],
    ['missing email rejected', mintToken(HEADER, { ...BASE, email: undefined, email_verified: undefined }, privateKey), false, 'unverified-email'],
    ['garbage token rejected', 'garbage.token', false, 'malformed'],
  ];

  let failed = 0;
  for (const [label, token, expectValid, expectReason] of cases) {
    const result = await verifyFirebaseIdToken(token, {
      projectId: PROJECT,
      jwksOverride: jwks,
    });
    const pass =
      result.valid === expectValid && (expectValid || result.reason === expectReason);
    if (!pass) failed += 1;
    console.log(
      `${pass ? 'PASS' : 'FAIL'} - ${label}` +
        (pass ? '' : ` (got valid=${result.valid} reason=${result.reason})`)
    );
  }

  console.log(failed ? `\n${failed} case(s) FAILED` : '\nALL CASES PASSED');
  process.exit(failed ? 1 : 0);
})();
