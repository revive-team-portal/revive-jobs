// Who may call the admin-only jobs functions (5 Nov 2026, portal review).
// - The jobs admin page on team.revive.co.nz: its Revive Apps session is signed in as the jobs admin
//   account, sent as `Authorization: Bearer <token>` (or `token` in the body for no-cors calls).
// - This site's own functions calling each other server-side (submit-application → send-email /
//   analyse-application, complete-interview → send-email): header `x-jobs-internal`, a SHA-256 derived
//   from SUPABASE_SVC_KEY, so it never appears in the repo and nothing new needs setting in Netlify.
const crypto = require('crypto');
const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SVC_KEY;
const JOBS_ADMIN_EMAIL = 'jobs@revivealicious.com';

function internalToken() { return crypto.createHash('sha256').update('revive-jobs-internal:' + (KEY || '')).digest('hex'); }
function internalHeaders() { return { 'x-jobs-internal': internalToken() }; }
function isInternal(event) {
  const h = (event && event.headers) || {};
  const v = String(h['x-jobs-internal'] || h['X-Jobs-Internal'] || '');
  const t = internalToken();
  return !!KEY && v.length === t.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(t));
}
async function isJobsAdminToken(token) {
  token = String(token || '').replace(/^Bearer\s+/i, '').trim();
  if (!token || !SUPABASE_URL || !KEY) return false;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${token}` } });
    if (!r.ok) return false;
    const u = await r.json();
    return String(u.email || '').toLowerCase() === JOBS_ADMIN_EMAIL;
  } catch (e) { console.error('Admin check failed', e); return false; }
}
async function isJobsAdmin(event) {
  const h = (event && event.headers) || {};
  return isJobsAdminToken(h.authorization || h.Authorization || '');
}
// Jobs admin or our own server-side call.
async function allowed(event, bodyToken) {
  if (isInternal(event)) return true;
  if (await isJobsAdmin(event)) return true;
  return bodyToken ? isJobsAdminToken(bodyToken) : false;
}
module.exports = { allowed, isJobsAdmin, isInternal, internalHeaders, JOBS_ADMIN_EMAIL };
