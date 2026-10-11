const mongoose = require('mongoose');

const ALLOCATION_STATUSES = ['ALLOCATED', 'CANCELLED', 'REALLOCATED'];
const ACTIVE_ALLOCATION_STATUSES = ['ALLOCATED'];

const allocationSchema = new mongoose.Schema(
  {
    allocationId: { type: String, required: true, unique: true, trim: true },
    officer: { type: mongoose.Schema.Types.ObjectId, ref: 'Officer', required: true },
    officerId: { type: String, trim: true, default: '' },
    booth: { type: mongoose.Schema.Types.ObjectId, ref: 'Booth' },
    boothId: { type: String, trim: true, default: '' },
    mandal: { type: String, trim: true, default: '' },
    status: { type: String, enum: ALLOCATION_STATUSES, default: 'ALLOCATED' },
    allocationReason: { type: String, trim: true, default: '' },
    isFallback: { type: Boolean, default: false },
    fallbackReason: { type: String, trim: true, default: '' },
    newBoothId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booth', default: null },
    allocationDate: { type: Date, default: Date.now },
    addressMatchScore: { type: Number, default: 0, min: 0, max: 100 },
    addressValidationReason: { type: String, default: '' },
    rejectedReasons: { type: [String], default: [] },
    adminApproved: { type: Boolean, default: true },
    allocatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    approvedAt: { type: Date },
    allocatedAt: { type: Date },
    cancelledAt: { type: Date },
    reallocatedAt: { type: Date },
    previousAllocationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Allocation', default: null },
  },
  { timestamps: true }
);
allocationSchema.index(
  { officer: 1 },
  { unique: true, partialFilterExpression: { status: { $nin: ['CANCELLED', 'REALLOCATED'] } } }
);
allocationSchema.index({ status: 1 });
allocationSchema.index({ mandal: 1 });
allocationSchema.index({ booth: 1 });

allocationSchema.statics.ACTIVE_ALLOCATION_STATUSES = ACTIVE_ALLOCATION_STATUSES;
allocationSchema.statics.ALLOCATION_STATUSES = ALLOCATION_STATUSES;

module.exports = mongoose.models.Allocation || mongoose.model('Allocation', allocationSchema);
