// ============================================================
// REVIVE CAFE JOBS - AI Shortlist
// Netlify Function: /netlify/functions/ai-shortlist
//
// Ranks the applicants who have NOT been categorised yet (status 'new')
// and moves the best N to the 'ai_shortlist' status. Anyone already
// sorted by a human is never read or touched.
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
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request' }) }; }

  const jobId = (body.job_id || '').trim();
  const want = Math.min(Math.max(parseInt(body.count, 10) || 10, 1), 30);
  const criteria = String(body.criteria || '').trim().slice(0, 600);
  if (!jobId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'job_id required' }) };

  // 1. The job
  const jobRows = await (await fetch(
    `${SUPABASE_URL}/rest/v1/jobs?id=eq.${encodeURIComponent(jobId)}&select=title,type,description`,
    { headers: svc() }
  )).json().catch(() => []);
  if (!Array.isArray(jobRows) || !jobRows.length) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Job not found' }) };
  }
  const job = jobRows[0];
  const isCasual = String(job.type || '').toLowerCase() === 'casual';

  // 1b. Clear any previous AI shortlist back to 'new' so this run reassesses
  // everyone from scratch. Only rows still marked ai_shortlist are reset — if a
  // human has since moved someone on, their decision stands.
  let cleared = 0;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/applications?job_id=eq.${encodeURIComponent(jobId)}&status=eq.ai_shortlist`,
      {
        method: 'PATCH',
        headers: svc({ 'Content-Profile': 'jobs', Prefer: 'return=representation' }),
        body: JSON.stringify({ status: 'new', ai_shortlist_reason: null, ai_shortlist_rank: null })
      }
    );
    if (r.ok) cleared = (await r.json().catch(() => [])).length;
  } catch (err) {
    console.error('Could not clear the previous shortlist', err);
  }

  // 2. ONLY the uncategorised ones. Anything a human has already filed stays put.
  const apps = await (await fetch(
    `${SUPABASE_URL}/rest/v1/applications?job_id=eq.${encodeURIComponent(jobId)}&status=eq.new` +
    `&select=id,full_name,created_at,cv_summary,suitability_score,ai_score,last_company,last_position,` +
    `countries_worked,recent_jobs,nationality,visa_type,visa_conditions,work_rights,answers,cover_letter,resume_text` +
    `&order=created_at.desc`,
    { headers: svc() }
  )).json().catch(() => []);

  if (!Array.isArray(apps) || !apps.length) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, considered: 0, shortlisted: 0, cleared, picks: [] }) };
  }

  // 3. A compact profile per applicant — enough to judge, small enough to send.
  const profiles = apps.map((a, i) => {
    const jobsList = Array.isArray(a.recent_jobs)
      ? a.recent_jobs.filter(Boolean).map(j =>
          [j.position, j.company, j.dates, j.country].filter(Boolean).join(' / ')).join(' | ')
      : '';
    const answers = (a.answers && typeof a.answers === 'object')
      ? Object.entries(a.answers).filter(([, v]) => v && String(v).trim())
          .map(([q, v]) => `${q} -> ${String(v).trim()}`).join(' ; ')
      : '';
    return [
      `#${i}`,
      `Name: ${a.full_name || 'Unknown'}`,
      a.cv_summary ? `CV: ${a.cv_summary}` : '',
      jobsList ? `Roles: ${jobsList}` : (a.last_position || a.last_company ? `Last role: ${[a.last_position, a.last_company].filter(Boolean).join(' at ')}` : ''),
      a.countries_worked ? `Worked in: ${a.countries_worked}` : '',
      a.visa_type ? `Visa: ${a.visa_type}${a.visa_conditions ? ' (' + a.visa_conditions + ')' : ''}` : '',
      a.work_rights ? `Right to work: ${a.work_rights}` : '',
      answers ? `Screening answers: ${answers.slice(0, 500)}` : '',
      (!a.cv_summary && a.cover_letter) ? `Cover letter: ${String(a.cover_letter).slice(0, 300)}` : '',
      a.suitability_score ? `Prior fit score: ${a.suitability_score}/10` : ''
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  const prompt = `You are shortlisting for Revive Cafe in Auckland.

ROLE: ${job.title}${job.type ? ' (' + String(job.type).replace(/_/g, ' ') + ')' : ''}
${job.description ? `ROLE DESCRIPTION:\n${stripHtml(job.description).substring(0, 1500)}\n` : ''}
WHAT MATTERS MOST:
${isCasual ? `- Relevant hands-on experience for this role.
- Availability that fits the shifts on offer.
- Reliability signals: steady work history, turns up when rostered.
- Right to work with enough hours for the role.
- How long they can stay matters, but this is a casual role, so do not rank
  someone down heavily for a shorter stint.` : `- HOW LONG THEY CAN COMMIT. This is the single most important factor for this
  role and it outranks everything else. This is a ${String(job.type || '').replace(/_/g, ' ')} position
  and training someone who leaves quickly is a real cost.
  * Under 6 months, or a visa expiring within 6 months: rank at the very bottom,
    however good the CV is. Do not shortlist them unless there are not enough
    other candidates to fill the list.
  * 6-12 months: acceptable, but rank below anyone who can stay longer.
  * Over 12 months, permanent, or open-ended: strongly preferred, rank first.
  * If they have not said, judge it from their visa type and expiry. Treat
    genuinely unknown as a risk, not a positive.
- Relevant hands-on experience for this role.
- Reliability signals: steady work history, no string of very short stints.
- Right to work with enough hours for the role.`}
${criteria ? `- The employer also says: ${criteria}` : ''}

Do not reward a polished CV over someone who can actually do the job and stay.
If the information on an applicant is too thin to judge, do not pick them.

APPLICANTS (${apps.length}):
${profiles}

Pick the best ${want}, ranked. Return ONLY valid JSON, no markdown:
{ "picks": [ { "n": <the #number>, "reason": "<one short sentence, concrete, why they made it>" } ] }

The reason must cite something specific from their profile — the length they can
commit, a relevant role, years of experience. Never a generic phrase.
${isCasual ? '' : 'Start every reason with how long they can commit, since that is what matters most for this role.'}`;

  let picks;
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
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!res.ok) throw new Error('Claude ' + res.status + ' ' + await res.text().catch(() => ''));
    const out = await res.json();
    const text = (out.content && out.content[0] && out.content[0].text || '').trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('no JSON in response');
    picks = JSON.parse(match[0]).picks;
    if (!Array.isArray(picks)) throw new Error('no picks array');
  } catch (err) {
    console.error('Shortlisting failed', err);
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not run the shortlist' }) };
  }

  // 4. Apply. Guard the index so a bad number can never touch the wrong person.
  const chosen = [];
  const seen = new Set();
  for (const p of picks) {
    const i = parseInt(p && p.n, 10);
    if (!Number.isInteger(i) || i < 0 || i >= apps.length) continue;
    if (seen.has(i)) continue;
    seen.add(i);
    chosen.push({ app: apps[i], reason: String((p && p.reason) || '').trim().slice(0, 300) });
    if (chosen.length >= want) break;
  }

  for (let k = 0; k < chosen.length; k++) {
    const { app, reason } = chosen[k];
    // status=eq.new means a human who has since filed this person wins the race.
    await fetch(
      `${SUPABASE_URL}/rest/v1/applications?id=eq.${app.id}&status=eq.new`,
      {
        method: 'PATCH',
        headers: svc({ 'Content-Profile': 'jobs' }),
        body: JSON.stringify({
          status: 'ai_shortlist',
          ai_shortlist_reason: reason || null,
          ai_shortlist_rank: k + 1
        })
      }
    ).catch(err => console.error('Could not set status for ' + app.id, err));
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      ok: true,
      considered: apps.length,
      shortlisted: chosen.length,
      cleared,
      picks: chosen.map((c, i) => ({ rank: i + 1, name: c.app.full_name, reason: c.reason }))
    })
  };
};

function stripHtml(h) {
  return String(h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
