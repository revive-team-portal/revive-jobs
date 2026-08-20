// ============================================================
// REVIVE CAFE JOBS - Email Sending Function
// Netlify Function: /netlify/functions/send-email
// Uses Resend API for all transactional emails
// ============================================================

const RESEND_API_KEY = process.env.RESEND_KEY;
const FROM_EMAIL = 'Revive Cafe Jobs <jobs@revivealicious.com>';
const DEFAULT_REPLY_TO = 'jobs@revivealicious.com';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SVC_KEY;

// Replies go to the contact address set on the job. Resolved here, once, so no
// caller can forget to pass it — give this function a jobId and it looks the
// address up itself; an explicit employerEmail wins if one is supplied.
// The Settings screen stores an editable subject and body for each email type,
// with {{placeholder}} tokens. Those templates are the source of truth; the
// hardcoded builders below are only a fallback if a template is missing.
const TEMPLATE_KEYS = {
  application_confirmation: ['email_confirmation_subject', 'email_confirmation_body', 'Application Received!'],
  interview_invite: ['email_interview_subject', 'email_interview_body', 'Interview Invitation'],
  interview_confirmation: ['email_interview_confirmation_subject', 'email_interview_confirmation_body', 'Interview Confirmed'],
  rejection: ['email_rejection_subject', 'email_rejection_body', 'Your Application'],
  bulk_rejection: ['email_rejection_subject', 'email_rejection_body', 'Your Application']
};

async function loadSettings(keys) {
  const out = {};
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return out;
  try {
    const q = keys.map(encodeURIComponent).join(',');
    const r = await fetch(`${SUPABASE_URL}/rest/v1/settings?key=in.(${q})&select=key,value`, {
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Accept-Profile': 'jobs'
      }
    });
    if (r.ok) (await r.json()).forEach(row => { out[row.key] = row.value; });
  } catch (err) {
    console.error('Could not load email templates', err);
  }
  return out;
}

function esc(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fillTokens(text, values) {
  return String(text || '').replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (m, key) => {
    const v = values[key];
    return (v === null || v === undefined) ? '' : String(v);
  });
}

// Wrap the plain-text template body in the branded shell so edits in Settings
// keep the Revive look without anyone having to write HTML.
function renderTemplate(bodyText, values, headline, contactEmail) {
  const filled = fillTokens(bodyText, values);
  const blocks = filled.split(/\n{2,}/).map(b => b.trim()).filter(Boolean).map(b => {
    if (/^-{3,}$/.test(b)) return '<hr style="border:none;border-top:1px solid #e5e5e5;margin:20px 0;">';
    const withBreaks = esc(b).replace(/\n/g, '<br>')
      .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#40d134;">$1</a>');
    return `<p style="font-size:15px;color:#555;line-height:1.7;margin:0 0 16px;">${withBreaks}</p>`;
  }).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Open Sans',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
        <tr><td style="background:#40d134;padding:30px 32px 26px;text-align:center;">
          <img src="https://jobs.revive.co.nz/images/revive-logo-ring.png" alt="Revive Cafe" width="64" height="64" style="width:64px;height:64px;display:block;margin:0 auto 14px;border:0;outline:none;text-decoration:none;">
          <span style="color:#ffffff;font-size:21px;font-weight:700;letter-spacing:-0.2px;line-height:1.25;display:block;">${esc(headline)}</span>
        </td></tr>
        <tr><td style="padding:32px;">${blocks}</td></tr>
        <tr><td style="background:#fafafa;padding:24px 32px;text-align:center;border-top:1px solid #eee;">
          <p style="margin:0;font-size:12px;color:#999;">Revive Cafe &middot; 24 Wyndham St, Auckland CBD</p>
          <p style="margin:6px 0 0;font-size:12px;color:#999;">${esc(contactEmail)}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

// Values available to {{tokens}} in any template.
function templateValues(data) {
  const visaLines = data.onVisa
    ? ['VISA TYPE: ' + (data.visaType || 'Not specified'),
       'COUNTRY: ' + (data.visaCountry || 'Not specified'),
       'CONDITIONS: ' + (data.visaConditions || 'None noted')].join('\n')
    : '';
  return {
    applicant_name: data.applicantName || '',
    applicant_email: data.applicantEmail || '',
    applicant_phone: data.applicantPhone || 'Not provided',
    applicant_location: data.applicantLocation || 'Not provided',
    referral_source: formatReferral(data.referralSource),
    job_title: data.jobTitle || '',
    job_type: formatJobType(data.jobType),
    job_description_summary: stripTags(data.jobDescription || '').slice(0, 400),
    job_description: htmlToText(data.jobDescription || ''),
    visa_info: visaLines,
    company_history: data.companyHistory || '',
    company_benefits: data.companyBenefits || '',
    interview_link: data.interviewLink || '',
    interview_time: data.interviewTime || '',
    interview_location: data.interviewLocation || '',
    employer_name: data.employerName || 'The Revive Cafe Team',
    employer_email: data.employerEmail || 'jobs@revivealicious.com'
  };
}

// The job description is rich text from the admin editor. Convert it to readable
// plain text so it drops into an email template without raw tags showing.
function htmlToText(h) {
  return String(h || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '\u2022 ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripTags(h) {
  return String(h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Returns { subject, html } from the stored template, or null to fall back.
async function buildFromTemplate(type, data, replyTo) {
  const keys = TEMPLATE_KEYS[type];
  if (!keys) return null;
  const [subjectKey, bodyKey, headline] = keys;
  const settings = await loadSettings([subjectKey, bodyKey]);
  const body = (settings[bodyKey] || '').trim();
  if (!body) return null;
  const values = templateValues(data);
  // Any address shown in the body should match where replies actually go.
  if (replyTo) values.employer_email = replyTo;
  const subject = fillTokens(settings[subjectKey] || '', values).trim();
  return {
    from: FROM_EMAIL,
    to: data.applicantEmail,
    subject: subject || `Revive Cafe — ${data.jobTitle || 'Your application'}`,
    html: renderTemplate(body, values, headline, values.employer_email)
  };
}

async function resolveReplyTo(data) {
  const explicit = (data.employerEmail || data.replyTo || '').trim();
  if (explicit) return explicit;

  const jobId = (data.jobId || data.job_id || '').trim();
  if (jobId && SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/jobs?id=eq.${encodeURIComponent(jobId)}&select=employer_email`,
        { headers: {
            apikey: SUPABASE_SERVICE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
            'Accept-Profile': 'jobs'
        } }
      );
      if (res.ok) {
        const rows = await res.json();
        const email = rows && rows[0] && (rows[0].employer_email || '').trim();
        if (email) return email;
      }
    } catch (err) {
      console.error('Could not resolve job reply-to address', err);
    }
  }
  return DEFAULT_REPLY_TO;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Content-Type': 'application/json'
  };

  // The CORS preflight must be answered before the method check, otherwise the
  // browser gets a 405 and blocks the real request. The admin is on
  // team.revive.co.nz calling this on jobs.revive.co.nz, so every call is
  // cross-origin and preflighted.
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let data;
  try {
    data = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { type } = data;

  try {
    const replyTo = await resolveReplyTo(data);
    let emailPayload = await buildFromTemplate(type, data, replyTo);

    switch (type) {
      case 'application_confirmation':
        if (!emailPayload) emailPayload = buildConfirmationEmail(data);
        break;
      case 'interview_invite':
        if (!emailPayload) emailPayload = buildInterviewInviteEmail(data);
        break;
      case 'interview_confirmation':
        if (!emailPayload) emailPayload = buildInterviewConfirmationEmail(data);
        break;
      case 'rejection':
        if (!emailPayload) emailPayload = buildRejectionEmail(data);
        break;
      case 'bulk_rejection':
        // Send multiple rejection emails
        const results = await sendBulkRejections(data.applicants, data.jobTitle, replyTo);
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, results }) };
      default:
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown email type' }) };
    }

    emailPayload.reply_to = replyTo;
    const result = await sendEmail(emailPayload);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, id: result.id }) };

  } catch (err) {
    console.error('Email send error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

// ============================================================
// EMAIL BUILDERS
// ============================================================

function buildConfirmationEmail(data) {
  const {
    applicantName, applicantEmail, applicantPhone, applicantLocation,
    referralSource, jobTitle, jobType, onVisa, visaType, visaCountry,
    visaExpiry, visaConditions, companyHistory, companyBenefits,
    employerEmail, employerName
  } = data;

  const jobTypeLabel = formatJobType(jobType);
  const referralLabel = formatReferral(referralSource);

  let visaInfo = '';
  if (onVisa) {
    visaInfo = `
<tr><td colspan="2" style="padding:8px 0;border-top:1px solid #eee;font-weight:600;color:#40d134;">VISA INFORMATION</td></tr>
<tr><td style="padding:4px 0;color:#666;width:160px;">Visa Type</td><td style="padding:4px 0;">${visaType || 'Not specified'}</td></tr>
<tr><td style="padding:4px 0;color:#666;">Country</td><td style="padding:4px 0;">${visaCountry || 'Not specified'}</td></tr>
<tr><td style="padding:4px 0;color:#666;">Expiry Date</td><td style="padding:4px 0;">${visaExpiry || 'Not specified'}</td></tr>
<tr><td style="padding:4px 0;color:#666;">Conditions</td><td style="padding:4px 0;">${visaConditions || 'None noted'}</td></tr>`;
  }

  const benefitsList = (companyBenefits || '').split('\n').filter(b => b.trim()).map(b =>
    `<li style="margin-bottom:6px;">${b.trim()}</li>`
  ).join('');

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Open Sans',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">

        <!-- Header -->
        <tr>
          <td style="background:#40d134;padding:32px;text-align:center;">
            <img src="https://jobs.revive.co.nz/images/revive-logo-ring.png" alt="Revive Cafe" width="64" height="64" style="width:64px;height:64px;display:block;margin:0 auto 14px;border:0;outline:none;text-decoration:none;">
            <span style="color:#ffffff;font-size:22px;font-weight:700;">Application Received!</span>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:32px;">
            <p style="font-size:16px;color:#333;margin:0 0 16px;">Hi <strong>${applicantName}</strong>,</p>
            <p style="font-size:15px;color:#555;line-height:1.6;margin:0 0 24px;">
              Thank you so much for applying for the <strong>${jobTitle}</strong> position at Revive Cafe.
              We have received your application and really appreciate you taking the time to apply.
            </p>

            <!-- Application Summary -->
            <div style="background:#f9f9f9;border-radius:6px;padding:20px;margin-bottom:24px;border-left:4px solid #40d134;">
              <p style="font-weight:700;color:#333;margin:0 0 12px;font-size:15px;">YOUR APPLICATION SUMMARY</p>
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr><td style="padding:4px 0;color:#666;width:160px;">Position</td><td style="padding:4px 0;font-weight:600;">${jobTitle} (${jobTypeLabel})</td></tr>
                <tr><td style="padding:4px 0;color:#666;">Name</td><td style="padding:4px 0;">${applicantName}</td></tr>
                <tr><td style="padding:4px 0;color:#666;">Email</td><td style="padding:4px 0;">${applicantEmail}</td></tr>
                <tr><td style="padding:4px 0;color:#666;">Phone</td><td style="padding:4px 0;">${applicantPhone || 'Not provided'}</td></tr>
                <tr><td style="padding:4px 0;color:#666;">Location</td><td style="padding:4px 0;">${applicantLocation || 'Not provided'}</td></tr>
                <tr><td style="padding:4px 0;color:#666;">How you heard about us</td><td style="padding:4px 0;">${referralLabel}</td></tr>
                ${visaInfo}
              </table>
            </div>

            <!-- Company History -->
            <div style="margin-bottom:24px;">
              <p style="font-weight:700;color:#333;font-size:15px;border-bottom:2px solid #40d134;padding-bottom:8px;margin-bottom:12px;">ABOUT REVIVE CAFE</p>
              <p style="color:#555;line-height:1.7;font-size:14px;white-space:pre-line;">${companyHistory || ''}</p>
            </div>

            <!-- Benefits -->
            <div style="background:#f0fdf0;border-radius:6px;padding:20px;margin-bottom:24px;">
              <p style="font-weight:700;color:#333;font-size:15px;margin:0 0 12px;">WHY WORK WITH US</p>
              <ul style="margin:0;padding-left:20px;color:#555;font-size:14px;line-height:1.7;">
                ${benefitsList}
              </ul>
            </div>

            <!-- Note -->
            <div style="background:#fff8e1;border-radius:6px;padding:16px;border-left:4px solid #f7ff19;">
              <p style="color:#555;font-size:14px;line-height:1.6;margin:0;">
                <strong>Please note:</strong> Due to the volume of applications we receive, we are unable to respond to each applicant individually.
                If you have not heard from us within <strong>two weeks</strong> of applying, please consider your application unsuccessful at this time.
              </p>
            </div>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#333;padding:24px;text-align:center;">
            <p style="color:#aaa;font-size:13px;margin:0;">
              Warm regards,<br>
              <strong style="color:#fff;">The Revive Cafe Team</strong><br>
              <a href="mailto:jobs@revivealicious.com" style="color:#40d134;">jobs@revivealicious.com</a>
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return {
    from: FROM_EMAIL,
    to: applicantEmail,
    subject: `Thank you for applying — ${jobTitle} at Revive Cafe`,
    html
  };
}

function buildInterviewInviteEmail(data) {
  const {
    applicantName, applicantEmail, jobTitle, jobType,
    interviewLink, employerName, companyHistory, companyBenefits,
    jobDescription
  } = data;

  const jobTypeLabel = formatJobType(jobType);

  const benefitsList = (companyBenefits || '').split('\n').filter(b => b.trim()).map(b =>
    `<li style="margin-bottom:6px;">${b.trim()}</li>`
  ).join('');

  // Short summary of job description (first 300 chars)
  const descSummary = jobDescription ? jobDescription.substring(0, 300) + (jobDescription.length > 300 ? '...' : '') : '';

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Open Sans',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">

        <!-- Header -->
        <tr>
          <td style="background:#40d134;padding:32px;text-align:center;">
            <img src="https://jobs.revive.co.nz/images/revive-logo-ring.png" alt="Revive Cafe" width="64" height="64" style="width:64px;height:64px;display:block;margin:0 auto 14px;border:0;outline:none;text-decoration:none;">
            <span style="color:#ffffff;font-size:22px;font-weight:700;">🎉 You've been selected for an interview!</span>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:32px;">
            <p style="font-size:16px;color:#333;margin:0 0 16px;">Hi <strong>${applicantName}</strong>,</p>
            <p style="font-size:15px;color:#555;line-height:1.6;margin:0 0 24px;">
              Congratulations! We were impressed with your application for the <strong>${jobTitle}</strong> position
              and would love to invite you for an interview.
            </p>

            <!-- CTA Button -->
            <div style="text-align:center;margin:32px 0;">
              <a href="${interviewLink}" style="display:inline-block;background:#40d134;color:#ffffff;text-decoration:none;padding:16px 40px;border-radius:6px;font-size:16px;font-weight:700;letter-spacing:0.5px;">
                Select Interview Time & Complete Form →
              </a>
              <p style="color:#888;font-size:13px;margin-top:12px;">Please complete this within 48 hours to secure your spot.</p>
            </div>

            <!-- What to expect -->
            <div style="background:#f9f9f9;border-radius:6px;padding:20px;margin-bottom:24px;">
              <p style="font-weight:700;color:#333;font-size:15px;margin:0 0 12px;">WHAT TO EXPECT</p>
              <p style="color:#555;font-size:14px;line-height:1.6;margin:0;">
                Clicking the link above will take you to a page where you can:<br>
                ✓ Choose your preferred interview time from available slots<br>
                ✓ Complete a short additional application form<br>
                ✓ Read and agree to our employment declarations
              </p>
            </div>

            <!-- Job Details -->
            <div style="margin-bottom:24px;">
              <p style="font-weight:700;color:#333;font-size:15px;border-bottom:2px solid #40d134;padding-bottom:8px;margin-bottom:12px;">ABOUT THE ROLE: ${jobTitle} (${jobTypeLabel})</p>
              <p style="color:#555;line-height:1.7;font-size:14px;">${descSummary}</p>
            </div>

            <!-- Company History -->
            <div style="margin-bottom:24px;">
              <p style="font-weight:700;color:#333;font-size:15px;border-bottom:2px solid #40d134;padding-bottom:8px;margin-bottom:12px;">ABOUT REVIVE CAFE</p>
              <p style="color:#555;line-height:1.7;font-size:14px;white-space:pre-line;">${companyHistory || ''}</p>
            </div>

            <!-- Benefits -->
            <div style="background:#f0fdf0;border-radius:6px;padding:20px;">
              <p style="font-weight:700;color:#333;font-size:15px;margin:0 0 12px;">WHY WORK WITH US</p>
              <ul style="margin:0;padding-left:20px;color:#555;font-size:14px;line-height:1.7;">
                ${benefitsList}
              </ul>
            </div>
          </td>
        </tr>

        <!-- Footer -->
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

  return {
    from: FROM_EMAIL,
    to: applicantEmail,
    subject: `Interview Invitation — ${jobTitle} at Revive Cafe`,
    html
  };
}

function buildInterviewConfirmationEmail(data) {
  const { applicantName, applicantEmail, jobTitle, interviewTime, employerName } = data;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Open Sans',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
        <tr>
          <td style="background:#40d134;padding:32px;text-align:center;">
            <img src="https://jobs.revive.co.nz/images/revive-logo-ring.png" alt="Revive Cafe" width="64" height="64" style="width:64px;height:64px;display:block;margin:0 auto 14px;border:0;outline:none;text-decoration:none;">
            <span style="color:#ffffff;font-size:22px;font-weight:700;">Interview Confirmed ✓</span>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;">
            <p style="font-size:16px;color:#333;margin:0 0 16px;">Hi <strong>${applicantName}</strong>,</p>
            <p style="font-size:15px;color:#555;line-height:1.6;margin:0 0 24px;">Your interview has been confirmed. Here are the details:</p>

            <div style="background:#f0fdf0;border-radius:6px;padding:24px;margin-bottom:24px;border:2px solid #40d134;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr><td style="padding:6px 0;color:#666;width:140px;">Interview Time</td><td style="padding:6px 0;font-weight:700;font-size:16px;color:#333;">${interviewTime}</td></tr>
                <tr><td style="padding:6px 0;color:#666;">Position</td><td style="padding:6px 0;">${jobTitle}</td></tr>
                <tr><td style="padding:6px 0;color:#666;">Location</td><td style="padding:6px 0;">Revive Cafe, Auckland CBD</td></tr>
              </table>
            </div>

            <p style="color:#555;font-size:14px;line-height:1.6;">
              Please arrive a few minutes early. If you need to reschedule, please contact us at
              <a href="mailto:jobs@revivealicious.com" style="color:#40d134;">jobs@revivealicious.com</a> as soon as possible.
            </p>
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

  return {
    from: FROM_EMAIL,
    to: applicantEmail,
    subject: `Interview Confirmed — ${jobTitle} at Revive Cafe`,
    html
  };
}

function buildRejectionEmail(data) {
  const { applicantName, applicantEmail, jobTitle } = data;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Open Sans',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
        <tr>
          <td style="background:#40d134;padding:32px;text-align:center;">
            <img src="https://jobs.revive.co.nz/images/revive-logo-ring.png" alt="Revive Cafe" width="64" height="64" style="width:64px;height:64px;display:block;margin:0 auto 14px;border:0;outline:none;text-decoration:none;">
            <span style="color:#ffffff;font-size:20px;font-weight:700;">Revive Cafe — Application Update</span>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;">
            <p style="font-size:16px;color:#333;margin:0 0 16px;">Hi <strong>${applicantName}</strong>,</p>
            <p style="font-size:15px;color:#555;line-height:1.6;margin:0 0 16px;">
              Thank you for taking the time to apply for the <strong>${jobTitle}</strong> position at Revive Cafe.
            </p>
            <p style="font-size:15px;color:#555;line-height:1.6;margin:0 0 24px;">
              After careful consideration, we have decided to progress with other candidates at this time.
              We genuinely appreciate your interest in joining our team and wish you all the best in your job search.
            </p>
            <p style="font-size:14px;color:#888;line-height:1.6;">
              Please feel free to apply for future roles — we regularly post new opportunities at
              <a href="https://revivejobs.netlify.app" style="color:#40d134;">revivejobs.netlify.app</a>
            </p>
          </td>
        </tr>
        <tr>
          <td style="background:#333;padding:24px;text-align:center;">
            <p style="color:#aaa;font-size:13px;margin:0;">
              Warm regards,<br>
              <strong style="color:#fff;">The Revive Cafe Team</strong><br>
              <a href="mailto:jobs@revivealicious.com" style="color:#40d134;">jobs@revivealicious.com</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return {
    from: FROM_EMAIL,
    to: applicantEmail,
    subject: `Your application to Revive Cafe — ${jobTitle}`,
    html
  };
}

async function sendBulkRejections(applicants, jobTitle, replyTo) {
  const tpl = await loadSettings(['email_rejection_subject', 'email_rejection_body']);
  const results = [];
  for (const applicant of applicants) {
    try {
      const data = { applicantName: applicant.full_name, applicantEmail: applicant.email, jobTitle };
      let emailPayload;
      if ((tpl.email_rejection_body || '').trim()) {
        const values = templateValues(data);
        emailPayload = {
          from: FROM_EMAIL,
          to: applicant.email,
          subject: fillTokens(tpl.email_rejection_subject || '', values).trim() ||
                   `Your application to Revive Cafe — ${jobTitle}`,
          html: renderTemplate(tpl.email_rejection_body, values, 'Your Application', replyTo || DEFAULT_REPLY_TO)
        };
      } else {
        emailPayload = buildRejectionEmail(data);
      }
      emailPayload.reply_to = replyTo || DEFAULT_REPLY_TO;
      const result = await sendEmail(emailPayload);
      results.push({ id: applicant.id, success: true, emailId: result.id });
    } catch (err) {
      results.push({ id: applicant.id, success: false, error: err.message });
    }
    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 100));
  }
  return results;
}

// ============================================================
// SEND VIA RESEND API
// ============================================================

async function sendEmail(payload) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.message || `Resend API error: ${response.status}`);
  }

  return result;
}

// ============================================================
// HELPERS
// ============================================================

function formatJobType(type) {
  const map = {
    full_time: 'Full Time',
    part_time: 'Part Time',
    casual: 'Casual',
    fixed_term: 'Fixed Term'
  };
  return map[type] || type;
}

function formatReferral(source) {
  const map = {
    seek: 'Seek',
    facebook: 'Facebook',
    friend: 'Friend / Word of Mouth',
    backpacker_board: 'Backpacker Board',
    sis: 'SIS',
    not_sure: 'Not Sure',
    other: 'Other'
  };
  return map[source] || source || 'Not specified';
}
