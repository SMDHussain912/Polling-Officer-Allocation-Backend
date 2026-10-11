/**
 * templateService.js
 * ==================
 * Tiny {{variable}} renderer shared by SMS / Email / WhatsApp.
 * Keeps rendering server-side so the frontend never builds provider payloads.
 */

function templateVars(allocation, extra = {}) {
  const o = (allocation && allocation.officer) || {};
  const b = (allocation && allocation.booth) || {};
  return {
    officerName: o.officerName || o.name || 'Officer',
    officerId: o.officerId || '',
    designation: o.designation || '',
    mobileNumber: o.mobileNumber || '',
    email: o.email || '',
    boothNumber: b.boothNumber || '',
    boothName: b.boothName || '',
    building: b.buildingName || '',
    locality: b.locality || '',
    mandal: allocation?.mandal || b.mandal || o.mandal || '',
    district: b.district || o.district || '',
    allocationId: allocation?.allocationId || '',
    allocationStatus: allocation?.status || '',
    reportingDate: extra.reportingDate || process.env.REPORTING_DATE || '',
    cardUrl: extra.cardUrl || '',
    electionName: process.env.ELECTION_NAME || 'General Elections',
    votingHours: process.env.VOTING_HOURS || '7:00 AM - 6:00 PM',
    helpline: process.env.ELECTION_HELPLINE || '',
  };
}

/** Replace {{key}} tokens. Unknown keys are left untouched. */
function renderTemplate(text, vars) {
  if (!text) return '';
  return String(text).replace(/{{\s*([\w.]+)\s*}}/g, (m, key) => {
    const v = vars[key];
    return v === undefined || v === null ? m : String(v);
  });
}

/** List {{variables}} used in a template string. */
function listVariables(text) {
  const found = new Set();
  String(text || '').replace(/{{\s*([\w.]+)\s*}}/g, (m, key) => {
    found.add(key);
    return m;
  });
  return [...found];
}

module.exports = { templateVars, renderTemplate, listVariables };
