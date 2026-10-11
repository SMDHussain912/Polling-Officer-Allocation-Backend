/**
 * Offline verification for the PDF ID-card pipeline (no server, no database):
 *   1. renders a REAL pdfkit card from fixture data and inspects the bytes
 *   2. checks the card URL builder
 *   3. checks the mail MIME builder (plain + multipart with PDF attachment)
 *   4. checks the short allocation mail (mandal + download link, no details)
 *   5. checks the SMS builder with a card download link
 * A sample PDF is written to the OS temp dir for manual inspection.
 *
 * Usage: node scripts/verify-id-card.js   (exit code 0 = all checks passed)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const os = require('os');
const path = require('path');
const idCardService = require('../services/idCardService');
const mailService = require('../services/mailService');
const smsService = require('../services/smsService');

let passed = 0;
let failed = 0;

function check(name, condition, extra = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}${extra ? ` (${extra})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}${extra ? ` (${extra})` : ''}`);
  }
}

// ---- fixtures (mimic populated Allocation documents) ------------------------
const officer = {
  _id: '5f8d0d55b54764421b7156da',
  officerId: 'OFF001',
  officerName: 'Anita Rani Sharma',
  designation: 'AE (WRD), RWS',
  mobileNumber: '+91 98765 43210',
  email: 'anita.sharma@example.com',
  houseNo: '8-2-120',
  street: 'Station Road',
  locality: 'Kondapur',
  ward: '12',
  mandal: 'Serilingampally',
  district: 'Rangareddy',
  pinCode: '500084',
};
const booth = {
  boothNumber: '142',
  boothName: 'Govt Primary School',
  buildingName: 'Govt Primary School Block-A',
  locality: 'Kondapur',
  ward: '12',
  mandal: 'Serilingampally',
  district: 'Rangareddy',
};
const allocation = {
  _id: '507f1f77bcf86cd799439011',
  allocationDate: new Date(),
  mandal: 'Serilingampally',
  status: 'ALLOCATED',
};

(async () => {
  console.log('\n[1] ID card PDF rendering (pdfkit)');
  const pdf = await idCardService.renderOfficerIdCard({ officer, booth, allocation });
  check('PDF magic bytes (%PDF-)', pdf.subarray(0, 5).toString() === '%PDF-');
  check('PDF size in sane range', pdf.length > 2000 && pdf.length < 500000, `${pdf.length} bytes`);
  check('PDF ends with %%EOF', pdf.subarray(-64).includes('%%EOF'));
  const tmpPdf = path.join(os.tmpdir(), 'sample-id-card.pdf');
  fs.writeFileSync(tmpPdf, pdf);
  check('sample card written to temp dir', fs.existsSync(tmpPdf), tmpPdf);

  console.log('\n[2] Card URL builder');
  const url = idCardService.publicCardUrl({
    _id: '665f1f77bcf86cd7994390ab',
    downloadToken: 'tok'.repeat(16),
  });
  check(
    'URL shape /api/idcards/pdf/<id>?token=<token>',
    url.includes('/api/idcards/pdf/665f1f77bcf86cd7994390ab?token=') &&
      url.endsWith('tok'.repeat(16)),
    url
  );

  console.log('\n[3] Mail MIME builder');
  const marker = Buffer.from(pdf).toString('base64').slice(0, 60);
  const mime = mailService.buildMimeMessage({
    to: officer.email,
    subject: 'Polling Duty Allocation',
    text: 'Dear officer, see attachment.',
    attachments: [{ filename: 'ID-Card-OFF001.pdf', buffer: pdf, contentType: 'application/pdf' }],
  });
  check('multipart/mixed when attachments present', mime.includes('multipart/mixed'));
  check('attachment filename declared', mime.includes('ID-Card-OFF001.pdf'));
  check('Content-Disposition attachment', mime.includes('Content-Disposition: attachment'));
  check('PDF base64 payload embedded', mime.includes(marker));
  check('message ends with closing boundary', mime.trimEnd().endsWith('--'));
  const plain = mailService.buildMimeMessage({ to: 'a@b.c', subject: 's', text: 'hello' });
  check(
    'plain text path preserved (no attachment)',
    plain.includes('Content-Type: text/plain') && !plain.includes('multipart/mixed')
  );

  console.log('\n[4] Short allocation mail (mandal + download link only)');
  const letter = mailService.buildAllocationLetter(
    { officer, booth, mandal: 'Serilingampally', allocationDate: allocation.allocationDate },
    { cardUrl: url }
  );
  check(
    'mentions the allocated mandal',
    /allocated for election \(polling\) duty in Serilingampally mandal/i.test(letter)
  );
  check('contains the tokenised card download link', letter.includes('/api/idcards/pdf/'));
  check(
    'no booth details any more',
    !letter.includes('Booth Number:') && !letter.includes('Booth Name:')
  );
  check('no officer details any more', !letter.includes('Officer ID:'));
  check('no "attached" wording any more', !/attached/i.test(letter));
  const letterNoUrl = mailService.buildAllocationLetter({
    officer,
    booth,
    mandal: 'Serilingampally',
  });
  check(
    'graceful wording when the card URL is not ready yet',
    letterNoUrl.includes('download link will be shared with you shortly')
  );

  console.log('\n[5] SMS message builder with card link');
  const sms = smsService.buildAllocationMessage(officer, booth, { cardUrl: url });
  check('SMS contains the card link', sms.includes('/api/idcards/pdf/'));
  check('SMS keeps booth details', sms.includes('Booth Number: 142'));
  const smsNoCard = smsService.buildAllocationMessage(officer, booth);
  check(
    'SMS unchanged without options (backward compatible)',
    !smsNoCard.includes('/api/idcards/')
  );

  console.log(`\nID-card verify: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
  console.log('ALL CASES PASSED');
})().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
