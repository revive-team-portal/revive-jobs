// ============================================================
// REVIVE CAFE JOBS - Application form review flags (7 Oct 2026)
// Netlify BACKGROUND function: /netlify/functions/form-flags-background
//
// POST { application_id, force? } (any content type) -> Netlify returns 202
// at once; this then runs _formflags.flagForm (Sonnet, 6-12 s), which writes
// applications.form_flags. The admin fires it with fetch(mode:'no-cors',
// text/plain) - no preflight, nothing to read back - and picks the result up
// from the table (targeted re-read + live refresh). Nothing is returned, so
// the endpoint never hands out form content.
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SVC_KEY;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '' };
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: '' }; }
  const id = String(body.application_id || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { statusCode: 400, body: '' };

  try {
    // Already flagged and not forced: no AI call.
    if (!body.force) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/applications?id=eq.${id}&select=form_flags`, {
        headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Accept-Profile': 'jobs' }
      });
      const rows = await r.json().catch(() => []);
      if (Array.isArray(rows) && rows[0] && rows[0].form_flags) return { statusCode: 200, body: '' };
    }
    const out = await require('./_formflags').flagForm(id);
    console.log('form-flags', id, JSON.stringify(out));
  } catch (err) {
    console.error('form-flags error', id, err);
  }
  return { statusCode: 200, body: '' };
};
