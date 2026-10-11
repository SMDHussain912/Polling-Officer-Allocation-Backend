/**
 * verify-mandal-balance.js
 * =========================
 * End-to-end verification of the MANDAL-WISE balanced allocation engine.
 *
 * Covers the required test cases from the allocation spec:
 *   TEST 1 - 10 officers + 2 booths (same Mandal)  -> balanced 5 + 5
 *   TEST 2 - 10 officers + 3 booths (same Mandal)  -> balanced 4 + 3 + 3
 *   TEST 3 - Multiple Mandals never mix officers/booths across Mandals
 *   TEST 4 - Officer + Booth in the same locality  -> allocation rejected
 *   TEST 5 - Full booth capacity  -> no additional officer allocated
 *   TEST 6 - Running allocation twice creates NO duplicates
 *   TEST 7 - Booth counters match the real ALLOCATED records
 *   TEST 8 - Mandal-wise and booth-wise result data is returned by the API
 *   EXTRA  - Mandal with officers but no booths / booths but no officers
 *
 * Run while the backend is listening:  node scripts/verify-mandal-balance.js
 */
require('dotenv').config();
const XLSX = require('xlsx');
const mongoose = require('mongoose');

const BASE = (process.env.API_BASE || 'http://127.0.0.1:5001').replace(/\/$/, '');
let failures = 0;
function check(name, ok, detail = '') {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures += 1;
}
function buildWorkbook(rows) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
async function uploadExcel(path, buffer, token) {
  const form = new FormData();
  form.append('file', new Blob([buffer]), 't.xlsx');
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  return { status: res.status, data: await res.json() };
}
async function api(method, path, token, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const MA = 'BalanceA'; // TEST 1: 10 officers / 2 booths (cap 5 each)
const MB = 'BalanceB'; // TEST 2: 10 officers / 3 booths (cap 4 each)
const MC = 'OnlyOfficersMandal'; // STEP 10: officers but zero booths
const MD = 'OnlyBoothsMandal'; // STEP 11: booths but zero officers
const ME = 'CapacityMandal'; // TEST 5: more officers than booth capacity

const officerRows = [];
const boothRows = [];

// Mandal A: 10 officers. Officer A10 shares the locality of booth MB-AB1.
for (let i = 1; i <= 10; i += 1) {
  officerRows.push({
    'Officer ID': `MB-A${String(i).padStart(2, '0')}`,
    'Officer Name': `Balance A Officer ${i}`,
    Designation: 'TA',
    'Mobile Number': `93000000${String(i).padStart(3, '0')}`,
    Email: `mba${i}@t.gov`,
    'House Number': String(i),
    Street: `Street A ${i}`,
    'Village/Locality': i === 10 ? 'SharedLocA' : `ALoc${i}`,
    Ward: `A${i}`,
    Mandal: MA,
    District: 'D',
    'PIN Code': '500001',
  });
}
boothRows.push(
  {
    'Booth ID': 'MB-AB1', 'Booth Number': '101', 'Booth Name': 'A School One',
    'Building Name': 'A1', Street: 'BSt 1', 'Village/Locality': 'SharedLocA', Ward: 'W1',
    Mandal: MA, District: 'D', 'PIN Code': '500011', 'Required Officers': 5, 'Minimum Officers': 1,
  },
  {
    'Booth ID': 'MB-AB2', 'Booth Number': '102', 'Booth Name': 'A School Two',
    'Building Name': 'A2', Street: 'BSt 2', 'Village/Locality': 'ALocBooth2', Ward: 'W2',
    Mandal: MA, District: 'D', 'PIN Code': '500012', 'Required Officers': 5, 'Minimum Officers': 1,
  }
);

// Mandal B: 10 officers / 3 booths (cap 4 each), all localities distinct.
for (let i = 1; i <= 10; i += 1) {
  officerRows.push({
    'Officer ID': `MB-B${String(i).padStart(2, '0')}`,
    'Officer Name': `Balance B Officer ${i}`,
    Designation: 'TA',
    'Mobile Number': `93010000${String(i).padStart(3, '0')}`,
    Email: `mbb${i}@t.gov`,
    'House Number': String(i),
    Street: `Street B ${i}`,
    'Village/Locality': `BLoc${i}`,
    Ward: `B${i}`,
    Mandal: MB,
    District: 'D',
    'PIN Code': '500002',
  });
}
for (let i = 1; i <= 3; i += 1) {
  boothRows.push({
    'Booth ID': `MB-BB${i}`, 'Booth Number': `20${i}`, 'Booth Name': `B School ${i}`,
    'Building Name': `B${i}`, Street: `BSt ${i}`, 'Village/Locality': `BBoothLoc${i}`, Ward: `BW${i}`,
    Mandal: MB, District: 'D', 'PIN Code': '500021', 'Required Officers': 4, 'Minimum Officers': 1,
  });
}

// Mandal C: 5 officers, NO booths.
for (let i = 1; i <= 5; i += 1) {
  officerRows.push({
    'Officer ID': `MB-C${String(i).padStart(2, '0')}`,
    'Officer Name': `No Booth Officer ${i}`,
    Designation: 'TA',
    'Mobile Number': `93020000${String(i).padStart(3, '0')}`,
    Email: `mbc${i}@t.gov`,
    'House Number': String(i),
    Street: `Street C ${i}`,
    'Village/Locality': `CLoc${i}`,
    Ward: `C${i}`,
    Mandal: MC,
    District: 'D',
    'PIN Code': '500003',
  });
}

// Mandal D: 0 officers, 2 booths.
boothRows.push(
  {
    'Booth ID': 'MB-DB1', 'Booth Number': '401', 'Booth Name': 'D School One',
    'Building Name': 'D1', Street: 'DSt 1', 'Village/Locality': 'DLocBooth1', Ward: 'D1',
    Mandal: MD, District: 'D', 'PIN Code': '500031', 'Required Officers': 3, 'Minimum Officers': 1,
  },
  {
    'Booth ID': 'MB-DB2', 'Booth Number': '402', 'Booth Name': 'D School Two',
    'Building Name': 'D2', Street: 'DSt 2', 'Village/Locality': 'DLocBooth2', Ward: 'D2',
    Mandal: MD, District: 'D', 'PIN Code': '500032', 'Required Officers': 3, 'Minimum Officers': 1,
  }
);

// Mandal E: 6 officers / 1 booth (cap 3) -> only 3 can be allocated.
for (let i = 1; i <= 6; i += 1) {
  officerRows.push({
    'Officer ID': `MB-E${String(i).padStart(2, '0')}`,
    'Officer Name': `Capacity Officer ${i}`,
    Designation: 'TA',
    'Mobile Number': `93030000${String(i).padStart(3, '0')}`,
    Email: `mbe${i}@t.gov`,
    'House Number': String(i),
    Street: `Street E ${i}`,
    'Village/Locality': `ELoc${i}`,
    Ward: `E${i}`,
    Mandal: ME,
    District: 'D',
    'PIN Code': '500004',
  });
}
boothRows.push({
  'Booth ID': 'MB-EB1', 'Booth Number': '301', 'Booth Name': 'E School One',
  'Building Name': 'E1', Street: 'ESt 1', 'Village/Locality': 'ELocBooth', Ward: 'E1',
  Mandal: ME, District: 'D', 'PIN Code': '500041', 'Required Officers': 3, 'Minimum Officers': 1,
});

const ALL_MANDALS = [MA, MB, MC, MD, ME];
const ALL_OFFICER_IDS = officerRows.map((o) => o['Officer ID']);
const ALL_BOOTH_IDS = boothRows.map((b) => b['Booth ID']);

async function cleanTestData() {
  const Officer = require('../models/Officer');
  const Booth = require('../models/Booth');
  const Allocation = require('../models/Allocation');
  const officers = await Officer.find({ officerId: { $in: ALL_OFFICER_IDS } }).select('_id').lean();
  const booths = await Booth.find({ boothId: { $in: ALL_BOOTH_IDS } }).select('_id').lean();
  const oids = officers.map((o) => o._id);
  const bids = booths.map((b) => b._id);
  await Allocation.deleteMany({
    $or: [{ officer: { $in: oids } }, { booth: { $in: bids } }],
  });
  await Officer.deleteMany({ _id: { $in: oids } });
  await Booth.deleteMany({ _id: { $in: bids } });
}

async function main() {
  const login = await api('POST', '/api/auth/login', null, { username: 'admin', password: 'admin123' });
  check('M1 Admin login', login.status === 200 && login.data.success, login.data.message || '');
  const token = login.data.token;

  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/polling_system');
  const Officer = require('../models/Officer');
  const Booth = require('../models/Booth');
  const Allocation = require('../models/Allocation');

  // Clean any leftover test data from an interrupted previous run.
  await cleanTestData();

  // Upload officers + booths through the REAL Excel pipeline.
  const up1 = await uploadExcel('/api/upload/officers', buildWorkbook(officerRows), token);
  check('M2 uploaded officers from Excel', up1.status === 201 && up1.data.inserted === 31,
    `inserted=${up1.data.inserted}`);
  const up2 = await uploadExcel('/api/upload/booths', buildWorkbook(boothRows), token);
  check('M3 uploaded booths from Excel', up2.status === 201 && up2.data.inserted === 8,
    `inserted=${up2.data.inserted}`);

  const dbOfficers = await Officer.find({ officerId: { $in: ALL_OFFICER_IDS } }).lean();
  const dbBooths = await Booth.find({ boothId: { $in: ALL_BOOTH_IDS } }).lean();
  check('M3b persisted from MongoDB', dbOfficers.length === 31 && dbBooths.length === 8,
    `officers=${dbOfficers.length} booths=${dbBooths.length}`);

  // TEST 8: suitable-booths endpoint returns only same-Mandal, different-locality options.
  const a10 = dbOfficers.find((o) => o.officerId === 'MB-A10');
  const suit = await api('GET', `/api/allocation/suitable-booths/${a10.officerId}`, token);
  const suitBooths = suit.data.data?.booths || [];
  const suitMandalOk = suitBooths.every(
    (b) => String(b.mandal || '').trim().toLowerCase() === MA.toLowerCase()
  );
  const suitLocalityOk = suitBooths.every(
    (b) => !String(b.locality || '').trim().toLowerCase().includes('sharedloca')
  );
  check('M16 TEST 8 - suitable-booths API returns only same-Mandal, different-locality booths',
    suit.status === 200 && suitMandalOk && suitLocalityOk && suitBooths.length >= 1,
    `booths=${suitBooths.length}`);

  // Full unlimited run (no maxAllocations body).
  const r1 = await api('POST', '/api/allocation/run', token);
  const d1 = r1.data.data || {};
  check('M4 full run succeeds', r1.status === 200 && r1.data.success, r1.data.message || '');
  check('M4b all Mandals processed separately', d1.totalMandals >= 5,
    `totalMandals=${d1.totalMandals}`);
  check('M4c run is unlimited (no limitReached)', d1.limitReached === false && d1.runLimit === null,
    `limitReached=${d1.limitReached}`);

  const allocs = await Allocation.find({ status: 'ALLOCATED' })
    .populate('officer')
    .populate('booth')
    .lean();

  // TEST 3: never mix Mandals.
  const crossMandal = allocs.filter(
    (a) =>
      a.officer &&
      a.booth &&
      String(a.officer.mandal || '').trim().toLowerCase() !==
        String(a.booth.mandal || '').trim().toLowerCase()
  );
  check('M5 TEST 3 - no allocation mixes officers with another Mandal', crossMandal.length === 0,
    crossMandal.length ? crossMandal.map((a) => `${a.officer.mandal}->${a.booth.mandal}`).join(',') : 'all matched');

  const byBoothCount = {};
  allocs.forEach((a) => {
    if (a.booth) byBoothCount[String(a.booth.boothId)] = (byBoothCount[String(a.booth.boothId)] || 0) + 1;
  });

  // TEST 1: Mandal A balanced 5 + 5.
  const aB1 = byBoothCount['MB-AB1'] || 0;
  const aB2 = byBoothCount['MB-AB2'] || 0;
  check('M6 TEST 1 - 10 officers / 2 booths -> 5 + 5', aB1 === 5 && aB2 === 5,
    `Booth101=${aB1} Booth102=${aB2}`);

  // TEST 4: officer with same locality as Booth101 (SharedLocA) must NOT be there.
  const a10Alloc = allocs.find((a) => a.officer && a.officer.officerId === 'MB-A10');
  check('M7 TEST 4 - same-locality booth rejected',
    Boolean(a10Alloc) && String(a10Alloc.booth.boothId) === 'MB-AB2',
    a10Alloc ? `${a10Alloc.officer.officerId} -> ${a10Alloc.booth.boothId}` : 'MB-A10 not allocated');

  // TEST 2: Mandal B balanced 4 + 3 + 3 (difference between booths <= 1).
  const bCounts = ['MB-BB1', 'MB-BB2', 'MB-BB3'].map((id) => byBoothCount[id] || 0).sort((x, y) => x - y);
  const bSum = bCounts.reduce((s, n) => s + n, 0);
  const bBalanced = bSum === 10 && bCounts[bCounts.length - 1] - bCounts[0] <= 1;
  check('M8 TEST 2 - 10 officers / 3 booths -> 4 + 3 + 3',
    bBalanced && bCounts.every((c) => c >= 0 && c <= 4),
    `counts=${bCounts.join('+')}`);

  // TEST 5: Mandal E booth has capacity 3 -> exactly 3 allocated.
  const eCount = byBoothCount['MB-EB1'] || 0;
  check('M9 TEST 5 - full booth gets no additional officer', eCount === 3, `Booth301=${eCount}`);

  const eUnallocated = d1.unallocatedOfficers.filter((u) => String(u.officerId || '').startsWith('MB-E'));
  check('M9b capacity reason is clear',
    eUnallocated.length === 3 &&
      eUnallocated.every((u) => /reached their required officer capacity/i.test(u.reason || '')),
    eUnallocated[0]?.reason || 'no reason');

  // STEP 10 - Mandal with officers but no booths.
  const cUnallocated = d1.unallocatedOfficers.filter((u) => String(u.officerId || '').startsWith('MB-C'));
  check('M10 STEP 10 - officers-only Mandal stays unallocated with reason',
    cUnallocated.length === 5 &&
      cUnallocated.every((u) => /No booths available in OnlyOfficersMandal/i.test(u.reason || '')),
    cUnallocated[0]?.reason || 'no reason');
  const cAllocs = allocs.filter((a) => a.officer && String(a.officer.officerId).startsWith('MB-C'));
  check('M10b no allocation for officers-only Mandal', cAllocs.length === 0);

  // STEP 11 - Mandal with booths but no officers: available slots = capacity.
  const mdEntry = d1.byMandal.find((m) => /onlybooths/i.test(String(m.mandal)));
  check('M11 STEP 11 - booths-only Mandal shows 0 allocated and capacity slots',
    Boolean(mdEntry) && mdEntry.totalOfficers === 0 && mdEntry.availableSlots === 6,
    mdEntry ? `allocated=${mdEntry.allocatedOfficers} slots=${mdEntry.availableSlots}` : 'no entry');

  // Per-mandal summary from the API (STEP 6 / TEST 8).
  const maEntry = d1.byMandal.find((m) => /balancea/i.test(String(m.mandal)));
  const mbEntry = d1.byMandal.find((m) => /balanceb/i.test(String(m.mandal)));
  check('M12 TEST 8 - Mandal-wise results returned per Mandal',
    maEntry && maEntry.allocatedOfficers === 10 && maEntry.unallocatedOfficers === 0 &&
      mbEntry && mbEntry.allocatedOfficers === 10 && mbEntry.unallocatedOfficers === 0,
    `A(${maEntry?.allocatedOfficers}/${maEntry?.unallocatedOfficers}) B(${mbEntry?.allocatedOfficers}/${mbEntry?.unallocatedOfficers})`);

  // TEST 6: run twice -> no NEW allocations for already-allocated test officers.
  // Count ONLY this fixture's officers (the shared dev DB may hold other data).
  const testOfficerIds = dbOfficers.map((o) => o._id);
  const countForTestOfficers = () =>
    Allocation.countDocuments({ status: 'ALLOCATED', officer: { $in: testOfficerIds } });

  const testAllocsBefore = await countForTestOfficers();
  await api('POST', '/api/allocation/run', token); // 1st repeat
  await api('POST', '/api/allocation/run', token); // 2nd repeat
  const testAllocsAfter = await countForTestOfficers();
  check('M13 TEST 6 - repeated runs create no duplicate allocations for the same officers',
    testAllocsAfter === testAllocsBefore,
    `${testAllocsBefore} active before -> ${testAllocsAfter} after two more runs`);

  const perOfficer = {};
  const current = await Allocation.find({ status: 'ALLOCATED', officer: { $in: dbOfficers.map((o) => o._id) } })
    .select('officer')
    .lean();
  current.forEach((a) => {
    perOfficer[String(a.officer)] = (perOfficer[String(a.officer)] || 0) + 1;
  });
  const dupes = Object.entries(perOfficer).filter(([, n]) => n > 1);
  check('M14 TEST 6b - one active allocation per officer across both runs', dupes.length === 0,
    dupes.length ? `dupes=${dupes.length}` : 'ok');

  // TEST 7: booth counters match the real ALLOCATED records.
  const refresh = await Promise.all(
    dbBooths.map(async (b) => {
      const live = await Allocation.countDocuments({ booth: b._id, status: 'ALLOCATED' });
      const stored = await Booth.findById(b._id).lean();
      return { id: b.boothId, stored: stored.allocatedOfficerCount, live, avail: stored.availableSlots, required: stored.requiredOfficers };
    })
  );
  const mismatches = refresh.filter((c) => c.stored !== c.live || c.avail !== c.required - c.live);
  check('M15 TEST 7 - booth counts match ALLOCATED records', mismatches.length === 0,
    mismatches.length
      ? mismatches.map((m) => `${m.id}(stored=${m.stored} live=${m.live} avail=${m.avail})`).join(', ')
      : 'all 8 booths consistent');

  // Cleanup.
  await cleanTestData();
  await mongoose.disconnect();
  console.log('cleanup: removed mandal-balance test data');

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nAll mandal-balance checks passed.');
}

main().catch((e) => {
  console.error('verify-mandal-balance crashed:', e.message);
  process.exit(1);
});
