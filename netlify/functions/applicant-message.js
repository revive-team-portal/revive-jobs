// ============================================================
// REVIVE CAFE JOBS - Applicant message (6 Oct 2026)
// Netlify Function: /netlify/functions/applicant-message
//
// "Send us a message" box on the interview-times page. The applicant is
// identified by their interview token (same as get-interview-data); the
// message is appended to applications.applicant_messages as {text, at} and
// shown in red on their tile and overlay in the Jobs admin.
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SVC_KEY;

const MAX_LEN = 2000;        // characters per message
const MAX_MESSAGES = 10;     // per application, so the box can't be used to flood a record

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

function svc(extra) {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    'Accept-Profile': 'jobs',
    'Content-Profile': 'jobs',
    ...(extra || {})
  };
}

const reply = (statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  // Preflight before the method check (AGENTS.md §6).
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return reply(500, { error: 'Server not configured.' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return reply(400, { error: 'Invalid request' }); }

  const token = String(body.token || '').trim();
  if (token.length < 30) return reply(400, { error: 'Invalid link' });

  const text = String(body.message || '').replace(/\r\n/g, '\n').trim();
  if (!text) return reply(400, { error: 'Please type a message first.' });
  if (text.length > MAX_LEN) return reply(400, { error: `Please keep your message under ${MAX_LEN} characters.` });

  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/applications?interview_token=eq.${encodeURIComponent(token)}&select=id,applicant_messages`,
      { headers: svc() }
    );
    if (!r.ok) throw new Error('read ' + r.status + ' ' + (await r.text().catch(() => '')));
    const rows = await r.json();
    if (!rows.length) return reply(404, { error: 'Invalid or expired link' });

    const app = rows[0];
    const list = Array.isArray(app.applicant_messages) ? app.applicant_messages : [];
    if (list.length >= MAX_MESSAGES) {
      return reply(429, { error: 'You have sent the maximum number of messages. Please email us instead.' });
    }

    const entry = { text, at: new Date().toISOString() };
    const next = list.concat([entry]);

    const p = await fetch(`${SUPABASE_URL}/rest/v1/applications?id=eq.${app.id}`, {
      method: 'PATCH',
      headers: svc({ Prefer: 'return=minimal' }),
      body: JSON.stringify({ applicant_messages: next })
    });
    if (!p.ok) throw new Error('save ' + p.status + ' ' + (await p.text().catch(() => '')));

    return reply(200, { success: true, messages: next });
  } catch (err) {
    console.error('applicant-message error', err);
    return reply(500, { error: 'Your message could not be sent — please try again.' });
  }
};
