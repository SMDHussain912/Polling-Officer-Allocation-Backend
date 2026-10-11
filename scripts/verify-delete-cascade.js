/**
 * verify-delete-cascade.js
 * =========================
 * Confirms the per-row delete on Officers/Booths now works even when the
 * record has an active allocation (it cascades instead of returning 409),
 * and that booth counters stay consistent afterwards.
 *
 * Run while the backend is listening: node scripts/verify-delete-cascade.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

const BASE = (process.env.API_BASE || 'http://127.0.0.1:5001').replace(/\/$/, '');
let failures = 0;

function check(name, condition, detail = '') {
  const icon = condition ? 'PASS' : 'FAIL';
  console.log(`[${icon}] ${name}${detail ? ` - ${detail}` : ''}`);
  if (!condition) failures += 1;
}

async function main() {
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: process.env.ADMIN_USERNAME || 'admin',
      password: process.env.ADMIN_PASSWORD || 'Admin@12345',
    }),
  });
  const login = await loginRes.json();
  check('POST /api/auth/login', loginRes.status === 200 && !!login.token, login.message || '');
  const auth = { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' };

  // 1. Create one officer + one booth (different localities, same mandal)
  const officer = await fetch(`${BASE}/api/officers`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ officerId: 'DC-O1', officerName: 'Cascade Officer', designation: 'TA',
      mobileNumber: '9200000001', email: 'dc@test.gov', houseNumber: '1', street: 'A Street',
      locality: 'Banjara Hills', ward: 'W5', mandal: 'Secunderabad', district: 'Hyderabad', pinCode: '500034' }),
  });
  const offJson = await officer.json();
  check('Create officer', officer.status === 201, offJson.message || '');

  const booth = await fetch(`${BASE}/api/booths`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ boothId: 'DC-B1', boothNumber: '301', boothName: 'Cascade Booth',
      buildingName: 'Hall', street: 'B Street', locality: 'Parade Grounds', ward: 'W7',
      mandal: 'Secunderabad', district: 'Hyderabad', pinCode: '500003', requiredOfficers: 1 }),
  });
  const boothJson = await booth.json();
  check('Create booth', booth.status === 201, boothJson.message || '');

  // 2. Run allocation - officer should be matched to the booth
  const runRes = await fetch(`${BASE}/api/allocation/run`, { method: 'POST', headers: auth });
  const runJson = await runRes.json();
  check('Run allocation', runRes.status === 200 && runJson?.data?.allocated >= 1,
    JSON.stringify({ allocated: runJson?.data?.allocated, skipped: runJson?.data?.skipped }));

  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/polling_system');
  const Officer = require('../models/Officer');
  const Booth = require('../models/Booth');
  const Allocation = require('../models/Allocation');

  // 3. The officer now has an allocation - booth counter should be 1.
  const boothDocAfter = await Booth.findOne({ boothId: 'DC-B1' }).lean();
  check('Booth allocatedOfficerCount = 1', boothDocAfter && boothDocAfter.allocatedOfficerCount === 1,
    `count=${boothDocAfter?.allocatedOfficerCount}`);

  // 4. Deleting the officer must succeed (cascade), NOT 409.
  const delRes = await fetch(`${BASE}/api/officers/${offJson.data._id}`, { method: 'DELETE', headers: auth });
  const delJson = await delRes.json();
  check('DELETE /api/officers/:id succeeds (cascade)', delRes.status === 200 && delJson.success, delJson.message || '');

  // 5. Officer gone, its allocations gone, booth counter rolled back to 0.
  const remainOff = await Officer.countDocuments({ officerId: 'DC-O1' });
  const remainAlloc = await Allocation.countDocuments({ officer: offJson.data._id });
  const boothDoc = await Booth.findOne({ boothId: 'DC-B1' }).lean();
  await mongoose.disconnect();
  check('Officer record removed from DB', remainOff === 0, `remaining=${remainOff}`);
  check('Officer allocations cascaded away', remainAlloc === 0, `allocRemaining=${remainAlloc}`);
  check('Booth counter back to 0', boothDoc && boothDoc.allocatedOfficerCount === 0,
    `count=${boothDoc?.allocatedOfficerCount}`);

  // Cleanup: remove the remaining booth.
  const authJson = { Authorization: `Bearer ${login.token}` };
  const delBooth = await fetch(`${BASE}/api/booths/${boothJson.data._id}`, { method: 'DELETE', headers: authJson });
  check('Cleanup booth delete', delBooth.status === 200, '');

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nAll delete-cascade checks passed.');
}

main().catch((err) => {
  console.error('verify-delete-cascade crashed:', err.message);
  process.exit(1);
});
