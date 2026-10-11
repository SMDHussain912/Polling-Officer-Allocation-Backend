/**
 * verify-upload.js
 * ================
 * End-to-end check of the Excel upload pipeline over real HTTP:
 *   login -> build .xlsx in memory -> multipart POST (preview) -> commit
 *         -> confirm rows landed in MongoDB -> re-upload skips duplicates
 *         -> template download -> wrong-file rejection -> cleanup.
 *
 * The multipart body is built with Node's FormData/Blob (same behaviour as
 * the fixed browser axios client). Run while the backend is listening.
 *
 * Usage: node scripts/verify-upload.js
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

/** Builds an in-memory .xlsx workbook buffer from row objects. */
function buildWorkbook(sheetName, rows) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/** Posts an Excel buffer as multipart/form-data (like the browser does). */
async function uploadExcel(path, buffer, token, mode) {
  const form = new FormData();
  form.append('file', new Blob([buffer]), 'upload.xlsx');
  const res = await fetch(`${BASE}${path}?mode=${mode}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  return { status: res.status, data: await res.json() };
}

async function main() {
  // 1. Login
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: process.env.ADMIN_USERNAME || 'admin',
      password: process.env.ADMIN_PASSWORD || 'admin123',
    }),
  });
  const login = await loginRes.json();
  check(
    'POST /api/auth/login',
    loginRes.status === 200 && login.success && !!login.token,
    login.message || ''
  );
  const token = login.token;

  // 2. Test workbooks. Officer localities deliberately match booth localities
  //    so the address rules can be exercised later if needed.
  const officerRows = [
    { 'Officer ID': 'VU-O1', 'Officer Name': 'Upload Test One', Designation: 'TA',
      'Mobile Number': '9000000001', Email: 'vu1@test.gov', 'House Number': '1-1',
      Street: 'Main Road', 'Village/Locality': 'Kondapur', Ward: 'W10',
      Mandal: 'Serilingampally', District: 'Rangareddy', 'PIN Code': '500084' },
    { 'Officer ID': 'VU-O2', 'Officer Name': 'Upload Test Two', Designation: 'TA',
      'Mobile Number': '9000000002', Email: 'vu2@test.gov', 'House Number': '2-1',
      Street: 'Lake Street', 'Village/Locality': 'Gachibowli', Ward: 'W11',
      Mandal: 'Serilingampally', District: 'Rangareddy', 'PIN Code': '500032' },
  ];
  const boothRows = [
    { 'Booth ID': 'VU-B1', 'Booth Number': '101', 'Booth Name': 'Upload Test School A',
      'Building Name': 'School A', Street: 'Main Road', 'Village/Locality': 'Kondapur',
      Ward: 'W10', Mandal: 'Serilingampally', District: 'Rangareddy',
      'PIN Code': '500084', 'Required Officers': 2 },
    { 'Booth ID': 'VU-B2', 'Booth Number': '102', 'Booth Name': 'Upload Test School B',
      'Building Name': 'School B', Street: 'Lake Street', 'Village/Locality': 'Gachibowli',
      Ward: 'W11', Mandal: 'Serilingampally', District: 'Rangareddy',
      'PIN Code': '500032', 'Required Officers': 2 },
  ];

  const officersXlsx = buildWorkbook('Officers', officerRows);
  const boothsXlsx = buildWorkbook('Booths', boothRows);

  // 3. Preview (validate only)
  const officersPreview = await uploadExcel('/api/upload/officers', officersXlsx, token, 'preview');
  check(
    'POST /api/upload/officers?mode=preview',
    officersPreview.status === 200 && officersPreview.data.success && officersPreview.data.totalRows === 2,
    officersPreview.data.message || ''
  );

  const boothsPreview = await uploadExcel('/api/upload/booths', boothsXlsx, token, 'preview');
  check(
    'POST /api/upload/booths?mode=preview',
    boothsPreview.status === 200 && boothsPreview.data.success && boothsPreview.data.totalRows === 2,
    boothsPreview.data.message || ''
  );

  // 4. Commit (save to MongoDB)
  const officersCommit = await uploadExcel('/api/upload/officers', officersXlsx, token, 'commit');
  check(
    'POST /api/upload/officers?mode=commit',
    officersCommit.status === 201 && officersCommit.data.inserted === 2,
    officersCommit.data.message || ''
  );

  const boothsCommit = await uploadExcel('/api/upload/booths', boothsXlsx, token, 'commit');
  check(
    'POST /api/upload/booths?mode=commit',
    boothsCommit.status === 201 && boothsCommit.data.inserted === 2,
    boothsCommit.data.message || ''
  );

  // 5. Re-upload -> duplicates must be skipped, never duplicated
  const reCommit = await uploadExcel('/api/upload/officers', officersXlsx, token, 'commit');
  check(
    'Re-upload skips duplicate IDs',
    reCommit.status === 201 && reCommit.data.inserted === 0 && reCommit.data.skipped === 2,
    reCommit.data.message || ''
  );

  // 6. Rows are visible through the normal GET endpoint
  const listRes = await fetch(`${BASE}/api/officers`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const listJson = await listRes.json();
  check(
    'GET /api/officers returns uploaded rows',
    listRes.status === 200 && JSON.stringify(listJson).includes('VU-O1'),
    ''
  );

  // 7. Sample template download (authenticated)
  const templateRes = await fetch(`${BASE}/api/upload/templates/officers`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const templateBuf = Buffer.from(await templateRes.arrayBuffer());
  check(
    'GET /api/upload/templates/officers',
    templateRes.status === 200 && templateBuf.length > 500,
    `bytes=${templateBuf.length}`
  );

  // 8. A booth file uploaded to the officers endpoint is rejected meaningfully
  const badRes = await uploadExcel('/api/upload/officers', boothsXlsx, token, 'preview');
  check(
    'Wrong file rejected with clear error',
    badRes.status === 400 && badRes.data.success === false,
    badRes.data.message || ''
  );

  // Cleanup: remove only the verification rows created above.
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/polling_system');
  const Officer = require('../models/Officer');
  const Booth = require('../models/Booth');
  const o = await Officer.deleteMany({ officerId: { $in: ['VU-O1', 'VU-O2'] } });
  const b = await Booth.deleteMany({ boothId: { $in: ['VU-B1', 'VU-B2'] } });
  await mongoose.disconnect();
  console.log(`cleanup: removed ${o.deletedCount} officer(s), ${b.deletedCount} booth(s)`);

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nAll upload pipeline checks passed.');
}

main().catch((err) => {
  console.error('verify-upload crashed:', err.message);
  process.exit(1);
});
