/**
 * addressMatchingService.js
 * ==========================
 * Reusable, pure address comparison engine used by the allocation
 * algorithm to decide whether an officer's residential address is
 * related to a polling booth's address.
 *
 * Rules (from the project specification - simple and clear):
 *   PRIMARY  : officer and booth MUST belong to the same Mandal.
 *              When both localities are known:
 *                - different locality = SUITABLE
 *                - same locality      = REJECT
 *   SECONDARY: only when locality info is missing, compare Ward and
 *              Street (reject on exact ward+street match or 2+ shared
 *              address tokens). Street similarity NEVER overrides a
 *              clearly different locality.
 *
 * The module is intentionally dependency-free so it can be unit tested
 * and reused by any other part of the system.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'near', 'opp', 'opposite', 'beside', 'behind', 'in', 'at', 'the', 'and', 'or',
  'road', 'rd', 'colony', 'village', 'grama', 'street', 'st', 'nagar', 'gnr',
  'hno', 'hno.', 'no', 'district', 'dist', 'mandal', 'mdt', 'pincode', 'pin',
  'post', 'po', 'via', 'c/o', 'careof', 'nearby', 'besides', 'next', 'of',
]);

const STRONG_SIMILARITY = 0.75;

const IMPORTANT_FIELDS = ['locality', 'street', 'ward'];

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

function normalizeAddress(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[.,#/&()'"\-–—|\\;:_*^%$@!?+=<>[\]{}~`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeAddress(text) {
  const normalized = normalizeAddress(text);
  if (!normalized) return [];
  return normalized
    .split(' ')
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[n];
}

function similarityRatio(a, b) {
  const na = normalizeAddress(a);
  const nb = normalizeAddress(b);
  if (!na && !nb) return 1;
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const distance = levenshtein(na, nb);
  return 1 - distance / Math.max(na.length, nb.length);
}

function compareFields(a, b) {
  const na = normalizeAddress(a);
  const nb = normalizeAddress(b);
  const exact = Boolean(na && nb && na === nb);
  const strong = Boolean(na && nb && !exact && similarityRatio(na, nb) >= STRONG_SIMILARITY);
  const tokensA = tokenizeAddress(a);
  const tokensB = tokenizeAddress(b);
  const set = new Set(tokensA);
  const sharedTokens = tokensB.filter((t) => set.has(t));
  return { exact, strong, sharedTokens };
}

function compareMandal(officerMandal, boothMandal) {
  const a = normalizeAddress(officerMandal);
  const b = normalizeAddress(boothMandal);
  const matched = Boolean(a && b && a === b);
  return {
    matched,
    officerMandal: officerMandal || '',
    boothMandal: boothMandal || '',
  };
}

/** Canonical key used to group officers/booths by Mandal name. */
function mandalKey(mandal) {
  return normalizeAddress(mandal);
}

// ---------------------------------------------------------------------------
// Core decision
// ---------------------------------------------------------------------------

/**
 * PRIMARY + SECONDARY address rule (requirement E).
 * @returns {{
 *   related: boolean,
 *   score: number,
 *   mandalMatched: boolean,
 *   localityMatched: boolean,
 *   matchedTokens: string[],
 *   reasons: string[],
 * }}
 */
function isRelated(officer, booth) {
  const officerData = officer || {};
  const boothData = booth || {};

  // PRIMARY GATE: same Mandal required.
  const mandalCheck = compareMandal(officerData.mandal, boothData.mandal);
  if (!mandalCheck.matched) {
    return {
      related: true,
      score: 100,
      mandalMatched: false,
      localityMatched: false,
      matchedTokens: [],
      reasons: ['Officer and booth belong to different Mandals - not eligible.'],
    };
  }

  const officerLocality = normalizeAddress(officerData.locality);
  const boothLocality = normalizeAddress(boothData.locality);

  if (officerLocality && boothLocality) {
    if (officerLocality === boothLocality) {
      return {
        related: true,
        score: 60,
        mandalMatched: true,
        localityMatched: true,
        matchedTokens: [],
        reasons: ['Officer residential locality matches booth locality.'],
      };
    }
    // Different locality within the same Mandal -> SUITABLE.
    return {
      related: false,
      score: 0,
      mandalMatched: true,
      localityMatched: false,
      matchedTokens: [],
      reasons: ['Different locality within the same Mandal.'],
    };
  }

  // SECONDARY RULE: locality missing on either side -> ward + street comparison.
  const wardRes = compareFields(officerData.ward, boothData.ward);
  const streetRes = compareFields(officerData.street, boothData.street);
  const matchedTokens = [...new Set([...wardRes.sharedTokens, ...streetRes.sharedTokens])];

  if (wardRes.exact && streetRes.exact) {
    return {
      related: true,
      score: 24,
      mandalMatched: true,
      localityMatched: false,
      matchedTokens,
      reasons: ['Locality is not specified and ward + street both match exactly.'],
    };
  }
  if (matchedTokens.length >= 2) {
    return {
      related: true,
      score: 24,
      mandalMatched: true,
      localityMatched: false,
      matchedTokens,
      reasons: [`Locality is not specified and multiple address tokens match (${matchedTokens.join(', ')}).`],
    };
  }
  return {
    related: false,
    score: 0,
    mandalMatched: true,
    localityMatched: false,
    matchedTokens: [],
    reasons: ['No significant address conflict detected.'],
  };
}

/**
 * Human readable outcome used by the UI / modal:
 * NOT SUITABLE -> a clear rejection reason.
 * SUITABLE     -> "Different locality within the same Mandal."
 */
function compatibilityReason(officer, booth) {
  const check = isRelated(officer, booth);
  if (!check.related) return 'Different locality within the same Mandal.';
  if (check.reasons && check.reasons.length > 0) return check.reasons[0];
  return 'Address conflict detected between officer residence and booth location.';
}

/** Convenience wrapper used by the allocation service. */
function isAllocationBlocked(officer, booth) {
  return isRelated(officer, booth).related;
}

function boothAddressLine(booth) {
  const b = booth || {};
  return [
    b.buildingName,
    b.street,
    b.locality,
    b.ward ? `Ward ${b.ward}` : '',
    b.mandal,
    b.district,
    b.pinCode ? `PIN ${b.pinCode}` : '',
  ]
    .filter((part) => part && String(part).trim())
    .join(', ');
}

function addressSimilarityScore(officer, booth) {
  const parts = (o) => [o && o.locality, o && o.street, o && o.ward].filter(Boolean).join(' ');
  const a = normalizeAddress(parts(officer));
  const b = normalizeAddress(parts(booth));
  if (!a || !b) return 0;
  if (a === b) return 100;
  const d = levenshtein(a, b);
  return Math.max(0, Math.round((1 - d / Math.max(a.length, b.length)) * 100));
}

module.exports = {
  STOPWORDS,
  STRONG_SIMILARITY,
  IMPORTANT_FIELDS,
  normalizeAddress,
  tokenizeAddress,
  levenshtein,
  similarityRatio,
  compareFields,
  compareMandal,
  mandalKey,
  isRelated,
  compatibilityReason,
  isAllocationBlocked,
  boothAddressLine,
  addressSimilarityScore,
};
