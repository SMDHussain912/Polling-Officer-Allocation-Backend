/**
 * smoke-test.js
 * =============
 * Standalone verification of the two most important services:
 *   1. addressMatchingService - the address comparison / conflict rules
 *   2. allocationService.scoreSuitability - the booth suitability scoring
 *
 * These services are pure (no DB access needed), so the whole test runs
 * without MongoDB. Run with:
 *    npm run smoke-test
 */

const assert = require('assert');
const ams = require('../services/addressMatchingService');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL  ${name}\n        ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const officerA = {
  // lives IN Kothapeta locality, ward 5, Mandal Alpha
  locality: 'Kothapeta',
  ward: '5',
  street: 'Main Road',
  mandal: 'Pedarami Reddy Palli',
  district: 'Kurnool',
  pinCode: '518442',
};

const officerB = {
  // lives in Gandhinagar, ward 8, Mandal Alpha
  locality: 'Gandhinagar',
  ward: '8',
  street: 'Church Street',
  mandal: 'Pedarami Reddy Palli',
  district: 'Kurnool',
  pinCode: '518443',
};

const boothKothapeta = {
  locality: 'Kothapeta',
  ward: '5',
  street: 'Main Road',
  mandal: 'Pedarami Reddy Palli',
  district: 'Kurnool',
  pinCode: '518442',
};

const boothGandhinagar = {
  locality: 'Gandhinagar',
  ward: '8',
  street: 'Church Street',
  mandal: 'Pedarami Reddy Palli',
  district: 'Kurnool',
  pinCode: '518443',
};

const boothOtherLocality = {
  locality: 'Rayadurgam',
  ward: '8',
  street: 'Temple Street',
  mandal: 'Pedarami Reddy Palli',
  district: 'Kurnool',
  pinCode: '518442', // same PIN as officerA on purpose (rule 7)
};

const boothWrongMandal = {
  locality: 'Kothapeta',
  ward: '5',
  street: 'Main Road',
  mandal: 'Nandyal',
  district: 'Kurnool',
  pinCode: '518502',
};

console.log('addressMatchingService tests');
console.log('-----------------------------');

test('normalizeAddress: lowercases, trims and strips punctuation', () => {
  assert.strictEqual(ams.normalizeAddress('  Kothapeta, Main Rd.  '), 'kothapeta main rd');
});

test('tokenizeAddress drops stopwords and short tokens', () => {
  const tokens = ams.tokenizeAddress('near main road, kothapeta');
  // 'near' and 'road' are stopwords; 'main' and 'kothapeta' are meaningful
  assert.deepStrictEqual(tokens, ['main', 'kothapeta']);
});

test('levenshtein basic distance', () => {
  assert.strictEqual(ams.levenshtein('kothapeta', 'kothapeta'), 0);
  assert.strictEqual(ams.levenshtein('kitten', 'sitting'), 3);
});

test('similarityRatio identical strings = 1', () => {
  assert.strictEqual(ams.similarityRatio('Kothapeta', ' KOTHAPETA,'), 1);
});

test('RULE 2: exact locality match rejects', () => {
  const r = ams.isRelated(officerA, boothKothapeta);
  assert.strictEqual(r.related, true);
  assert.ok(r.reasons.some((x) => x.toLowerCase().includes('locality')));
});

test('RULE 7: PIN code alone never rejects', () => {
  const r = ams.isRelated(officerA, boothOtherLocality);
  assert.strictEqual(r.related, false);
});

test('RULE 1: different Mandal rejects', () => {
  const r = ams.isRelated(officerA, boothWrongMandal);
  assert.strictEqual(r.related, true);
  assert.strictEqual(r.mandalMatched, false);
  assert.ok(r.score >= 100);
});

test('different locality + different street + different ward = safe', () => {
  const r = ams.isRelated(officerA, boothGandhinagar);
  assert.strictEqual(r.related, false);
  assert.ok(r.score < 50);
});

test('RULE 6 (fallback): ward+street exact match without locality rejects', () => {
  const officerC = {
    locality: '',
    ward: '5',
    street: 'Main Bazaar Road',
    mandal: 'Pedarami Reddy Palli',
    district: 'Kurnool',
    pinCode: '518450',
  };
  const crafted = {
    locality: '',
    ward: '5',
    street: 'Main Bazaar Road',
    mandal: 'Pedarami Reddy Palli',
    district: 'Kurnool',
    pinCode: '518451',
  };
  const r = ams.isRelated(officerC, crafted);
  assert.strictEqual(r.related, true);
});

console.log('');
console.log('allocationService scoring tests');
console.log('-------------------------------');

const { scoreSuitability } = require('../services/allocationService');

test('suitable booth receives a finite positive score', () => {
  const r = scoreSuitability(officerA, boothGandhinagar, 2);
  assert.strictEqual(r.suitable, true);
  assert.ok(r.score >= 0);
  assert.ok(Number.isFinite(r.score));
});

test('conflicted (related) booth is rejected with -Infinity score', () => {
  const r = scoreSuitability(officerA, boothKothapeta, 2);
  assert.strictEqual(r.suitable, false);
  assert.strictEqual(r.score, -Infinity);
});

test('booth with fewer allocated officers scores higher (balance rule)', () => {
  const light = { ...boothOtherLocality, allocatedOfficerCount: 0 };
  const heavy = { ...boothOtherLocality, allocatedOfficerCount: 4 };
  const r1 = scoreSuitability(officerA, light, 2);
  const r2 = scoreSuitability(officerA, heavy, 2);
  assert.ok(r1.score > r2.score, 'lower occupancy should score better');
});

console.log('');
console.log(`RESULT: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('All allocation core-logic tests passed.');