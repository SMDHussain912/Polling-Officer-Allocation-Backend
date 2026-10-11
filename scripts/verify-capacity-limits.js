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

const M = 'CapacityMandal';
const officerRows = Array.from({ length: 12 }, (_, i) => ({
  'Officer ID': `VC-O${i + 1}`,
  'Officer Name': `Capacity Officer ${i + 1}`,
  Designation: 'TA',
  'Mobile Number': `92000000${String(i + 1).padStart(2, '0')}`,
  Email: `vc${i + 1}@t.gov`,
  'House Number': `${i + 1}`,
  Street: `Street${i + 1}`,
  'Village/Locality': `CapVillage${i + 1}`,
  Ward: `${i + 1}`,
  Mandal: M,
  District: 'D',
  'PIN Code': '500010',
}));
const boothRows = [
  { 'Booth ID': 'VC-B1', 'Booth Number': '501', 'Booth Name': 'Cap School A', 'Building Name': 'A', Street: 'S1', 'Village/Locality': 'CapBoothVillage1', Ward: '20', Mandal: M, District: 'D', 'PIN Code': '500011', 'Required Officers': 6, 'Minimum Officers': 3 },
  { 'Booth ID': 'VC-B2', 'Booth Number': '502', 'Booth Name': 'Cap School B', 'Building Name': 'B', Street: 'S2', 'Village/Locality': 'CapBoothVillage2', Ward: '21', Mandal: M, District: 'D', 'PIN Code': '500012', 'Required Officers': 6, 'Minimum Officers': 3 },
];

async function main() {
  const login = await api('POST', '/api/auth/login', null, { username: 'admin', password: 'admin123' });
  check('K1 login', login.status === 200 && login.data.success, login.data.message || '');
  const token = login.data.token;

  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/polling_system');
  const Officer = require('../models/Officer');
  const Booth = require('../models/Booth');
  const Allocation = require('../models/Allocation');

  const up1 = await uploadExcel('/api/upload/officers', buildWorkbook(officerRows), token);
  check('K2 upload 12 officers', up1.status === 201 && up1.data.inserted === 12, up1.data.message || '');
  const up2 = await uploadExcel('/api/upload/booths', buildWorkbook(boothRows), token);
  check('K3 upload booths with min/max', up2.status === 201 && up2.data.inserted === 2, up2.data.message || '');

  const dbOffs = await Officer.find({ officerId: { $in: officerRows.map((o) => o['Officer ID']) } }).lean();
  const dbBooths = await Booth.find({ boothId: { $in: boothRows.map((b) => b['Booth ID']) } }).lean();
  const b1 = dbBooths.find((b) => b.boothId === 'VC-B1');
  check('K4 booth min/max persisted', b1 && b1.minOfficers === 3 && b1.requiredOfficers === 6,
    `min=${b1?.minOfficers} max=${b1?.requiredOfficers}`);

  const invalid = buildWorkbook([
    { 'Booth ID': 'VC-BX', 'Booth Number': '599', 'Booth Name': 'Bad', 'Village/Locality': 'XV', Mandal: M, 'Required Officers': 3, 'Minimum Officers': 5 },
  ]);
  const upBad = await uploadExcel('/api/upload/booths', invalid, token);
  const badMsg = (upBad.data.errors || [upBad.data.message || '']).join(' | ');
  check('K5 min>max rejected with clear error',
    upBad.status === 400 && /Minimum Officers cannot be greater/i.test(badMsg),
    badMsg);

  const outOfRange = await api('POST', '/api/allocation/run', token, { maxAllocations: 0 });
  check('K6 maxAllocations=0 rejected (positive integer only)', outOfRange.status === 400,
    outOfRange.data.errors?.[0] || outOfRange.data.message || '');

  const r1 = await api('POST', '/api/allocation/run', token, { maxAllocations: 10 });
  const d1 = r1.data.data || {};
  check('K7 capped run succeeds', r1.status === 200 && r1.data.success, r1.data.message || '');
  check('K8 allocated exactly 10 in capped run', d1.allocated === 10, `allocated=${d1.allocated}`);
  check('K9 limitReached reported', d1.limitReached === true && d1.runLimit === 10);
  // Only the capacity-test officers matter here - other Mandals may exist in the
  // shared database and legitimately appear in the unallocated list too.
  const vcUnallocated = (d1.unallocatedOfficers || []).filter((u) =>
    String(u.officerId || '').startsWith('VC-O')
  );
  check('K10 remaining capacity officers listed as unallocated with run-limit reason',
    vcUnallocated.length === 2 &&
      vcUnallocated.every((u) => /Run limit reached/i.test(u.reason || '')),
    vcUnallocated[0]?.reason || 'no reason');

  const liveB1 = await Allocation.countDocuments({ booth: b1._id, status: 'ALLOCATED' });
  check('K11 booth capacity never exceeded', liveB1 <= 6, `B1 live=${liveB1}/6`);

  const r2 = await api('POST', '/api/allocation/run', token, { maxAllocations: 10 });
  const d2 = r2.data.data || {};
  check('K12 second run continues allocation', d2.allocated === 2 && d2.limitReached === false,
    `allocated=${d2.allocated} limitReached=${d2.limitReached}`);

  const allLive = await Allocation.find({ status: 'ALLOCATED' }).select('booth officer').lean();
  const perOfficer = {};
  const perBooth = {};
  let exceeds = false;
  for (const a of allLive) {
    const o = String(a.officer);
    const b = String(a.booth);
    perOfficer[o] = (perOfficer[o] || 0) + 1;
    perBooth[b] = (perBooth[b] || 0) + 1;
  }
  for (const [o, n] of Object.entries(perOfficer)) if (n > 1) exceeds = true;
  check('K13 one active allocation per officer', !exceeds);

  const defaults = await api('POST', '/api/allocation/run', token);
  check('K14 run without body uses default cap', defaults.status === 200, defaults.data.message || '');

  await Allocation.deleteMany({ officer: { $in: dbOffs.map((o) => o._id) } });
  await Officer.deleteMany({ _id: { $in: dbOffs.map((o) => o._id) } });
  await Booth.deleteMany({ _id: { $in: dbBooths.map((b) => b._id) } });
  await mongoose.disconnect();
  console.log('cleanup: removed capacity-test data');

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nAll capacity-limit checks passed.');
}

main().catch((e) => {
  console.error('verify-capacity-limits crashed:', e.message);
  process.exit(1);
});
