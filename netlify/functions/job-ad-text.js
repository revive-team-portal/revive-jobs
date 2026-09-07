// ============================================================
// REVIVE CAFE JOBS - Job Ad Text
// Netlify Function: /netlify/functions/job-ad-text
//
// Produces plain text about a position that can be pasted straight
// into Facebook, Seek, Backpacker Board etc. No HTML, no markdown.
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

  const jobId = (body.job_id || '').trim();
  if (!jobId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'job_id required' }) };

  const jobRows = await (await fetch(
    `${SUPABASE_URL}/rest/v1/jobs?id=eq.${encodeURIComponent(jobId)}` +
    `&select=id,title,code,type,description,hourly_rate,min_hours,start_date,expiry_date`,
    { headers: svc() }
  )).json().catch(() => []);
  if (!Array.isArray(jobRows) || !jobRows.length) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Job not found' }) };
  }
  const job = jobRows[0];

  const setRows = await (await fetch(
    `${SUPABASE_URL}/rest/v1/settings?key=in.(company_history,company_benefits)&select=key,value`,
    { headers: svc() }
  )).json().catch(() => []);
  const S = {};
  (setRows || []).forEach(r => { S[r.key] = r.value; });

  const applyUrl = job.code
    ? `https://jobs.revive.co.nz/${job.code}`
    : `https://jobs.revive.co.nz/job.html?id=${job.id}`;

  const facts = [
    job.type ? 'Type: ' + String(job.type).replace(/_/g, ' ') : '',
    job.hourly_rate ? 'Rate: $' + job.hourly_rate + '/hour' : '',
    job.min_hours ? 'Hours: from ' + job.min_hours + ' per week' : '',
    job.start_date ? 'Start: ' + job.start_date : ''
  ].filter(Boolean).join('\n');

  const prompt = `Write a job advertisement for Revive Cafe as PLAIN TEXT, ready to paste
straight into a Facebook post, Backpacker Board, Seek or a community noticeboard.

POSITION: ${job.title}
${facts ? `KEY FACTS (only use what is here — invent nothing):\n${facts}\n` : ''}
APPLY LINK: ${applyUrl}

FULL JOB DESCRIPTION (the source of truth for the role):
${htmlToText(job.description || '').substring(0, 4000)}

${S.company_history ? `ABOUT THE CAFE:\n${S.company_history.substring(0, 900)}\n` : ''}
${S.company_benefits ? `WHAT STAFF GET:\n${S.company_benefits.substring(0, 700)}\n` : ''}

WRITE IT EXACTLY LIKE THIS:
Line 1: the position title in capitals, then " - Revive Cafe, Auckland CBD"
Line 2: Apply here: ${applyUrl}
Line 3: blank
Then 2 sentences of warm marketing copy that make a good hospitality person want
this job. Lead with what is genuinely attractive - for Revive that is Monday to
Friday only, no nights, no weekends, no public holidays, and real food to be proud of.

Then these blocks, each a heading in capitals on its own line followed immediately
by its content, with ONE blank line between blocks:
THE ROLE
WHAT YOU'LL BE DOING
WHO WE'RE LOOKING FOR
THE DETAILS
ABOUT REVIVE CAFE

Under ABOUT REVIVE CAFE, include the concrete facts that make Revive distinctive —
open since 2004, Monday to Friday only (closed nights, weekends and public holidays),
closed over Christmas and New Year, plant-based, fresh cabinet food made daily,
in the Auckland CBD, plus what staff get. Use ONLY facts present above.

Finish with a blank line then: Apply here: ${applyUrl}

RULES:
- PLAIN TEXT ONLY. No markdown, no *, no #, no HTML. Use "- " for list items.
- KEEP IT SHORT: 200-260 words total. This is a social post, not a brochure.
  Tight sentences. Cut anything that does not help someone decide to apply.
- Exactly ONE blank line between blocks. Never two. No blank line between a
  heading and its content.
- Invent nothing. No pay rate, hours or start date that is not given above.
- Warm and human. Write like a cafe owner, not an HR department.

Return ONLY the advertisement text, nothing else.`;

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
        max_tokens: 1600,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!res.ok) throw new Error('Claude ' + res.status + ' ' + await res.text().catch(() => ''));
    const out = await res.json();
    let text = (out.content && out.content[0] && out.content[0].text || '').trim();

    // Strip any markdown the model slipped in — this has to paste clean.
    text = text
      .replace(/^```[a-z]*\n?/i, '').replace(/```$/, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/^#{1,6}\s*/gm, '')
      .replace(/^\s*[*•]\s+/gm, '- ')
      .replace(/\n{3,}/g, '\n\n')
      // A heading should sit directly above its content, not floated off it.
      .replace(/^([A-Z][A-Z' ]{3,}:?)\n\n/gm, '$1\n')
      .replace(/[ \t]+$/gm, '')
      .trim();

    // Guarantee the apply link is present at the top, whatever the model did.
    if (!text.includes(applyUrl)) {
      text = `${(job.title || '').toUpperCase()} — Revive Cafe, Auckland CBD\nApply here: ${applyUrl}\n\n${text}\n\nApply here: ${applyUrl}`;
    }

    return { statusCode: 200, headers, body: JSON.stringify({ text, applyUrl }) };
  } catch (err) {
    console.error('Ad text generation failed', err);
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not generate the ad text' }) };
  }
};

function htmlToText(h) {
  return String(h || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#39;|&rsquo;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
