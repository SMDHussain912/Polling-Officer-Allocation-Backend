/**
 * verify-upload-delete.js
 * ========================
 * End-to-end check of the "Uploaded Files" list + per-row delete:
 *   login -> build .xlsx in memory -> commit upload (records a batch)
 *   -> GET /api/upload/history lists the file
 *   -> DELETE /api/upload/:id removes the file record AND its imported
 *      officers/booths completely from MongoDB
 *   -> officer list no longer contains the imported IDs
 *
 * Run while the backend is listening: node scripts/verify-upload-delete.js
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
  form.append('file', new Blob([buffer]), 'test-upload.xlsx');
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
  const token = login.token;
  const auth = { Authorization: `Bearer ${token}` };

  const officerRows = [
    { 'Officer ID': 'DL-O1', 'Officer Name': 'Delete Test One', Designation: 'TA',
      'Mobile Number': '9100000001', Email: 'dl1@test.gov', 'House Number': '1-9',
      Street: 'High Street', 'Village/Locality': 'Malkajgiri', Ward: 'W2',
      Mandal: 'Malkajgiri', District: 'Medchal', 'PIN Code': '500047' },
    { 'Officer ID': 'DL-O2', 'Officer Name': 'Delete Test Two', Designation: 'TA',
      'Mobile Number': '9100000002', Email: 'dl2@test.gov', 'House Number': '2-9',
      Street: 'Colony Road', 'Village/Locality': 'Uppal', Ward: 'W3',
      Mandal: 'Uppal', District: 'Medchal', 'PIN Code': '500039' },
  ];
  const boothRows = [
    { 'Booth ID': 'DL-B1', 'Booth Number': '201', 'Booth Name': 'Delete Test School X',
      'Building Name': 'School X', Street: 'High Street', 'Village/Locality': 'Malkajgiri',
      Ward: 'W2', Mandal: 'Malkajgiri', District: 'Medchal',
      'PIN Code': '500047', 'Required Officers': 2 },
  ];

  const officersXlsx = buildWorkbook('Officers', officerRows);
  const boothsXlsx = buildWorkbook('Booths', boothRows);

  // 1. Commit both uploads (creates UploadBatch records)
  const offCommit = await uploadExcel('/api/upload/officers', officersXlsx, token, 'commit');
  check('Commit officers (records batch)', offCommit.status === 201 && offCommit.data.inserted === 2, offCommit.data.message || '');

  const boothCommit = await uploadExcel('/api/upload/booths', boothsXlsx, token, 'commit');
  check('Commit booths (records batch)', boothCommit.status === 201 && boothCommit.data.inserted === 1, boothCommit.data.message || '');

  // 2. History lists the files
  const histRes = await fetch(`${BASE}/api/upload/history`, { headers: auth });
  const hist = await histRes.json();
  const officerBatch = hist.data.find((b) => b.kind === 'officers' && b.recordRefs.includes('DL-O1'));
  const boothBatch = hist.data.find((b) => b.kind === 'booths' && b.recordRefs.includes('DL-B1'));
  check('GET /api/upload/history lists files', histRes.status === 200 && !!officerBatch && !!boothBatch,
    `officerBatch=${!!officerBatch}, boothBatch=${!!boothBatch}`);

  // 3. Delete the officer upload batch
  const delRes = await fetch(`${BASE}/api/upload/${officerBatch.id}`, { method: 'DELETE', headers: auth });
  const del = await delRes.json();
  check('DELETE /api/upload/:id (officers)', delRes.status === 200 && del.success, del.message || '');
  check('Cascade removed the 2 officers', del.removed && del.removed.officers === 2, JSON.stringify(del.removed));

  // 4. Officer rows are really gone from the database
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/polling_system');
  const Officer = require('../models/Officer');
  const count = await Officer.countDocuments({ officerId: { $in: ['DL-O1', 'DL-O2'] } });
  await mongoose.disconnect();
  check('Officers deleted completely from DB', count === 0, `remaining=${count}`);

  // 5. Batch record is gone from history too
  const hist2Res = await fetch(`${BASE}/api/upload/history`, { headers: auth });
  const hist2 = await hist2Res.json();
  check('Deleted batch removed from history', !hist2.data.some((b) => b.id === officerBatch.id), '');

  // 6. Delete the booth upload batch (cleanup)
  const delB = await fetch(`${BASE}/api/upload/${boothBatch.id}`, { method: 'DELETE', headers: auth });
  const delBJson = await delB.json();
  check('DELETE booth upload batch', delB.status === 200 && delBJson.success && delBJson.removed.booths === 1, delBJson.message || '');

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nAll upload-delete checks passed.');
}

main().catch((err) => {
  console.error('verify-upload-delete crashed:', err.message);
  process.exit(1);
});
