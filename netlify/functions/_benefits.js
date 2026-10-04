// Two company benefit lists live in jobs.settings:
//
//   company_benefits_optional — one per line. Every one is ON by default; an
//                               individual ad can switch lines off (e.g. a
//                               night-shift role cannot offer "No weekend work").
//   company_benefits          — one per line. Applies to every ad, always.
//
// The per-ad exclusions are stored on jobs.jobs.benefits_off (jsonb array of the
// exact optional lines that are switched off for that job).
//
// Matching is case/whitespace-insensitive so that re-typing a benefit with a
// stray space in Settings does not silently switch it back on everywhere.

const SETTINGS_KEYS = ['company_benefits', 'company_benefits_optional'];

function parseList(value) {
  return String(value || '')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
}

const norm = s => String(s || '').trim().toLowerCase();

// Optional benefits (minus the ones this ad switches off) first, because they
// are the lines that differ between ads, then the ones every ad carries.
function benefitsFor(settings, job) {
  const raw = job && job.benefits_off;
  const off = new Set((Array.isArray(raw) ? raw : []).map(norm));
  const optional = parseList((settings || {}).company_benefits_optional)
    .filter(b => !off.has(norm(b)));
  return optional.concat(parseList((settings || {}).company_benefits));
}

function benefitsTextFor(settings, job) {
  return benefitsFor(settings, job).join('\n');
}

module.exports = { SETTINGS_KEYS, parseList, benefitsFor, benefitsTextFor };
