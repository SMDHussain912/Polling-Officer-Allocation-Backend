/**
 * verify-single-sheet-report.js
 * =============================
 * Standalone validation for excelService.allocationReportByMandal().
 * Seeds two officers in two different Mandals plus allocated booths, generates
 * the report workbook in memory and asserts:
 *   1. the workbook contains exactly ONE sheet;
 *   2. every row keeps its Mandal (Officer Mandal / Booth Mandal columns);
 *   3. rows are sorted by Officer ID ascending across ALL Mandals.
 * All seed data is removed afterwards.
 *
 * Run: node scripts/verify-single-sheet-report.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const XLSX = require('xlsx');
const Officer = require('../models/Officer');
const Booth = require('../models/Booth');
const Allocation = require('../models/Allocation');
const { allocationReportByMandal } = require('../services/excelService');
const { compareOfficerIds } = require('../services/sortUtil');

const TEST_URI =
  process.env.MONGODB_URI_TEST || 'mongodb://127.0.0.1:27017/polling_system_capacity_test';

const OFFICER_IDS = ['E2E-M1-OFF-01', 'E2E-M2-OFF-02', 'E2E-M1-OFF-03'];
const BOOTH_IDS = ['E2E-B1-OFF-01', 'E2E-B2-OFF-02', 'E2E-B3-OFF-03'];

let passed = 0;

function check(name, condition, detail) {
  if (!condition) throw new Error(`${name} :: ${detail}`);
  passed += 1;
  console.log(`  PASS  ${name}`);
}

async function cleanup() {
  const officers = await Officer.find({ officerId: { $in: OFFICER_IDS } }).select('_id').lean();
  const booths = await Booth.find({ boothId: { $in: BOOTH_IDS } }).select('_id').lean();
  await Allocation.deleteMany({
    $or: [
      { officer: { $in: officers.map((o) => o._id) } },
      { booth: { $in: booths.map((b) => b._id) } },
    ],
  });
  await Officer.deleteMany({ _id: { $in: officers.map((o) => o._id) } });
  await Booth.deleteMany({ _id: { $in: booths.map((b) => b._id) } });
}

(async () => {
  await mongoose.connect(TEST_URI);
  await mongoose.connection.dropDatabase();
  try {
    await cleanup();

    // ----- seed two Mandals (M1 has OFF-01 and OFF-03, M2 has OFF-02) -----
    const officers = await Promise.all(
      [
        { officerId: 'E2E-M1-OFF-01', officerName: 'E2E Officer One', mandal: 'Mandal Alpha' },
        { officerId: 'E2E-M2-OFF-02', officerName: 'E2E Officer Two', mandal: 'Mandal Beta' },
        { officerId: 'E2E-M1-OFF-03', officerName: 'E2E Officer Three', mandal: 'Mandal Alpha' },
      ].map((o) =>
        Officer.create({
          officerId: o.officerId,
          officerName: o.officerName,
          designation: 'Assistant Engineer',
          mobileNumber: '9000000000',
          street: '',
          locality: '',
          ward: '',
          mandal: o.mandal,
          district: 'E2E District',
          isActive: true,
        })
      )
    );
    const booths = await Promise.all(
      [
        { boothId: 'E2E-B1-OFF-01', boothNumber: '101', mandal: 'Mandal Alpha' },
        { boothId: 'E2E-B2-OFF-02', boothNumber: '102', mandal: 'Mandal Beta' },
        { boothId: 'E2E-B3-OFF-03', boothNumber: '103', mandal: 'Mandal Alpha' },
      ].map((b) =>
        Booth.create({
          boothId: b.boothId,
          boothNumber: b.boothNumber,
          boothName: `Booth ${b.boothNumber}`,
          buildingName: '',
          street: '',
          locality: '',
          ward: '',
          mandal: b.mandal,
          district: 'E2E District',
          requiredOfficers: 4,
          minOfficers: 1,
          isActive: true,
          allocatedOfficerCount: 0,
        })
      )
    );
    await Promise.all(
      [0, 1, 2].map((i) =>
        Allocation.create({
          allocationId: `E2E-ALLOC-${i}`,
          officer: officers[i]._id,
          officerId: officers[i].officerId,
          booth: booths[i]._id,
          boothId: booths[i].boothId,
          mandal: officers[i].mandal,
          status: 'ALLOCATED',
          allocationDate: new Date(),
          allocatedAt: new Date(),
          adminApproved: true,
          addressMatchScore: 90,
          isFallback: false,
        })
      )
    );

    // ----- run the changed function and inspect the workbook ---------------- 
    const buffer = await allocationReportByMandal({});
    const wb = XLSX.read(buffer);
    check(
      'workbook has exactly ONE sheet',
      wb.SheetNames.length === 1,
      `got ${wb.SheetNames.length} sheets: ${wb.SheetNames.join(', ')}`
    );
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    check('sheet contains all 3 seeded rows', rows.length === 3, `got ${rows.length}`);
    check(
      'every row keeps its Officer Mandal column',
      rows.every((r) => String(r['Officer Mandal'] || '').startsWith('Mandal')),
      'Officer Mandal missing on some rows'
    );
    const ids = rows.map((r) => String(r['Officer ID'] || ''));
    const sorted = [...ids].sort(compareOfficerIds);
    check(
      'rows sorted by Officer ID ascending (both Mandals combined)',
      JSON.stringify(ids) === JSON.stringify(sorted),
      `order was ${ids.join(', ')}`
    );
    const mandalsSeen = new Set(rows.map((r) => r['Officer Mandal']));
    check(
      'rows from BOTH Mandals live in the same sheet',
      mandalsSeen.size === 2,
      `mandals found: ${[...mandalsSeen].join(', ')}`
    );

    console.log(`\nRESULT: ${passed} passed`);
  } finally {
    await cleanup();
    await mongoose.disconnect();
    console.log('cleanup: removed verification seed data');
  }
})().catch((error) => {
  console.error('FATAL', error);
  process.exit(1);
});