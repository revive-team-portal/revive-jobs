// ============================================================
// REVIVE CAFE JOBS - Get Interview Data (Secure)
// Netlify Function: /netlify/functions/get-interview-data
//
// Accepts a candidate's interview token and returns their
// application + job data. Uses the SERVICE ROLE KEY server-side
// so application data is never publicly readable via the anon key.
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SVC_KEY;

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

  let token;
  try {
    ({ token } = JSON.parse(event.body));
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if (!token || typeof token !== 'string' || token.length < 30) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid token' }) };
  }

  try {
    // Fetch application by interview token using service role key
    const appRes = await supabaseQuery(
      `${SUPABASE_URL}/rest/v1/applications?interview_token=eq.${encodeURIComponent(token)}&select=id,full_name,email,job_id,status,extended_form_completed,interview_slot_id,interview_invite_sent,applicant_messages`,
      SUPABASE_SERVICE_KEY
    );

    if (!appRes.length) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Invalid or expired link' }) };
    }

    const application = appRes[0];

    // Fetch job details
    const jobRes = await supabaseQuery(
      `${SUPABASE_URL}/rest/v1/jobs?id=eq.${application.job_id}&select=id,title,type,description,employer_name,employer_email,interview_location_type,interview_location_detail,interview_meeting_link`,
      SUPABASE_SERVICE_KEY
    );

    const job = jobRes[0] || null;

    // Only times the applicant can actually choose: future AND not booked.
    // Taken times used to be shown struck through (removed 6 Oct 2026 at Jeremy's request).
    const now = new Date().toISOString();
    const slotsRes = await supabaseQuery(
      `${SUPABASE_URL}/rest/v1/interview_slots?job_id=eq.${application.job_id}&slot_time=gte.${now}&is_booked=eq.false&order=slot_time.asc&select=id,slot_time,is_booked,location_type`,
      SUPABASE_SERVICE_KEY
    );

    // Their current booking (it is booked, so it is not in the open list above).
    let currentSlotTime = null;
    if (application.interview_slot_id) {
      const cur = await supabaseQuery(
        `${SUPABASE_URL}/rest/v1/interview_slots?id=eq.${application.interview_slot_id}&select=slot_time`,
        SUPABASE_SERVICE_KEY
      );
      currentSlotTime = (cur[0] && cur[0].slot_time) || null;
    }

    // Fetch settings needed for the interview page
    const settingsRes = await supabaseQuery(
      `${SUPABASE_URL}/rest/v1/settings?key=in.(company_history,company_benefits,interview_form_questions,declarations_text)&select=key,value`,
      SUPABASE_SERVICE_KEY
    );

    const settings = {};
    settingsRes.forEach(s => { settings[s.key] = s.value; });

    // Return only what the interview page needs — no sensitive fields
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        application: {
          id: application.id,
          full_name: application.full_name,
          email: application.email,
          status: application.status,
          extended_form_completed: application.extended_form_completed,
          interview_slot_id: application.interview_slot_id,
          interview_invite_sent: application.interview_invite_sent,
          // Their own messages, so the page can show what they've already sent.
          applicant_messages: Array.isArray(application.applicant_messages) ? application.applicant_messages : []
        },
        job,
        current_slot_time: currentSlotTime,
        slots: slotsRes,
        settings
      })
    };

  } catch (err) {
    console.error('get-interview-data error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  }
};

// Simple Supabase REST helper using service role key
async function supabaseQuery(url, serviceKey) {
  const res = await fetch(url, {
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      'Accept-Profile': 'jobs'
    }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase error ${res.status}: ${text}`);
  }
  return res.json();
}
