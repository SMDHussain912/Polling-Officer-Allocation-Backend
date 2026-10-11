/**
 * verify-capacity-and-sorting.js
 * ==============================
 * Direct (no HTTP) verification of the STRICT BOOTH CAPACITY rules and the
 * numeric Officer ID ordering, run against an ISOLATED test database so real
 * data is never touched.
 *
 * Covers the acceptance tests:
 *   1. Booth required=3, 5 eligible officers -> only 3 ever allocated (3/3).
 *   2. Allocating a 4th officer to a full booth is REJECTED.
 *   3. Cancel one allocation (3/3 -> 2/3) then allocate again (-> 3/3, never 4/3).
 *   4. Officer IDs OFF1, OFF10, OFF2, OFF25, OFF3 sort to OFF1..OFF3..OFF10..OFF25.
 *   5. Reallocation frees the old booth slot and fills the new booth slot.
 *   6. Stored booth counters always match the ACTIVE allocation documents.
 *
 * Run: node scripts/verify-capacity-and-sorting.js
 *      (uses MONGODB_URI_TEST or default mongodb://127.0.0.1:27017/polling_system_capacity_test)
 */

const TEST_URI =
  process.env.MONGODB_URI_TEST || 'mongodb://127.0.0.1:27017/polling_system_capacity_test';

let passed = 0;
function check(name, condition, detail = '') {
  if (!condition) throw new Error(`${name} :: ${detail}`);
  passed += 1;
  console.log(`  PASS  ${name}${detail ? `  [${detail}]` : ''}`);
}

async function expectRejected(label, fn, statusCode) {
  try {
    await fn();
    throw new Error(`${label} :: expected a ${statusCode} error but the call SUCCEEDED`);
  } catch (error) {
    if (String(error.statusCode || 500) !== String(statusCode)) throw error;
    passed += 1;
    console.log(`  PASS  ${label}  [rejected ${statusCode}: ${error.message}]`);
  }
}

(async () => {
  const mongoose = require('mongoose');
  await mongoose.connect(TEST_URI);
  const db = mongoose.connection;
  await db.dropDatabase();

  const Officer = require('../models/Officer');
  const Booth = require('../models/Booth');
  const Allocation = require('../models/Allocation');
  const countService = require('../services/countService');
  const allocationService = require('../services/allocationService');
  const { compareOfficerIds } = require('../services/sortUtil');

  try {
    // ---------------------------------------------------------------- SEED ----
    const MANDAL = 'CapacityMandal';
    const booth1 = await Booth.create({
      boothId: 'PB-TEST', boothNumber: '901', boothName: 'Test Booth PB101',
      street: '', locality: 'CapBoothLoc', ward: '1', mandal: MANDAL,
      district: 'D', pinCode: '500010', requiredOfficers: 3, minOfficers: 1,
      isActive: true, allocatedOfficerCount: 0,
    });
    // PB-ALT is created LATER (after the bulk run) on purpose: while the bulk
    // run executes, PB-TEST is the ONLY eligible booth, so exactly 3 of the 5
    // officers fit and the 4th/5th must be skipped by capacity. PB-ALT is used
    // afterwards to prove reallocation moves a slot correctly.
    let booth2 = null;

    const officerIds = ['OFF1', 'OFF2', 'OFF3', 'OFF9', 'OFF10'];
    await Promise.all(
      officerIds.map((id, i) =>
        Officer.create({
          officerId: id,
          officerName: `Officer ${id}`,
          designation: 'TA',
          mobileNumber: `9300000${String(i + 1).padStart(3, '0')}`,
          street: '', locality: `CapLoc${i + 1}`, ward: `${i + 1}`, mandal: MANDAL,
          district: 'D', isActive: true,
        })
      )
    );
    check('seeded booth required=3 (PB-TEST)',
      booth1.requiredOfficers === 3,
      `PB-TEST=${booth1.requiredOfficers}`);

    // ------------------------------------------------- TEST CASE 4: sorting ----
    const unsorted = ['OFF1', 'OFF10', 'OFF2', 'OFF25', 'OFF3'];
    const sortedExpect = ['OFF1', 'OFF2', 'OFF3', 'OFF10', 'OFF25'];
    const sortedIds = [...unsorted].sort(compareOfficerIds);
    check('numeric Officer ID sort: OFF1,OFF10,OFF2,OFF25,OFF3 -> numeric ascending',
      JSON.stringify(sortedIds) === JSON.stringify(sortedExpect),
      sortedIds.join(', '));
    const prefixed = ['OFF001', 'OFF002', 'OFF010', 'OFF100'].sort(compareOfficerIds);
    check('numeric sort handles zero-padded IDs OFF001..OFF100',
      prefixed[0] === 'OFF001' && prefixed[1] === 'OFF002' && prefixed[2] === 'OFF010' && prefixed[3] === 'OFF100',
      prefixed.join(', '));

    // ----------------------------------------- TEST CASE 1: bulk capacity -------
    // 5 eligible officers but PB-TEST requires only 3 -> exactly 3 allocated.
    const run = await allocationService.runAllocation();
    const liveB1 = await Allocation.countDocuments({ booth: booth1._id, status: 'ALLOCATED' });
    check('automatic run allocates ONLY 3 officers to a required=3 booth',
      run.allocated === 3 && liveB1 === 3,
      `run.allocated=${run.allocated}, live PB-TEST=${liveB1}/3`);

    const b1AfterRun = await Booth.findById(booth1._id).lean();
    check('stored booth counter refreshed from ACTIVE allocations (3/3)',
      b1AfterRun.allocatedOfficerCount === 3 && b1AfterRun.availableSlots === 0,
      `counter=${b1AfterRun.allocatedOfficerCount}, slots=${b1AfterRun.availableSlots}`);

    const perOfficer = await Allocation.aggregate([
      { $match: { status: 'ALLOCATED' } },
      { $group: { _id: '$officer', n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
    ]);
    check('no officer holds more than one ACTIVE allocation', perOfficer.length === 0);

    const allocatedRows = await Allocation.find({ status: 'ALLOCATED' }).select('officer').lean();
    const unallocatedOfficers = await Officer.find({
      _id: { $nin: allocatedRows.map((a) => a.officer) },
    }).lean();
    check('the 2 remaining eligible officers were NOT allocated', unallocatedOfficers.length === 2);

    // ----------------------------- TEST CASE 2: manual allocate to full booth ---
    const waitingOfficer = unallocatedOfficers[0];
    await expectRejected(
      'manual allocate a 4th officer to a 3/3 booth is rejected',
      () => allocationService.manualAllocate(waitingOfficer.officerId, 'PB-TEST'),
      409
    );

    // --------------- TEST CASE 3: cancel (3/3 -> 2/3) then allocate again -------
    const oneAlloc = await Allocation.findOne({ booth: booth1._id, status: 'ALLOCATED' });
    await allocationService.cancelAllocation(oneAlloc._id);
    const liveAfterCancel = await countService.getLiveAllocatedCount(booth1._id);
    check('cancel reduces the booth count 3/3 -> 2/3', liveAfterCancel === 2, `live=${liveAfterCancel}`);

    const cancelledDoc = await Booth.findById(booth1._id).lean();
    check('cancelled allocation no longer counts toward booth capacity',
      cancelledDoc.allocatedOfficerCount === 2 && cancelledDoc.availableSlots === 1,
      `counter=${cancelledDoc.allocatedOfficerCount}, slots=${cancelledDoc.availableSlots}`);

    await allocationService.manualAllocate(waitingOfficer.officerId, 'PB-TEST');
    const liveAfterReuse = await countService.getLiveAllocatedCount(booth1._id);
    check('freed slot can be reused: 2/3 -> 3/3 (never 4/3)', liveAfterReuse === 3, `live=${liveAfterReuse}`);

    const fifthOfficer = (await Officer.findOne({ officerId: 'OFF9' }))._id;
    const fifth = await Officer.findById(fifthOfficer).lean();
    await expectRejected(
      'a 4th manual allocate after 3/3 is rejected again',
      () => allocationService.manualAllocate(fifth.officerId, 'PB-TEST'),
      409
    );

    // ---------------- TEST CASE 5: reallocation updates old + new booth counts ---
    // Add the alternative booth now - it is in the same Mandal so it becomes a
    // valid reallocation target with 2 free slots.
    booth2 = await Booth.create({
      boothId: 'PB-ALT', boothNumber: '902', boothName: 'Alternative Booth',
      street: '', locality: 'CapBoothLoc2', ward: '2', mandal: MANDAL,
      district: 'D', pinCode: '500010', requiredOfficers: 2, minOfficers: 0,
      isActive: true, allocatedOfficerCount: 0,
    });
    const activeAlloc = await Allocation.findOne({ booth: booth1._id, status: 'ALLOCATED' });
    const realloc = await allocationService.reallocateOfficer(activeAlloc._id, null);
    const oldLive = await countService.getLiveAllocatedCount(booth1._id);
    const newLive = await countService.getLiveAllocatedCount(booth2._id);
    check('reallocation frees the old booth slot (3 -> 2) and fills the new booth (0 -> 1)',
      oldLive === 2 && newLive === 1 && String(realloc.newAllocation.booth) === String(booth2._id),
      `old=${oldLive}, new=${newLive}`);

    // ---------------- TEST CASE 6: stored counters == ACTIVE documents ----------
    await countService.resyncAllBoothCounts();
    const booths = await Booth.find({}).lean();
    for (const b of booths) {
      const live = await countService.getLiveAllocatedCount(b._id);
      check(`stored counter matches ACTIVE allocations for ${b.boothId} (${live}/${b.requiredOfficers})`,
        b.allocatedOfficerCount === live && b.availableSlots === Math.max(0, b.requiredOfficers - live),
        `counter=${b.allocatedOfficerCount}, slots=${b.availableSlots}, live=${live}, required=${b.requiredOfficers}`);
    }

    console.log(`\nRESULT: ${passed} passed`);
  } finally {
    try {
      await db.dropDatabase();
    } catch { /* ignore */ }
    try {
      await mongoose.disconnect();
    } catch { /* ignore */ }
    console.log('cleanup: dropped isolated test database');
  }
})().catch((error) => {
  console.error('FATAL', error);
  process.exit(1);
});