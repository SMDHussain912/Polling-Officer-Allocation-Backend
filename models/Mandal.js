const mongoose = require('mongoose');

/**
 * Mandal model
 * =============
 * A Mandal (sub-district / revenue division) that contains booths and
 * officers. The Super Admin creates Mandals and then creates a Mandal Admin
 * login account for each Mandal.
 *
 * Fields:
 *   mandalId    - human readable unique code (e.g. PEDDAPURAM)
 *   mandalName  - display name (e.g. Peddapuram)
 *   district    - district the Mandal belongs to
 *   state       - state the Mandal belongs to
 *   isActive    - deactivated Mandals cannot be used for new allocations
 *   createdBy   - Admin who created this Mandal
 */
const mandalSchema = new mongoose.Schema(
  {
    mandalId: {
      type: String,
      required: [true, 'Mandal ID is required'],
      unique: true,
      trim: true,
      uppercase: true,
    },
    mandalName: {
      type: String,
      required: [true, 'Mandal Name is required'],
      unique: true,
      trim: true,
    },
    district: { type: String, trim: true, default: '' },
    state: { type: String, trim: true, default: '' },
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  },
  { timestamps: true }
);

// Case-insensitive name lookups (login / allocation scoping).
mandalSchema.index({ mandalName: 1 });
mandalSchema.index({ district: 1 });

module.exports = mongoose.models.Mandal || mongoose.model('Mandal', mandalSchema);