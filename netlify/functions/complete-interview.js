// ============================================================
// REVIVE CAFE JOBS - Complete Interview Booking (Secure)
// Netlify Function: /netlify/functions/complete-interview
//
// Handles slot booking + extended form submission using the
// SERVICE ROLE KEY server-side. Validates the token, atomically
// books the slot, saves form data, sends confirmation email.
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SVC_KEY;
const RESEND_API_KEY = process.env.RESEND_KEY;

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const { token, slotId, answers, declarationsAgreed } = body;

  // The form can be completed without booking a time; the slot is optional.
  if (!token || (!body.rebuildPdf && !body.bookOnly && !body.reschedule && !declarationsAgreed)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields' }) };
  }

  try {
    // 1. Verify token is valid and application exists
    const appRes = await supabaseGet(
      `${SUPABASE_URL}/rest/v1/applications?interview_token=eq.${encodeURIComponent(token)}&select=id,full_name,email,phone,location,nationality,visa_type,visa_country,visa_conditions,on_visa,work_rights,work_rights_detail,referral_source,cover_letter,documents,created_at,job_id,extended_form_completed,interview_notes,interview_slot_id,declarations_agreed,declarations_agreed_at,form_flags`
    );

    if (!appRes.length) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Invalid token' }) };
    }

    const application = appRes[0];

    // Rebuild the PDF for a form that was completed before PDFs existed, or
    // after the questions were corrected. Does not touch the booking.
    if (body.rebuildPdf) {
      await rebuildPdfFor(application);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, rebuilt: true }) };
    }

    // Reschedule (6 Oct 2026): the Reschedule button in the confirmation email
    // opens interview.html?reschedule=1. Book the new time first, then release
    // the old one, so a failure never leaves them with no interview at all.
    if (body.reschedule) {
      const oldSlotId = application.interview_slot_id;
      if (!oldSlotId) return { statusCode: 409, headers, body: JSON.stringify({ error: "You don't have an interview booked yet." }) };
      if (!slotId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please choose a new time.' }) };
      if (slotId === oldSlotId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'That is already your interview time.' }) };
      // bookSlot links the slot to the application when the form is complete; force that here.
      const booked = await bookSlot({ ...application, extended_form_completed: true }, slotId);
      if (booked.error) return { statusCode: booked.status, headers, body: JSON.stringify({ error: booked.error }) };
      await releaseSlot(oldSlotId, application.id);
      application.interview_slot_id = slotId;
      await advanceStatus(application.id, 'interview_accepted');
      const jr = await supabaseGet(
        `${SUPABASE_URL}/rest/v1/jobs?id=eq.${application.job_id}&select=title,type,employer_name,employer_email,interview_location_type,interview_location_detail,interview_meeting_link`
      );
      const rjob = (jr && jr[0]) || {};
      const when = formatSlot(booked.slot.slot_time);
      await sendInterviewConfirmation(application, rjob, when, token);
      try { await rebuildPdfFor(application); } catch (e) { console.error('PDF rebuild after reschedule failed (booking still saved)', e); }
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, slotTime: when, rescheduled: true }) };
    }

    // Form already done but no time picked yet: the applicant has come back to the
    // same link to choose one (the form promises they can). Book only.
    if (application.extended_form_completed && body.bookOnly) {
      if (application.interview_slot_id) {
        return { statusCode: 409, headers, body: JSON.stringify({ error: 'You already have an interview booked.' }) };
      }
      if (!slotId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please choose a time.' }) };
      const booked = await bookSlot(application, slotId);
      if (booked.error) return { statusCode: booked.status, headers, body: JSON.stringify({ error: booked.error }) };
      application.interview_slot_id = slotId;
      await advanceStatus(application.id, 'interview_accepted');
      const jr = await supabaseGet(
        `${SUPABASE_URL}/rest/v1/jobs?id=eq.${application.job_id}&select=title,type,employer_name,employer_email,interview_location_type,interview_location_detail,interview_meeting_link`
      );
      const bjob = (jr && jr[0]) || {};
      const when = formatSlot(booked.slot.slot_time);
      await sendInterviewConfirmation(application, bjob, when, token);
      try { await rebuildPdfFor(application); } catch (e) { console.error('PDF rebuild after booking failed (booking still saved)', e); }
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, slotTime: when }) };
    }

    if (application.extended_form_completed) {
      return { statusCode: 409, headers, body: JSON.stringify({ error: 'Already completed' }) };
    }

    // 2 & 3. Book a slot if one was chosen. The form can be completed without a
    // time — the applicant returns to the same link to pick one later.
    let slot = null;
    if (slotId) {
      const booked = await bookSlot(application, slotId);
      if (booked.error) return { statusCode: booked.status, headers, body: JSON.stringify({ error: booked.error }) };
      slot = booked.slot;
    }

    // 4. Save extended form data to application
    const settings = await supabaseGet(
      `${SUPABASE_URL}/rest/v1/settings?key=in.(interview_form_questions,declarations_text)&select=key,value`
    );
    const settingsMap = {};
    (settings || []).forEach(r => { settingsMap[r.key] = r.value; });
    const questionList = (settingsMap.interview_form_questions || '')
      .split('\n').map(q => q.trim()).filter(Boolean);
    const declarationList = (settingsMap.declarations_text || '')
      .split('\n').map(d => d.trim()).filter(Boolean);

    // Store the question text alongside the answer, so the record still makes
    // sense if the questions are edited later.
    const questionAnswers = {};
    (answers || []).forEach((ans, i) => {
      questionAnswers[`q${i + 1}`] = { question: questionList[i] || `Question ${i + 1}`, answer: ans };
    });

    const appPatch = await supabasePatch(
      `${SUPABASE_URL}/rest/v1/applications?id=eq.${application.id}`,
      {
        ...(slotId ? { interview_slot_id: slotId } : {}),
        declarations_agreed: true,
        declarations_agreed_at: new Date().toISOString(),
        extended_form_completed: true,
        interview_notes: JSON.stringify(questionAnswers)
      }
    );
    if (!appPatch.ok) {
      const detail = await appPatch.text().catch(() => '');
      console.error('Application save failed', appPatch.status, detail);
      if (slotId) await releaseSlot(slotId, application.id);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'We could not save your form — please try again. If it keeps happening, reply to the email we sent you.' }) };
    }
    await advanceStatus(application.id, slotId ? 'interview_accepted' : 'interview_offered');

    // 5. Fetch job for the email and the PDF
    const jobRes = await supabaseGet(
      `${SUPABASE_URL}/rest/v1/jobs?id=eq.${application.job_id}&select=title,type,employer_name,employer_email,interview_location_type,interview_location_detail,interview_meeting_link`
    );
    const job = jobRes[0] || {};

    // 6. Send confirmation email
    const slotTime = slot ? new Date(slot.slot_time).toLocaleString('en-NZ', {
      weekday: 'long', day: 'numeric', month: 'long',
      hour: '2-digit', minute: '2-digit', hour12: true,
      timeZone: 'Pacific/Auckland'
    }) : '';

    // Route through send-email so this uses the editable Settings template and
    // the same reply-to rules as every other email, rather than its own copy.
    if (slot) await sendInterviewConfirmation(application, job, slotTime, token);

    // 7. Build a one-page PDF of the completed application and attach it to
    // their documents, so the whole application is one printable record.
    try {
      await attachApplicationPdf({
        application, job, slotTime, questionAnswers, declarationList
      });
    } catch (err) {
      console.error('Application PDF failed (booking still saved)', err);
    }

    // 8. Their typed address now replaces anything read off the CV for the
    // suburb + distance shown on the admin tile.
    try { await require('./_home').locate(application.id); }
    catch (err) { console.error('Home location failed (form still saved)', err); }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, slotTime })
    };

  } catch (err) {
    console.error('complete-interview error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error: ' + err.message }) };
  }
};

// ============================================================
// BOOKING HELPERS (6 Oct 2026)
// ============================================================

// Book a slot for this application. The PATCH is filtered on is_booked=false and
// asks for the changed rows back, so a slot someone else just took returns zero
// rows instead of a silent 204 that looked like success.
// Status (7 Oct 2026): 'interview' was split into interview_offered (invited,
// no time yet) and interview_accepted (time booked). Only moves people forward:
// the status filter means Hired / Not Hired / Not Suitable / Deleted are never
// overwritten. A failure is logged, never fails the booking.
const ADVANCE_FROM = {
  interview_offered:  ['new', 'ai_shortlist', 'shortlist_a', 'shortlist_b', 'interview'],
  interview_accepted: ['new', 'ai_shortlist', 'shortlist_a', 'shortlist_b', 'interview', 'interview_offered']
};
async function advanceStatus(appId, status) {
  try {
    const from = ADVANCE_FROM[status];
    const r = await supabasePatch(
      `${SUPABASE_URL}/rest/v1/applications?id=eq.${appId}&status=in.(${from.join(',')})`, { status });
    if (!r.ok) console.error('Status update failed', status, r.status, await r.text().catch(() => ''));
  } catch (e) { console.error('Status update failed', status, e); }
}

async function bookSlot(application, slotId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/interview_slots?id=eq.${encodeURIComponent(slotId)}&job_id=eq.${application.job_id}&is_booked=eq.false&select=id,slot_time`,
    { method: 'PATCH', headers: {
        apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json', 'Accept-Profile': 'jobs', 'Content-Profile': 'jobs',
        Prefer: 'return=representation' },
      body: JSON.stringify({ is_booked: true, application_id: application.id }) });
  if (!res.ok) {
    console.error('Slot booking failed', res.status, await res.text().catch(() => ''));
    return { status: 500, error: 'We could not book that time — please try again.' };
  }
  const rows = await res.json().catch(() => []);
  if (!rows.length) return { status: 409, error: 'Slot no longer available — please choose another time.' };
  if (application.extended_form_completed) {
    // Book-only path: the form is already saved, so link the slot now and
    // undo the booking if that write fails.
    const p = await supabasePatch(`${SUPABASE_URL}/rest/v1/applications?id=eq.${application.id}`, { interview_slot_id: slotId });
    if (!p.ok) {
      console.error('Linking slot to application failed', p.status, await p.text().catch(() => ''));
      await releaseSlot(slotId, application.id);
      return { status: 500, error: 'We could not save your booking — please try again.' };
    }
  }
  return { slot: rows[0] };
}

async function releaseSlot(slotId, applicationId) {
  const r = await supabasePatch(
    `${SUPABASE_URL}/rest/v1/interview_slots?id=eq.${encodeURIComponent(slotId)}&application_id=eq.${applicationId}`,
    { is_booked: false, application_id: null });
  if (!r.ok) console.error('Could not release slot', slotId, r.status);
}

function formatSlot(iso) {
  return new Date(iso).toLocaleString('en-NZ', {
    weekday: 'long', day: 'numeric', month: 'long',
    hour: '2-digit', minute: '2-digit', hour12: true,
    timeZone: 'Pacific/Auckland'
  });
}

// Route through send-email so this uses the editable Settings template and
// the same reply-to rules as every other email, rather than its own copy.
async function sendInterviewConfirmation(application, job, slotTime, token) {
  try {
    const base = process.env.URL || 'https://jobs.revive.co.nz';
    const res = await fetch(`${base}/.netlify/functions/send-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'interview_confirmation',
        jobId: application.job_id,
        employerEmail: job.employer_email,
        applicantName: application.full_name,
        applicantEmail: application.email,
        jobTitle: job.title,
        jobType: job.type,
        interviewTime: slotTime,
        employerName: job.employer_name,
        interviewLocation: interviewLocation(job),
        // Reschedule button in the email: same link, straight into choosing a new time.
        rescheduleLink: token ? `${base}/interview.html?token=${encodeURIComponent(token)}&reschedule=1` : ''
      })
    });
    if (!res.ok) console.error('Interview confirmation email failed', res.status, await res.text().catch(() => ''));
  } catch (err) {
    console.error('Interview confirmation email threw (booking still saved)', err);
  }
}

// Rebuild the one-page application PDF from what is stored (answers, slot).
async function rebuildPdfFor(application) {
  const s2 = await supabaseGet(
    `${SUPABASE_URL}/rest/v1/settings?key=in.(interview_form_questions,declarations_text)&select=key,value`
  );
  const m2 = {}; (s2 || []).forEach(r => { m2[r.key] = r.value; });
  const qs2 = (m2.interview_form_questions || '').split('\n').map(q => q.trim()).filter(Boolean);
  const ds2 = (m2.declarations_text || '').split('\n').map(d => d.trim()).filter(Boolean);
  let stored = {};
  try { stored = JSON.parse(application.interview_notes || '{}'); } catch (e) {}
  const qa2 = {};
  Object.keys(stored).forEach(k => {
    const idx = parseInt(String(k).replace(/\D/g, ''), 10) - 1;
    qa2[k] = { question: (stored[k] && stored[k].question) || qs2[idx] || `Question ${idx + 1}`,
               answer: (stored[k] && stored[k].answer) || '' };
  });
  const j2 = await supabaseGet(
    `${SUPABASE_URL}/rest/v1/jobs?id=eq.${application.job_id}&select=title,type,interview_location_type,interview_location_detail,interview_meeting_link`
  );
  let when = '';
  if (application.interview_slot_id) {
    const sl = await supabaseGet(`${SUPABASE_URL}/rest/v1/interview_slots?id=eq.${application.interview_slot_id}&select=slot_time`);
    if (sl && sl[0]) when = new Date(sl[0].slot_time).toLocaleString('en-NZ', {
      weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit',
      hour12: true, timeZone: 'Pacific/Auckland'
    });
  }
  await attachApplicationPdf({
    application, job: (j2 && j2[0]) || {}, slotTime: when,
    questionAnswers: qa2, declarationList: ds2,
    flags: application.form_flags || null
  });
}

// ============================================================
// SUPABASE HELPERS (service role key)
// ============================================================

async function supabaseGet(url) {
  const res = await fetch(url, {
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Accept-Profile': 'jobs'
    }
  });
  if (!res.ok) throw new Error(`GET ${res.status}: ${await res.text()}`);
  return res.json();
}

async function supabasePatch(url, data) {
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Accept-Profile': 'jobs',
      'Content-Profile': 'jobs',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(data)
  });
  return res; // Return raw response so caller can check .ok
}

// Where the interview happens, as one line for the email.
function interviewLocation(job) {
  if (!job) return '';
  if (job.interview_location_type === 'video') {
    return job.interview_meeting_link
      ? 'Zoom / Meet video call — ' + job.interview_meeting_link
      : 'Zoom / Meet video call — we will email you the link';
  }
  return job.interview_location_detail || '24 Wyndham St, Auckland CBD';
}


// ============================================================
// APPLICATION PDF
// ============================================================
const { buildPdf } = require('./_pdf');

function labelFor(map, value, fallback) {
  return map[value] || value || fallback || '';
}

async function attachApplicationPdf({ application, job, slotTime, questionAnswers, declarationList, flags }) {
  // Review flags (7 Oct 2026) - written by _formflags after the form is in;
  // every rebuild (booking, reschedule, flagging) reads them from the row.
  const formFlags = (flags && typeof flags === 'object') ? flags
    : ((application.form_flags && typeof application.form_flags === 'object') ? application.form_flags : null);
  const workRights = labelFor({
    citizen: 'NZ / Australian Citizen', resident: 'NZ Permanent Resident',
    work_visa: 'Work / Student Visa', student_visa: 'Student Visa', other: 'Other'
  }, application.work_rights, 'Not stated');

  const referral = labelFor({
    seek: 'Seek', instagram: 'Instagram', facebook: 'Facebook', friend: 'Friend / word of mouth',
    walked_past: 'Walked past the cafe', backpacker_board: 'Backpacker Board', other: 'Other'
  }, application.referral_source, 'Not stated');

  const blocks = [];
  blocks.push({ text: 'Revive Cafe - Employment Application', style: 'title' });
  blocks.push({ text: [application.full_name, application.email, application.phone].filter(Boolean).join('  |  '), style: 'body' });
  blocks.push({ style: 'rule' });

  blocks.push({ text: 'POSITION & INTERVIEW', style: 'heading' });
  blocks.push({ style: 'qa', question: 'Applied for', answer: (job.title || '') + (job.type ? ' (' + String(job.type).replace(/_/g, ' ') + ')' : '') });
  blocks.push({ style: 'qa', question: 'Application received', answer: formatNZ(application.created_at) });
  if (slotTime) blocks.push({ style: 'qa', question: 'Interview', answer: slotTime + ' - ' + interviewLocation(job) });
  blocks.push({ style: 'space', h: 5 });

  blocks.push({ text: 'APPLICANT DETAILS', style: 'heading' });
  [
    ['Location', application.location],
    ['Nationality', application.nationality],
    ['Right to work', workRights + (application.work_rights_detail ? ' - ' + application.work_rights_detail : '')],
    ['Visa', application.on_visa
      ? [application.visa_type, application.visa_country ? 'nationality ' + application.visa_country : '', application.visa_conditions].filter(Boolean).join(', ')
      : ''],
    ['Heard about us via', referral]
  ].filter(([, v]) => v).forEach(([k, v]) => blocks.push({ style: 'qa', question: k, answer: v }));
  blocks.push({ style: 'space', h: 5 });

  blocks.push({ text: 'APPLICATION FORM', style: 'heading' });
  Object.keys(questionAnswers).forEach(k => {
    const qa = questionAnswers[k];
    // Blank answers stay blank — a printed form is easier to read with gaps
    // than with "no answer" repeated down the page.
    const fl = formFlags && formFlags[k];
    blocks.push({ style: 'qa', question: qa.question, answer: (qa.answer && String(qa.answer).trim()) || '',
                  flag: fl && ['red', 'amber', 'green'].includes(fl.flag) ? fl.flag : null,
                  reason: fl ? fl.reason : '' });
  });

  blocks.push({ style: 'rule' });
  const agreedAt = application.declarations_agreed_at || new Date().toISOString();
  blocks.push({ text: 'DECLARATIONS', style: 'heading' });
  blocks.push({ text: 'Agreed ' + formatNZ(agreedAt) + ' by ' + application.full_name + '.', style: 'body' });
  blocks.push({ style: 'space', h: 3 });
  (declarationList || []).forEach(d => {
    blocks.push({ style: 'tick', text: d, checked: application.declarations_agreed !== false });
    blocks.push({ style: 'space', h: 2 });
  });

  const pdf = buildPdf(blocks, { title: 'Application - ' + application.full_name });

  const safeName = String(application.full_name || 'applicant').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
  const path = `${application.job_id}/${application.id}_application-form.pdf`;
  const filename = `Application Form - ${safeName}.pdf`;

  const up = await fetch(`${SUPABASE_URL}/storage/v1/object/jobs-resumes/${path}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/pdf',
      'x-upsert': 'true'
    },
    body: pdf
  });
  if (!up.ok) throw new Error('storage upload failed: ' + up.status + ' ' + await up.text().catch(() => ''));

  // Add it to their documents without disturbing what they uploaded themselves.
  const docs = Array.isArray(application.documents) ? application.documents.slice() : [];
  const entry = { path, filename, size: pdf.length, kind: 'application_form' };
  const existing = docs.findIndex(d => d && d.path === path);
  if (existing >= 0) docs[existing] = entry; else docs.push(entry);

  await supabasePatch(`${SUPABASE_URL}/rest/v1/applications?id=eq.${application.id}`, { documents: docs });
}

function formatNZ(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-NZ', {
    weekday: 'short', day: 'numeric', month: 'long', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Pacific/Auckland'
  });
}
