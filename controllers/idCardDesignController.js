/**
 * idCardDesignController.js (part 1)
 * Backend for the "ID Card Designer" page.
 */

const multer = require('multer');

const {
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
} = require('../models/IdCardDesign');
const idCardService = require('../services/idCardService');

function samplePayload() {
  return {
    officer: {
      officerName: 'Ravi Kumar',
      officerId: 'OFF001',
      designation: 'School Assistant',
      mobileNumber: '98765 43210',
      email: 'ravi.kumar@example.gov',
      houseNo: '12-34',
      street: 'Main Road',
      locality: 'Gandhi Nagar',
      mandal: 'Guntur East',
      district: 'Guntur',
    },
    booth: {
      boothNumber: '123',
      boothName: 'ZPH School, Room 2',
      buildingName: 'ZPH School',
      locality: 'Main Road',
      mandal: 'Guntur East',
      district: 'Guntur',
    },
    allocation: { _id: '000000000000000000000001', allocationDate: new Date('2026-05-10T07:00:00') },
  };
}

function cleanFields(list, defaults) {
  if (!Array.isArray(list) || !list.length) return defaults;
  const out = [];
  for (const item of list.slice(0, 12)) {
    const key = String(item?.key || '').trim();
    if (!FIELD_CHOICES.includes(key)) continue;
    out.push({ key, label: String(item?.label || key).slice(0, 40), show: item?.show !== false });
  }
  return out.length ? out : defaults;
}

const clamp = (n, min, max, dflt) => {
  const v = Number(n);
  if (Number.isNaN(v)) return dflt;
  return Math.min(max, Math.max(min, v));
};

/**
 * Sanitises freeform elements server-side: bounds every position/size to the
 * card, clamps rotation (-180..180) and font (4..72), keeps only known enum
 * values, and caps the count. Image src is only ever a validated PNG/JPEG
 * data-URI produced by uploadIdCardAsset.
 */
function cleanElements(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const el of list.slice(0, MAX_ELEMENTS)) {
    const type = el?.type === 'image' ? 'image' : 'text';
    const item = {
      id: String(el?.id || '').slice(0, 40) || undefined,
      type,
      show: el?.show !== false,
      x: clamp(el?.x, 0, CARD_W, 24),
      y: clamp(el?.y, 0, CARD_H, 24),
      width: clamp(el?.width, 4, CARD_W, 160),
      height: clamp(el?.height, 4, CARD_H, 40),
      rotation: clamp(el?.rotation, -180, 180, 0),
    };
    if (type === 'image') {
      const src = String(el?.src || '');
      if (!/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=\s]+$/.test(src)) continue;
      item.src = src.replace(/\s+/g, '');
    } else {
      item.text = String(el?.text || '').slice(0, 300);
      item.fontSize = clamp(el?.fontSize, 4, 72, 12);
      item.color = /^#[0-9a-fA-F]{6}$/.test(String(el?.color || '')) ? String(el.color) : '#000000';
      item.fontWeight = el?.fontWeight === 'bold' ? 'bold' : 'normal';
      item.align = ['left', 'center', 'right'].includes(el?.align) ? el.align : 'left';
    }
    out.push(item);
  }
  return out;
}

// In-memory upload (image is base64-encoded straight into the design doc).
const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_IMAGE_MIME.includes(file.mimetype)) {
      return cb(Object.assign(new Error('Only PNG or JPEG images are allowed'), { statusCode: 400 }), false);
    }
    cb(null, true);
  },
}).single('image');

async function getIdCardDesign(req, res, next) {
  try {
    const design = await getDesign();
    res.json({
      success: true,
      data: { design, fieldChoices: FIELD_CHOICES, themes: THEMES, values: idCardService.designValues(samplePayload()) },
    });
  } catch (error) {
    next(error);
  }
}

async function saveIdCardDesign(req, res, next) {
  try {
    const b = req.body || {};
    const patch = { updatedBy: req.user?.id || null };
    if (b.theme !== undefined) {
      if (!THEMES.includes(b.theme)) return res.status(400).json({ success: false, message: 'Invalid color theme' });
      patch.theme = b.theme;
    }
    if (b.headerTitle !== undefined) patch.headerTitle = String(b.headerTitle).slice(0, 120);
    if (b.headerSubtitle !== undefined) patch.headerSubtitle = String(b.headerSubtitle).slice(0, 200);
    if (b.footerNote !== undefined) patch.footerNote = String(b.footerNote).slice(0, 500);
    if (b.stampText !== undefined) patch.stampText = String(b.stampText).slice(0, 60);
    if (b.signatureName !== undefined) patch.signatureName = String(b.signatureName).slice(0, 120);
    if (b.signatureTitle !== undefined) patch.signatureTitle = String(b.signatureTitle).slice(0, 120);
    for (const flag of ['showPhoto', 'showStamp', 'showFooter']) {
      if (b[flag] !== undefined) patch[flag] = b[flag] !== false;
    }
    if (b.baseTextScale !== undefined) patch.baseTextScale = clamp(b.baseTextScale, 0.7, 1.5, 1);
    if (b.watermark !== undefined) patch.watermark = String(b.watermark).slice(0, 40);
    if (b.elements !== undefined) patch.elements = cleanElements(b.elements);
    if (b.officerFields !== undefined) patch.officerFields = cleanFields(b.officerFields, DEFAULT_OFFICER_FIELDS);
    if (b.dutyFields !== undefined) patch.dutyFields = cleanFields(b.dutyFields, DEFAULT_DUTY_FIELDS);
    const saved = await IdCardDesign.findOneAndUpdate(
      { key: 'active' },
      { $set: patch, $setOnInsert: { key: 'active' } },
      { upsert: true, new: true, runValidators: true }
    );
    res.json({ success: true, message: 'ID card design saved', data: saved });
  } catch (error) {
    next(error);
  }
}

/**
 * Uploads a signature/stamp/emblem image and returns a validated PNG/JPEG
 * data-URI the designer stores inside an image element. The raw file never
 * touches disk; the 400KB cap keeps the design doc small.
 */
function uploadIdCardAsset(req, res, next) {
  uploadImage(req, res, (err) => {
    if (err) return res.status(err.statusCode || 400).json({ success: false, message: err.message || 'Upload failed' });
    if (!req.file) return res.status(400).json({ success: false, message: 'No image file received' });
    const dataUri = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    res.json({ success: true, data: { src: dataUri, bytes: req.file.size, mime: req.file.mimetype } });
  });
}

module.exports = { getIdCardDesign, saveIdCardDesign, samplePayload };

/** Live PDF preview with sample officer data (admin session only). */
async function previewIdCardPdf(req, res, next) {
  try {
    const idCardService = require('../services/idCardService');
    const { getDesign, THEMES } = require('../models/IdCardDesign');
    const { samplePayload } = require('./idCardDesignController');
    let design = await getDesign();
    if (req.query.theme && THEMES.includes(req.query.theme)) design = { ...design, theme: req.query.theme };
    const pdf = await idCardService.renderOfficerIdCard({ ...samplePayload(), design });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="ID-Card-preview.pdf"');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(pdf);
  } catch (error) {
    next(error);
  }
}

async function resetIdCardDesign(req, res, next) {
  try {
    const { IdCardDesign, getDesign } = require('../models/IdCardDesign');
    await IdCardDesign.deleteOne({ key: 'active' });
    const design = await getDesign();
    res.json({ success: true, message: 'Design restored to defaults', data: design });
  } catch (error) {
    next(error);
  }
}

module.exports.previewIdCardPdf = previewIdCardPdf;
module.exports.resetIdCardDesign = resetIdCardDesign;
module.exports.uploadIdCardAsset = uploadIdCardAsset;
