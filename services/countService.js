/**
 * countService.js
 * ================
 * Single source of truth for booth capacity counters.
 *
 * MongoDB allocation records are the authority: allocatedOfficerCount is
 * ALWAYS recomputed from the live Allocation documents (status ALLOCATED)
 * and availableSlots is derived as requiredOfficers - allocatedOfficerCount.
 *
 * Never trust previously stored booth counters (they can be corrupted by
 * failed runs) - always recalculate via this service.
 */

const Allocation = require('../models/Allocation');
const Booth = require('../models/Booth');

const ACTIVE_STATUS = 'ALLOCATED';

async function computeBoothCountsMap() {
  const rows = await Allocation.aggregate([
    { $match: { status: ACTIVE_STATUS, booth: { $ne: null } } },
    { $group: { _id: '$booth', count: { $sum: 1 } } },
  ]);
  const map = new Map();
  rows.forEach((r) => map.set(String(r._id), r.count));
  return map;
}

async function getLiveAllocatedCount(boothId) {
  if (!boothId) return 0;
  return Allocation.countDocuments({ booth: boothId, status: ACTIVE_STATUS });
}

async function recalculateBoothCounts(boothId) {
  if (!boothId) return 0;
  const booth = await Booth.findById(boothId);
  if (!booth) return 0;
  const rawReq = Number(booth.requiredOfficers);
  const required = Number.isInteger(rawReq) && rawReq > 0 ? rawReq : 4;
  const allocated = Math.min(await getLiveAllocatedCount(booth._id), required);
  if (booth.requiredOfficers !== required) { try { await Booth.updateOne({ _id: booth._id }, { $set: { requiredOfficers: required } }); } catch (e) {} }
  const availableSlots = Math.max(0, required - allocated);
  await Booth.updateOne(
    { _id: booth._id },
    { $set: { allocatedOfficerCount: allocated, availableSlots } }
  );
  return allocated;
}

async function resyncAllBoothCounts() {
  const map = await computeBoothCountsMap();
  const booths = await Booth.find({}).select('_id requiredOfficers allocatedOfficerCount availableSlots').lean();
  let updated = 0;
  for (const booth of booths) {
    const required = Math.max(0, booth.requiredOfficers || 0);
    const allocated = Math.min(map.get(String(booth._id)) || 0, required);
    const availableSlots = Math.max(0, required - allocated);
    if (booth.allocatedOfficerCount !== allocated || booth.availableSlots !== availableSlots) {
      await Booth.updateOne(
        { _id: booth._id },
        { $set: { allocatedOfficerCount: allocated, availableSlots } }
      );
      updated += 1;
    }
  }
  return { booths: booths.length, updated };
}

module.exports = {
  ACTIVE_STATUS,
  computeBoothCountsMap,
  getLiveAllocatedCount,
  recalculateBoothCounts,
  resyncAllBoothCounts,
};
