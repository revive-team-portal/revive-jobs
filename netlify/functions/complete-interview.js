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
      `${SUPABASE_URL}/rest/v1/applications?interview_token=eq.${encodeURIComponent(token)}&select=id,full_name,email,job_id,extended_form_completed`
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
    const questionAnswers = {};
    (answers || []).forEach((ans, i) => {
      questionAnswers[`q${i + 1}`] = { answer: ans };
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

    // 5. Fetch job for email
    const jobRes = await supabaseGet(
      `${SUPABASE_URL}/rest/v1/jobs?id=eq.${application.job_id}&select=title,employer_name,employer_email`
    );
    const job = jobRes[0] || {};

    // 6. Send confirmation email
    const slotTime = new Date(slot.slot_time).toLocaleString('en-NZ', {
      weekday: 'long', day: 'numeric', month: 'long',
      hour: '2-digit', minute: '2-digit', hour12: true,
      timeZone: 'Pacific/Auckland'
    });

    await sendConfirmationEmail({
      applicantName: application.full_name,
      applicantEmail: application.email,
      jobTitle: job.title,
      interviewTime: slotTime,
      employerName: job.employer_name,
      replyTo: job.employer_email || 'jobs@revivealicious.com'
    });

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
