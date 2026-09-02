// ============================================================
// REVIVE CAFE JOBS - Prefill Interview Form
// Netlify Function: /netlify/functions/prefill-form
//
// Reads the applicant's CV and application, and answers what it can
// of the interview form so the candidate only has to check and correct
// rather than retype what they already sent us.
//
// Deliberately never pre-fills: medical questions, convictions, or
// anything the applicant must attest to themselves.
// ============================================================

const CLAUDE_API_KEY = process.env.CLAUDE_KEY;
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SVC_KEY;

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

// Questions we will not answer on someone's behalf, matched loosely on wording.
const NEVER_PREFILL = [
  /medical/i, /illness/i, /condition/i, /medication/i,
  /conviction/i, /court/i, /criminal/i,
  /declare/i, /consent/i, /permission/i
];

function svc() {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    'Accept-Profile': 'jobs'
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  if (!CLAUDE_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server not configured.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request' }) }; }

  const token = (body.token || '').trim();
  if (token.length < 30) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid link' }) };
  }

  // 1. The applicant, via their interview token
  const appRes = await fetch(
    `${SUPABASE_URL}/rest/v1/applications?interview_token=eq.${encodeURIComponent(token)}` +
    `&select=id,full_name,email,phone,location,nationality,visa_type,visa_country,visa_expiry,` +
    `visa_conditions,on_visa,work_rights,cover_letter,resume_text,documents`,
    { headers: svc() }
  );
  const rows = await appRes.json().catch(() => []);
  if (!Array.isArray(rows) || !rows.length) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Invalid or expired link' }) };
  }
  const app = rows[0];

  // 2. The questions being asked
  const setRes = await fetch(
    `${SUPABASE_URL}/rest/v1/settings?key=eq.interview_form_questions&select=value`,
    { headers: svc() }
  );
  const setRows = await setRes.json().catch(() => []);
  const questions = ((setRows[0] && setRows[0].value) || '')
    .split('\n').map(q => q.trim()).filter(Boolean);
  if (!questions.length) {
    return { statusCode: 200, headers, body: JSON.stringify({ prefill: {} }) };
  }

  // 3. What we know about them
  const docs = Array.isArray(app.documents) ? app.documents : [];
  const docText = docs.map(d => (d && d.text) ? d.text : '').filter(Boolean).join('\n\n');
  const cvText = [app.resume_text, docText].filter(Boolean).join('\n\n').trim();

  let attachment = null;
  if (!cvText) {
    const file = docs.find(d => d && d.path && /\.(pdf|jpe?g|png|webp)$/i.test(d.filename || d.path));
    if (file) attachment = await fetchAttachment(file.path, file.filename);
  }

  if (!cvText && !attachment && !app.cover_letter) {
    return { statusCode: 200, headers, body: JSON.stringify({ prefill: {} }) };
  }

  // Only ask about questions that are safe to answer for someone.
  const askable = questions
    .map((q, i) => ({ i, q }))
    .filter(({ q }) => !NEVER_PREFILL.some(re => re.test(q)));
  if (!askable.length) {
    return { statusCode: 200, headers, body: JSON.stringify({ prefill: {} }) };
  }

  const known = [
    ['Name', app.full_name], ['Email', app.email], ['Phone', app.phone],
    ['Location', app.location], ['Nationality', app.nationality],
    ['On a visa', app.on_visa ? 'yes' : 'no'], ['Visa type', app.visa_type],
    ['Visa country', app.visa_country], ['Visa expiry', app.visa_expiry],
    ['Visa conditions', app.visa_conditions], ['Right to work', app.work_rights]
  ].filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n');

  const prompt = `An applicant to Revive Cafe is filling in an employment application form.
Using ONLY what their CV and application actually show, answer whichever of the
questions below you can, so they only have to check rather than retype.

WHAT THEY ALREADY TOLD US:
${known}

${app.cover_letter ? `COVER LETTER:\n${String(app.cover_letter).substring(0, 1500)}\n` : ''}
${cvText ? `CV TEXT:\n${cvText.substring(0, 6000)}` : 'Their CV is attached above - read it.'}

QUESTIONS (answer by number):
${askable.map(({ i, q }) => `${i}. ${q}`).join('\n')}

Return ONLY valid JSON, no markdown:
{ "<question number>": "<your answer>", ... }

RULES - these matter more than being helpful:
- Omit a question entirely if the CV and application do not answer it. A wrong
  guess on an employment form is far worse than a blank box for them to fill.
- Never invent dates, employers, referees, qualifications or availability.
- Answer in the applicant's voice, first person, brief and plain.
- Do not answer anything about health, medication, convictions or court matters.
- For referees: only if the CV actually names them with contact details.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 2048,
        messages: [{
          role: 'user',
          content: attachment
            ? [{ type: attachment.type === 'image' ? 'image' : 'document',
                 source: { type: 'base64', media_type: attachment.media_type, data: attachment.data } },
               { type: 'text', text: prompt }]
            : prompt
        }]
      })
    });
    if (!res.ok) throw new Error('Claude ' + res.status);
    const out = await res.json();
    const text = (out.content && out.content[0] && out.content[0].text || '').trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('no JSON in response');

    const raw = JSON.parse(match[0]);
    const prefill = {};
    const allowed = new Set(askable.map(a => String(a.i)));
    Object.keys(raw).forEach(k => {
      const key = String(parseInt(k, 10));
      if (!allowed.has(key)) return;
      const v = raw[k];
      if (typeof v !== 'string') return;
      const clean = v.trim();
      if (!clean || /^(unknown|n\/?a|not stated|not specified)$/i.test(clean)) return;
      prefill[key] = clean.slice(0, 600);
    });

    return { statusCode: 200, headers, body: JSON.stringify({ prefill }) };
  } catch (err) {
    console.error('Prefill failed', err);
    // A failed prefill must never block the form.
    return { statusCode: 200, headers, body: JSON.stringify({ prefill: {} }) };
  }
};

const MEDIA = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

async function fetchAttachment(path, filename) {
  const ext = String(filename || path).split('.').pop().toLowerCase();
  const media = MEDIA[ext];
  if (!media) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/jobs-resumes/${path}`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` }
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 4 * 1024 * 1024) return null;
    return { type: ext === 'pdf' ? 'document' : 'image', media_type: media, data: buf.toString('base64') };
  } catch {
    return null;
  }
}
