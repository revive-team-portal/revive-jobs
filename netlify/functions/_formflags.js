// ============================================================
// REVIVE CAFE JOBS - Application form review flags (7 Oct 2026)
//
// flagForm(applicationId) reads the applicant's interview/application form
// answers (applications.interview_notes, {"q1":{question,answer},...}) plus
// the job and visa context, asks Claude to mark every row
//   red   = a real problem for this role (holiday/absence planned,
//           commitment or visa too short, unavailable on the shift, a conviction)
//   amber = worth asking about at interview
//   green = fine / nothing to check
// and writes {"q1":{"flag","reason"},...} to applications.form_flags.
//
// Called by the admin, via form-flags-background, for any completed form
// that has no flags yet (on job load, and when live refresh brings in a newly
// completed form). Deliberately NOT called inside complete-interview: that
// function already does booking + email + PDF + location inside Netlify's
// 10 s limit, and the applicant's submit must never wait on this. A Sonnet
// call takes 6-12 s, hence the background function.
// No npm packages (revive-jobs has no package.json) - fetch only.
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SVC_KEY;
const CLAUDE_API_KEY = process.env.CLAUDE_KEY;
const MODEL = 'claude-sonnet-4-6';   // runs in a -background function, so speed is not critical
const FLAGS = ['red', 'amber', 'green'];

function svc(extra) {
  return Object.assign({
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    'Accept-Profile': 'jobs',
    'Content-Profile': 'jobs'
  }, extra || {});
}

function nzToday() {
  return new Date().toLocaleDateString('en-NZ', {
    timeZone: 'Pacific/Auckland', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric'
  });
}

// Models get month arithmetic across a year boundary wrong (said Feb 2027 was
// "16 months" away on 7 Oct 2026), so hand it a lookup table instead.
function monthsTable() {
  const p = new Intl.DateTimeFormat('en-NZ', { timeZone: 'Pacific/Auckland', year: 'numeric', month: 'numeric' })
    .formatToParts(new Date());
  let y = +p.find(x => x.type === 'year').value, m = +p.find(x => x.type === 'month').value - 1;
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const out = [];
  for (let i = 0; i <= 24; i++) {
    out.push(`${names[m]} ${y} = ${i} month${i === 1 ? '' : 's'} away`);
    if (++m === 12) { m = 0; y++; }
  }
  return out.join('; ');
}

function stripTags(html) {
  return String(html || '').replace(/<\/(p|li|div|h\d)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

async function flagForm(applicationId) {
  if (!CLAUDE_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error('Server not configured');

  const ar = await fetch(`${SUPABASE_URL}/rest/v1/applications?id=eq.${encodeURIComponent(applicationId)}` +
    `&select=id,job_id,extended_form_completed,interview_notes,interview_token,on_visa,visa_type,visa_length,visa_conditions,work_rights`,
    { headers: svc() });
  const rows = await ar.json().catch(() => []);
  if (!Array.isArray(rows) || !rows.length) return { ok: false, status: 404, error: 'Application not found' };
  const app = rows[0];
  if (!app.extended_form_completed || !app.interview_notes) return { ok: false, status: 409, error: 'Form not completed' };

  let raw;
  try { raw = JSON.parse(app.interview_notes); } catch { raw = null; }
  if (!raw || typeof raw !== 'object') return { ok: false, status: 422, error: 'Form answers unreadable' };
  const keys = Object.keys(raw);
  if (!keys.length) return { ok: false, status: 422, error: 'Form is empty' };

  const jr = await fetch(`${SUPABASE_URL}/rest/v1/jobs?id=eq.${app.job_id}&select=title,type,description,min_hours,start_date,start_asap`,
    { headers: svc() });
  const job = ((await jr.json().catch(() => [])) || [])[0] || {};
  const isCasual = String(job.type || '').toLowerCase() === 'casual';

  const formText = keys.map(k => {
    const it = raw[k] || {};
    const a = String(it.answer || '').trim();
    return `${k}: ${it.question || k}\nANSWER: ${a || '(left blank)'}`;
  }).join('\n\n');

  const visa = app.on_visa
    ? `On a visa. Type: ${app.visa_type || 'not given'}. Expiry (as typed on the ad form): ${app.visa_length || 'not given'}. Conditions: ${app.visa_conditions || 'none given'}.`
    : `Not on a visa (right to work: ${String(app.work_rights || 'not stated').replace(/_/g, ' ')}).`;

  const prompt = `You are checking a job applicant's completed application form for Revive Cafe (Auckland, NZ) so the manager can see at a glance which answers need attention.

TODAY (NZ): ${nzToday()}
MONTHS FROM TODAY (use this table, do not do your own date arithmetic): ${monthsTable()}. Anything later is over 24 months away.
ROLE: ${job.title || 'unknown'}${job.type ? ' (' + String(job.type).replace(/_/g, ' ') + ')' : ''}${job.min_hours ? ', min ' + job.min_hours + ' hrs/week' : ''}${job.start_asap ? ', start ASAP' : (job.start_date ? ', start ' + job.start_date : '')}
ROLE DETAILS (for shift days/hours):
${stripTags(job.description).slice(0, 2500)}

VISA (from the ad form): ${visa}

FORM ANSWERS:
${formText}

Give EVERY question key above exactly one flag:
- "red": a real problem for this role that the manager must see.
- "amber": not a deal-breaker, but worth asking about at interview.
- "green": fine, nothing to check (including "No"/"None" answers to problem questions, and plain information such as an address or ID).

Rules:
- Holidays / absences planned: ANY planned holiday, trip or absence (dates or not) = red; say when and how long. None = green.
- Commitment (how many months): ${isCasual
    ? 'casual role: 6+ months green, 3-5 months amber, under 3 months red.'
    : 'permanent / non-casual role: 12+ months green, 6-11 months amber, under 6 months red.'} "Long term", "indefinitely", "as long as needed" = green. Vague "about a year?" = green. A visa or per-employer limit that caps the commitment counts.
- Visa / work period: a per-employer limit or visa expiry that ends within 6 months of today = red; within 12 months = amber; citizen, resident or long open work visa = green. Use the visa line above as well as the answer. If the answer is blank and they are not on a visa, green.
- Hours or days not available: a clash with the role's core shift days/hours = red; a clash with some shifts or overtime only = amber; no clash with this role's shifts = green (say why in the reason). Quote what they actually said - never invent days.
- Hours wanted: a mismatch with the role (e.g. wants part time for a full-time role, or a study-visa hours cap) = amber or red by size.
- Study: currently studying = amber (hours caps, exams, timetable); finished or not studying = green.
- Medical questions: "No"/blank = green. Any condition disclosed = amber with the reason exactly "Discuss any support needed" — never red unless they say it stops them doing the job. Never comment on or speculate about the condition.
- Court convictions or court action: anything other than no = red.
- Overtime / short notice: no or reluctant = amber.
- Referees: fewer than two, or only friends/partner/family, or no contact details = amber.
- Identification: none offered = amber.
- Address and living situation: flatting, renting, apartment, living with family/partner, own home or anything ordinary = green. Only hostel, backpackers, couch-surfing, house-sitting or "looking for a place" = amber.
- "Anything else that could affect employment": anything substantive = amber, or red if it clearly conflicts with the role.
- A blank answer to a question that needed one (address, ID, commitment, holidays, availability, referees) = amber "Not answered". Blank medical, conviction, study or visa answers = green.
- Never flag anything because of nationality, ethnicity, age, gender, religion or family status.

Reason: max 12 words, specific (dates, months, days). For green use "" unless a short note helps.

Reply with ONLY JSON, no other text:
{"q1":{"flag":"green","reason":""},"q2":{"flag":"amber","reason":"..."}}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 1200, messages: [{ role: 'user', content: prompt }] })
  });
  if (!res.ok) throw new Error('Claude ' + res.status + ' ' + (await res.text().catch(() => '')).slice(0, 200));
  const out = await res.json();
  const text = (out.content || []).map(c => c.text || '').join('').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('No JSON from model');
  const parsed = JSON.parse(m[0]);

  // Keep only the real question keys, with a valid flag and a short reason.
  const flags = {};
  keys.forEach(k => {
    const f = parsed[k] || {};
    const flag = FLAGS.includes(f.flag) ? f.flag : 'amber';
    const reason = String(f.reason || (FLAGS.includes(f.flag) ? '' : 'Not checked — review manually')).slice(0, 160);
    flags[k] = { flag, reason };
  });

  const pr = await fetch(`${SUPABASE_URL}/rest/v1/applications?id=eq.${app.id}`, {
    method: 'PATCH',
    headers: svc({ Prefer: 'return=minimal' }),
    body: JSON.stringify({ form_flags: flags, form_flags_at: new Date().toISOString() })
  });
  if (!pr.ok) throw new Error('Save failed ' + pr.status + ' ' + (await pr.text().catch(() => '')).slice(0, 200));

  // Redraw the application-form PDF with the flags in it (7 Oct 2026) -
  // through complete-interview's existing rebuildPdf path, which reads
  // form_flags from the row we have just saved.
  if (app.interview_token) {
    try {
      const base = process.env.URL || 'https://jobs.revive.co.nz';
      const rb = await fetch(`${base}/.netlify/functions/complete-interview`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: app.interview_token, rebuildPdf: true })
      });
      if (!rb.ok) console.error('PDF rebuild after flags failed', rb.status, (await rb.text().catch(() => '')).slice(0, 200));
    } catch (e) { console.error('PDF rebuild after flags threw', e); }
  }

  const count = f => Object.values(flags).filter(x => x.flag === f).length;
  return { ok: true, red: count('red'), amber: count('amber'), green: count('green') };
}

module.exports = { flagForm };
