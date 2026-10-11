const Booth = require('../models/Booth');
const Allocation = require('../models/Allocation');
const uploadBatchService = require('../services/uploadBatchService');
const countService = require('../services/countService');
const { scopeFilter } = require('../services/roleService');

/** Escapes a user-provided value so it is safe inside a RegExp. */
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds a MongoDB query from the search/filter query-string params, then
 * FORCES the logged-in user's data scope on top (Mandal Officers only ever
 * see their assigned Mandal - any client-supplied mandal filter is ignored).
 */
function buildBoothFilter(req) {
  const filter = {};
  const { search, ward } = req.query;

  if (search) {
    const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [
      { boothId: re },
      { boothName: re },
      { boothNumber: re },
      { buildingName: re },
      { locality: re },
    ];
  }
  if (ward) filter.ward = ward;

  const scope = scopeFilter(req.user);
  if (scope) {
    // Mandal Officer: force the assigned mandal (never trust client params).
    Object.assign(filter, scope);
  } else if (req.query.mandal) {
    // Full-access roles may use the optional mandal filter.
    filter.mandal = {
      $regex: new RegExp(`^${escapeRegex(String(req.query.mandal).trim())}$`, 'i'),
    };
  }
  return filter;
}

/** GET /api/booths?search=&mandal=&ward=&page=&limit= */
async function getBooths(req, res, next) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const filter = buildBoothFilter(req);

    const [booths, total, liveMap] = await Promise.all([
      Booth.find(filter).sort({ boothId: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      Booth.countDocuments(filter),
      countService.computeBoothCountsMap(),
    ]);

    // Live counts are the authority: allocatedOfficerCount / availableSlots are
    // recomputed from the ACTIVE (ALLOCATED) allocation documents so the UI can
    // never show a stale manually-stored counter (e.g. 4/3).
    booths.forEach((b) => {
      const required = Math.max(0, Number(b.requiredOfficers) || 0);
      const live = Math.min(liveMap.get(String(b._id)) || 0, required);
      b.allocatedOfficerCount = live;
      b.availableSlots = Math.max(0, required - live);
    });

    return res.json({
      success: true,
      data: booths,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
}

/** POST /api/booths - create one booth (duplicate Booth ID blocked by schema). */
async function createBooth(req, res, next) {
  try {
    const booth = await Booth.create({ ...req.body, allocatedOfficerCount: 0 });
    return res.status(201).json({ success: true, data: booth });
  } catch (error) {
    next(error);
  }
}

/** PUT /api/booths/:id - update an existing booth. */
async function updateBooth(req, res, next) {
  try {
    const existing = await Booth.findById(req.params.id).lean();
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Booth not found' });
    }

    // Capacity counters are computed from ACTIVE allocation documents - never
    // accept them from a client payload.
    const { allocatedOfficerCount, availableSlots, ...allowed } = req.body || {};

    // STRICT CAPACITY RULE: never let Required Officers drop below the number
    // of officers that are currently ACTIVE on this booth - otherwise the data
    // would silently exceed capacity (e.g. live 3, set required to 2 -> 3/2).
    let newRequired = existing.requiredOfficers;
    if (allowed.requiredOfficers !== undefined) {
      newRequired = Number(allowed.requiredOfficers);
    }
    const live = await countService.getLiveAllocatedCount(existing._id);
    if (Number.isInteger(newRequired) && newRequired >= 0 && live > newRequired) {
      const error = new Error(
        `Cannot set Required Officers to ${newRequired}: booth already has ${live} active allocation(s)`
      );
      error.statusCode = 409;
      throw error;
    }

    const booth = await Booth.findByIdAndUpdate(req.params.id, allowed, {
      new: true,
      runValidators: true,
    });
    if (!booth) {
      return res.status(404).json({ success: false, message: 'Booth not found' });
    }

    // Re-derive the counters from the real ALLOCATED documents so the stored
    // values always match reality after the update.
    await countService.recalculateBoothCounts(booth._id);
    const fresh = await Booth.findById(booth._id).lean();
    return res.json({ success: true, data: fresh });
  } catch (error) {
    next(error);
  }
}

/** DELETE /api/booths/:id - remove a booth (linked allocations cascaded). */
async function deleteBooth(req, res, next) {
  try {
    const booth = await Booth.findById(req.params.id);
    if (!booth) {
      return res.status(404).json({ success: false, message: 'Booth not found' });
    }

    // Cascade: remove any allocations that referenced this booth so no
    // orphaned records remain.
    const allocCount = await Allocation.countDocuments({ booth: booth._id });
    if (allocCount > 0) {
      await Allocation.deleteMany({ booth: booth._id });
    }
    await booth.deleteOne();

    return res.json({
      success: true,
      message: `Booth '${booth.boothId}' deleted with ${allocCount} allocation(s)`,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/booths/grouped?search=&mandal=
 * Returns every matching booth grouped by Mandal so the UI can render one
 * separate section per Mandal (uploaded files must never be mixed together).
 */
async function getBoothsGrouped(req, res, next) {
  try {
    const filter = buildBoothFilter(req);
    const [booths, liveMap] = await Promise.all([
      Booth.find(filter).sort({ mandal: 1, boothId: 1 }).lean(),
      countService.computeBoothCountsMap(),
    ]);

    // Live counts come from ACTIVE allocation documents - never stale counters.
    booths.forEach((b) => {
      const required = Math.max(0, Number(b.requiredOfficers) || 0);
      const live = Math.min(liveMap.get(String(b._id)) || 0, required);
      b.allocatedOfficerCount = live;
      b.availableSlots = Math.max(0, required - live);
    });

    const groups = new Map();
    for (const booth of booths) {
      const key = booth.mandal || 'Unspecified';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(booth);
    }

    const data = [...groups.entries()]
      .map(([mandal, list]) => ({
        mandal,
        total: list.length,
        booths: list,
        requiredOfficers: list.reduce((sum, b) => sum + (b.requiredOfficers || 0), 0),
        allocatedOfficers: list.reduce((sum, b) => sum + (b.allocatedOfficerCount || 0), 0),
      }))
      .sort((a, b) => a.mandal.localeCompare(b.mandal));

    return res.json({
      success: true,
      data,
      totalBooths: booths.length,
      totalMandals: groups.size,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /api/booths/all?mandal=
 * Bulk delete - removes every booth (optionally scoped to a single Mandal,
 * i.e. "delete this uploaded file's data") together with:
 *   - all allocations pointing at those booths (officers simply become free
 *     again - they are never deleted here),
 *   - upload-batch records whose rows are all gone ("entire uploaded file").
 */
async function deleteAllBooths(req, res, next) {
  try {
    const filter = {};
    if (req.query.mandal) {
      filter.mandal = { $regex: new RegExp(`^${escapeRegex(req.query.mandal.trim())}$`, 'i') };
    }

    const booths = await Booth.find(filter).select('_id boothId').lean();
    if (booths.length === 0) {
      return res.status(404).json({ success: false, message: 'No booths found to delete' });
    }
    const ids = booths.map((b) => b._id);

    // Cascade: remove any allocations that referenced these booths so no
    // orphaned records remain (officers keep existing, just unallocated).
    const delAllocs = await Allocation.deleteMany({ booth: { $in: ids } });
    const delBooths = await Booth.deleteMany({ _id: { $in: ids } });

    // Drop upload-batch records that no longer contain any live booth.
    const prunedBatches = await uploadBatchService.pruneUploadBatches('booths');

    return res.json({
      success: true,
      message:
        `Deleted ${delBooths.deletedCount} booth(s)` +
        `${req.query.mandal ? ` in Mandal '${req.query.mandal}'` : ''} - removed ` +
        `${delAllocs.deletedCount} allocation(s)` +
        `${prunedBatches ? `, ${prunedBatches} uploaded file record(s) cleared` : ''}`,
      removed: {
        booths: delBooths.deletedCount || 0,
        allocations: delAllocs.deletedCount || 0,
        uploadBatches: prunedBatches,
      },
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getBooths,
  getBoothsGrouped,
  createBooth,
  updateBooth,
  deleteBooth,
  deleteAllBooths,
  buildBoothFilter,
};