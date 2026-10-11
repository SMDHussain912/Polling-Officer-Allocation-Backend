const mongoose = require('mongoose');

/**
 * IdCardDesign — the SINGLE active ID-card design, edited in the visual
 * "ID Card Designer" page. Only ONE row ever exists (key: 'active').
 *
 * Everything is plain data (texts, on/off switches, colors from preset list)
 * so a 2015-batch admin edits it like a form — zero code, zero drag-drop.
 * The PDF renderer (idCardService) reads this; missing doc => safe defaults.
 *
 * Blocks (each can be shown/hidden + text edited):
 *   headerTitle/headerSubtitle top navy band
 *   officerFields / dutyFields  left & right panels (field keys from allowlist)
 *   footerNote                  bottom strip
 *   stampText                   round stamp
 *   showPhoto/showStamp/showFooter toggles + preset color theme
 */

const FIELD_CHOICES = [
  'officerName', 'officerId', 'designation', 'mobileNumber', 'email',
  'address', 'mandal', 'district',
  'boothNumber', 'boothName', 'building', 'boothLocality',
  'allocationId', 'allocationDate', 'reportingDate', 'votingHours', 'electionName',
];

const THEMES = ['navy', 'green', 'maroon', 'teal'];

// Card canvas size in PDF points (kept in sync with idCardService).
const CARD_W = 480;
const CARD_H = 300;

// Freeform "elements" (custom text boxes + uploaded signature/stamp images)
// limits. Kept small so the single design document stays well under MongoDB's
// 16 MB document cap and rendering stays fast.
const MAX_ELEMENTS = 10;
const MAX_IMAGE_BYTES = 400 * 1024; // 400 KB raw
const ALLOWED_IMAGE_MIME = ['image/png', 'image/jpeg'];

/**
 * One freeform element. type 'text' renders a label; type 'image' renders an
 * uploaded PNG/JPEG data-URI (collector signature, official stamp, emblem…).
 * x/y/width/height are in card points (0..CARD_W, 0..CARD_H); rotation in
 * degrees. Admins position these by dragging in the designer.
 */
const elementSchema = new mongoose.Schema(
  {
    id: { type: String, default: () => require('crypto').randomUUID() },
    type: { type: String, enum: ['text', 'image'], required: true },
    show: { type: Boolean, default: true },
    x: { type: Number, default: 24 },
    y: { type: Number, default: 24 },
    width: { type: Number, default: 160 },
    height: { type: Number, default: 40 },
    rotation: { type: Number, default: 0 },
    // text-only
    text: { type: String, default: '', maxlength: 300 },
    fontSize: { type: Number, default: 12, min: 4, max: 72 },
    color: { type: String, default: '#000000' },
    fontWeight: { type: String, enum: ['normal', 'bold'], default: 'normal' },
    align: { type: String, enum: ['left', 'center', 'right'], default: 'left' },
    // image-only
    src: { type: String, default: '' }, // validated data-URI
  },
  { _id: false }
);

const fieldLabelSchema = new mongoose.Schema(
  { key: { type: String, required: true }, label: { type: String, default: '' }, show: { type: Boolean, default: true } },
  { _id: false }
);

const idCardDesignSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'active', unique: true, trim: true },
    theme: { type: String, enum: THEMES, default: 'navy' },
    headerTitle: { type: String, default: 'POLLING DUTY OFFICER ID CARD', maxlength: 120 },
    headerSubtitle: { type: String, default: '', maxlength: 200 },
    footerNote: {
      type: String,
      default: 'Carry this card + a photo ID on polling duty. Report to the Presiding Officer on time.',
      maxlength: 500,
    },
    stampText: { type: String, default: 'ELECTION DUTY', maxlength: 60 },
    signatureName: { type: String, default: '', maxlength: 120 },
    signatureTitle: { type: String, default: '', maxlength: 120 },
    showPhoto: { type: Boolean, default: true },
    showStamp: { type: Boolean, default: true },
    showFooter: { type: Boolean, default: true },
    // Global text-size multiplier for all built-in card text (0.8 small .. 1.4 large).
    baseTextScale: { type: Number, default: 1, min: 0.7, max: 1.5 },
    // Optional diagonal watermark (e.g. election name or "SPECIMEN").
    watermark: { type: String, default: '', maxlength: 40 },
    // Freeform draggable/rotatable text boxes + uploaded signature/stamp images.
    elements: { type: [elementSchema], default: [], validate: [(v) => v.length <= MAX_ELEMENTS, `Max ${MAX_ELEMENTS} elements`] },
    officerFields: { type: [fieldLabelSchema], default: undefined },
    dutyFields: { type: [fieldLabelSchema], default: undefined },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  },
  { timestamps: true }
);

const DEFAULT_OFFICER_FIELDS = [
  { key: 'officerName', label: 'Name', show: true },
  { key: 'officerId', label: 'ID', show: true },
  { key: 'designation', label: 'Designation', show: true },
  { key: 'mobileNumber', label: 'Mobile', show: true },
  { key: 'mandal', label: 'Mandal', show: true },
];

const DEFAULT_DUTY_FIELDS = [
  { key: 'boothNumber', label: 'Booth No', show: true },
  { key: 'boothName', label: 'Booth', show: true },
  { key: 'building', label: 'Building', show: true },
  { key: 'reportingDate', label: 'Report By', show: true },
  { key: 'votingHours', label: 'Poll Hours', show: true },
];

const IdCardDesign =
  mongoose.models.IdCardDesign || mongoose.model('IdCardDesign', idCardDesignSchema);

async function getDesign() {
  const doc = await IdCardDesign.findOne({ key: 'active' }).lean();
  if (doc) {
    return {
      ...doc,
      officerFields: doc.officerFields?.length ? doc.officerFields : DEFAULT_OFFICER_FIELDS,
      dutyFields: doc.dutyFields?.length ? doc.dutyFields : DEFAULT_DUTY_FIELDS,
    };
  }
  return {
    key: 'active',
    theme: 'navy',
    headerTitle: 'POLLING DUTY OFFICER ID CARD',
    headerSubtitle: '',
    footerNote: 'Carry this card + a photo ID on polling duty. Report to the Presiding Officer on time.',
    stampText: 'ELECTION DUTY',
    signatureName: '',
    signatureTitle: '',
    showPhoto: true,
    showStamp: true,
    showFooter: true,
    baseTextScale: 1,
    watermark: '',
    elements: [],
    officerFields: DEFAULT_OFFICER_FIELDS,
    dutyFields: DEFAULT_DUTY_FIELDS,
  };
}

module.exports = {
  IdCardDesign,
  getDesign,
  FIELD_CHOICES,
  THEMES,
  DEFAULT_OFFICER_FIELDS,
  DEFAULT_DUTY_FIELDS,
  CARD_W,
  CARD_H,
  MAX_ELEMENTS,
  MAX_IMAGE_BYTES,
  ALLOWED_IMAGE_MIME,
};
