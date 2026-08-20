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
    `&select=id,job_id,cover_letter,resume_text,documents,visa_type,answers,analysed_at`,
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

  // Screening answers are often the most role-specific thing an applicant gives us.
  const answers = (app.answers && typeof app.answers === 'object')
    ? Object.entries(app.answers)
        .filter(([, v]) => v && String(v).trim())
        .map(([q, v]) => `Q: ${q}\nA: ${String(v).trim()}`)
        .join('\n\n')
    : '';

  // At submit time no text has been extracted yet — the browser does that later.
  // Rather than analyse a CV we cannot read, hand the file itself to the model.
  // Photographed and scanned CVs arrive as images and have no text layer at all,
  // so this is also the only way they ever get read.
  const attachments = [];
  if (!cvText) {
    const readable = docs.filter(d => d && d.path && SUPPORTED.test(d.filename || d.path));
    // CV first if we can tell, then anything else, capped to keep the call small.
    readable.sort((a, b) => (b.kind === 'cv' ? 1 : 0) - (a.kind === 'cv' ? 1 : 0));
    for (const d of readable.slice(0, 3)) {
      const att = await fetchAttachment(d.path, d.filename);
      if (att) attachments.push(att);
    }
  }
  const hasImage = attachments.some(a => a.type === 'image');

  if (!cvText && !coverLetter && !answers && !attachments.length) {
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
    analysis = await analyse({ cvText, coverLetter, answers, jobTitle, jobDescription, attachments, hasImage });
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
    countries_worked: analysis.countries_worked,
    recent_jobs: analysis.recent_jobs,
    previous_employers: analysis.previous_employers,
    cv_summary: analysis.cv_summary,
    ai_analysis_notes: [analysis.fit_reasoning ? ('Fit: ' + analysis.fit_reasoning) : '', analysis.ai_notes ? ('Authenticity: ' + analysis.ai_notes) : ''].filter(Boolean).join('  \u00b7  ') || analysis.ai_notes,
    analysed_at: new Date().toISOString()
  };
  if (!app.visa_type && analysis.visa_type) patch.visa_type = analysis.visa_type;
  // Text read off a photographed CV becomes the CV text, so quotes and search work.
  if (!app.resume_text && analysis.ocr_text) patch.resume_text = analysis.ocr_text;

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

async function analyse({ cvText, coverLetter, answers, jobTitle, jobDescription, attachments, hasImage }) {
  const prompt = `You are a recruitment analyst for Revive Cafe, a plant-based cafe and food brand in Auckland, New Zealand.

ROLE APPLIED FOR: ${jobTitle || 'Not specified'}
${jobDescription ? `JOB DESCRIPTION:\n${stripHtml(jobDescription).substring(0, 1500)}\n` : ''}
${cvText ? `CV / RESUME TEXT:\n${cvText.substring(0, 6000)}\n` : (attachments && attachments.length ? 'The applicant\'s CV is attached above. Read it carefully, including any photographed or scanned pages.\n' : 'No CV supplied.\n')}
${coverLetter ? `COVER LETTER:\n${coverLetter.substring(0, 2000)}\n` : ''}
${answers ? `SCREENING QUESTIONS THE EMPLOYER ASKED, AND THEIR ANSWERS:\n${answers.substring(0, 2500)}\n` : ''}

Return ONLY valid JSON with exactly this structure, no markdown and no explanation:

{
  "fit_reasoning": "<1-2 sentences: the role type and its 2-3 main needs, what this applicant has that matches, and the biggest gap>",
  "suitability_score": <integer 1-10>,
  "ai_score": <integer 1-10>,
  "nationality": "<nationality or citizenship if clearly stated, else null>",
  "visa_type": "<visa type if clearly stated, else null>",
  "last_company": "<most recent employer name, else null>",
  "last_position": "<most recent job title, else null>",
  "countries_worked": "<comma-separated countries they have WORKED in, most recent first, else null>",
  "recent_jobs": [ { "company": "<name>", "position": "<title>", "dates": "<e.g. 2022-2024, else null>", "country": "<else null>" } ],
  "previous_employers": "<Company (Role), Company (Role) — earlier roles, else null>",
  "cv_summary": "<one sentence, factual, about their background>",
  "ai_notes": "<1-2 sentences explaining the ai_score>"${hasImage ? `,
  "ocr_text": "<the CV text transcribed from the image, verbatim. Use \\n for line breaks. Transcribe only - do not summarise, correct or add anything. Empty string if the image is not a CV>"` : ''}
}

HOW TO SCORE SUITABILITY (do this carefully — it is the most important output):
STEP 1 — From the title and description, work out the ROLE TYPE and its 2-3 key requirements
(e.g. front-of-house / barista / customer service; kitchen / food prep / chef; cleaning;
delivery / driver; management; office/admin).
STEP 2 — Write "fit_reasoning" FIRST, then score based on how much DIRECTLY RELEVANT, RECENT
experience the applicant has for THAT role type.

suitability_score (1-10) — anchor to relevant experience, NOT to how polished the writing is:
  9-10  Strong, recent experience in this exact role type; clearly meets the key requirements.
  7-8   Solid experience in this or a closely related role (e.g. other cafe/hospitality
        front-of-house for a front-of-house role); only minor gaps.
  5-6   Some transferable experience, but not in this role type, or relevant experience that
        is brief or dated.
  3-4   Little relevant experience; would need significant training for this role.
  1-2   No relevant experience, or a clear role mismatch (e.g. only kitchen experience for a
        customer-facing role, or only front-of-house for a kitchen role).

Directly relevant recent experience outweighs everything else. Do NOT inflate the score for a
tidy CV, unrelated or senior roles, general enthusiasm, or strong screening answers on their own
— a good answer with no relevant experience is a moderate match at best. Treat the screening
answers as a strong SECONDARY signal that refines the score, not a replacement for real
experience. Someone with a year in the same role type should clearly outscore someone whose
experience is in a different type of role.

ai_score: how genuinely human-written the application reads (higher = more human).
9-10 clearly a real person — specific, natural voice, informal phrasing; 7-8 mostly human;
5-6 possibly AI-assisted; 3-4 likely AI-generated; 1-2 almost certainly AI-generated.

EXTRACTION RULES — these matter more than the scores:
- Use null, not a guess, for anything not clearly stated. Never invent an employer, title or nationality.
- Do not use placeholder strings like "Not stated", "Unknown" or "N/A". Use null.
- last_company and last_position must be the MOST RECENT role only. Put earlier roles in previous_employers.
- nationality means citizenship or stated nationality, not the city they live in.
- countries_worked: only countries where they actually held a job. Infer the country from
  an employer's location when it is clear (e.g. "Cafe in Sydney" implies Australia). Do not
  include countries they only studied in, travelled to, or hold a passport for. If every role
  is in one country, return just that country. Return null if no work location is identifiable.
- recent_jobs: up to 4 roles, most recent FIRST. Use null for any field you cannot read.
  Return an empty array if no work history is identifiable. Never invent an employer.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      // Transcribing a whole CV needs far more room than the scores alone;
      // at 1024 the JSON was being truncated and failing to parse.
      max_tokens: hasImage ? 4096 : 1024,
      messages: [{
        role: 'user',
        content: (attachments && attachments.length)
          ? attachments.map(a => a.type === 'image'
              ? { type: 'image', source: { type: 'base64', media_type: a.media_type, data: a.data } }
              : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.data } })
              .concat([{ type: 'text', text: prompt }])
          : prompt
      }]
    })
  });

  if (!response.ok) throw new Error(`Claude API error ${response.status}: ${await response.text()}`);

  const result = await response.json();
  const text = (result.content && result.content[0] && result.content[0].text || '').trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Could not parse JSON from model response');
  const a = JSON.parse(match[0]);

  return {
    fit_reasoning: clean(a.fit_reasoning),
    suitability_score: clamp(a.suitability_score),
    ai_score: clamp(a.ai_score),
    nationality: clean(a.nationality),
    visa_type: clean(a.visa_type),
    last_company: clean(a.last_company),
    last_position: clean(a.last_position),
    countries_worked: clean(a.countries_worked),
    recent_jobs: cleanJobs(a.recent_jobs),
    previous_employers: clean(a.previous_employers),
    cv_summary: clean(a.cv_summary),
    ai_notes: clean(a.ai_notes),
    ocr_text: typeof a.ocr_text === 'string' && a.ocr_text.trim().length > 40 ? a.ocr_text.trim() : null
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

// Keep only entries with something real in them, so the tile never shows blank rows.
function cleanJobs(v) {
  if (!Array.isArray(v)) return null;
  const out = v.slice(0, 4).map(j => ({
    company: clean(j && j.company),
    position: clean(j && j.position),
    dates: clean(j && j.dates),
    country: clean(j && j.country)
  })).filter(j => j.company || j.position);
  return out.length ? out : null;
}

const SUPPORTED = /\.(pdf|jpe?g|png|webp|gif)$/i;

const MEDIA = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  png: 'image/png', webp: 'image/webp', gif: 'image/gif'
};

// Pull a stored document out of the bucket as base64 so it can be sent to the
// model. PDFs go as documents; photos and scans go as images to be read.
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
    if (buf.length > 4 * 1024 * 1024) return null;   // keep the request sane
    return { type: ext === 'pdf' ? 'document' : 'image', media_type: media, data: buf.toString('base64') };
  } catch (err) {
    console.error('Could not read attachment for analysis', err);
    return null;
  }
}

function stripHtml(h) {
  return String(h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
