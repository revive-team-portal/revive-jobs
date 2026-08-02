// ============================================================
// REVIVE CAFE JOBS - Email Sending Function
// Netlify Function: /netlify/functions/send-email
// Uses Resend API for all transactional emails
// ============================================================

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = 'Revive Cafe Jobs <jobs@revivealicious.com>';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  let data;
  try {
    data = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { type } = data;

  try {
    let emailPayload;

    switch (type) {
      case 'application_confirmation':
        emailPayload = buildConfirmationEmail(data);
        break;
      case 'interview_invite':
        emailPayload = buildInterviewInviteEmail(data);
        break;
      case 'interview_confirmation':
        emailPayload = buildInterviewConfirmationEmail(data);
        break;
      case 'rejection':
        emailPayload = buildRejectionEmail(data);
        break;
      case 'bulk_rejection':
        // Send multiple rejection emails
        const results = await sendBulkRejections(data.applicants, data.jobTitle);
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, results }) };
      default:
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown email type' }) };
    }

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
            <img src="https://www.revive.co.nz/cdn/shop/files/01-060_Revive_Cafe_Logo_40x.png" alt="Revive Cafe" style="height:50px;margin-bottom:12px;"><br>
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
    reply_to: employerEmail || 'jobs@revivealicious.com',
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
            <img src="https://www.revive.co.nz/cdn/shop/files/01-060_Revive_Cafe_Logo_40x.png" alt="Revive Cafe" style="height:50px;margin-bottom:12px;"><br>
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
            <img src="https://www.revive.co.nz/cdn/shop/files/01-060_Revive_Cafe_Logo_40x.png" alt="Revive Cafe" style="height:50px;margin-bottom:12px;"><br>
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
            <img src="https://www.revive.co.nz/cdn/shop/files/01-060_Revive_Cafe_Logo_40x.png" alt="Revive Cafe" style="height:50px;margin-bottom:12px;"><br>
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

async function sendBulkRejections(applicants, jobTitle) {
  const results = [];
  for (const applicant of applicants) {
    try {
      const emailPayload = buildRejectionEmail({
        applicantName: applicant.full_name,
        applicantEmail: applicant.email,
        jobTitle
      });
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
