/* One-off cleanup for the delete-cascade verification leftovers. */
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/polling_system');
  const Officer = require('../models/Officer');
  const Booth = require('../models/Booth');
  const Allocation = require('../models/Allocation');

  const officers = await Officer.find({ officerId: 'DC-O1' }).lean();
  const booths = await Booth.find({ boothId: 'DC-B1' }).lean();
  const offIds = officers.map((o) => o._id);
  const boothIds = booths.map((b) => b._id);

  let allocs = 0;
  if (offIds.length || boothIds.length) {
    const or = [];
    if (offIds.length) or.push({ officer: { $in: offIds } });
    if (boothIds.length) or.push({ booth: { $in: boothIds } });
    const res = await Allocation.deleteMany({ $or: or });
    allocs = res.deletedCount || 0;
  }
  const o = await Officer.deleteMany({ officerId: 'DC-O1' });
  const b = await Booth.deleteMany({ boothId: 'DC-B1' });
  console.log(
    `cleanup: removed ${o.deletedCount} officer(s), ${b.deletedCount} booth(s), ${allocs} allocation(s)`
  );
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});