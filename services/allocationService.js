const mongoose = require('mongoose');
const Officer = require('../models/Officer');
const Booth = require('../models/Booth');
const Allocation = require('../models/Allocation');
const countService = require('./countService');
const {
  normalizeAddress,
  isRelated,
  compatibilityReason,
  mandalKey,
  addressSimilarityScore,
} = require('./addressMatchingService');

function strictAddressMode() {
  const raw = process.env.STRICT_ADDRESS_MODE;
  if (raw === undefined || raw === null || String(raw).trim() === '') return true;
  const v = String(raw).trim().toLowerCase();
  return !(v === 'false' || v === '0' || v === 'no' || v === 'off');
}
function fallbackAllowed() {
  const raw = process.env.ALLOW_FALLBACK_ALLOCATION;
  if (raw === undefined || raw === null || String(raw).trim() === '') return true;
  const v = String(raw).trim().toLowerCase();
  return !(v === 'false' || v === '0' || v === 'no' || v === 'off');
}
function defaultRequiredOfficers() {
  try {
    const d = require('../models/Booth').DEFAULT_REQUIRED_OFFICERS;
    if (Number.isInteger(d) && d > 0) return d;
  } catch (e) {}
  const e = Number(process.env.DEFAULT_REQUIRED_OFFICERS);
  if (Number.isInteger(e) && e > 0) return e;
  return 4;
}


const STATUS = {
  ALLOCATED: 'ALLOCATED',
  CANCELLED: 'CANCELLED',
  REALLOCATED: 'REALLOCATED',
};

const RUN_LIMIT = { MIN: 1, MAX: 1000000, DEFAULT: null };

let runInProgress = false;

function makeAllocationId(officer) {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(
    d.getDate()
  ).padStart(2, '0')}`;
  return `ALLOC-${ymd}-${String(officer.officerId || '').toUpperCase()}`;
}

async function nextAllocationId(officer) {
  const base = makeAllocationId(officer);
  let candidate = base;
  let n = 2;
  while ((await Allocation.exists({ allocationId: candidate })) && n < 100) {
    candidate = `${base}-R${n}`;
    n += 1;
  }
  return candidate;
}

function groupBy(list, keyFn) {
  const map = new Map();
  list.forEach((item) => {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  });
  return map;
}

function boothCapacity(booth) {
  const rawMax = Number(booth && booth.requiredOfficers);
  const max = Number.isInteger(rawMax) && rawMax > 0 ? rawMax : defaultRequiredOfficers();
  const min = Math.min(Math.max(0, Number(booth.minOfficers) || 0), max);
  return { min, max };
}

/**
 * STRICT BOOTH CAPACITY GUARD (backend hard rule).
 * --------------------------------------------------
 * Before ANY allocation is created - bulk, manual or reallocation - the booth
 * must still have a free position. The source of truth is the ACTIVE
 * (`ALLOCATED`) allocation documents, NEVER the possibly-stale stored booth
 * counter:
 *
 *   1. find the booth
 *   2. required = booth.requiredOfficers
 *   3. live = count of ACTIVE/ALLOCATED allocations for the booth
 *   4. if live >= required  -> reject/skip (booth is FULL)
 *   5. only then may a new allocation be created
 *
 * Cancelled / reallocated allocations are NOT counted, so cancelling an
 * officer frees the slot immediately.
 */
async function assertBoothHasCapacity(boothId, label = 'Booth') {
  const booth = await Booth.findById(boothId).lean();
  if (!booth) {
    const error = new Error(`${label} not found`);
    error.statusCode = 404;
    throw error;
  }
  const cap = boothCapacity(booth);
  const live = await countService.getLiveAllocatedCount(booth._id);
  if (live >= cap.max) {
    const error = new Error(
      `${label} has no available capacity (${live}/${cap.max} already allocated - maximum is ${cap.max})`
    );
    error.statusCode = 409;
    throw error;
  }
  return { booth, live, cap };
}

function scoreSuitability(officer, booth, capacity) {
  const check = isRelated(officer, booth);
  if (check.related) return { suitable: false, score: -Infinity, check };

  let score = 0;
  const cap = boothCapacity(booth);
  const current = Math.max(0, Number(booth.allocatedOfficerCount) || 0);

  // Booths that still need their minimum officers get top priority.
  if (current < cap.min) {
    score += 5000 + 100 * (cap.min - current);
  }

  // Balanced distribution: the lower the current occupancy the higher the score.
  score += Math.max(0, 1000 - current * 100);

  const officerWard = normalizeAddress(officer.ward);
  const boothWard = normalizeAddress(booth.ward);
  if (officerWard && boothWard && officerWard !== boothWard) score += 10;

  score += Math.min(Math.max(0, capacity || 0), 5) * 2;
  return { suitable: true, score, check };
}

/**
 * Orders suitable booths for ONE officer so the least-loaded booth always wins:
 *   1. booths that still need their minimum officers first
 *   2. lowest current ALLOCATED officer count first (balanced distribution)
 *   3. most remaining available capacity next
 *   4. stable tie-break by boothNumber / _id
 *
 * This greedy "pick the least-loaded suitable booth" rule produces the exact
 * balanced distributions required by the spec:
 *   10 officers / 2 booths (cap 5) -> 5 + 5
 *   10 officers / 3 booths (cap 4) -> 4 + 3 + 3
 */
function compareBoothCandidates(a, b) {
  const aNeedMin = a.live < a.cap.min ? 0 : 1;
  const bNeedMin = b.live < b.cap.min ? 0 : 1;
  if (aNeedMin !== bNeedMin) return aNeedMin - bNeedMin;

  if (a.live !== b.live) return a.live - b.live;

  const aAvail = a.cap.max - a.live;
  const bAvail = b.cap.max - b.live;
  if (aAvail !== bAvail) return bAvail - aAvail;

  const an = String(a.booth.boothNumber || '');
  const bn = String(b.booth.boothNumber || '');
  if (an !== bn) return an.localeCompare(bn, undefined, { numeric: true });
  return String(a.booth._id).localeCompare(String(b.booth._id));
}

function pickUnallocatedReason(officer, mandalBooths, liveCounts, options = {}) {
  const mandalName = String(officer.mandal || 'Unspecified').trim();
  if (options.limitReached) {
    return `Run limit reached (max ${options.runLimit} officers per run) - run allocation again to continue.`;
  }
  if (!mandalBooths || mandalBooths.length === 0) {
    return `No booths available in ${mandalName} Mandal.`;
  }

  let anyCapacity = false;
  let anySuitable = false;
  for (const booth of mandalBooths) {
    const cap = boothCapacity(booth);
    const live = liveCounts.get(String(booth._id)) || 0;
    if (Math.max(0, cap.max - live) > 0) anyCapacity = true;
    if (!isRelated(officer, booth).related) anySuitable = true;
  }
  const allFull = !anyCapacity;
  const allRelated = !anySuitable;
  if (allFull && allRelated) {
    return `All booths in ${mandalName} Mandal have reached their required officer capacity and every booth matches the officer's locality.`;
  }
  if (allFull) {
    return `All booths in ${mandalName} Mandal have reached their required officer capacity.`;
  }
  if (allRelated) {
    return `All available booths in ${mandalName} Mandal match the officer's locality.`;
  }
  return `No suitable booth available in ${mandalName} Mandal.`;
}

async function findSuitableBoothsForOfficer(officer) {
  const mandalName = String(officer.mandal || '').trim();
  if (!mandalName) return [];
  const escaped = mandalName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const [booths, liveCounts] = await Promise.all([
    Booth.find({
      mandal: { $regex: new RegExp(`^${escaped}$`, 'i') },
      isActive: true,
    }).lean(),
    countService.computeBoothCountsMap(),
  ]);

  const result = [];
  for (const booth of booths) {
    const cap = boothCapacity(booth);
    const live = Math.min(liveCounts.get(String(booth._id)) || 0, cap.max);
    const availableSlots = Math.max(0, cap.max - live);
    if (availableSlots <= 0) continue;

    const check = isRelated(officer, booth);
    if (check.related) continue;

    result.push({
      _id: booth._id,
      boothId: booth.boothId,
      boothNumber: booth.boothNumber,
      boothName: booth.boothName,
      buildingName: booth.buildingName,
      street: booth.street,
      locality: booth.locality,
      ward: booth.ward,
      mandal: booth.mandal,
      district: booth.district,
      minOfficers: cap.min,
      requiredOfficers: cap.max,
      allocatedOfficerCount: live,
      availableSlots,
      addressMatchScore: Math.max(0, Math.round(check.score)),
      reason: compatibilityReason(officer, booth),
    });
  }

  // Balanced distribution: prefer the least-loaded suitable booth.
  result.sort(
    (a, b) =>
      a.allocatedOfficerCount - b.allocatedOfficerCount ||
      b.availableSlots - a.availableSlots ||
      String(a.boothNumber).localeCompare(String(b.boothNumber), undefined, { numeric: true })
  );
  return result;
}

async function runAllocation(options = {}) {
  // Optional progressive-run cap (any positive integer). When the API omits
  // `maxAllocations` the run is UNLIMITED and allocates every eligible officer
  // in every Mandal (the full mandal-wise run required by STEP 9 - dynamic
  // counts, never hardcoded to 10/2 or 10/3).
  const hasLimit = Number.isInteger(options.maxAllocations);
  const maxAllocations = hasLimit
    ? Math.min(RUN_LIMIT.MAX, Math.max(RUN_LIMIT.MIN, options.maxAllocations))
    : Number.POSITIVE_INFINITY;

  if (runInProgress) {
    const error = new Error('Allocation is already running - please wait a moment');
    error.statusCode = 409;
    throw error;
  }
  runInProgress = true;

  const result = {
    totalOfficers: 0,
    totalBooths: 0,
    totalMandals: 0,
    allocated: 0,
    unallocated: 0,
    skipped: 0,
    runLimit: hasLimit ? maxAllocations : null,
    limitReached: false,
    allocations: [],
    unallocatedOfficers: [],
    byMandal: [],
  };

  try {
    // STEP 1: read all active officers + booths and group them by Mandal.
    const booths = await Booth.find({ isActive: true }).lean();
    const officers = await Officer.find({ isActive: true }).lean();
    result.totalBooths = booths.length;
    result.totalOfficers = officers.length;

    const boothsByMandal = groupBy(booths, (b) => mandalKey(b.mandal));
    const officersByMandal = groupBy(officers, (o) => mandalKey(o.mandal));

    const mandalNames = [
      ...new Set([...officersByMandal.keys(), ...boothsByMandal.keys()]),
    ].sort((a, b) => a.localeCompare(b));
    result.totalMandals = mandalNames.length;

    // Live ALLOCATED counts per booth - MongoDB allocation records are the
    // source of truth (STEP 12). Never trust previously stored counters.
    const liveCounts = await countService.computeBoothCountsMap();

    // STEP 13: officers that already hold an ALLOCATED allocation are skipped,
    // so clicking "Run Automatic Allocation" again never creates duplicates.
    const activeAllocs = await Allocation.find({ status: STATUS.ALLOCATED })
      .select('officer')
      .lean();
    const alreadyAllocated = new Set(activeAllocs.map((a) => String(a.officer)));

    const created = [];

    const pushUnallocatedRow = (officer, reason, mandalEntryForRow, mandalLabel) => {
      const row = {
        ...officerToUnallocatedRow(officer),
        mandal: mandalLabel || officer.mandal || '',
        reason,
      };
      result.unallocatedOfficers.push(row);
      if (mandalEntryForRow) mandalEntryForRow.unallocatedOfficerList.push(row);
      result.unallocated += 1;
      if (mandalEntryForRow) mandalEntryForRow.unallocatedOfficers += 1;
    };

    // STEP 2-5: process EACH Mandal completely independently. Officers are never
    // allocated to booths of another Mandal.
    for (const name of mandalNames) {
      const mandalOfficers = officersByMandal.get(name) || [];
      const mandalBooths = boothsByMandal.get(name) || [];
      const displayMandal =
        (mandalOfficers[0] && mandalOfficers[0].mandal) ||
        (mandalBooths[0] && mandalBooths[0].mandal) ||
        name ||
        'Unspecified';

      const mandalEntry = {
        mandal: displayMandal,
        totalOfficers: mandalOfficers.length,
        totalBooths: mandalBooths.length,
        requiredCapacity: mandalBooths.reduce(
          (sum, b) => sum + Math.max(0, Number(b.requiredOfficers) || 0),
          0
        ),
        allocatedOfficers: 0,
        unallocatedOfficers: 0,
        availableSlots: 0,
        reason: '',
        unallocatedOfficerList: [],
      };
      result.byMandal.push(mandalEntry);

      // STEP 10: Mandal that has officers but no booths - clear reason.
      if (mandalBooths.length === 0 && mandalOfficers.length > 0) {
        mandalEntry.reason = `No booths available in ${displayMandal} Mandal.`;
      }

        for (const officer of mandalOfficers) {
        const officerKey = String(officer._id);

        // STEP 13: never duplicate an existing ALLOCATED allocation.
        if (alreadyAllocated.has(officerKey)) {
          result.skipped += 1;
          mandalEntry.allocatedOfficers += 1;
          continue;
        }

        // Optional progressive-run cap (backwards compatible).
        if (hasLimit && result.allocated >= maxAllocations) {
          result.limitReached = true;
          pushUnallocatedRow(
            officer,
            pickUnallocatedReason(officer, mandalBooths, liveCounts, {
              limitReached: true,
              runLimit: maxAllocations,
            }),
            mandalEntry,
            displayMandal
          );
          continue;
        }

        // STEP 10: never allocate across Mandals when this Mandal has no booths.
        if (mandalBooths.length === 0) {
          pushUnallocatedRow(
            officer,
            mandalEntry.reason || pickUnallocatedReason(officer, mandalBooths, liveCounts, {}),
            mandalEntry,
            displayMandal
          );
          continue;
        }

        // STEP 5a-5c: candidates = booths in the SAME Mandal with available
        // capacity whose locality is DIFFERENT from the officer's locality.
        const candidates = [];
        for (const booth of mandalBooths) {
          const cap = boothCapacity(booth);
          const live = liveCounts.get(String(booth._id)) || 0;
          const available = Math.max(0, cap.max - live);
          if (available <= 0) continue;
          const check = isRelated(officer, booth);
          if (check.related) continue;
          candidates.push({ booth, live, cap, check });
        }

        if (candidates.length === 0) {
          // STEP 3 + STEP 14: clear, Mandal-specific unallocated reason.
          pushUnallocatedRow(
            officer,
            pickUnallocatedReason(officer, mandalBooths, liveCounts, {}),
            mandalEntry,
            displayMandal
          );
          continue;
        }

        // STEP 5d/5e: pick the suitable booth with the LOWEST current
        // allocation count (balanced distribution). Never "the first booth
        // from MongoDB" - the sorted candidate wins.
        candidates.sort(compareBoothCandidates);
        const best = candidates[0];

        const already = await Allocation.exists({ officer: officer._id, status: STATUS.ALLOCATED });
        if (already) {
          result.skipped += 1;
          mandalEntry.allocatedOfficers += 1;
          continue;
        }

        // STRICT CAPACITY RULE (in-run): re-verify the picked booth still has a
        // free position from the live counts before creating the allocation.
        // `liveCounts` is updated after every allocation, so once a booth is
        // full the very next officer is redirected (or skipped with a reason).
        if (best.live >= best.cap.max) {
          pushUnallocatedRow(
            officer,
            pickUnallocatedReason(officer, mandalBooths, liveCounts, {}),
            mandalEntry,
            displayMandal
          );
          continue;
        }

        const allocation = await Allocation.create({
          allocationId: await nextAllocationId(officer),
          officer: officer._id,
          officerId: officer.officerId,
          booth: best.booth._id,
          boothId: best.booth.boothId,
          mandal: officer.mandal || best.booth.mandal || '',
          status: STATUS.ALLOCATED,
          allocationDate: new Date(),
          allocatedAt: new Date(),
          adminApproved: true,
          addressMatchScore: Math.max(0, Math.round(best.check.score)),
          addressValidationReason: compatibilityReason(officer, best.booth),
          allocationReason: (best.check.reasons && best.check.reasons[0]) || '',
        });

        created.push(allocation);
        liveCounts.set(String(best.booth._id), best.live + 1);
        alreadyAllocated.add(officerKey);
        result.allocated += 1;
        mandalEntry.allocatedOfficers += 1;
      }

      // STEP 6: final per-Mandal summary (also covers STEP 11 booths-only mandals).
      mandalEntry.unallocatedOfficers = Math.max(
        0,
        mandalEntry.totalOfficers - mandalEntry.allocatedOfficers
      );
      mandalEntry.availableSlots = Math.max(
        0,
        mandalEntry.requiredCapacity - mandalEntry.allocatedOfficers
      );
    }

    // STEP 12: refresh booth counters from the real ALLOCATED documents.
    for (const allocation of created) {
      await countService.recalculateBoothCounts(allocation.booth);
    }

    result.allocations = created.map((a) => a._id);
    return result;
  } finally {
    runInProgress = false;
  }
}

function officerToUnallocatedRow(officer) {
  return {
    officer: officer._id,
    officerId: officer.officerId,
    officerName: officer.officerName,
    designation: officer.designation,
    mobileNumber: officer.mobileNumber,
    mandal: officer.mandal || '',
    locality: officer.locality || '',
    ward: officer.ward || '',
  };
}

async function cancelAllocation(allocationId) {
  const allocation = await Allocation.findById(allocationId).populate('booth');
  if (!allocation) {
    const error = new Error('Allocation not found');
    error.statusCode = 404;
    throw error;
  }
  if (allocation.status === STATUS.CANCELLED) {
    return { changed: false, message: 'Allocation is already cancelled', allocation };
  }
  if (allocation.status !== STATUS.ALLOCATED) {
    const error = new Error('Only an ALLOCATED allocation can be cancelled');
    error.statusCode = 400;
    throw error;
  }

  allocation.status = STATUS.CANCELLED;
  allocation.cancelledAt = new Date();
  allocation.adminApproved = false;
  await allocation.save();

  if (allocation.booth) {
    await countService.recalculateBoothCounts(allocation.booth._id);
  }

  return { changed: true, message: 'Allocation cancelled successfully', allocation };
}

async function runInTransaction(fn) {
  let session = null;
  try {
    session = await mongoose.startSession();
  } catch {
    return fn();
  }
  try {
    return await session.withTransaction(async () => fn());
  } catch (error) {
    const text = `${error.message || ''} ${error.errmsg || ''}`;
    if (/transaction numbers are only allowed on a replica set member or mongos/i.test(text)) {
      try {
        await session.abortTransaction();
      } catch {

      }
      return fn();
    }
    throw error;
  } finally {
    try {
      await session.endSession();
    } catch {

    }
  }
}

async function reallocateOfficer(allocationId, preferredBoothId = null) {
  const current = await Allocation.findById(allocationId).populate('officer').populate('booth');
  if (!current) {
    const error = new Error('Allocation not found');
    error.statusCode = 404;
    throw error;
  }
  if (current.status !== STATUS.ALLOCATED) {
    const error = new Error('Only an ALLOCATED allocation can be reallocated');
    error.statusCode = 400;
    throw error;
  }
  const officer = current.officer;
  if (!officer) {
    const error = new Error('Officer record missing on this allocation');
    error.statusCode = 404;
    throw error;
  }

  const suitableBooths = await findSuitableBoothsForOfficer(officer);
  let chosen = null;
  if (preferredBoothId) {
    chosen = suitableBooths.find((b) => String(b._id) === String(preferredBoothId)) || null;
    if (!chosen) {
      const error = new Error('Preferred booth is not suitable or has no available capacity');
      error.statusCode = 409;
      throw error;
    }
  } else {
    const alternatives = suitableBooths.filter((b) => String(b._id) !== String(current.booth?._id));
    alternatives.sort(
      (a, b) => a.allocatedOfficerCount - b.allocatedOfficerCount || String(a._id).localeCompare(String(b._id))
    );
    chosen = alternatives[0] || null;
  }
  if (!chosen) {
    const error = new Error('No suitable alternative booth available for reallocation');
    error.statusCode = 409;
    throw error;
  }

  const txResult = await runInTransaction(async () => {
    const oldBoothId = current.booth?._id || null;

    current.status = STATUS.REALLOCATED;
    current.reallocatedAt = new Date();
    current.adminApproved = false;
    await current.save();

    const existingActive = await Allocation.exists({ officer: officer._id, status: STATUS.ALLOCATED });
    if (existingActive) {
      const error = new Error('Officer already has an active allocation');
      error.statusCode = 409;
      throw error;
    }

    // STRICT CAPACITY RULE: the destination booth must still have a free slot.
    // Re-verified from ACTIVE allocation documents right before the insert so a
    // reallocation can never push a booth past requiredOfficers.
    await countService.recalculateBoothCounts(chosen._id);
    await assertBoothHasCapacity(chosen._id, 'Booth');

    const newAllocation = await Allocation.create({
      allocationId: await nextAllocationId(officer),
      officer: officer._id,
      officerId: officer.officerId,
      booth: chosen._id,
      boothId: chosen.boothId,
      mandal: officer.mandal || chosen.mandal || '',
      status: STATUS.ALLOCATED,
      allocationDate: new Date(),
      allocatedAt: new Date(),
      adminApproved: true,
      previousAllocationId: current._id,
      addressMatchScore: chosen.addressMatchScore || 0,
      addressValidationReason: chosen.reason || '',
      allocationReason: chosen.reason || '',
    });

    if (oldBoothId) {
      await countService.recalculateBoothCounts(oldBoothId);
    }
    await countService.recalculateBoothCounts(chosen._id);

    return { changed: true, newAllocation, oldAllocation: current, chosenBooth: chosen };
  });

  // After the reallocation is committed, automatically create the notification
  // for the ACCEPTED booth so the admin immediately sees the accepted booth
  // message (same wording as the polling-duty SMS). Best-effort: a notification
  // provider failure never rolls back the reallocation itself.
  let notification = null;
  try {
    const sms = require('./smsService');
    const acceptedMessage = sms.buildAllocationMessage(officer, chosen);
    notification = await sms.sendSms({
      officer,
      allocation: txResult.newAllocation,
      message: acceptedMessage,
    });
  } catch (e) {
    notification = null;
  }

  return { ...txResult, notification };
}

async function getAllocationRows(filter = {}) {
  return Allocation.find(filter)
    .populate('officer')
    .populate('booth')
    .sort({ createdAt: -1 })
    .lean();
}

module.exports = {
  STATUS,
  RUN_LIMIT,
  makeAllocationId,
  nextAllocationId,
  scoreSuitability,
  runAllocation,
  cancelAllocation,
  reallocateOfficer,
  findSuitableBoothsForOfficer,
  getAllocationRows,
  manualAllocate,
  strictAddressMode,
  fallbackAllowed,
  defaultRequiredOfficers,
};

async function manualAllocate(officerRef, boothRef) {
  const OfficerModel = require('../models/Officer');
  const BoothModel = require('../models/Booth');
  const officer = typeof officerRef === 'object' && officerRef !== null && officerRef.officerId
    ? officerRef
    : await OfficerModel.findOne({ officerId: String(officerRef || '').toUpperCase() });
  if (!officer) { const e = new Error('Officer not found'); e.statusCode = 404; throw e; }
  if (!officer.isActive) { const e = new Error('Officer is inactive'); e.statusCode = 400; throw e; }
  const booth = boothRef && boothRef._id
    ? boothRef
    : (await BoothModel.findById(boothRef).catch(() => null)) || await BoothModel.findOne({ boothId: String(boothRef || '').toUpperCase() });
  if (!booth) { const e = new Error('Booth not found'); e.statusCode = 404; throw e; }
  if (!booth.isActive) { const e = new Error('Booth is inactive'); e.statusCode = 400; throw e; }
  if (mandalKey(officer.mandal) !== mandalKey(booth.mandal)) {
    const e = new Error('Officer and booth belong to different Mandals'); e.statusCode = 400; throw e;
  }
  const dup = await Allocation.exists({ officer: officer._id, status: STATUS.ALLOCATED });
  if (dup) { const e = new Error('Officer already has an active allocation'); e.statusCode = 409; throw e; }
  await countService.recalculateBoothCounts(booth._id);
  const fresh = await BoothModel.findById(booth._id).lean();
  const cap = boothCapacity(fresh || booth);
  const live = await countService.getLiveAllocatedCount(booth._id);
  if (live >= cap.max) { const e = new Error('Booth has no available capacity'); e.statusCode = 409; throw e; }
  const check = isRelated(officer, fresh || booth);
  const isFallbackBooth = check.related;
  if (isFallbackBooth && (strictAddressMode() || !fallbackAllowed())) {
    const e = new Error('Booth rejected by locality rule: ' + compatibilityReason(officer, fresh || booth));
    e.statusCode = 409; throw e;
  }
  const picked = await BoothModel.findById(booth._id);
  const sim = addressSimilarityScore(officer, picked);
  const reason = isFallbackBooth
    ? ('Fallback Allocation: same-locality booth used (lowest address similarity) - ' + compatibilityReason(officer, picked))
    : compatibilityReason(officer, picked);
  return runInTransaction(async () => {
    const stillDup = await Allocation.findOne({ officer: officer._id, status: STATUS.ALLOCATED });
    if (stillDup) { const e = new Error('Officer already has an active allocation'); e.statusCode = 409; throw e; }
    // Hard backend capacity rule: re-verify from ACTIVE allocation documents
    // right before insert so the booth can never exceed requiredOfficers.
    await countService.recalculateBoothCounts(booth._id);
    await assertBoothHasCapacity(booth._id, 'Booth');
    const allocation = await Allocation.create({
      allocationId: await nextAllocationId(officer),
      officer: officer._id,
      officerId: officer.officerId,
      booth: picked._id,
      boothId: picked.boothId,
      mandal: officer.mandal || picked.mandal || '',
      status: STATUS.ALLOCATED,
      allocationDate: new Date(),
      allocatedAt: new Date(),
      adminApproved: true,
      addressMatchScore: sim,
      addressValidationReason: reason,
      allocationReason: reason,
      isFallback: isFallbackBooth,
      fallbackReason: isFallbackBooth ? reason : '',
    });
    await countService.recalculateBoothCounts(picked._id);
    try {
      const sms = require('./smsService');
      const msg = sms.buildAllocationMessage(officer, picked);
      await sms.sendSms({ officer, allocation, message: msg });
    } catch (e) {}
    return { allocation, officer, booth: picked, isFallback: isFallbackBooth, reason };
  });
}
