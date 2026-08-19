// ============================================================
// REVIVE CAFE JOBS - Analyse Application
// Netlify Function: /netlify/functions/analyse-application
//
// Scores an application and extracts the key facts shown on the
// applicant tile. Loads the record itself and writes the result back,
// so callers only need to supply an application_id.
//
// Callers may also pass cvText when they have freshly extracted text
// that has not been saved to the record yet.
// ============================================================

const CLAUDE_API_KEY = process.env.CLAUDE_KEY;
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SVC_KEY;

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
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
  if (!CLAUDE_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server not configured.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) }; }

  const id = (body.application_id || '').trim();
  if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'application_id required' }) };

  // 1. Load the application
  const appRes = await fetch(
    `${SUPABASE_URL}/rest/v1/applications?id=eq.${encodeURIComponent(id)}` +
    `&select=id,job_id,cover_letter,resume_text,documents,visa_type,analysed_at`,
    { headers: svc() }
  );
  const rows = await appRes.json().catch(() => []);
  if (!Array.isArray(rows) || !rows.length) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Application not found' }) };
  }
  const app = rows[0];

  // 2. Gather everything the applicant actually wrote
  const docs = Array.isArray(app.documents) ? app.documents : [];
  const docText = docs.map(d => (d && d.text) ? d.text : '').filter(Boolean).join('\n\n');
  const cvText = [body.cvText, app.resume_text, docText].filter(Boolean).join('\n\n').trim();
  const coverLetter = (app.cover_letter || '').trim();

  if (!cvText && !coverLetter) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, reason: 'Nothing to analyse yet.' }) };
  }

  // 3. Job context
  let jobTitle = '', jobDescription = '';
  if (app.job_id) {
    const jr = await fetch(
      `${SUPABASE_URL}/rest/v1/jobs?id=eq.${app.job_id}&select=title,description`,
      { headers: svc() }
    );
    const jrows = await jr.json().catch(() => []);
    if (jrows && jrows[0]) { jobTitle = jrows[0].title || ''; jobDescription = jrows[0].description || ''; }
  }

  // 4. Analyse
  let analysis;
  try {
    analysis = await analyse({ cvText, coverLetter, jobTitle, jobDescription });
  } catch (err) {
    console.error('Analysis failed', err);
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Analysis failed' }) };
  }

  // 5. Save. The form's own visa answer always beats anything inferred from a CV.
  const patch = {
    suitability_score: analysis.suitability_score,
    ai_score: analysis.ai_score,
    nationality: analysis.nationality,
    last_company: analysis.last_company,
    last_position: analysis.last_position,
    previous_employers: analysis.previous_employers,
    cv_summary: analysis.cv_summary,
    ai_analysis_notes: analysis.ai_notes,
    analysed_at: new Date().toISOString()
  };
  if (!app.visa_type && analysis.visa_type) patch.visa_type = analysis.visa_type;

  const upd = await fetch(`${SUPABASE_URL}/rest/v1/applications?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: svc({ 'Content-Profile': 'jobs', Prefer: 'return=representation' }),
    body: JSON.stringify(patch)
  });
  if (!upd.ok) {
    console.error('Could not save analysis', await upd.text().catch(() => ''));
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not save analysis' }) };
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ...patch }) };
};

async function analyse({ cvText, coverLetter, jobTitle, jobDescription }) {
  const prompt = `You are a recruitment analyst for Revive Cafe, a plant-based cafe and food brand in Auckland, New Zealand.

ROLE APPLIED FOR: ${jobTitle || 'Not specified'}
${jobDescription ? `JOB DESCRIPTION:\n${stripHtml(jobDescription).substring(0, 800)}\n` : ''}
${cvText ? `CV / RESUME TEXT:\n${cvText.substring(0, 6000)}\n` : 'No CV supplied.\n'}
${coverLetter ? `COVER LETTER:\n${coverLetter.substring(0, 2000)}\n` : ''}

Return ONLY valid JSON with exactly this structure, no markdown and no explanation:

{
  "suitability_score": <integer 1-10>,
  "ai_score": <integer 1-10>,
  "nationality": "<nationality or citizenship if clearly stated, else null>",
  "visa_type": "<visa type if clearly stated, else null>",
  "last_company": "<most recent employer name, else null>",
  "last_position": "<most recent job title, else null>",
  "previous_employers": "<Company (Role), Company (Role) — earlier roles, else null>",
  "cv_summary": "<one sentence, factual, about their background>",
  "ai_notes": "<1-2 sentences explaining the ai_score>"
}

suitability_score: how well their background matches the role.
9-10 exceptional match, 7-8 good with minor gaps, 5-6 moderate with notable gaps, 3-4 weak, 1-2 poor.

ai_score: how genuinely human-written the application reads (higher = more human).
9-10 clearly a real person — specific, natural voice, informal phrasing; 7-8 mostly human;
5-6 possibly AI-assisted; 3-4 likely AI-generated; 1-2 almost certainly AI-generated.

EXTRACTION RULES — these matter more than the scores:
- Use null, not a guess, for anything not clearly stated. Never invent an employer, title or nationality.
- Do not use placeholder strings like "Not stated", "Unknown" or "N/A". Use null.
- last_company and last_position must be the MOST RECENT role only. Put earlier roles in previous_employers.
- nationality means citizenship or stated nationality, not the city they live in.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) throw new Error(`Claude API error ${response.status}: ${await response.text()}`);

  const result = await response.json();
  const text = (result.content && result.content[0] && result.content[0].text || '').trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Could not parse JSON from model response');
  const a = JSON.parse(match[0]);

  return {
    suitability_score: clamp(a.suitability_score),
    ai_score: clamp(a.ai_score),
    nationality: clean(a.nationality),
    visa_type: clean(a.visa_type),
    last_company: clean(a.last_company),
    last_position: clean(a.last_position),
    previous_employers: clean(a.previous_employers),
    cv_summary: clean(a.cv_summary),
    ai_notes: clean(a.ai_notes)
  };
}

function clamp(n) {
  const v = parseInt(n, 10);
  return Number.isFinite(v) ? Math.min(10, Math.max(1, v)) : null;
}

// The model sometimes ignores the null rule and sends a placeholder instead;
// those used to get stored and displayed as if they were real answers.
function clean(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^(null|none|n\/?a|not stated|not listed|not specified|unknown|not provided)$/i.test(s)) return null;
  return s.slice(0, 300);
}

function stripHtml(h) {
  return String(h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
