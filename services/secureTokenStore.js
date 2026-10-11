/**
 * secureTokenStore.js
 * ===================
 * Encrypted at-rest storage for the Google OAuth tokens. The refresh token
 * allows sending mail as the connected account, so it must never sit on disk
 * in plaintext (the old tokens.json did exactly that).
 *
 * Format: tokens.enc = base64(iv).base64(authTag).base64(ciphertext)
 * Cipher : AES-256-GCM
 * Key    : scrypt(TOKEN_ENCRYPTION_KEY, 'polling-officer.token.store.v1', 32)
 * File   : mode 0600 (owner read/write only)
 *
 * Migration: if the legacy plaintext tokens.json is found, its contents are
 * encrypted into tokens.enc, the plaintext file is DELETED, and the same
 * credentials object is returned to the caller.
 */
const fs = require('fs');
const crypto = require('crypto');

const ENC_FILE = 'tokens.enc';
const LEGACY_FILE = 'tokens.json';

function encryptionKey() {
  if (!process.env.TOKEN_ENCRYPTION_KEY) {
    console.warn(
      '[SECURITY] TOKEN_ENCRYPTION_KEY not set - deriving the token-encryption key from SESSION_SECRET. Set a dedicated TOKEN_ENCRYPTION_KEY in backend/.env.'
    );
  }
  const secret = process.env.TOKEN_ENCRYPTION_KEY || process.env.SESSION_SECRET || '';
  return crypto.scryptSync(secret, 'polling-officer.token.store.v1', 32);
}

function encryptJSON(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return [
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    data.toString('base64'),
  ].join('.');
}

function decryptJSON(payload) {
  const [ivB64, tagB64, dataB64] = String(payload).split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('malformed token store');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(ivB64, 'base64')
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(plain.toString('utf8'));
}

/**
 * Loads the stored Google credentials (or null when none exist).
 * Transparently migrates the legacy plaintext tokens.json.
 */
function loadTokens() {
  try {
    if (fs.existsSync(ENC_FILE)) {
      return decryptJSON(fs.readFileSync(ENC_FILE, 'utf8'));
    }
    if (fs.existsSync(LEGACY_FILE)) {
      const tokens = JSON.parse(fs.readFileSync(LEGACY_FILE, 'utf8'));
      saveTokens(tokens);
      fs.rmSync(LEGACY_FILE, { force: true });
      console.log(
        '[SECURITY] Migrated plaintext tokens.json -> encrypted tokens.enc (plaintext file removed)'
      );
      return tokens;
    }
  } catch (error) {
    console.error('[SECURITY] Failed to load stored Google tokens:', error.message);
  }
  return null;
}

/** Persists credentials encrypted, with file mode 0600. */
function saveTokens(tokens) {
  fs.writeFileSync(ENC_FILE, encryptJSON(tokens), { mode: 0o600 });
  try {
    fs.chmodSync(ENC_FILE, 0o600);
  } catch {
    /* filesystem without POSIX permissions - write mode already applied */
  }
}

/** Removes the stored credentials (used by POST /api/mail/disconnect). */
function clearTokens() {
  for (const file of [ENC_FILE, LEGACY_FILE]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* ignore */
    }
  }
}

module.exports = { loadTokens, saveTokens, clearTokens };