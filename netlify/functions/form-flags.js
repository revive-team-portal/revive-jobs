// ============================================================
// REVIVE CAFE JOBS - Application form review flags (7 Oct 2026)
// Netlify Function: /netlify/functions/form-flags
//
// POST { application_id, force? } -> runs _formflags.flagForm, which writes
// applications.form_flags. Called by the admin (team.revive.co.nz/jobs/) for
// completed forms that have no flags yet. Returns counts only - the admin
// reads the flags themselves from the table with its own login, so this
// endpoint never hands out form content.
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SVC_KEY;

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  // Preflight first - the admin calls this cross-origin.
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) }; }
  const id = String(body.application_id || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { statusCode: 400, headers, body: JSON.stringify({ error: 'application_id required' }) };

  try {
    // Already flagged and not forced: nothing to do (no AI call).
    if (!body.force) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/applications?id=eq.${id}&select=form_flags`, {
        headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Accept-Profile': 'jobs' }
      });
      const rows = await r.json().catch(() => []);
      if (Array.isArray(rows) && rows[0] && rows[0].form_flags) {
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, cached: true }) };
      }
    }
    const out = await require('./_formflags').flagForm(id);
    return { statusCode: out.ok ? 200 : (out.status || 500), headers, body: JSON.stringify(out) };
  } catch (err) {
    console.error('form-flags error', err);
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: String(err.message || err).slice(0, 200) }) };
  }
};
