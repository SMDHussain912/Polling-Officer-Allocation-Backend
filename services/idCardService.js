/**
 * idCardService — renders the official Polling Duty ID card (PDF, pdfkit) for
 * an allocation and caches it in the IdCard collection.
 *
 * - renderOfficerIdCard(): pure pdfkit rendering officer + booth + allocation
 *   into a landscape card -> Buffer (no database needed; unit-testable).
 * - getOrCreateCard(): loads the allocation (populated), renders the card once
 *   and stores it — later mails/downloads reuse the cached PDF. Race-safe via
 *   the unique allocationId index (duplicate-key -> return the winner).
 * - publicCardUrl(): tokenised link embedded in the SMS so the officer can
 *   download the card from their phone without a session.
 */
const crypto = require('crypto');
const mongoose = require('mongoose');
const PDFDocument = require('pdfkit');
const IdCard = require('../models/IdCard');
const Allocation = require('../models/Allocation');

const CARD_W = 480;
const CARD_H = 300;

const THEME_COLORS = {
  navy: {
    navy: '#0f2a5c',
    accent: '#1d4ed8',
    ink: '#1f2937',
    muted: '#6b7280',
    panel: '#f8fafc',
    border: '#c7d2fe',
    faint: '#93c5fd',
    lightText: '#cbd5f5',
  },
  green: {
    navy: '#14532d',
    accent: '#15803d',
    ink: '#1f2937',
    muted: '#6b7280',
    panel: '#f0fdf4',
    border: '#bbf7d0',
    faint: '#86efac',
    lightText: '#bbf7d0',
  },
  maroon: {
    navy: '#7f1d1d',
    accent: '#b91c1c',
    ink: '#1f2937',
    muted: '#6b7280',
    panel: '#fef2f2',
    border: '#fecaca',
    faint: '#fca5a5',
    lightText: '#fecaca',
  },
  teal: {
    navy: '#134e4a',
    accent: '#0f766e',
    ink: '#1f2937',
    muted: '#6b7280',
    panel: '#f0fdfa',
    border: '#99f6e4',
    faint: '#5eead4',
    lightText: '#99f6e4',
  },
};

const COLORS = THEME_COLORS.navy;

function themeColors(theme) {
  return THEME_COLORS[theme] || THEME_COLORS.navy;
}

function votingHours() {
  return (process.env.VOTING_HOURS || '7:00 AM - 6:00 PM').trim();
}

function electionName() {
  return (process.env.ELECTION_NAME || 'General Elections').trim();
}

function short(value, fallback = '-') {
  const s = String(value ?? '').trim();
  return s || fallback;
}

function clamp(n, min, max, fallback = min) {
  const v = Number(n);
  if (Number.isNaN(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function isHexColor(v) {
  return typeof v === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim());
}

function formatDate(d) {
  const date = d ? new Date(d) : new Date();
  if (Number.isNaN(date.getTime())) return '-';
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

function formatDateTime(d) {
  const date = d ? new Date(d) : new Date();
  if (Number.isNaN(date.getTime())) return '-';
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  return `${formatDate(date)} ${hh}:${mi}`;
}

function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'OF';
  return parts.slice(0, 2).map((p) => p[0].toUpperCase()).join('');
}

function officerAddress(o = {}) {
  return [
    o.houseNo || o.houseNumber || '',
    o.street || '',
    o.locality || '',
    o.ward ? `Ward ${o.ward}` : '',
    o.district || '',
    o.pinCode || '',
  ]
    .filter(Boolean)
    .join(', ');
}

/** Grey uppercase label + single-line (ellipsis-truncated) value pairs. */
function drawRows(doc, rows, x, y, { labelW, rowH, valueW, labelSize = 6.5, valueSize = 8.5 }, C = COLORS) {
  rows.forEach((row, i) => {
    const rowY = y + i * rowH;
    doc.font('Helvetica').fillColor(C.muted).fontSize(labelSize)
      .text(String(row.label).toUpperCase(), x, rowY + 2, { lineBreak: false });
    doc.font('Helvetica').fillColor(C.ink).fontSize(valueSize)
      .text(row.value, x + labelW, rowY, { width: valueW, ellipsis: true, lineBreak: false });
  });
}

/**
 * Every design-controlled value on the card, resolved from officer + booth +
 * allocation + design doc. The editor shows these same labels so the admin
 * knows exactly which line they are switching on/off.
 */
function designValues({ officer = {}, booth = {}, allocation = {} }) {
  const b = booth || {};
  return {
    officerName: short(officer.officerName || officer.name, 'Officer'),
    officerId: short(officer.officerId),
    designation: short(officer.designation),
    mobileNumber: short(officer.mobileNumber),
    email: short(officer.email, 'Not provided'),
    address: officerAddress(officer) || 'Not recorded',
    mandal: short(b.mandal || allocation.mandal || officer.mandal),
    district: short(b.district || officer.district),
    boothNumber: short(b.boothNumber),
    boothName: short(b.boothName),
    building: short(b.buildingName),
    boothLocality: short(b.locality),
    allocationId: `...${String(allocation._id || '').slice(-8)}`,
    allocationDate: formatDate(allocation.allocationDate),
    reportingDate: (process.env.REPORTING_DATE || '').trim() || formatDate(allocation.allocationDate),
    votingHours: votingHours(),
    electionName: electionName(),
  };
}

/** Draws the whole card onto an open pdfkit document (fixed layout). */
/**
 * Draws one freeform element (custom text box OR uploaded signature/stamp
 * image) with drag position + rotation. x/y/width/height are card points;
 * rotation is degrees. Images are PNG/JPEG Buffers decoded from a data-URI.
 */
function drawElement(doc, el) {
  const x = Number(el.x) || 0;
  const y = Number(el.y) || 0;
  const w = Math.max(4, Number(el.width) || 40);
  const h = Math.max(4, Number(el.height) || 40);
  const rot = (Number(el.rotation) || 0) * Math.PI / 180;
  doc.save();
  doc.translate(x + w / 2, y + h / 2);
  if (rot) doc.rotate(rot);
  if (el.type === 'image' && el.src) {
    try {
      const m = /^data:(image\/(?:png|jpeg));base64,(.+)$/i.exec(String(el.src));
      if (m) doc.image(Buffer.from(m[2], 'base64'), -w / 2, -h / 2, { width: w, height: h });
    } catch { /* ignore a corrupt image rather than failing the whole card */ }
  } else {
    const size = Math.max(3, Number(el.fontSize) || 12);
    const font = el.fontWeight === 'bold' ? 'Helvetica-Bold' : 'Helvetica';
    doc.font(font).fontSize(size).fillColor(el.color || '#000000')
      .text(String(el.text || ''), -w / 2, -size / 2, {
        width: w, height: h, align: el.align || 'left', lineBreak: true,
      });
  }
  doc.restore();
}

/** Optional faint diagonal watermark across the middle of the card. */
function drawWatermark(doc, text) {
  const wm = String(text || '').trim();
  if (!wm) return;
  doc.save();
  doc.fillColor('#000000');
  if (typeof doc.opacity === 'function') doc.opacity(0.10);
  doc.font('Helvetica-Bold').fontSize(46)
    .text(wm, 0, CARD_H / 2 - 23, { width: CARD_W, align: 'center', lineBreak: false, rotate: 90 });
  doc.restore();
}

function renderCard(doc, { officer = {}, booth = {}, allocation = {}, design = null }) {
  const C = themeColors(design?.theme);
  const D = design || {};
  // Global text-size multiplier (0.7 small .. 1.5 large) for built-in card text.
  const S = (typeof D.baseTextScale === 'number' && D.baseTextScale >= 0.7 && D.baseTextScale <= 1.5)
    ? D.baseTextScale : 1;
  const fs = (n) => +(n * S).toFixed(2);
  const officerFields = Array.isArray(D.officerFields) && D.officerFields.length
    ? D.officerFields
    : [
      { key: 'officerId', label: 'Officer ID', show: true },
      { key: 'designation', label: 'Designation', show: true },
      { key: 'mobileNumber', label: 'Mobile', show: true },
      { key: 'email', label: 'E-mail', show: true },
    ];
  const dutyFields = Array.isArray(D.dutyFields) && D.dutyFields.length
    ? D.dutyFields
    : [
      { key: 'boothNumber', label: 'Booth No.', show: true },
      { key: 'boothName', label: 'Booth Name', show: true },
      { key: 'building', label: 'Building', show: true },
      { key: 'boothLocality', label: 'Locality', show: true },
      { key: 'mandal', label: 'Mandal', show: true },
      { key: 'district', label: 'District', show: true },
      { key: 'allocationDate', label: 'Duty Date', show: true },
      { key: 'allocationId', label: 'Allocation ID', show: true },
    ];
  const V = designValues({ officer, booth, allocation });
  const headerTitle = String(D.headerTitle || 'POLLING DUTY OFFICER ID CARD');
  const headerSubtitle = String(D.headerSubtitle || `${electionName()} - Election Administration`);
  const footerNote = String(D.footerNote || 'Carry this card at all times during polling duty - Election Administration');
  const showPhoto = D.showPhoto !== false;
  const showFooter = D.showFooter !== false;
  // --- header band -------------------------------------------------------
  doc.rect(0, 0, CARD_W, 46).fill(C.navy);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(fs(11))
    .text(headerTitle, 14, 11, { lineBreak: false });
  doc.fillColor(C.lightText).font('Helvetica').fontSize(fs(7))
    .text(headerSubtitle, 14, 27, { lineBreak: false });
  doc.roundedRect(398, 14, 68, 17, 3).fill(C.accent);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(fs(8))
    .text('OFFICIAL', 398, 19, { width: 68, align: 'center', lineBreak: false });

  // --- photo placeholder ---------------------------------------------------
  const fx = showPhoto ? 96 : 14;
  const fw = CARD_W - fx - 14;
  if (showPhoto) {
    doc.lineWidth(1);
    doc.rect(14, 58, 72, 92).fillAndStroke('#eef2ff', '#94a3b8');
    doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(fs(20))
      .text(initialsOf(officer.officerName || officer.name), 14, 88, {
        width: 72, align: 'center', lineBreak: false,
      });
    doc.fillColor(C.muted).font('Helvetica').fontSize(fs(5.5))
      .text('AFFIX RECENT PHOTO', 14, 140, { width: 72, align: 'center', lineBreak: false });
  }

  // --- officer details ------------------------------------------------------
  doc.fillColor(C.muted).font('Helvetica').fontSize(fs(6.5))
    .text('NAME', fx, 58, { lineBreak: false });
  doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(fs(11))
    .text(short(officer.officerName || officer.name, 'Officer'), fx, 66, {
      width: fw, ellipsis: true, lineBreak: false,
    });

  drawRows(
    doc,
    officerFields.filter((f) => f.show !== false).slice(0, 5).map((f) => ({ label: f.label || f.key, value: V[f.key] ?? '-' })),
    fx,
    86,
    { labelW: 58, rowH: 13, valueW: fw - 58, labelSize: fs(6.5), valueSize: fs(8.5) },
    C
  );

  doc.fillColor(C.muted).font('Helvetica').fontSize(fs(6.5))
    .text('RESIDENTIAL ADDRESS', fx, 139, { lineBreak: false });
  doc.fillColor(C.ink).font('Helvetica').fontSize(fs(7.5))
    .text(officerAddress(officer) || 'Not recorded', fx, 147, {
      width: fw, height: 18, ellipsis: true,
    });

  // --- duty allocation panel -------------------------------------------------
  doc.roundedRect(14, 178, CARD_W - 28, 92, 4).fillAndStroke(C.panel, C.border);
  doc.fillColor(C.accent).font('Helvetica-Bold').fontSize(fs(8))
    .text('DUTY ALLOCATION', 24, 186, { lineBreak: false });

  const visibleDuty = dutyFields.filter((f) => f.show !== false).slice(0, 8)
    .map((f) => ({ label: f.label || f.key, value: V[f.key] ?? '-' }));
  const leftDuty = visibleDuty.slice(0, 4);
  const rightDuty = visibleDuty.slice(4, 8);

  drawRows(doc, leftDuty, 24, 202, { labelW: 62, rowH: 16, valueW: 150, labelSize: fs(6.5), valueSize: fs(8.5) }, C);
  drawRows(doc, rightDuty, 240, 202, { labelW: 62, rowH: 16, valueW: 150, labelSize: fs(6.5), valueSize: fs(8.5) }, C);

  // --- stamp (optional round seal on the duty panel) --------------------------
  if (D.showStamp !== false) {
    const stampText = String(D.stampText || 'ELECTION DUTY');
    doc.lineWidth(1.2).strokeColor(C.accent).circle(428, 232, 26).stroke();
    doc.fillColor(C.accent).font('Helvetica-Bold').fontSize(fs(5.5))
      .text(stampText, 404, 224, { width: 48, align: 'center' });
  }
  // --- signature (optional, bottom-right of duty panel) -----------------------
  if (D.signatureName) {
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(fs(7))
      .text(String(D.signatureName), 300, 244, { width: 160, align: 'right', lineBreak: false });
    if (D.signatureTitle) {
      doc.fillColor(C.muted).font('Helvetica').fontSize(fs(6))
        .text(String(D.signatureTitle), 300, 253, { width: 160, align: 'right', lineBreak: false });
    }
  }

  // --- watermark + freeform custom text / uploaded signature+stamp images ------
  drawWatermark(doc, D.watermark);
  if (Array.isArray(D.elements)) {
    for (const el of D.elements) {
      if (el && el.show !== false) drawElement(doc, el);
    }
  }

  // --- footer band ------------------------------------------------------------
  if (showFooter) {
    doc.rect(0, CARD_H - 30, CARD_W, 30).fill(C.navy);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(fs(8.5))
      .text(`VOTING DUTY TIMING: ${votingHours()}`, 14, CARD_H - 22, { lineBreak: false });
    doc.fillColor(C.faint).font('Helvetica').fontSize(fs(5.5))
      .text(footerNote, 14, CARD_H - 10, {
        lineBreak: false,
      });
    doc.fillColor(C.lightText).font('Helvetica').fontSize(fs(5.5))
      .text(`Generated: ${formatDateTime(new Date())}`, CARD_W - 154, CARD_H - 22, {
        width: 140, align: 'right', lineBreak: false,
      });
  }
}

/**
 * Renders the ID card PDF for a (populated) allocation-like object.
 * Returns a Promise<Buffer>.
 */
function renderOfficerIdCard(payload = {}) {
  return new Promise((resolve, reject) => {
    let doc;
    try {
      doc = new PDFDocument({
        size: [CARD_W, CARD_H],
        margin: 0,
        info: {
          Title: `Polling Duty ID Card - ${payload.officer?.officerId || 'Officer'}`,
          Author: 'Election Administration',
          Creator: 'polling-officer',
        },
      });
    } catch (err) {
      return reject(err);
    }
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      renderCard(doc, payload);
      doc.end();
    } catch (err) {
      try { doc.end(); } catch { /* already closed */ }
      reject(err);
    }
  });
}

/**
 * Loads the allocation (populated) and returns its cached IdCard document,
 * generating + storing the PDF on first use.
 * The active IdCardDesign is read at generation time; old cached cards keep
 * their original look until regenerated with force:true (design "apply").
 */
async function getOrCreateCard(allocationId, { force = false } = {}) {
  if (!mongoose.Types.ObjectId.isValid(String(allocationId || ''))) {
    throw Object.assign(new Error('Invalid allocation id'), { statusCode: 400 });
  }

  if (!force) {
    const existing = await IdCard.findOne({ allocationId });
    if (existing) return existing;
  }

  const allocation = await Allocation.findById(allocationId)
    .populate(
      'officer',
      'officerId officerName name designation mobileNumber email houseNo houseNumber street locality ward mandalId mandal district pinCode'
    )
    .populate('booth', 'boothNumber boothName buildingName locality ward mandal district');

  if (!allocation) {
    throw Object.assign(new Error('Allocation not found'), { statusCode: 404 });
  }
  if (!allocation.officer) {
    throw Object.assign(new Error('Allocation has no officer record'), { statusCode: 400 });
  }
  if (allocation.status !== 'ALLOCATED') {
    throw Object.assign(
      new Error('ID card can only be issued for an ALLOCATED officer'),
      { statusCode: 409 }
    );
  }

  let design = null;
  try {
    design = await require('../models/IdCardDesign').getDesign();
  } catch { design = null; }

  const pdf = await renderOfficerIdCard({
    officer: allocation.officer,
    booth: allocation.booth || {},
    allocation,
    design,
  });
  const filename = `ID-Card-${short(allocation.officer.officerId, 'officer')}.pdf`;

  try {
    return await IdCard.create({
      allocationId: allocation._id,
      officer: allocation.officer._id,
      pdf,
      filename,
      downloadToken: crypto.randomBytes(24).toString('hex'),
    });
  } catch (err) {
    // Lost a create race (unique allocationId index) -> reuse the winner.
    if (err && err.code === 11000) {
      const existing = await IdCard.findOne({ allocationId });
      if (existing) return existing;
    }
    throw err;
  }
}

/**
 * Public (token-gated) URL for a stored card, embedded in the SMS so the
 * officer can download the PDF from a phone without an admin session.
 */
function publicCardUrl(card) {
  const base = (
    process.env.PUBLIC_BASE_URL ||
    `http://localhost:${process.env.PORT || 5002}`
  ).replace(/\/+$/, '');
  return `${base}/api/idcards/pdf/${card._id}?token=${card.downloadToken}`;
}

module.exports = {
  renderOfficerIdCard,
  renderCard,
  getOrCreateCard,
  publicCardUrl,
  designValues,
  themeColors,
};
