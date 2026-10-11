 /**
 * verify-delete-all.js
 * =====================
 * End-to-end check of the "Delete All Files" button:
 *   login -> commit uploads (batches recorded) -> DELETE /api/upload/all
 *   -> verify every batch, officer, booth, allocation and notification
 *      collection is completely emptied.
 *
 * IMPORTANT: run the server against a TEST database, e.g.
 *   $env:MONGODB_URI='mongodb://127.0.0.1:27017/polling_system_test'
 * because this endpoint wipes all data.
 *
 * Run while the backend is listening: node scripts/verify-delete-all.js
 */
require('dotenv').config();
const XLSX = require('xlsx');
const mongoose = require('mongoose');

const BASE = (process.env.API_BASE || 'http://127.0.0.1:5001').replace(/\/$/, '');
let failures = 0;

function check(name, condition, detail = '') {
  const icon = condition ? 'PASS' : 'FAIL';
  console.log(`[${icon}] ${name}${detail ? ` - ${detail}` : ''}`);
  if (!condition) failures += 1;
}

function buildWorkbook(sheetName, rows) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

async function uploadExcel(path, buffer, token, mode) {
  const form = new FormData();
  form.append('file', new Blob([buffer]), 'bulk-upload.xlsx');
  const res = await fetch(`${BASE}${path}?mode=${mode}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  return { status: res.status, data: await res.json() };
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
  const auth = { Authorization: `Bearer ${login.token}` };

  const officerRows = [
    { 'Officer ID': 'DA-O1', 'Officer Name': 'Delete All One', Designation: 'TA',
      'Mobile Number': '9300000001', Email: 'da1@test.gov', 'House Number': '1',
      Street: 'X Street', 'Village/Locality': 'Kukatpally', Ward: 'W8',
      Mandal: 'Kukatpally', District: 'Medchal', 'PIN Code': '500072' },
    { 'Officer ID': 'DA-O2', 'Officer Name': 'Delete All Two', Designation: 'TA',
      'Mobile Number': '9300000002', Email: 'da2@test.gov', 'House Number': '2',
      Street: 'Y Street', 'Village/Locality': 'KPHB', Ward: 'W9',
      Mandal: 'Kukatpally', District: 'Medchal', 'PIN Code': '500085' },
  ];
  const boothRows = [
    { 'Booth ID': 'DA-B1', 'Booth Number': '401', 'Booth Name': 'Delete All School',
      'Building Name': 'Hall', Street: 'Z Street', 'Village/Locality': 'Moosapet',
      Ward: 'W10', Mandal: 'Kukatpally', District: 'Medchal',
      'PIN Code': '500018', 'Required Officers': 2 },
  ];

  // 1. Commit uploads -> batches recorded
  const off = await uploadExcel('/api/upload/officers', buildWorkbook('Officers', officerRows), auth.Authorization.replace('Bearer ', ''), 'commit');
  check('Commit officers', off.status === 201 && off.data.inserted === 2, off.data.message || '');
  const booths = await uploadExcel('/api/upload/booths', buildWorkbook('Booths', boothRows), auth.Authorization.replace('Bearer ', ''), 'commit');
  check('Commit booths', booths.status === 201 && booths.data.inserted === 1, booths.data.message || '');

  // 2. History has 2 files
  const hist = await fetch(`${BASE}/api/upload/history`, { headers: auth });
  const histJson = await hist.json();
  check('History lists 2 files', hist.status === 200 && histJson.data.length === 2, `count=${histJson.data.length}`);

  // 3. DELETE /api/upload/all
  const delAll = await fetch(`${BASE}/api/upload/all`, { method: 'DELETE', headers: auth });
  const delAllJson = await delAll.json();
  check('DELETE /api/upload/all', delAll.status === 200 && delAllJson.success, delAllJson.message || '');
  check('Removed counts correct',
    delAllJson.removed && delAllJson.removed.batches === 2 && delAllJson.removed.officers === 2 && delAllJson.removed.booths === 1,
    JSON.stringify(delAllJson.removed));

  // 4. Every collection is completely empty
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/polling_system_test');
  const UploadBatch = require('../models/UploadBatch');
  const Officer = require('../models/Officer');
  const Booth = require('../models/Booth');
  const Allocation = require('../models/Allocation');
  const Notification = require('../models/Notification');
  const [b, o, bo, a, n] = await Promise.all([
    UploadBatch.countDocuments(), Officer.countDocuments(), Booth.countDocuments(),
    Allocation.countDocuments(), Notification.countDocuments(),
  ]);
  await mongoose.disconnect();
  check('All rows/records deleted from DB', b === 0 && o === 0 && bo === 0 && a === 0 && n === 0,
    `batches=${b}, officers=${o}, booths=${bo}, allocations=${a}, notifications=${n}`);

  // 5. History is empty now
  const hist2 = await fetch(`${BASE}/api/upload/history`, { headers: auth });
  const hist2Json = await hist2.json();
  check('History empty after delete-all', hist2.status === 200 && hist2Json.data.length === 0, '');

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nAll delete-all checks passed.');
}

main().catch((err) => {
  console.error('verify-delete-all crashed:', err.message);
  process.exit(1);
});
