/**
 * cleanup-e2e.js
 * ==============
 * Removes every document created by scripts/e2e-test.js so the database is
 * left pristine for real usage. Safe to run at any time - it only touches
 * records whose IDs start with OFF-E2E / BOOTH-E2E.
 *
 * Run: node scripts/cleanup-e2e.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Officer = require('../models/Officer');
const Booth = require('../models/Booth');
const Allocation = require('../models/Allocation');
const Notification = require('../models/Notification');

const OFFICER_ID = /^OFF-E2E-/i;
const BOOTH_ID = /^BOOTH-E2E-/i;

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/polling_system');
  console.log('[cleanup] connected');

  // E2E officers and booths by their business IDs.
  const officers = await Officer.find({ officerId: { $regex: OFFICER_ID } }).select('_id');
  const booths = await Booth.find({ boothId: { $regex: BOOTH_ID } }).select('_id');
  const officerIds = officers.map((o) => o._id);
  const boothIds = booths.map((b) => b._id);

  const allocFilter = {
    $or: [{ officer: { $in: officerIds } }, { booth: { $in: boothIds } }],
  };

  const n = await Notification.deleteMany({ officer: { $in: officerIds } });
  const a = await Allocation.deleteMany(allocFilter);
  const o = await Officer.deleteMany({ _id: { $in: officerIds } });
  const b = await Booth.deleteMany({ _id: { $in: boothIds } });

  console.log(
    `[cleanup] removed: ${n.deletedCount} notifications, ${a.deletedCount} allocations, ` +
      `${o.deletedCount} officers, ${b.deletedCount} booths`
  );

  await mongoose.disconnect();
  console.log('[cleanup] done - database is pristine');
  process.exit(0);
})().catch((error) => {
  console.error('[cleanup] failed:', error.message);
  process.exit(1);
});
