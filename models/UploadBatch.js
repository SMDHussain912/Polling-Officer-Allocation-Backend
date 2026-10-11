const mongoose = require('mongoose');

/**
 * UploadBatch
 * ===========
 * Records one committed Excel import ("uploaded file"). Keeping the
 * fileName, the inserted record references and counts lets the admin
 * see every uploaded file in a history list and delete a complete
 * batch (file + its imported data) from the database in one action.
 */
const uploadBatchSchema = new mongoose.Schema(
  {
    fileName: { type: String, required: true },
    kind: { type: String, enum: ['officers', 'booths'], required: true },
    inserted: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 },
    // Human-readable unique ids of the inserted records (officerId / boothId).
    recordRefs: { type: [String], default: [] },
    // Mongo _ids of the inserted records - used for the cascade delete.
    recordIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    uploadedByUsername: { type: String, default: '' },
  },
  { timestamps: true }
);

uploadBatchSchema.index({ createdAt: -1 });

module.exports =
  mongoose.models.UploadBatch || mongoose.model('UploadBatch', uploadBatchSchema);