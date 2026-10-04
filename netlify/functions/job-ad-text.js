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

const { SETTINGS_KEYS, benefitsTextFor } = require('./_benefits');

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
    `&select=id,title,code,type,description,hourly_rate,min_hours,start_date,start_asap,benefits_off`,
    { headers: svc() }
  )).json().catch(() => []);
  if (!Array.isArray(jobRows) || !jobRows.length) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Job not found' }) };
  }
  const job = jobRows[0];

  const setRows = await (await fetch(
    `${SUPABASE_URL}/rest/v1/settings?key=in.(company_history,${SETTINGS_KEYS.join(',')})&select=key,value`,
    { headers: svc() }
  )).json().catch(() => []);
  const S = {};
  (setRows || []).forEach(r => { S[r.key] = r.value; });

  const applyUrl = job.code
    ? `https://jobs.revive.co.nz/${job.code}`
    : `https://jobs.revive.co.nz/job.html?id=${job.id}`;

  const facts = [
    job.type ? 'Type: ' + titleCase(String(job.type).replace(/_/g, ' ')) : '',
    job.hourly_rate ? 'Rate: $' + job.hourly_rate + '/hour' : '',
    job.min_hours ? 'Hours: from ' + job.min_hours + ' per week' : '',
    job.start_asap ? 'Start: ASAP' : (job.start_date ? 'Start: ' + formatDate(job.start_date) : '')
  ].filter(Boolean).join('\n');

  const descriptionText = htmlToText(job.description || '');

  // Only the opening lines are written by AI. Everything after it is reproduced
  // verbatim from the job description and the company details, so the advert
  // always matches what is actually on file.
  const prompt = `Write ONLY a short opening for a job advertisement. Two sentences, plain text.

POSITION: ${job.title}
LOCATION: Revive Cafe, Auckland CBD
${facts ? `KEY FACTS:\n${facts}\n` : ''}
THE ROLE (for context only — do not repeat it, it is printed after your opening):
${descriptionText.substring(0, 2500)}

Write two sentences that would make a good hospitality person want this job.
Lead with what is genuinely attractive — for Revive that is Monday to Friday only,
no nights, no weekends, no public holidays, and real food to be proud of.
Warm and human, like a cafe owner, not an HR department.
Plain text only. No markdown, no headings, no emoji, no quotes around it.
Do not mention pay, hours or dates unless they appear in KEY FACTS.

Return ONLY those two sentences.`;

  let intro = '';
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
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!res.ok) throw new Error('Claude ' + res.status);
    const out = await res.json();
    intro = (out.content && out.content[0] && out.content[0].text || '').trim()
      .replace(/^```[a-z]*\n?/i, '').replace(/```$/, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/^#{1,6}\s*/gm, '')
      .replace(/^["']|["']$/g, '')
      .trim();
  } catch (err) {
    console.error('Ad intro generation failed, continuing without it', err);
    intro = '';
  }

  // ---- assemble, verbatim from here down ----
  const parts = [];
  parts.push(`${String(job.title || '').toUpperCase()} - Revive Cafe, Auckland CBD`);
  parts.push(`Apply here: ${applyUrl}`);
  if (intro) parts.push('', intro);

  if (facts) parts.push('', 'THE DETAILS', facts);

  if (descriptionText) parts.push('', 'ABOUT THE POSITION', descriptionText);

  if (S.company_history && S.company_history.trim()) {
    parts.push('', 'ABOUT REVIVE CAFE', S.company_history.trim());
  }
  // Optional benefits this ad has switched off are dropped here, so the advert
  // never promises something the role cannot offer.
  const benefitsText = benefitsTextFor(S, job);
  if (benefitsText) {
    parts.push('', 'WHAT YOU GET', benefitsText);
  }

  parts.push('', `Apply here: ${applyUrl}`);

  const text = parts.join('\n')
    .replace(/\r/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Store it so every future copy is identical until it is regenerated.
  await fetch(`${SUPABASE_URL}/rest/v1/jobs?id=eq.${encodeURIComponent(jobId)}`, {
    method: 'PATCH',
    headers: { ...svc(), 'Content-Profile': 'jobs' },
    body: JSON.stringify({ ad_text: text, ad_text_generated_at: new Date().toISOString() })
  }).catch(err => console.error('Could not save ad text', err));

  return { statusCode: 200, headers, body: JSON.stringify({ text, applyUrl }) };
};

// 01-Oct-2025
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function formatDate(d) {
  if (!d) return '';
  const parts = String(d).slice(0, 10).split('-');
  if (parts.length !== 3) return String(d);
  const [y, m, day] = parts;
  const mi = parseInt(m, 10) - 1;
  if (!MONTHS[mi]) return String(d);
  return `${day.padStart(2, '0')}-${MONTHS[mi]}-${y}`;
}

function titleCase(t) {
  return String(t || '').replace(/\b\w/g, c => c.toUpperCase());
}

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
