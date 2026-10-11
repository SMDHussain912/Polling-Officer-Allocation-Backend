/**
 * sortUtil.js
 * ===========
 * Natural/numeric sorting helpers for Officer IDs.
 *
 * Officer IDs look like "OFF1", "OFF2", "OFF10", "OFF100", "OFF001", "PED-7",
 * "TS-05", etc. A plain alphabetic sort puts OFF10 before OFF2, which is wrong.
 * The correct display order is by the NUMERIC part of the ID:
 *
 *   OFF1, OFF2, OFF3, OFF9, OFF10, OFF11, OFF20, OFF100
 *
 * We extract the LAST numeric run in the ID (`OFF10` -> 10, `OFF001` -> 1,
 * `PED-7` -> 7) and compare numbers first. IDs that produce the same number
 * (e.g. "OFF1" vs "OFF1A") fall back to a plain string comparison.
 */

/** Returns the numeric part of an officer ID, or Number.MAX_SAFE_INTEGER when there is none. */
function officerIdNumber(id) {
  const runs = String(id || '').match(/\d+/g);
  if (!runs || runs.length === 0) return Number.MAX_SAFE_INTEGER;
  return Number(runs[runs.length - 1]);
}

/** Comparator for two Officer ID strings: numeric part first, plain text after. */
function compareOfficerIds(a, b) {
  const na = officerIdNumber(a);
  const nb = officerIdNumber(b);
  if (na !== nb) return na - nb;
  return String(a).localeCompare(String(b));
}

module.exports = { officerIdNumber, compareOfficerIds };