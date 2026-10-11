
const XLSX = require('xlsx');
const Officer = require('../models/Officer');
const Booth = require('../models/Booth');
const Notification = require('../models/Notification');
const countService = require('./countService');
const { compareOfficerIds } = require('./sortUtil');

const OFFICER_COLUMNS = [
  'Officer ID',
  'Officer Name',
  'Designation',
  'Mobile Number',
  'Email',
  'House Number',
  'Street',
  'Village/Locality',
  'Ward',
  'Mandal',
  'District',
  'PIN Code',
];

const BOOTH_COLUMNS = [
  'Booth ID',
  'Booth Number',
  'Booth Name',
  'Building Name',
  'Street',
  'Village/Locality',
  'Ward',
  'Mandal',
  'District',
  'PIN Code',
  'Required Officers',
  'Minimum Officers',
]
const OFFICER_MAP = {
  'Officer ID': 'officerId',
  'Officer Name': 'officerName',
  Designation: 'designation',
  'Mobile Number': 'mobileNumber',
  Email: 'email',
  'House Number': 'houseNumber',
  Street: 'street',
  'Village/Locality': 'locality',
  Ward: 'ward',
  Mandal: 'mandal',
  District: 'district',
  'PIN Code': 'pinCode',
};

const BOOTH_MAP = {
  'Booth ID': 'boothId',
  'Booth Number': 'boothNumber',
  'Booth Name': 'boothName',
  'Building Name': 'buildingName',
  Street: 'street',
  'Village/Locality': 'locality',
  Ward: 'ward',
  Mandal: 'mandal',
  District: 'district',
  'PIN Code': 'pinCode',
  'Required Officers': 'requiredOfficers',
  'Minimum Officers': 'minOfficers',
}

const REQUIRED_OFFICER_COLUMNS = [
  'Officer ID',
  'Officer Name',
  'Designation',
  'Mobile Number',
  'Village/Locality',
  'Mandal',
];

const REQUIRED_BOOTH_COLUMNS = [
  'Booth ID',
  'Booth Number',
  'Booth Name',
  'Village/Locality',
  'Mandal',
];

function isMissing(value) {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim() === '')
  );
}

function asString(value) {
  if (isMissing(value)) return '';
  return String(value).trim();
}

function normalizeHeader(header) {
  return String(header || '')
    .trim()
    .replace(/\s+/g, ' ');
}

function canonicalHeader(header) {
  return String(header || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function mapRow(row, mapping) {
  const result = {};
  const keys = Object.keys(row);
  const canonicalKeys = keys.map((key) => canonicalHeader(key));
  Object.keys(mapping).forEach((header) => {
    const wanted = canonicalHeader(header);
    const index = canonicalKeys.indexOf(wanted);
    result[mapping[header]] = index !== -1 ? row[keys[index]] : undefined;
  });
  return result;
}

function validateAndParseOfficers(rows) {
  const errors = [];
  const seenIds = new Set();
  const mapped = [];

  if (!Array.isArray(rows) || rows.length === 0) {
    return { valid: false, missingColumns: [], errors: ['Excel file contains no data rows'], mapped: [] };
  }

  const headers = Object.keys(rows[0]).map(canonicalHeader);
  const missingColumns = REQUIRED_OFFICER_COLUMNS.filter(
    (col) => !headers.includes(canonicalHeader(col))
  );

  rows.forEach((rawRow, index) => {
    const row = mapRow(rawRow, OFFICER_MAP);
    if (Object.values(row).every((value) => isMissing(value))) return;
    const lineNo = index + 2; // 1-based + header row

    if (isMissing(row.officerId)) errors.push(`Row ${lineNo}: Officer ID is required`);
    else if (seenIds.has(row.officerId.trim().toUpperCase())) {
      errors.push(`Row ${lineNo}: Duplicate Officer ID '${row.officerId}' inside the file`);
    } else {
      seenIds.add(row.officerId.trim().toUpperCase());
    }

    if (isMissing(row.officerName)) errors.push(`Row ${lineNo}: Officer Name is required`);
    if (isMissing(row.designation)) errors.push(`Row ${lineNo}: Designation is required`);
    if (isMissing(row.mobileNumber)) {
      errors.push(`Row ${lineNo}: Mobile Number is required`);
    } else if (!/^[0-9+\-\s]{10,15}$/.test(String(row.mobileNumber))) {
      errors.push(`Row ${lineNo}: Mobile Number '${row.mobileNumber}' is invalid`);
    }
    if (!isMissing(row.pinCode) && !/^\d{6}$/.test(String(row.pinCode))) {
      errors.push(`Row ${lineNo}: PIN Code must be a 6-digit number`);
    }
    if (isMissing(row.locality)) errors.push(`Row ${lineNo}: Village/Locality is required`);
    if (isMissing(row.mandal)) errors.push(`Row ${lineNo}: Mandal is required`);

    mapped.push({
      ...row,
      officerId: asString(row.officerId),
      officerName: asString(row.officerName),
      designation: asString(row.designation),
      mobileNumber: asString(row.mobileNumber),
      email: asString(row.email),
      houseNumber: asString(row.houseNumber),
      street: asString(row.street),
      locality: asString(row.locality),
      ward: asString(row.ward),
      mandal: asString(row.mandal),
      district: asString(row.district),
      pinCode: asString(row.pinCode),
    });
  });

  return {
    valid: errors.length === 0,
    missingColumns,
    errors,
    mapped,
    preview: mapped.slice(0, 50),
  };
}

function validateAndParseBooths(rows) {
  const errors = [];
  const seenIds = new Set();
  const mapped = [];

  if (!Array.isArray(rows) || rows.length === 0) {
    return { valid: false, missingColumns: [], errors: ['Excel file contains no data rows'], mapped: [] };
  }

  const headers = Object.keys(rows[0]).map(canonicalHeader);
  const missingColumns = REQUIRED_BOOTH_COLUMNS.filter(
    (col) => !headers.includes(canonicalHeader(col))
  );

  rows.forEach((rawRow, index) => {
    const row = mapRow(rawRow, BOOTH_MAP);
    if (Object.values(row).every((value) => isMissing(value))) return;
    const lineNo = index + 2;

    if (isMissing(row.boothId)) errors.push(`Row ${lineNo}: Booth ID is required`);
    else if (seenIds.has(row.boothId.trim().toUpperCase())) {
      errors.push(`Row ${lineNo}: Duplicate Booth ID '${row.boothId}' inside the file`);
    } else {
      seenIds.add(row.boothId.trim().toUpperCase());
    }

    if (isMissing(row.boothNumber)) errors.push(`Row ${lineNo}: Booth Number is required`);
    if (isMissing(row.boothName)) errors.push(`Row ${lineNo}: Booth Name is required`);
    if (isMissing(row.locality)) errors.push(`Row ${lineNo}: Village/Locality is required`);
    if (isMissing(row.mandal)) errors.push(`Row ${lineNo}: Mandal is required`);
    if (!isMissing(row.pinCode) && !/^\d{6}$/.test(String(row.pinCode))) {
      errors.push(`Row ${lineNo}: PIN Code must be a 6-digit number`);
    }
    let requiredOfficers = 4;
    try { const d = require('../models/Booth').DEFAULT_REQUIRED_OFFICERS; if (Number.isInteger(d) && d > 0) requiredOfficers = d; } catch (e) {}
    if (process.env.DEFAULT_REQUIRED_OFFICERS && Number.isInteger(Number(process.env.DEFAULT_REQUIRED_OFFICERS)) && Number(process.env.DEFAULT_REQUIRED_OFFICERS) > 0) { requiredOfficers = Number(process.env.DEFAULT_REQUIRED_OFFICERS); }
    if (!isMissing(row.requiredOfficers)) {
      const parsed = Number(row.requiredOfficers);
      if (Number.isNaN(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
        errors.push(`Row ${lineNo}: Required Officers must be a positive integer (or blank for default 4)`);
      } else { requiredOfficers = parsed; }
    }

    let minOfficers = 0;
    if (!isMissing(row.minOfficers)) {
      const parsedMin = Number(row.minOfficers);
      if (Number.isNaN(parsedMin) || parsedMin < 0 || !Number.isInteger(parsedMin)) {
        errors.push(`Row ${lineNo}: Minimum Officers must be a non-negative integer`);
      } else {
        minOfficers = parsedMin;
      }
    }
    if (minOfficers > requiredOfficers) {
      errors.push(`Row ${lineNo}: Minimum Officers cannot be greater than Required Officers`);
    }

    mapped.push({
      ...row,
      boothId: asString(row.boothId),
      boothNumber: asString(row.boothNumber),
      boothName: asString(row.boothName),
      buildingName: asString(row.buildingName),
      street: asString(row.street),
      locality: asString(row.locality),
      ward: asString(row.ward),
      mandal: asString(row.mandal),
      district: asString(row.district),
      pinCode: asString(row.pinCode),
      requiredOfficers,
      minOfficers,
    });
  });

  return {
    valid: errors.length === 0,
    missingColumns,
    errors,
    mapped,
    preview: mapped.slice(0, 50),
  };
}

async function saveOfficersFromRows(mappedRows) {
  let inserted = 0;
  let skipped = 0;
  const saved = [];

  for (const row of mappedRows) {
    const exists = await Officer.findOne({
      officerId: row.officerId.toUpperCase(),
    }).lean();
    if (exists) {
      skipped += 1;
      continue;
    }
    const officer = await Officer.create(row);
    saved.push(officer);
    inserted += 1;
  }
  return { inserted, skipped, count: saved.length, saved };
}

async function saveBoothsFromRows(mappedRows) {
  let inserted = 0;
  let skipped = 0;
  const saved = [];

  for (const row of mappedRows) {
    const exists = await Booth.findOne({ boothId: row.boothId.toUpperCase() }).lean();
    if (exists) {
      skipped += 1;
      continue;
    }
    const booth = await Booth.create(row);
    saved.push(booth);
    inserted += 1;
  }
  return { inserted, skipped, count: saved.length, saved };
}

function toXlsxBuffer(rows, sheetName = 'Sheet1') {
  const worksheet = XLSX.utils.json_to_sheet(rows.length ? rows : [{ Info: 'No data' }]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

/**
 * Builds a workbook from { sheetName, rows }[] so reports can export one sheet
 * per Mandal while keeping a single file download.
 */
function toWorkbookBuffer(sheets) {
  const workbook = XLSX.utils.book_new();
  (sheets || []).forEach((s) => {
    const worksheet = XLSX.utils.json_to_sheet((s.rows && s.rows.length ? s.rows : [{ Info: 'No data' }]));
    XLSX.utils.book_append_sheet(workbook, worksheet, String(s.sheetName || 'Sheet1'));
  });
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

function buildTemplate(kind) {
  const sampleRows =
    kind === 'officers'
      ? [
          {
            'Officer ID': 'OFF001',
            'Officer Name': 'Rama Rao',
            Designation: 'Assistant Engineer',
            'Mobile Number': '9876543210',
            Email: 'rama.rao@example.gov.in',
            'House Number': '12-3/4',
            Street: 'Main Road',
            'Village/Locality': 'Kothapeta',
            Ward: '5',
            Mandal: 'Pedarami Reddy Palli',
            District: 'Kurnool',
            'PIN Code': '518442',
          },
          {
            'Officer ID': 'OFF002',
            'Officer Name': 'Sita Devi',
            Designation: 'School Teacher',
            'Mobile Number': '9876500011',
            Email: 'sita.devi@example.gov.in',
            'House Number': '4-56',
            Street: 'Church Street',
            'Village/Locality': 'Gandhinagar',
            Ward: '8',
            Mandal: 'Pedarami Reddy Palli',
            District: 'Kurnool',
            'PIN Code': '518443',
          },
          {
            'Officer ID': 'OFF003',
            'Officer Name': 'Mohan Krishna',
            Designation: 'Revenue Inspector',
            'Mobile Number': '9701122334',
            Email: 'mohan.krishna@example.gov.in',
            'House Number': '7-89',
            Street: 'Temple Street',
            'Village/Locality': 'Rayadurgam',
            Ward: '12',
            Mandal: 'Pedarami Reddy Palli',
            District: 'Kurnool',
            'PIN Code': '518445',
          },
        ]
      : [
          {
            'Booth ID': 'BOOTH001',
            'Booth Number': '101',
            'Booth Name': 'MPP School Main Building',
            'Building Name': 'MPP School',
            Street: 'Church Street',
            'Village/Locality': 'Gandhinagar',
            Ward: '8',
            Mandal: 'Pedarami Reddy Palli',
            District: 'Kurnool',
            'PIN Code': '518443',
            'Required Officers': 3,
            'Minimum Officers': 1,
          },
          {
            'Booth ID': 'BOOTH002',
            'Booth Number': '102',
            'Booth Name': 'ZP High School Room 4',
            'Building Name': 'ZP High School',
            Street: 'Temple Street',
            'Village/Locality': 'Rayadurgam',
            Ward: '12',
            Mandal: 'Pedarami Reddy Palli',
            District: 'Kurnool',
            'PIN Code': '518445',
            'Required Officers': 2,
            'Minimum Officers': 1,
          },
          {
            'Booth ID': 'BOOTH003',
            'Booth Number': '103',
            'Booth Name': 'Panchayat Office Hall',
            'Building Name': 'Gram Panchayat Office',
            Street: 'Main Road',
            'Village/Locality': 'Kothapeta',
            Ward: '5',
            Mandal: 'Pedarami Reddy Palli',
            District: 'Kurnool',
            'PIN Code': '518442',
            'Required Officers': 2,
            'Minimum Officers': 1,
          },
        ];

  return toXlsxBuffer(sampleRows, kind === 'officers' ? 'Officers' : 'Booths');
}

async function officerReport(filter = {}) {
  const officers = await Officer.find(filter).sort({ officerId: 1 }).lean();
  const rows = officers.map((o) => ({
    'Officer ID': o.officerId,
    'Officer Name': o.officerName,
    Designation: o.designation,
    'Mobile Number': o.mobileNumber,
    Email: o.email,
    'House Number': o.houseNumber,
    Street: o.street,
    'Village/Locality': o.locality,
    Ward: o.ward,
    Mandal: o.mandal,
    District: o.district,
    'PIN Code': o.pinCode,
  }));
  return toXlsxBuffer(rows, 'Officers');
}

async function boothReport(filter = {}) {
  const booths = await Booth.find(filter).sort({ boothId: 1 }).lean();
  // Live allocated counts (source of truth = ACTIVE allocation documents) so
  // the report never trusts a stale stored booth counter.
  const liveMap = await countService.computeBoothCountsMap();
  const rows = booths.map((b) => {
    const required = Math.max(0, Number(b.requiredOfficers) || 0);
    const allocated = Math.min(liveMap.get(String(b._id)) || 0, required);
    return {
      'Booth ID': b.boothId,
      'Booth Number': b.boothNumber,
      'Booth Name': b.boothName,
      'Building Name': b.buildingName,
      Street: b.street,
      'Village/Locality': b.locality,
      Ward: b.ward,
      Mandal: b.mandal,
      District: b.district,
      'PIN Code': b.pinCode,
      'Required Officers': required,
      'Allocated Officers': allocated,
      'Vacant Slots': Math.max(0, required - allocated),
    };
  });
  return toXlsxBuffer(rows, 'Booths');
}

/**
 * Shared row builder: officer details + allocated booth details + capacity.
 * Used by both the flat and the mandal-wise allocation reports so the columns
 * and ordering are always identical.
 */
function rowForAllocation(a) {
  const required = Math.max(0, Number(a.booth?.requiredOfficers) || 0);
  const allocated = Math.max(0, Number(a.booth?.allocatedOfficerCount) || 0);
  return {
    'Officer ID': a.officer?.officerId || '',
    'Officer Name': a.officer?.officerName || '',
    Designation: a.officer?.designation || '',
    'Mobile Number': a.officer?.mobileNumber || '',
    'Officer House No': a.officer?.houseNumber || '',
    'Officer Street': a.officer?.street || '',
    'Officer Locality': a.officer?.locality || '',
    'Officer Ward': a.officer?.ward || '',
    'Officer Mandal': a.officer?.mandal || '',
    'Booth Number': a.booth?.boothNumber || '',
    'Booth Name': a.booth?.boothName || '',
    'Booth Building': a.booth?.buildingName || '',
    'Booth Street': a.booth?.street || '',
    'Booth Locality': a.booth?.locality || '',
    'Booth Ward': a.booth?.ward || '',
    'Booth Mandal': a.booth?.mandal || '',
    'Required Officers': required,
    'Allocated Officers': allocated,
    'Available Slots': Math.max(0, required - allocated),
    'Allocation Status': a.status,
    'Address Match Score': a.addressMatchScore,
    'Allocation Date': a.allocationDate ? new Date(a.allocationDate).toISOString() : '',
  };
}

async function allocationReport(filter = {}) {
  const allocations = await getAllocationRowsForReport({
    status: 'ALLOCATED',
    booth: { $ne: null },
    ...filter,
  });
  const rows = allocations
    .sort((x, y) => compareOfficerIds(x.officer?.officerId, y.officer?.officerId))
    .map(rowForAllocation);
  return toXlsxBuffer(rows, 'Allocations');
}

/**
 * Allocation details for ALL Mandals in a SINGLE Excel sheet.
 * Every row carries its own 'Officer Mandal' / 'Booth Mandal' columns so the
 * Mandal is never lost, and the whole sheet is sorted by Officer ID ascending
 * so the officer list is easy to scan in one place.
 */
async function allocationReportByMandal(filter = {}) {
  const allocations = await getAllocationRowsForReport({
    status: 'ALLOCATED',
    booth: { $ne: null },
    ...filter,
  });
  const rows = allocations
    .sort((x, y) => compareOfficerIds(x.officer?.officerId, y.officer?.officerId))
    .map(rowForAllocation);
  return toXlsxBuffer(rows, 'All Allocations');
}

/**
 * Single-Mandal downloadable allocated-officers list.
 * `mandalName` is matched case-insensitively (and trim-insensitive) so that
 * "Jami", "jami" and " JAMI " all resolve to the same Mandal.
 */
async function allocatedOfficersReportForMandal(filter = {}, mandalName = '') {
  const target = String(mandalName || '').trim().toLowerCase();
  const base = await getAllocationRowsForReport({
    status: 'ALLOCATED',
    booth: { $ne: null },
    ...filter,
  });
  const matched = base.filter((a) => {
    const m = (a.officer?.mandal || a.mandal || '').trim().toLowerCase();
    return m === target;
  });
  const rows = matched
    .sort((x, y) => compareOfficerIds(x.officer?.officerId, y.officer?.officerId))
    .map(rowForAllocation);
  return toXlsxBuffer(rows, `Allocated_${String(mandalName || 'mandal').replace(/[^a-z0-9]/gi, '_').slice(0, 20) || 'mandal'}`);
}

async function unallocatedOfficersReport(filter = {}) {
  const Officer = require('../models/Officer');
  const Allocation = require('../models/Allocation');
  const allocated = await Allocation.find({ status: 'ALLOCATED' }).select('officer').lean();
  const allocatedIds = new Set(allocated.map((a) => String(a.officer)));
  const officers = await Officer.find(filter).sort({ officerId: 1 }).lean();
  const rows = officers
    .filter((o) => !allocatedIds.has(String(o._id)))
    .map((o) => ({
      'Officer ID': o.officerId || '',
      'Officer Name': o.officerName || '',
      Designation: o.designation || '',
      'Mobile Number': o.mobileNumber || '',
      'Officer Locality': o.locality || '',
      'Officer Ward': o.ward || '',
      Mandal: o.mandal || '',
      District: o.district || '',
      'PIN Code': o.pinCode || '',
      Status: 'UNALLOCATED',
      Reason: 'No active ALLOCATED allocation',
    }));
  return toXlsxBuffer(rows, 'Unallocated Officers');
}

async function notificationReport(filter = {}) {
  const notifications = await Notification.find(filter)
    .populate('officer')
    .sort({ createdAt: -1 })
    .lean();
  const rows = notifications.map((n) => ({
    'Officer ID': n.officer?.officerId || '',
    'Officer Name': n.officer?.officerName || '',
    'Mobile Number': n.mobileNumber,
    Mandal: n.mandal || n.officer?.mandal || '',
    Status: n.status,
    Provider: n.provider,
    'Provider Message ID': n.providerMessageId || '',
    'Sent At': n.sentAt ? new Date(n.sentAt).toISOString() : '',
    Error: n.error || '',
  }));
  return toXlsxBuffer(rows, 'Notifications');
}

async function getAllocationRowsForReport(filter = {}) {
  const Allocation = require('../models/Allocation');
  return Allocation.find(filter)
    .populate('officer')
    .populate('booth')
    .sort({ allocationDate: -1 })
    .lean();
}

module.exports = {
  OFFICER_COLUMNS,
  BOOTH_COLUMNS,
  OFFICER_MAP,
  BOOTH_MAP,
  isMissing,
  asString,
  mapRow,
  validateAndParseOfficers,
  validateAndParseBooths,
  saveOfficersFromRows,
  saveBoothsFromRows,
  toXlsxBuffer,
  buildTemplate,
    officerReport,
  boothReport,
  allocationReport,
  allocationReportByMandal,
  allocatedOfficersReportForMandal,
  unallocatedOfficersReport,
  notificationReport,
};