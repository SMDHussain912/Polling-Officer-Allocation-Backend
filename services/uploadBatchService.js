const UploadBatch = require('../models/UploadBatch');
const Officer = require('../models/Officer');
const Booth = require('../models/Booth');

/** Model backing each UploadBatch kind. */
const KIND_MODELS = { officers: Officer, booths: Booth };

/**
 * Removes UploadBatch records ("uploaded files") whose imported rows were ALL
 * deleted from the database. Called after a bulk delete so the upload history
 * stays truthful: when every row of a file is gone, the file entry is gone too.
 * Batches that still contain at least one live record (e.g. rows re-imported
 * from another file) are always kept.
 *
 * @param {'officers'|'booths'} kind - which upload kind to prune
 * @returns {Promise<number>} number of batch records removed
 */
async function pruneUploadBatches(kind) {
  const Model = KIND_MODELS[kind];
  if (!Model) return 0;

  const batches = await UploadBatch.find({ kind }).select('_id recordIds').lean();
  let pruned = 0;

  for (const batch of batches) {
    const recordIds = (batch.recordIds || []).filter(Boolean);
    if (recordIds.length === 0) continue; // keep batches without references

    // eslint-disable-next-line no-await-in-loop
    const stillAlive = await Model.countDocuments({ _id: { $in: recordIds } });
    if (stillAlive === 0) {
      // eslint-disable-next-line no-await-in-loop
      await UploadBatch.deleteOne({ _id: batch._id });
      pruned += 1;
    }
  }

  return pruned;
}

module.exports = { pruneUploadBatches };
