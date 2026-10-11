/**
 * phoneUtil.js
 * ============
 * Shared phone validation + normalization for SMS / WhatsApp.
 * India-first: accepts 10-digit mobiles, 91-prefixed, +91-prefixed,
 * and generic E.164 (+<country><number>).
 */

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

/**
 * Normalize to E.164 (+91XXXXXXXXXX for India).
 * Returns { e164, national, countryCode, valid, reason? }
 */
function normalizePhone(raw, defaultCountry = '91') {
  const original = String(raw || '').trim();
  if (!original) return { valid: false, reason: 'missing phone number' };
  const hasPlus = original.startsWith('+');
  const digits = digitsOnly(original);
  if (!digits) return { valid: false, reason: 'invalid phone number' };

  // 10-digit Indian mobile starting 6-9
  if (digits.length === 10 && /^[6-9]\d{9}$/.test(digits)) {
    return {
      valid: true,
      e164: `+${defaultCountry}${digits}`,
      national: digits,
      countryCode: defaultCountry,
    };
  }
  // 12-digit with 91 prefix
  if (digits.length === 12 && digits.startsWith('91') && /^[6-9]\d{9}$/.test(digits.slice(2))) {
    return {
      valid: true,
      e164: `+${digits}`,
      national: digits.slice(2),
      countryCode: '91',
    };
  }
  // Generic E.164: 11-15 digits with leading +
  if (hasPlus && digits.length >= 11 && digits.length <= 15) {
    return { valid: true, e164: `+${digits}`, national: digits, countryCode: '' };
  }
  // 11-15 digits without plus: accept as E.164 if plausible
  if (!hasPlus && digits.length >= 11 && digits.length <= 15) {
    return { valid: true, e164: `+${digits}`, national: digits, countryCode: '' };
  }
  return { valid: false, reason: 'invalid phone number — expected 10-digit Indian mobile' };
}

/** WhatsApp `to` must be digits without + (Meta requirement). */
function toWhatsAppRecipient(normalized) {
  return String(normalized.e164 || '').replace(/^\+/, '');
}

module.exports = { normalizePhone, toWhatsAppRecipient, digitsOnly };
