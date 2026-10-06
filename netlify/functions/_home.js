// ============================================================
// REVIVE CAFE JOBS - Where does the applicant live, and how far away?
//
// locate(applicationId, opts) reads the applicant's address from the
// interview form ("Current residential address") or, failing that, the CV,
// works out the suburb, geocodes it (OpenStreetMap Nominatim) and measures
// the road distance to Revive Cafe (OSRM). Writes jobs.applications.home_*.
//
// The form address always beats the CV: once home_source = 'form', a CV
// re-analysis never overwrites it.
// No npm packages (revive-jobs has no package.json) - fetch only.
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SVC_KEY;
const CLAUDE_API_KEY = process.env.CLAUDE_KEY;
const MODEL = 'claude-haiku-4-5-20251001';

// Revive Cafe, 24 Wyndham St, Auckland CBD (geocoded 7 Oct 2026).
const CAFE = { lat: -36.8472542, lng: 174.7647376 };
const UA = 'ReviveJobs/1.0 (jobs@revive.co.nz)';

function svc(extra) {
  return Object.assign({
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    'Accept-Profile': 'jobs',
    'Content-Profile': 'jobs'
  }, extra || {});
}

function withTimeout(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
}

// The interview form stores answers as {"q1":{"question","answer"},...}.
function formAddress(app) {
  let notes = app.interview_notes;
  if (!notes) return '';
  try { if (typeof notes === 'string') notes = JSON.parse(notes); } catch { return ''; }
  for (const v of Object.values(notes || {})) {
    if (v && /residential address|home address|where do you live/i.test(v.question || '')) {
      const a = String(v.answer || '').trim();
      if (a && !/^(n\/?a|none|-)$/i.test(a)) return a;
    }
  }
  return '';
}

function cvText(app) {
  const docs = Array.isArray(app.documents) ? app.documents : [];
  const docText = docs.map(d => (d && d.text) || '').filter(Boolean).join('\n\n');
  // Addresses sit in the CV header; the first part is all we need.
  return [app.resume_text, docText].filter(Boolean).join('\n\n').trim().slice(0, 3500);
}

async function extract({ address, cv }) {
  const input = address
    ? `The applicant typed this as their CURRENT RESIDENTIAL ADDRESS:\n${address}`
    : `CV text (the applicant's contact details are usually at the top):\n${cv}`;
  const prompt = `${input}

Work out where this job applicant LIVES. Use only their own home address or the place they say they live
(e.g. "Based in Mt Albert", a postal address in the header). Do NOT use the locations of employers,
schools or past jobs. If nothing says where they live now, return nulls.

Return ONLY JSON, no markdown:
{"address": "<their address as written, else null>",
 "suburb": "<suburb, e.g. Grafton, Mt Albert, Manurewa - else null>",
 "city": "<town or city, e.g. Auckland, Hamilton - else null>",
 "country": "<country name if clearly outside New Zealand, else \\"New Zealand\\">"}`;
  const t = withTimeout(20000);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: t.signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 300, messages: [{ role: 'user', content: prompt }] })
    });
    if (!r.ok) throw new Error('Claude ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const j = await r.json();
    const text = (j.content && j.content[0] && j.content[0].text) || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no JSON');
    const a = JSON.parse(m[0]);
    return { address: clean(a.address), suburb: clean(a.suburb), city: clean(a.city), country: clean(a.country) || 'New Zealand' };
  } finally { t.done(); }
}

function clean(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || /^(null|none|n\/?a|unknown|not stated|not provided)$/i.test(s)) return null;
  return s.slice(0, 200);
}

// Nominatim allows 1 request a second. Calls are queued one at a time across
// the whole process, so parallel resolves (the backfill) still keep the pace.
let lastGeo = 0;
let geoChain = Promise.resolve();
const geoCache = new Map();
function geocode(q, nzOnly) {
  const run = geoChain.then(() => geocodeNow(q, nzOnly));
  geoChain = run.catch(() => null);
  return run;
}
async function geocodeNow(q, nzOnly) {
  const key = (nzOnly ? 'nz|' : '*|') + q.toLowerCase();
  if (geoCache.has(key)) return geoCache.get(key);
  const wait = 1100 - (Date.now() - lastGeo);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastGeo = Date.now();
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=1'
    + (nzOnly ? '&countrycodes=nz' : '') + '&q=' + encodeURIComponent(q);
  const t = withTimeout(10000);
  let hit = null;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' }, signal: t.signal });
    if (r.ok) {
      const rows = await r.json();
      if (Array.isArray(rows) && rows[0]) hit = rows[0];
    }
  } catch (e) { console.error('geocode failed', q, e.message); }
  finally { t.done(); }
  geoCache.set(key, hit);
  return hit;
}

function haversineKm(a, b) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function driveKm(from) {
  const t = withTimeout(10000);
  try {
    const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${CAFE.lng},${CAFE.lat}?overview=false`,
      { headers: { 'User-Agent': UA }, signal: t.signal });
    if (!r.ok) return null;
    const j = await r.json();
    const m = j && j.routes && j.routes[0] && j.routes[0].distance;
    return Number.isFinite(m) ? m / 1000 : null;
  } catch { return null; }
  finally { t.done(); }
}

function suburbFrom(hit) {
  const a = (hit && hit.address) || {};
  return a.suburb || a.village || a.town || a.hamlet || a.city_district || a.neighbourhood || a.city || null;
}

// Work out the home_* fields for one application row (needs interview_notes,
// resume_text, documents). Returns the patch; never throws for "not found".
async function resolve(app) {
  const address = formAddress(app);
  const cv = address ? '' : cvText(app);
  const base = { home_located_at: new Date().toISOString() };
  if (!address && !cv) return { ...base, home_source: null };

  const x = await extract({ address, cv });
  const source = address ? 'form' : 'cv';
  if (!x.address && !x.suburb && !x.city) {
    return { ...base, home_source: source, home_address: null, home_suburb: null, home_city: null,
      home_lat: null, home_lng: null, home_km: null, home_km_kind: null };
  }
  const nz = !x.country || /new zealand|aotearoa|^nz$/i.test(x.country);
  // "Auckland" given as the suburb is really just the city - no suburb known.
  if (x.suburb && /^(auckland|akl|auckland city)$/i.test(x.suburb)) { x.city = x.city || 'Auckland'; x.suburb = null; }

  // Most precise first: full address, then suburb + city, then city alone.
  const tries = [];
  if (x.address && /\d/.test(x.address)) tries.push({ q: x.address, level: 'street' });
  if (x.suburb) tries.push({ q: [x.suburb, x.city, nz ? 'New Zealand' : x.country].filter(Boolean).join(', '), level: 'suburb' });
  if (x.address && !/\d/.test(x.address)) tries.push({ q: x.address, level: 'suburb' });
  if (x.city) tries.push({ q: [x.city, nz ? 'New Zealand' : x.country].join(', '), level: 'city' });

  let hit = null, level = null;
  for (const t of tries) {
    hit = await geocode(t.q, nz);
    if (hit) { level = t.level; break; }
  }

  const patch = {
    ...base, home_source: source, home_address: x.address,
    home_suburb: x.suburb || (hit && level !== 'city' ? suburbFrom(hit) : null),
    home_city: x.city || (hit && hit.address && (hit.address.city || hit.address.town)) || (nz ? null : x.country),
    home_lat: null, home_lng: null, home_km: null, home_km_kind: null
  };
  if (!hit) return patch;

  const at = { lat: Number(hit.lat), lng: Number(hit.lon) };
  patch.home_lat = at.lat; patch.home_lng = at.lng;
  const inNz = (hit.address && hit.address.country_code) === 'nz';
  if (!inNz) { patch.home_km_kind = 'overseas'; return patch; }
  // "Auckland" alone lands on the CBD and would read as ~1 km - meaningless.
  if (level === 'city' && /auckland/i.test(x.city || '')) return patch;

  const d = await driveKm(at);
  if (d !== null) { patch.home_km = Math.round(d * 10) / 10; patch.home_km_kind = 'drive'; }
  else { patch.home_km = Math.round(haversineKm(at, CAFE) * 10) / 10; patch.home_km_kind = 'straight'; }
  return patch;
}

// Load, resolve and save one application. opts.cvOnly: called after a CV
// re-analysis - skip if the form address is already in use.
async function locate(applicationId, opts = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !CLAUDE_API_KEY) return { ok: false, reason: 'not configured' };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/applications?id=eq.${encodeURIComponent(applicationId)}`
    + '&select=id,interview_notes,resume_text,documents,home_source', { headers: svc() });
  const rows = await r.json().catch(() => []);
  const app = Array.isArray(rows) && rows[0];
  if (!app) return { ok: false, reason: 'not found' };
  if (opts.cvOnly && app.home_source === 'form') return { ok: true, skipped: 'form address already used' };
  const patch = await resolve(app);
  const u = await fetch(`${SUPABASE_URL}/rest/v1/applications?id=eq.${encodeURIComponent(applicationId)}`, {
    method: 'PATCH', headers: svc({ Prefer: 'return=minimal' }), body: JSON.stringify(patch)
  });
  if (!u.ok) throw new Error('save failed ' + u.status + ' ' + (await u.text()).slice(0, 200));
  return { ok: true, ...patch };
}

module.exports = { locate, resolve, CAFE };
