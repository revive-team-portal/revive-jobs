// ============================================================
// REVIVE CAFE JOBS - Record a job ad view
// Netlify Function: /netlify/functions/record-view
//
// The public ad page never recorded views, so the Views figure on the
// dashboard was always zero. One row per view, plus a counter on the job
// so the dashboard does not have to count rows every time.
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SVC_KEY;

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

function svc(extra) {
  return Object.assign({
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    'Accept-Profile': 'jobs'
  }, extra || {});
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request' }) }; }

  const jobId = String(body.job_id || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'job_id required' }) };
  }
  const referral = String(body.referral_source || '').trim().slice(0, 60) || null;

  try {
    await fetch(`${SUPABASE_URL}/rest/v1/job_views`, {
      method: 'POST',
      headers: svc({ 'Content-Profile': 'jobs' }),
      body: JSON.stringify({ job_id: jobId, referral_source: referral })
    });

    // Keep the counter on the job in step, via a function so concurrent
    // views cannot overwrite each other.
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/bump_job_views`, {
      method: 'POST',
      headers: svc({ 'Content-Profile': 'jobs' }),
      body: JSON.stringify({ p_job_id: jobId })
    });
  } catch (err) {
    // A view is never worth failing the page over.
    console.error('Could not record view', err);
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
};
