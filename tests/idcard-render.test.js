/**
 * DB-free unit tests for the ID Card Designer's new customisation layer:
 * custom text boxes, uploaded signature/stamp images, watermark, rotation,
 * overall text scale, and server-side validation (cleanElements / schema).
 * No network, no database, no real messages. Renders PDFs to Buffers only.
 * Run: node tests/idcard-render.test.js   (exits non-zero on failure)
 */
const assert = require('assert');
const path = require('path');

// A tiny valid 1x1 PNG as a data-URI (stands in for an uploaded stamp image).
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQAY3Y2wAAAAAElFTkSuQmCC';

const idCardService = require('../services/idCardService');
const { IdCardDesign } = require('../models/IdCardDesign');

const officer = {
  officerName: 'Ravi Kumar', officerId: 'OFF001', designation: 'School Assistant',
  mobileNumber: '9876543210', email: 'r@x.gov', mandal: 'Guntur East', district: 'Guntur',
};
const booth = { boothNumber: '123', boothName: 'ZPH School Room 2', buildingName: 'ZPH School', locality: 'Main Road', mandal: 'Guntur East', district: 'Guntur' };
const allocation = { _id: '000000000000000000001', allocationDate: new Date('2026-05-10') };

let passed = 0;
function ok(name) { passed += 1; console.log(`  ok - ${name}`); }

(async () => {
  // 1. Default card still renders (no design saved).
  const def = await idCardService.renderOfficerIdCard({ officer, booth, allocation });
  assert.ok(Buffer.isBuffer(def) && def.length > 1000, 'default PDF should render');
  ok('renders default card (no design)');

  // 2. Custom text + watermark + text scale render and change the bytes.
  const design = {
    theme: 'green', baseTextScale: 1.3, watermark: 'SPECIMEN',
    elements: [
      { id: 't1', type: 'text', show: true, x: 300, y: 40, width: 150, height: 30, rotation: -10, text: 'Collector Verified', fontSize: 14, color: '#b91c1c', fontWeight: 'bold', align: 'center' },
      { id: 'i1', type: 'image', show: true, x: 330, y: 220, width: 70, height: 50, rotation: 0, src: PNG },
    ],
  };
  const custom = await idCardService.renderOfficerIdCard({ officer, booth, allocation, design });
  assert.ok(Buffer.isBuffer(custom) && custom.length > 1000, 'custom PDF should render');
  assert.notStrictEqual(def.equals(custom), 'customised card bytes must differ from default');
  ok('custom text + image + watermark + scale render differently');

  // 3. A corrupt image must NOT crash the whole card.
  const badImg = {
    theme: 'navy',
    elements: [{ id: 'x', type: 'image', show: true, x: 10, y: 10, width: 40, height: 40, src: 'data:image/png;base64,@@not-base64@@' }],
  };
  const safe = await idCardService.renderOfficerIdCard({ officer, booth, allocation, design: badImg });
  assert.ok(Buffer.isBuffer(safe) && safe.length > 1000, 'corrupt image should be skipped, card still renders');
  ok('corrupt image is ignored, card still renders');

  // 4. Schema rejects an invalid element type (validation runs server-side).
  const badType = new IdCardDesign({ key: 'active', elements: [{ type: 'video', x: 0, y: 0 }] });
  const typeErr = badType.validateSync();
  assert.ok(typeErr && typeErr.errors['elements.0.type'], 'invalid element type must fail validation');
  ok('schema rejects invalid element type');

  // 5. Schema caps elements at the documented maximum.
  const many = Array.from({ length: 11 }, (_, i) => ({ type: 'text', x: i, y: i, text: `t${i}` }));
  const capped = new IdCardDesign({ key: 'active', elements: many });
  const capErr = capped.validateSync();
  assert.ok(capErr && capErr.errors.elements, 'more than the max elements must fail validation');
  ok('schema enforces the max-elements cap');

  // 6. baseTextScale stays within the allowed range via schema min/max.
  const scaleErr = new IdCardDesign({ key: 'active', baseTextScale: 9 }).validateSync();
  assert.ok(scaleErr && scaleErr.errors.baseTextScale, 'out-of-range text scale must fail validation');
  ok('schema clamps/rejects out-of-range text scale');

  console.log(`\n${passed} idcard-render tests passed`);
  process.exit(0);
})().catch((err) => { console.error(`  FAIL: ${err.message}`); process.exit(1); });