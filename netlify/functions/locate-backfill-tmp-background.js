// TEMPORARY (7 Oct 2026) - one-off backfill of jobs.applications.home_* for
// existing applicants. Guarded by a hashed one-time secret (STACK.md 3b).
// Delete after use.
const crypto = require('crypto');
const { resolve } = require('./_home');
const H = 'af39ffb94e17412d6396e87f814ba38d29f2c8a6858dbf231e9f18c841e4c478';
const URL_ = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SVC_KEY;
const hdr = (x) => Object.assign({ apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json',
  'Accept-Profile': 'jobs', 'Content-Profile': 'jobs' }, x || {});
exports.handler = async (event) => {
  const k = String((event.queryStringParameters || {}).k || '');
  const got = crypto.createHash('sha256').update(k).digest();
  if (!crypto.timingSafeEqual(got, Buffer.from(H, 'hex'))) return { statusCode: 403, body: 'nope' };
  const only = (event.queryStringParameters || {}).id;
  const t0 = Date.now();
  let done = 0, failed = 0;
  while (Date.now() - t0 < 12.5 * 60 * 1000) {
    const q = only ? 'id=eq.' + encodeURIComponent(only)
      : 'home_located_at=is.null&status=neq.deleted&order=created_at.desc&limit=5';
    const r = await fetch(URL_ + '/rest/v1/applications?' + q + '&select=id,interview_notes,resume_text,documents', { headers: hdr() });
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) break;
    await Promise.all(rows.map(async (app) => {
      let patch;
      try { patch = await resolve(app); }
      catch (e) { failed++; console.error('resolve', app.id, e.message); patch = { home_located_at: new Date().toISOString(), home_source: 'error' }; }
      const u = await fetch(URL_ + '/rest/v1/applications?id=eq.' + app.id, { method: 'PATCH', headers: hdr({ Prefer: 'return=minimal' }), body: JSON.stringify(patch) });
      if (u.ok) done++; else { failed++; console.error('save', app.id, u.status, await u.text()); }
    }));
    if (only) break;
  }
  console.log('locate backfill', { done, failed, secs: Math.round((Date.now() - t0) / 1000) });
  return { statusCode: 200, body: 'ok' };
};
