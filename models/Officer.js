const mongoose = require('mongoose');

/**
 * Election / Government officer who is available for polling duty.
 * The address is stored in structured fields so the allocation engine
 * can compare it with booth addresses in a meaningful way.
 *
 * Fields:
 *   officerId            - unique human readable officer code (e.g. OFF001)
 *   name/officerName    - officer name
 *   designation          - designation / post
 *   houseNo/street/locality/ward - structured residential address
 *   mandalId            - ObjectId reference to the Mandal this officer belongs to
 *   mandal             - legacy human-readable Mandal name (kept in sync)
 *   userId              - link to the login account (Admin collection) this officer uses
 *   currentAllocationId - reference to the officer's current active allocation
 *   isActive            - inactive officers are skipped by the allocation engine
 */
const officerSchema = new mongoose.Schema(
  {
    officerId: {
      type: String,
      required: [true,'Officer ID is required'],
      unique: true,
      trim: true,
      uppercase: true,
    },
    officerName: {
      type: String,
      required: [true,'Officer Name is required'],
      trim: true,
    },
    // Alias for code that uses `name`.
    name: { type: String, trim: true, default: '' },
    designation: {
      type: String,
      required: [true,'Designation is required'],
      trim: true,
    },
    mobileNumber: {
      type: String,
      required: [true,'Mobile Number is required'],
      trim: true,
      match: [/^[0-9+\-\s]{10,15}$/, 'Invalid mobile number'],
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: '',
      match: [/^\S+@\S+\.\S+$/, 'Invalid email address'],
    },
    // --- Structured residential address fields ---
    houseNo: { type: String, trim: true, default: '' },
    houseNumber: { type: String, trim: true, default: '' }, // legacy alias
    street: { type: String, trim: true, default: '' },
    locality: { type: String, trim: true, default: '' }, // village / locality
    ward: { type: String, trim: true, default: '' },
    // Mandal binding: prefer `mandalId` (ObjectId ref); `mandal` is kept in sync
    mandalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Mandal', default: null },
    mandal: { type: String, trim: true, default: '' },
    district: { type: String, trim: true, default: '' },
    pinCode: { type: String, trim: true, default: '' },
    isActive: { type: Boolean, default: true },
    // Login account link (OFFICER role users only)
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    // Pointer to the officer's single active allocation
    currentAllocationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Allocation', default: null },
  },
  { timestamps: true }
);

// Query performance index for grouping/filtering by Mandal and Locality
// (the officerId unique index is created automatically by unique: true above)
officerSchema.index({ mandalId: 1 });
officerSchema.index({ mandal: 1 });
officerSchema.index({ locality: 1 });
officerSchema.index({ isActive: 1 });

module.exports = mongoose.models.Officer || mongoose.model('Officer', officerSchema);