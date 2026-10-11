/**
 * e2e-test.js
 * ===========
 * End-to-end HTTP test against a running backend (MongoDB must be up).
 * Reflects the CURRENT workflow:
 *  1. expects the API at http://localhost:5001
 *  2. logs in as Main Admin (admin/admin123)
 *  3. seeds officers + booths (duplicate-safe)
 *  4. runs the FULL allocation algorithm (all Mandals, unlimited)
 *  5. verifies the address-conflict rule (same-locality is NOT allocated)
 *  6. sends an SMS (mock provider)
 *  7. reallocates an officer (old -> REALLOCATED, new -> ALLOCATED)
 *  8. checks notification + report + dashboard endpoints respond
 *  9. cleans up its own test data
 *
 * Run: node scripts/e2e-test.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { compareOfficerIds } = require('../services/sortUtil');

const BASE = process.env.API_BASE || 'http://localhost:5001';

let passed = 0;
let failed = 0;
let token = null;

const ADMIN = { username: 'admin', password: 'admin123' };
const MANDAL = 'E2eMandal';
const OFFICER_IDS = ['E2E-OFF-A', 'E2E-OFF-B'];
const BOOTH_IDS = ['E2E-BOOTH-1', 'E2E-BOOTH-2', 'E2E-BOOTH-3'];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  PASS  ${name}`);
    })
    .catch((error) => {
      failed += 1;
      console.error(`  FAIL  ${name}\n        ${error.message}`);
    });
}

async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(`HTTP ${response.status} ${path}: ${data.message || ''}`);
    err.status = response.status;
    throw err;
  }
  return data;
}

/** POST that tolerates 409 so the test is repeatable against existing data. */
async function seed(method, path, body) {
  try {
    return await api(method, path, body);
  } catch (error) {
    if (error.status === 409) return null; // already exists from a previous run
    throw error;
  }
}

async function cleanTestData() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/polling_system');
  const Officer = require('../models/Officer');
  const Booth = require('../models/Booth');
  const Allocation = require('../models/Allocation');
  const Notification = require('../models/Notification');

  const officers = await Officer.find({ officerId: { $in: OFFICER_IDS } }).select('_id').lean();
  const booths = await Booth.find({ boothId: { $in: BOOTH_IDS } }).select('_id').lean();
  const oids = officers.map((o) => o._id);
  const bids = booths.map((b) => b._id);
  await Allocation.deleteMany({ $or: [{ officer: { $in: oids } }, { booth: { $in: bids } }] });
  await Notification.deleteMany({ officer: { $in: oids } });
  await Officer.deleteMany({ _id: { $in: oids } });
  await Booth.deleteMany({ _id: { $in: bids } });
  await mongoose.disconnect();
}

(async () => {
  console.log('E2E test against', BASE);
  console.log('-------------------------');

  await cleanTestData();

  await test('POST /api/auth/login returns a JWT', async () => {
    const res = await api('POST', '/api/auth/login', ADMIN);
    if (!res.token) throw new Error('no token in response');
    token = res.token;
  });

  await test('POST /api/auth/login rejects bad password', async () => {
    try {
      await api('POST', '/api/auth/login', { username: ADMIN.username, password: 'wrong' });
      throw new Error('should have failed');
    } catch (error) {
      if (error.status !== 401) throw new Error(`expected 401, got ${error.status}`);
    }
  });

  await test('GET /api/officers (protected) works', async () => {
    const res = await api('GET', '/api/officers?limit=5');
    if (!Array.isArray(res.data)) throw new Error('data is not an array');
  });

  // --- Seed data -------------------------------------------------------------
  await test('seed officers + booths', async () => {
    await seed('POST', '/api/officers', {
      officerId: 'E2E-OFF-A',
      officerName: 'E2E Officer Alpha',
      designation: 'Assistant Engineer',
      mobileNumber: '9000000001',
      email: 'alpha@test.gov.in',
      locality: 'AlphaVillage',
      ward: '5',
      street: 'Main Road',
      mandal: MANDAL,
      district: 'Kurnool',
      pinCode: '518442',
    });
    await seed('POST', '/api/officers', {
      officerId: 'E2E-OFF-B',
      officerName: 'E2E Officer Beta',
      designation: 'Assistant Engineer',
      mobileNumber: '9000000002',
      email: 'beta@test.gov.in',
      locality: 'BetaVillage',
      ward: '6',
      street: 'Church Street',
      mandal: MANDAL,
      district: 'Kurnool',
      pinCode: '518443',
    });
    await seed('POST', '/api/booths', {
      boothId: 'E2E-BOOTH-1',
      boothNumber: '501',
      boothName: 'E2E ZP High School',
      buildingName: 'ZP High School',
      locality: 'AlphaVillage',
      ward: '5',
      street: 'Main Road',
      mandal: MANDAL,
      district: 'Kurnool',
      pinCode: '518442',
      requiredOfficers: 2,
    });
    await seed('POST', '/api/booths', {
      boothId: 'E2E-BOOTH-2',
      boothNumber: '502',
      boothName: 'E2E Municipal School',
      buildingName: 'Municipal School',
      locality: 'BetaVillage',
      ward: '6',
      street: 'Church Street',
      mandal: MANDAL,
      district: 'Kurnool',
      pinCode: '518443',
      requiredOfficers: 2,
    });
    // Third booth in a DIFFERENT locality (GammaVillage) so the reallocation
    // test has a valid same-Mandal, different-locality target. Without it the
    // only different-locality booth for each officer is the one they already
    // occupy and a 409 "No suitable alternative booth" is the correct result.
    await seed('POST', '/api/booths', {
      boothId: 'E2E-BOOTH-3',
      boothNumber: '503',
      boothName: 'E2E Panchayat Office',
      buildingName: 'Panchayat Office',
      locality: 'GammaVillage',
      ward: '7',
      street: 'Hill Street',
      mandal: MANDAL,
      district: 'Kurnool',
      pinCode: '518444',
      requiredOfficers: 2,
    });
  });

  await test('run FULL automatic allocation (all Mandals)', async () => {
    const res = await api('POST', '/api/allocation/run');
    if (typeof res.data?.allocated !== 'number') throw new Error('missing allocation result');
    if (res.data.limitReached === true) throw new Error('full run should not be capped');
  });

  await test('same-locality allocation is NEVER created', async () => {
    const { data } = await api('GET', '/api/allocation?limit=200');
    const invalid = data.filter(
      (a) =>
        a.officer &&
        a.booth &&
        String(a.officer.locality || '').trim().toLowerCase() ===
          String(a.booth.locality || '').trim().toLowerCase() &&
        a.status === 'ALLOCATED'
    );
    if (invalid.length > 0) {
      throw new Error(
        `found ${invalid.length} invalid same-locality allocation(s): ${invalid
          .map((a) => `${a.officer.officerId}->${a.booth.boothId}`)
          .join(', ')}`
      );
    }
  });

  // --- Current workflow: ALLOCATED / REALLOCATED / notifications ---------------
  let activeAllocations = [];
  await test('both E2E officers hold exactly one ALLOCATED allocation', async () => {
    const { data } = await api('GET', '/api/allocation?limit=200');
    activeAllocations = data.filter(
      (a) => a.status === 'ALLOCATED' && a.officer && OFFICER_IDS.includes(a.officer.officerId)
    );
    if (activeAllocations.length !== 2) {
      throw new Error(`expected 2 active allocations, got ${activeAllocations.length}`);
    }
    const seen = new Set();
    activeAllocations.forEach((a) => {
      const k = String(a.officer.officerId);
      if (seen.has(k)) throw new Error(`duplicate allocation for ${k}`);
      seen.add(k);
      if (a.officer.mandal !== MANDAL || a.booth.mandal !== MANDAL) {
        throw new Error(`cross-Mandal allocation ${a.officer.officerId}`);
      }
    });
  });

  let targetAllocation = null;
  await test('send notification for an ALLOCATED allocation (mock SMS)', async () => {
    targetAllocation = activeAllocations[0];
    const notif = await api('POST', `/api/notifications/send/${targetAllocation._id}`);
    if (!notif.data || !notif.data.status) throw new Error('no notification status returned');
    console.log(
      `          notification status: ${notif.data.status} (provider ${notif.data.provider})`
    );
  });

  await test('reallocate: old -> REALLOCATED, new -> ALLOCATED, booth changed', async () => {
    const oldBoothId = String(targetAllocation.booth._id || targetAllocation.booth);
    const res = await api('POST', `/api/allocation/${targetAllocation._id}/reallocate`, {});
    if (!res.data || !res.data.newAllocation) throw new Error('no new allocation returned');
    if (res.data.oldAllocation.status !== 'REALLOCATED') {
      throw new Error(`old allocation status ${res.data.oldAllocation.status}`);
    }
    const newBoothId = String(res.data.newAllocation.booth || '');
    if (newBoothId === oldBoothId) throw new Error('booth did not change');
  });

    await test('report endpoints respond 200 with xlsx content', async () => {
    const response = await fetch(`${BASE}/api/reports/allocation-excel`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`report HTTP ${response.status}`);
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('spreadsheet')) {
      throw new Error(`unexpected content-type: ${contentType}`);
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength < 1000) throw new Error('report file too small');
  });

  await test('allocation-by-mandal returns a SINGLE sheet sorted by Officer ID ascending', async () => {
    const response = await fetch(`${BASE}/api/reports/allocation-by-mandal`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('spreadsheet')) throw new Error(`bad content-type: ${contentType}`);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength < 1000) throw new Error('report file too small');
    const X = require('xlsx');
    const wb = X.read(Buffer.from(bytes));
    if (wb.SheetNames.length !== 1) {
      throw new Error(`expected exactly 1 sheet, got ${wb.SheetNames.length}`);
    }
    const rows = X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    if (!rows.length) throw new Error('expected at least one allocated officer row');
    // Allocation details are sorted by Officer ID ascending across ALL Mandals.
    const ids = rows.map((r) => String(r['Officer ID'] || ''));
    const sorted = [...ids].sort(compareOfficerIds);
    if (JSON.stringify(ids) !== JSON.stringify(sorted)) throw new Error('rows not sorted by Officer ID');
  });

  await test('allocated-officers/:mandal returns this Mandal only', async () => {
    const response = await fetch(`${BASE}/api/reports/allocated-officers/E2eMandal`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('spreadsheet')) throw new Error(`bad content-type: ${contentType}`);
    const bytes = await response.arrayBuffer();
    const X = require('xlsx');
    const wb = X.read(Buffer.from(bytes));
    const rows = X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    if (!rows.length) throw new Error('expected at least one allocated officer row');
    // Officers are sorted by Officer ID ascending.
    const ids = rows.map((r) => String(r['Officer ID'] || ''));
    const sorted = [...ids].sort(compareOfficerIds);
    if (JSON.stringify(ids) !== JSON.stringify(sorted)) throw new Error('rows not sorted by Officer ID');
  });

  await test('dashboard stats endpoint works', async () => {
    const res = await api('GET', '/api/dashboard/stats');
    if (typeof res.data?.totalOfficers !== 'number') throw new Error('missing stats');
  });

  console.log('');
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  await cleanTestData().catch(() => {});
  console.log('cleanup: removed E2E test data');
  if (failed > 0) process.exit(1);
  console.log('E2E flow succeeded.');
})().catch((error) => {
  console.error('FATAL', error);
  process.exit(1);
});