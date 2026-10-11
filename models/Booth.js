const mongoose = require('mongoose');

const boothSchema = new mongoose.Schema(
  {
    boothId: {
      type: String,
      required: [true, 'Booth ID is required'],
      unique: true,
      trim: true,
      uppercase: true,
    },
    boothNumber: {
      type: String,
      required: [true, 'Booth Number is required'],
      trim: true,
    },
    boothName: {
      type: String,
      required: [true, 'Booth Name is required'],
      trim: true,
    },
    buildingName: { type: String, trim: true, default: '' },
    street: { type: String, trim: true, default: '' },
    locality: { type: String, trim: true, default: '' },
    ward: { type: String, trim: true, default: '' },
    mandalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Mandal', default: null },
    mandal: { type: String, trim: true, default: '' },
    district: { type: String, trim: true, default: '' },
    pinCode: { type: String, trim: true, default: '' },
    requiredOfficers: {
      type: Number,
      
      min: [0, 'Required Officers cannot be negative'],
      default: 4,
    },
    minOfficers: {
      type: Number,
      min: [0, 'Minimum Officers cannot be negative'],
      default: 0,
    },
    allocatedOfficerCount: {
      type: Number,
      default: 0,
      min: [0, 'Allocated count cannot be negative'],
    },
    availableSlots: {
      type: Number,
      default: 4,
      min: [0, 'Available slots cannot be negative'],
    },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

const DEFAULT_REQUIRED_OFFICERS = Math.max(1, Number(process.env.DEFAULT_REQUIRED_OFFICERS) || 4);
function effectiveRequired(v) {
  const num = Number(v);
  if (!Number.isInteger(num) || num <= 0) return DEFAULT_REQUIRED_OFFICERS;
  return num;
}
boothSchema.pre('validate', function ensureCapacityConsistency() {
  const max = effectiveRequired(this.requiredOfficers);
  this.requiredOfficers = max;
  const rawMin = Number(this.minOfficers);
  this.minOfficers = Number.isInteger(rawMin) && rawMin >= 0 ? Math.min(rawMin, max) : 0;
  this.availableSlots = Math.max(0, max - (this.allocatedOfficerCount || 0));
  if (this.allocatedOfficerCount > max) {
    this.invalidate('allocatedOfficerCount', 'Allocated count cannot exceed required officers');
  }
});

boothSchema.index({ mandalId: 1 });
boothSchema.index({ mandal: 1 });
boothSchema.index({ locality: 1 });
boothSchema.index({ isActive: 1 });

module.exports = mongoose.models.Booth || mongoose.model('Booth', boothSchema);
module.exports.DEFAULT_REQUIRED_OFFICERS = DEFAULT_REQUIRED_OFFICERS;
module.exports.effectiveRequired = effectiveRequired;
