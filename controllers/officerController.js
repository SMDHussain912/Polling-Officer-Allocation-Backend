const crypto = require('crypto');

const Officer = require('../models/Officer');
const Allocation = require('../models/Allocation');
const Booth = require('../models/Booth');
const Notification = require('../models/Notification');
const uploadBatchService = require('../services/uploadBatchService');
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
function buildOfficerFilter(req) {
  const filter = {};
  const { search, ward, designation } = req.query;

  if (search) {
    const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [
      { officerId: re },
      { officerName: re },
      { mobileNumber: re },
      { locality: re },
    ];
  }
  if (ward) filter.ward = ward;
  if (designation) filter.designation = designation;

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

/** GET /api/officers?search=&mandal=&ward=&page=&limit= */
async function getOfficers(req, res, next) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const filter = buildOfficerFilter(req);

    const [officers, total] = await Promise.all([
      Officer.find(filter).sort({ officerId: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      Officer.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: officers,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
}

/** POST /api/officers - create one officer (duplicate Officer ID blocked by schema). */
async function createOfficer(req, res, next) {
  try {
    const officer = await Officer.create(req.body);
    return res.status(201).json({ success: true, data: officer });
  } catch (error) {
    next(error);
  }
}

/** PUT /api/officers/:id - update an existing officer. */
async function updateOfficer(req, res, next) {
  try {
    const officer = await Officer.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!officer) {
      return res.status(404).json({ success: false, message: 'Officer not found' });
    }
    return res.json({ success: true, data: officer });
  } catch (error) {
    next(error);
  }
}

/** DELETE /api/officers/:id - remove an officer (linked data cascaded). */
async function deleteOfficer(req, res, next) {
  try {
    const officer = await Officer.findById(req.params.id);
    if (!officer) {
      return res.status(404).json({ success: false, message: 'Officer not found' });
    }

    // Cascade: remove this officer's allocations (and fix booth counters)
    // plus any SMS notifications, so no orphaned records remain.
    const allocs = await Allocation.find({ officer: officer._id }).lean();
    if (allocs.length > 0) {
      await Allocation.deleteMany({ officer: officer._id });
      const boothCounts = {};
      for (const a of allocs) {
        const boothId = a.booth ? String(a.booth) : '';
        if (boothId) boothCounts[boothId] = (boothCounts[boothId] || 0) + 1;
      }
      for (const [boothId, count] of Object.entries(boothCounts)) {
        // Clamp so the counter can never go below zero.
        const booth = await Booth.findById(boothId).lean();
        if (booth) {
          await Booth.updateOne(
            { _id: boothId },
            { allocatedOfficerCount: Math.max(0, booth.allocatedOfficerCount - count) }
          );
        }
      }
    }
    await Notification.deleteMany({ officer: officer._id });
    await officer.deleteOne();

    return res.json({
      success: true,
      message: `Officer '${officer.officerId}' deleted with ${allocs.length} allocation(s)`,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/officers/grouped?search=&mandal=
 * Returns every matching officer grouped by Mandal so the UI can render one
 * separate section per Mandal (uploaded files are processed mandal-wise and
 * must never be mixed together).
 */
async function getOfficersGrouped(req, res, next) {
  try {
    const filter = buildOfficerFilter(req);
    const officers = await Officer.find(filter).sort({ mandal: 1, officerId: 1 }).lean();

    const groups = new Map();
    for (const officer of officers) {
      const key = officer.mandal || 'Unspecified';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(officer);
    }

    const data = [...groups.entries()]
      .map(([mandal, list]) => ({ mandal, total: list.length, officers: list }))
      .sort((a, b) => a.mandal.localeCompare(b.mandal));

    return res.json({
      success: true,
      data,
      totalOfficers: officers.length,
      totalMandals: groups.size,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /api/officers/all?mandal=
 * Bulk delete - removes every officer (optionally scoped to a single Mandal,
 * i.e. "delete this uploaded file's data") together with:
 *   - all of their allocations (booth counters corrected),
 *   - all of their SMS notifications,
 *   - upload-batch records whose rows are all gone ("entire uploaded file").
 */
async function deleteAllOfficers(req, res, next) {
  try {
    const filter = {};
    if (req.query.mandal) {
      filter.mandal = { $regex: new RegExp(`^${escapeRegex(req.query.mandal.trim())}$`, 'i') };
    }

    const officers = await Officer.find(filter).select('_id officerId').lean();
    if (officers.length === 0) {
      return res.status(404).json({ success: false, message: 'No officers found to delete' });
    }
    const ids = officers.map((o) => o._id);

    // 1. Cascade: remove the officers' allocations and free the booth slots.
    const allocs = await Allocation.find({ officer: { $in: ids } }).select('booth').lean();
    const delAllocs = await Allocation.deleteMany({ officer: { $in: ids } });

    const boothCounts = {};
    for (const a of allocs) {
      const boothId = a.booth ? String(a.booth) : '';
      if (boothId) boothCounts[boothId] = (boothCounts[boothId] || 0) + 1;
    }
    for (const [boothId, count] of Object.entries(boothCounts)) {
      // Clamp so the counter can never go below zero.
      const booth = await Booth.findById(boothId).lean();
      if (booth) {
        await Booth.updateOne(
          { _id: boothId },
          { allocatedOfficerCount: Math.max(0, booth.allocatedOfficerCount - count) }
        );
      }
    }

    // 2. Notifications + the officers themselves.
    const delNotifs = await Notification.deleteMany({ officer: { $in: ids } });
    const delOfficers = await Officer.deleteMany({ _id: { $in: ids } });

    // 3. Drop upload-batch records that no longer contain any live officer.
    const prunedBatches = await uploadBatchService.pruneUploadBatches('officers');

    return res.json({
      success: true,
      message:
        `Deleted ${delOfficers.deletedCount} officer(s)` +
        `${req.query.mandal ? ` in Mandal '${req.query.mandal}'` : ''} - removed ` +
        `${delAllocs.deletedCount} allocation(s), ${delNotifs.deletedCount} notification(s)` +
        `${prunedBatches ? `, ${prunedBatches} uploaded file record(s) cleared` : ''}`,
      removed: {
        officers: delOfficers.deletedCount || 0,
        allocations: delAllocs.deletedCount || 0,
        notifications: delNotifs.deletedCount || 0,
        uploadBatches: prunedBatches,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Generates a collision-safe Employee ID for public self-registration.
 * Excel imports use OFF001-style sequential IDs, so the timestamp-based
 * suffix here can never collide with imported data.
 */
function generateOfficerId() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `OFF${ts}${rand}`;
}

/**
 * POST /api/officers/register - PUBLIC employee self-registration (no JWT).
 * No approval workflow: the record goes straight into the employees list and
 * is immediately available to the admin for allocation. Employees never
 * receive login credentials - only admins can log in.
 */
async function registerOfficer(req, res, next) {
  try {
    // Whitelist only the public fields - never spread req.body into the model.
    const payload = {
      officerName: req.body.officerName,
      designation: req.body.designation,
      mobileNumber: req.body.mobileNumber,
      email: req.body.email || '',
      mandal: req.body.mandal,
      district: req.body.district || '',
      houseNo: req.body.houseNo || '',
      street: req.body.street || '',
      locality: req.body.locality || '',
      ward: req.body.ward || '',
      pinCode: req.body.pinCode || '',
    };

    // Friendly duplicate check: one mobile number / e-mail = one record.
    const dupConditions = [{ mobileNumber: payload.mobileNumber }];
    if (payload.email) dupConditions.push({ email: payload.email });
    const duplicate = await Officer.findOne({ $or: dupConditions })
      .select('_id officerId')
      .lean();
    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: 'An employee with this mobile number or e-mail is already registered',
      });
    }

    // Auto-generate the Employee ID (schema enforces uniqueness; retry on the
    // astronomically unlikely collision).
    let officer;
    let lastError;
    for (let attempt = 0; attempt < 5 && !officer; attempt += 1) {
      try {
        officer = await Officer.create({ ...payload, officerId: generateOfficerId() });
      } catch (error) {
        if (error.code === 11000) {
          lastError = error; // duplicate key - regenerate and retry
        } else {
          throw error;
        }
      }
    }
    if (!officer) throw lastError || new Error('Could not allocate an Employee ID - please try again');

    // Minimal response - never echo the full document back publicly.
    return res.status(201).json({
      success: true,
      message: 'Registration successful - your details have been added to the employees list',
      data: { officerId: officer.officerId, officerName: officer.officerName },
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getOfficers,
  getOfficersGrouped,
  createOfficer,
  updateOfficer,
  deleteOfficer,
  deleteAllOfficers,
  buildOfficerFilter,
  registerOfficer,
};