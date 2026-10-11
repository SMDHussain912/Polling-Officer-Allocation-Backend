/**
 * verify-allocation-flow.js
 * =========================
 * End-to-end verification of the allocation engine over real HTTP + MongoDB.
 * Run while the backend is listening:  node scripts/verify-allocation-flow.js
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

const M = 'FlowTestMandal';
const officerRows = [
  { 'Officer ID': 'VF-O1', 'Officer Name': 'Flow One', Designation: 'TA', 'Mobile Number': '9100000001', Email: 'f1@t.gov', 'House Number': '1', Street: 'S1', 'Village/Locality': 'AlphaVillage', Ward: '1', Mandal: M, District: 'D', 'PIN Code': '500001' },
  { 'Officer ID': 'VF-O2', 'Officer Name': 'Flow Two', Designation: 'TA', 'Mobile Number': '9100000002', Email: 'f2@t.gov', 'House Number': '2', Street: 'S2', 'Village/Locality': 'BetaVillage', Ward: '2', Mandal: M, District: 'D', 'PIN Code': '500002' },
  { 'Officer ID': 'VF-O3', 'Officer Name': 'Flow Three', Designation: 'TA', 'Mobile Number': '9100000003', Email: 'f3@t.gov', 'House Number': '3', Street: 'S3', 'Village/Locality': 'GammaVillage', Ward: '3', Mandal: 'OtherMandal', District: 'D', 'PIN Code': '500003' },
];
const boothRows = [
  { 'Booth ID': 'VF-B1', 'Booth Number': '401', 'Booth Name': 'Flow School A', 'Building Name': 'School A', Street: 'S1', 'Village/Locality': 'AlphaVillage', Ward: '1', Mandal: M, District: 'D', 'PIN Code': '500001', 'Required Officers': 2 },
  { 'Booth ID': 'VF-B2', 'Booth Number': '402', 'Booth Name': 'Flow School B', 'Building Name': 'School B', Street: 'S2', 'Village/Locality': 'BetaVillage', Ward: '2', Mandal: M, District: 'D', 'PIN Code': '500002', 'Required Officers': 1 },
  { 'Booth ID': 'VF-B3', 'Booth Number': '403', 'Booth Name': 'Flow School C', 'Building Name': 'School C', Street: 'S3', 'Village/Locality': 'GammaVillage', Ward: '3', Mandal: M, District: 'D', 'PIN Code': '500003', 'Required Officers': 1 },
];

async function main() {
  // 1. Main Admin login (admin/admin123)
  const login = await api('POST', '/api/auth/login', null, { username: 'admin', password: 'admin123' });
  check('J1 Main Admin login admin/admin123', login.status === 200 && login.data.success, login.data.message || '');
  const token = login.data.token;

  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/polling_system');
  const Admin = require('../models/Admin');
  check('J2 Only one Main Admin account exists', (await Admin.countDocuments()) === 1);

  const Officer = require('../models/Officer');
  const Booth = require('../models/Booth');
  const Allocation = require('../models/Allocation');

  // Cleanup any leftovers from previous runs
  const oldOff = await Officer.find({ officerId: { $in: ['VF-O1', 'VF-O2', 'VF-O3'] } }).select('_id').lean();
  const oldBth = await Booth.find({ boothId: { $in: ['VF-B1', 'VF-B2', 'VF-B3'] } }).select('_id').lean();
  await Allocation.deleteMany({ $or: [{ officer: { $in: oldOff.map((o) => o._id) } }, { booth: { $in: oldBth.map((b) => b._id) } }] });
  await Officer.deleteMany({ officerId: { $in: ['VF-O1', 'VF-O2', 'VF-O3'] } });
  await Booth.deleteMany({ boothId: { $in: ['VF-B1', 'VF-B2', 'VF-B3'] } });

  // 3+4. Upload officers & booths
  const upO = await uploadExcel('/api/upload/officers', buildWorkbook(officerRows), token);
  check('J3 Officer Excel upload', upO.status === 201 && upO.data.inserted === 3, upO.data.message || '');
  const upB = await uploadExcel('/api/upload/booths', buildWorkbook(boothRows), token);
  check('J4 Booth Excel upload', upB.status === 201 && upB.data.inserted === 3, upB.data.message || '');

  // 5+6. Uploaded data visible
  const listO = await api('GET', '/api/officers?limit=500', token);
  check('J5 Uploaded officers visible', listO.data.data.some((o) => o.officerId === 'VF-O1'));
  const listB = await api('GET', '/api/booths?limit=500', token);
  check('J6 Uploaded booths visible', listB.data.data.some((b) => b.boothId === 'VF-B1'));

  // 7. Dashboard stats
  const stats = await api('GET', '/api/dashboard/stats', token);
  check('J7 Stats show uploaded counts', stats.data.data.totalOfficers >= 3 && stats.data.data.totalBooths >= 3,
    `officers=${stats.data.data.totalOfficers} booths=${stats.data.data.totalBooths}`);

  // 8. Run allocation
  const run1 = await api('POST', '/api/allocation/run', token);
  check('J8 Run allocation succeeds', run1.status === 200 && run1.data.success,
    run1.data.message || JSON.stringify(run1.data.error || ''));

  const dbOffs = await Officer.find({ officerId: { $in: ['VF-O1', 'VF-O2', 'VF-O3'] } }).lean();
  const dbBooths = await Booth.find({ boothId: { $in: ['VF-B1', 'VF-B2', 'VF-B3'] } }).lean();
  const byId = (arr, k, v) => arr.find((x) => x[k] === v);
  const o1 = byId(dbOffs, 'officerId', 'VF-O1');
  const o2 = byId(dbOffs, 'officerId', 'VF-O2');
  const o3 = byId(dbOffs, 'officerId', 'VF-O3');
  const b1 = byId(dbBooths, 'boothId', 'VF-B1');
  const allocs = await Allocation.find({ officer: { $in: dbOffs.map((o) => o._id) }, status: 'ALLOCATED' }).lean();
  check('J8b Allocation records created in MongoDB', allocs.length >= 1, `active=${allocs.length}`);

  // 10. Same-locality rejection: O1 (AlphaVillage) must NOT sit at B1 (AlphaVillage)
  const a1 = allocs.find((a) => String(a.officer) === String(o1._id));
  check('J10 Same-locality officer rejected', !a1 || String(a1.booth) !== String(b1._id),
    a1 ? `O1 at booth ${a1.boothId}` : 'O1 unallocated');

  // 12. Cross-Mandal never happens: O3 has no booth in its Mandal -> unallocated
  const a3 = allocs.find((a) => String(a.officer) === String(o3._id));
  check('J12 Cross-Mandal allocation never happens', !a3, a3 ? 'O3 allocated outside own mandal!' : 'O3 stays unallocated');
  const mMatch = allocs.every((a) => {
    const booth = dbBooths.find((b) => String(b._id) === String(a.booth));
    const off = dbOffs.find((o) => String(o._id) === String(a.officer));
    return booth && off && booth.mandal.toLowerCase() === off.mandal.toLowerCase();
  });
  check('J12b Every allocation is same-Mandal', mMatch);

  // 9. Re-run does not duplicate
  const run2 = await api('POST', '/api/allocation/run', token);
  const allocs2 = await Allocation.find({ officer: { $in: dbOffs.map((o) => o._id) }, status: 'ALLOCATED' }).lean();
  check('J9 Re-run creates no duplicates', run2.status === 200 && allocs2.length === allocs.length,
    `before=${allocs.length} after=${allocs2.length}`);

  // 16. One officer never has 2 active allocations
  const perOfficer = {};
  let dup = false;
  allocs2.forEach((a) => {
    const k = String(a.officer);
    perOfficer[k] = (perOfficer[k] || 0) + 1;
    if (perOfficer[k] > 1) dup = true;
  });
  check('J16 Officer has only one active ALLOCATED allocation', !dup);

  // 11+13. Different-locality officer allocated; booth count matches records
  const o2Alloc = allocs2.find((a) => String(a.officer) === String(o2._id));
  check('J11 Different-locality officer allocated', Boolean(o2Alloc), o2Alloc ? `O2 -> ${o2Alloc.boothId}` : 'O2 unallocated');
  const countBooth = async (boothId) => {
    const b = await Booth.findById(boothId).lean();
    const live = await Allocation.countDocuments({ booth: boothId, status: 'ALLOCATED' });
    return { stored: b.allocatedOfficerCount, live, available: b.availableSlots, required: b.requiredOfficers };
  };
  if (o2Alloc) {
    const c = await countBooth(o2Alloc.booth);
    check('J13 Booth count matches ALLOCATED records', c.stored === c.live && c.available === c.required - c.live,
      `stored=${c.stored} live=${c.live} avail=${c.available}`);
  }

  // 14. Cancel decreases booth count, history kept
  if (o2Alloc) {
    const before = await countBooth(o2Alloc.booth);
    const cancel = await api('POST', `/api/allocation/${o2Alloc._id}/cancel`, token);
    const after = await countBooth(o2Alloc.booth);
    check('J14 Cancel works, booth count decreases',
      cancel.status === 200 && after.stored === before.stored - 1,
      `before=${before.stored} after=${after.stored}`);
    const hist = await Allocation.findById(o2Alloc._id).lean();
    check('J14b Cancelled history kept (CANCELLED)', hist && hist.status === 'CANCELLED');

    // 15. Reallocate O1 (if allocated)
    await api('POST', '/api/allocation/run', token);
    const active = await Allocation.findOne({ officer: o1._id, status: 'ALLOCATED' }).lean();
    if (active) {
      const oldBooth = active.booth;
      const suit = await api('GET', `/api/allocation/suitable-booths/${o1.officerId}`, token);
      check('J-G Suitable-booths endpoint works', suit.status === 200 && Array.isArray(suit.data.data?.booths),
        `booths=${suit.data.data?.booths?.length ?? 'n/a'}`);
      const target = (suit.data.data?.booths || []).find((b) => String(b._id) !== String(oldBooth));
      const re = await api('POST', `/api/allocation/${active._id}/reallocate`, token, { preferredBoothId: target?._id });
      const newA = await Allocation.findOne({ officer: o1._id, status: 'ALLOCATED' }).lean();
      const oldA = await Allocation.findById(active._id).lean();
      check('J15 Reallocate: old REALLOCATED, new ALLOCATED, booth changed',
        re.status === 200 && oldA.status === 'REALLOCATED' && Boolean(newA) && String(newA.booth) !== String(oldBooth),
        re.data.message || re.data.error || '');
      if (newA) {
        const oc = await countBooth(oldBooth);
        const nc = await countBooth(newA.booth);
        check('J15b Both booth counts correct after reallocate', oc.stored === oc.live && nc.stored === nc.live,
          `old(${oc.stored}/${oc.live}) new(${nc.stored}/${nc.live})`);
      }
    } else {
      check('J15 Reallocate flow', false, 'O1 had no active allocation to reallocate');
    }
  }

  // Cleanup test rows
  await Allocation.deleteMany({ officer: { $in: dbOffs.map((o) => o._id) } });
  await Officer.deleteMany({ _id: { $in: dbOffs.map((o) => o._id) } });
  await Booth.deleteMany({ _id: { $in: dbBooths.map((b) => b._id) } });
  await mongoose.disconnect();
  console.log('cleanup: removed flow-test officers/booths/allocations');

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nAll allocation-flow checks passed.');
}

main().catch((e) => {
  console.error('verify-allocation-flow crashed:', e.message);
  process.exit(1);
});

