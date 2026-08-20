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
const FROM_EMAIL = 'Revive Cafe Jobs <jobs@revivealicious.com>';

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

  if (!token || !slotId || !declarationsAgreed) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields' }) };
  }

  try {
    // 1. Verify token is valid and application exists
    const appRes = await supabaseGet(
      `${SUPABASE_URL}/rest/v1/applications?interview_token=eq.${encodeURIComponent(token)}&select=id,full_name,email,phone,location,nationality,visa_type,visa_country,visa_conditions,on_visa,work_rights,work_rights_detail,referral_source,cover_letter,documents,created_at,job_id,extended_form_completed`
    );

    if (!appRes.length) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Invalid token' }) };
    }

    const application = appRes[0];

    if (application.extended_form_completed) {
      return { statusCode: 409, headers, body: JSON.stringify({ error: 'Already completed' }) };
    }

    // 2. Verify the slot exists, belongs to this job, and is still free
    const slotRes = await supabaseGet(
      `${SUPABASE_URL}/rest/v1/interview_slots?id=eq.${slotId}&job_id=eq.${application.job_id}&is_booked=eq.false&select=id,slot_time`
    );

    if (!slotRes.length) {
      return { statusCode: 409, headers, body: JSON.stringify({ error: 'Slot no longer available — please choose another time.' }) };
    }

    const slot = slotRes[0];

    // 3. Atomically book the slot (PATCH with filter ensures race-condition safety)
    const slotPatch = await supabasePatch(
      `${SUPABASE_URL}/rest/v1/interview_slots?id=eq.${slotId}&is_booked=eq.false`,
      { is_booked: true, application_id: application.id }
    );

    if (!slotPatch.ok) {
      return { statusCode: 409, headers, body: JSON.stringify({ error: 'Slot was just taken — please choose another time.' }) };
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

    await supabasePatch(
      `${SUPABASE_URL}/rest/v1/applications?id=eq.${application.id}`,
      {
        interview_slot_id: slotId,
        declarations_agreed: true,
        extended_form_completed: true,
        interview_notes: JSON.stringify(questionAnswers),
        status: 'interview'
      }
    );

    // 5. Fetch job for the email and the PDF
    const jobRes = await supabaseGet(
      `${SUPABASE_URL}/rest/v1/jobs?id=eq.${application.job_id}&select=title,type,employer_name,employer_email,interview_location_type,interview_location_detail,interview_meeting_link`
    );
    const job = jobRes[0] || {};

    // 6. Send confirmation email
    const slotTime = new Date(slot.slot_time).toLocaleString('en-NZ', {
      weekday: 'long', day: 'numeric', month: 'long',
      hour: '2-digit', minute: '2-digit', hour12: true,
      timeZone: 'Pacific/Auckland'
    });

    // Route through send-email so this uses the editable Settings template and
    // the same reply-to rules as every other email, rather than its own copy.
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
          interviewLocation: interviewLocation(job)
        })
      });
      if (!res.ok) console.error('Interview confirmation email failed', res.status, await res.text().catch(() => ''));
    } catch (err) {
      console.error('Interview confirmation email threw (booking still saved)', err);
    }

    // 7. Build a one-page PDF of the completed application and attach it to
    // their documents, so the whole application is one printable record.
    try {
      await attachApplicationPdf({
        application, job, slotTime, questionAnswers, declarationList
      });
    } catch (err) {
      console.error('Application PDF failed (booking still saved)', err);
    }

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

// ============================================================
// CONFIRMATION EMAIL
// ============================================================

async function sendConfirmationEmail({ applicantName, applicantEmail, jobTitle, interviewTime, employerName, replyTo }) {
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Open Sans',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
        <tr>
          <td style="background:#40d134;padding:32px;text-align:center;">
            <img src="https://www.revive.co.nz/cdn/shop/files/01-060_Revive_Cafe_Logo_40x.png" alt="Revive Cafe" style="height:50px;margin-bottom:12px;"><br>
            <span style="color:#fff;font-size:22px;font-weight:700;">Interview Confirmed ✓</span>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;">
            <p style="font-size:16px;color:#333;margin:0 0 16px;">Hi <strong>${applicantName}</strong>,</p>
            <p style="font-size:15px;color:#555;line-height:1.6;margin:0 0 24px;">Your interview has been confirmed. Here are the details:</p>
            <div style="background:#f0fdf0;border-radius:6px;padding:24px;margin-bottom:24px;border:2px solid #b5edb1;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr><td style="padding:6px 0;color:#666;width:140px;">Interview Time</td><td style="padding:6px 0;font-weight:700;font-size:16px;color:#333;">${interviewTime}</td></tr>
                <tr><td style="padding:6px 0;color:#666;">Position</td><td style="padding:6px 0;">${jobTitle}</td></tr>
                <tr><td style="padding:6px 0;color:#666;">Location</td><td style="padding:6px 0;">Revive Cafe, Auckland CBD</td></tr>
              </table>
            </div>
            <p style="color:#555;font-size:14px;line-height:1.6;">Please arrive a few minutes early. If you need to reschedule, contact us at <a href="mailto:jobs@revivealicious.com" style="color:#40d134;">jobs@revivealicious.com</a></p>
            <p style="color:#555;font-size:14px;">We look forward to meeting you!</p>
          </td>
        </tr>
        <tr>
          <td style="background:#333;padding:24px;text-align:center;">
            <p style="color:#aaa;font-size:13px;margin:0;">
              Warm regards,<br>
              <strong style="color:#fff;">${employerName || 'The Revive Cafe Team'}</strong><br>
              <a href="mailto:jobs@revivealicious.com" style="color:#40d134;">jobs@revivealicious.com</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: applicantEmail,
      reply_to: replyTo || 'jobs@revivealicious.com',
      subject: `Interview Confirmed — ${jobTitle} at Revive Cafe`,
      html
    })
  });
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

async function attachApplicationPdf({ application, job, slotTime, questionAnswers, declarationList }) {
  const workRights = labelFor({
    citizen: 'NZ / Australian Citizen', resident: 'NZ Permanent Resident',
    work_visa: 'Work Visa', student_visa: 'Student Visa', other: 'Other'
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
  blocks.push({ text: 'Applied for: ' + (job.title || '') + (job.type ? ' (' + job.type.replace(/_/g, ' ') + ')' : ''), style: 'body' });
  blocks.push({ text: 'Applied on: ' + formatNZ(application.created_at), style: 'body' });
  blocks.push({ text: 'Interview: ' + (slotTime || '') + ' - ' + interviewLocation(job), style: 'body' });
  blocks.push({ style: 'space', h: 5 });

  blocks.push({ text: 'APPLICANT DETAILS', style: 'heading' });
  const details = [
    ['Location', application.location],
    ['Nationality', application.nationality],
    ['Right to work', workRights + (application.work_rights_detail ? ' - ' + application.work_rights_detail : '')],
    ['Visa', application.on_visa
      ? [application.visa_type, application.visa_country, application.visa_conditions].filter(Boolean).join(', ')
      : null],
    ['Heard about us via', referral]
  ].filter(([, v]) => v);
  details.forEach(([k, v]) => blocks.push({ text: k + ': ' + v, style: 'body' }));
  blocks.push({ style: 'space', h: 5 });

  if (application.cover_letter && application.cover_letter.trim()) {
    blocks.push({ text: 'COVER LETTER', style: 'heading' });
    blocks.push({ text: application.cover_letter.trim(), style: 'body' });
    blocks.push({ style: 'space', h: 5 });
  }

  blocks.push({ text: 'APPLICATION FORM', style: 'heading' });
  Object.keys(questionAnswers).forEach(k => {
    const qa = questionAnswers[k];
    blocks.push({ text: qa.question, style: 'label' });
    blocks.push({ text: (qa.answer && String(qa.answer).trim()) || 'No answer given', style: 'body' });
    blocks.push({ style: 'space', h: 2.5 });
  });

  blocks.push({ style: 'rule' });
  blocks.push({ text: 'DECLARATIONS - agreed ' + formatNZ(new Date().toISOString()), style: 'heading' });
  (declarationList || []).forEach(d => {
    blocks.push({ text: '- ' + d, style: 'body' });
    blocks.push({ style: 'space', h: 2 });
  });
  blocks.push({ text: 'Agreed electronically by ' + application.full_name + ' via the Revive Cafe interview booking form.', style: 'body' });

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
