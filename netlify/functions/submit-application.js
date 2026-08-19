// ============================================================
// REVIVE CAFE JOBS - Submit Application (Secure)
// Netlify Function: /netlify/functions/submit-application
//
// The public form used to insert straight into Postgres with the anon
// key. That is now blocked (anon has no INSERT grant) and the payload
// used column names that do not exist, so every submission failed.
// This function does the insert server-side with the service role and
// maps the form fields onto the real columns.
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SVC_KEY;

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server not configured.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) }; }

  const job_id = str(body.job_id, 60);
  const first_name = str(body.first_name, 80);
  const last_name = str(body.last_name, 80);
  const email = str(body.email, 160);

  if (!job_id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing job.' }) };
  if (!first_name || !email) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Name and email are required.' }) };
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'That email address does not look right.' }) };
  }

  // Confirm the job exists and is open before accepting an application.
  const jobRes = await fetch(
    `${SUPABASE_URL}/rest/v1/jobs?id=eq.${encodeURIComponent(job_id)}&select=id,status`,
    { headers: svcHeaders() }
  );
  const jobs = await jobRes.json().catch(() => []);
  if (!Array.isArray(jobs) || !jobs.length) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'This job listing is no longer available.' }) };
  }
  if (jobs[0].status !== 'active') {
    return { statusCode: 409, headers, body: JSON.stringify({ error: 'This listing has closed.' }) };
  }

  // Only keep documents that were actually uploaded to our own bucket.
  const documents = Array.isArray(body.documents)
    ? body.documents
        .filter(d => d && typeof d.path === 'string' && d.path.startsWith(job_id + '/'))
        .slice(0, 10)
        .map(d => ({
          path: str(d.path, 300),
          filename: str(d.filename, 200) || 'document',
          size: Number(d.size) || null,
          kind: str(d.kind, 20) || 'document'
        }))
    : [];

  const primary = documents.find(d => d.kind === 'cv') || documents[0] || null;

  const workRights = str(body.work_rights, 40);
  const onVisa = workRights === 'work_visa' || workRights === 'student_visa';

  const row = {
    job_id,
    full_name: (first_name + ' ' + last_name).trim(),
    email,
    phone: str(body.phone, 40) || null,
    location: str(body.location, 120) || null,
    cover_letter: str(body.cover_letter, 8000) || null,
    referral_source: str(body.referral_source, 60) || null,
    referral_other: str(body.referral_other, 200) || null,
    work_rights: workRights || null,
    work_rights_detail: str(body.work_rights_detail, 500) || null,
    on_visa: onVisa,
    visa_country: onVisa ? (str(body.visa_country, 80) || null) : null,
    visa_type: onVisa ? (str(body.visa_type, 80) || null) : null,
    visa_length: onVisa ? (str(body.visa_length, 80) || null) : null,
    visa_conditions: onVisa ? (str(body.visa_conditions, 200) || null) : null,
    answers: body.answers && typeof body.answers === 'object' ? body.answers : {},
    documents,
    resume_url: primary ? primary.path : null,
    resume_filename: primary ? primary.filename : null,
    status: 'new'
  };

  const res = await fetch(`${SUPABASE_URL}/rest/v1/applications`, {
    method: 'POST',
    headers: { ...svcHeaders(), 'Content-Profile': 'jobs', Prefer: 'return=representation' },
    body: JSON.stringify(row)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error('Application insert failed', res.status, text);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not save your application.' }) };
  }

  const saved = (await res.json().catch(() => []))[0] || {};

  // Score and extract key facts now, so the tile is useful the moment it lands.
  // Never let this hold up or fail the applicant's submission.
  if (saved.id) {
    try {
      await Promise.race([
        fetch(`${process.env.URL || 'https://jobs.revive.co.nz'}/.netlify/functions/analyse-application`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ application_id: saved.id })
        }),
        new Promise(r => setTimeout(r, 7000))
      ]);
    } catch (err) {
      console.error('Post-submit analysis failed (application still saved)', err);
    }
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, id: saved.id || null }) };
};

function svcHeaders() {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    'Accept-Profile': 'jobs'
  };
}
