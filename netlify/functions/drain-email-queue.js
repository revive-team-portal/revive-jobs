// ============================================================
// REVIVE CAFE JOBS - Drain the email queue
// Netlify Scheduled Function: runs hourly (see netlify.toml)
//
// Sends anything held back when the Resend daily cap was reached,
// staying inside the cap so it never re-triggers the limit.
// ============================================================

const RESEND_API_KEY = process.env.RESEND_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SVC_KEY;

const DAILY_CAP = 100;
const SAFETY_MARGIN = 5;   // leave room for live sends during the day

function svc(extra) {
  return Object.assign({
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    'Accept-Profile': 'jobs'
  }, extra || {});
}

exports.handler = async () => {
  if (!RESEND_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, body: 'Not configured' };
  }

  // How many sends are left today
  const since = new Date(); since.setUTCHours(0, 0, 0, 0);
  let used = 0;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/email_sent_log?sent_at=gte.${since.toISOString()}&select=id`,
      { headers: svc({ Prefer: 'count=exact', Range: '0-0' }) }
    );
    const total = parseInt((r.headers.get('content-range') || '').split('/')[1], 10);
    used = Number.isFinite(total) ? total : 0;
  } catch (err) {
    console.error('Could not count sends', err);
  }

  const room = DAILY_CAP - SAFETY_MARGIN - used;
  if (room <= 0) {
    return { statusCode: 200, body: JSON.stringify({ sent: 0, reason: 'no room today', used }) };
  }

  const now = new Date().toISOString();
  const queued = await (await fetch(
    `${SUPABASE_URL}/rest/v1/email_queue?status=eq.queued&send_after=lte.${now}` +
    `&order=queued_at.asc&limit=${room}&select=*`,
    { headers: svc() }
  )).json().catch(() => []);

  if (!Array.isArray(queued) || !queued.length) {
    return { statusCode: 200, body: JSON.stringify({ sent: 0, reason: 'queue empty' }) };
  }

  let sent = 0, failed = 0, stopped = false;
  for (const item of queued) {
    const body = { ...(item.payload || {}) };
    delete body.__type;
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const result = await res.json().catch(() => ({}));

      if (!res.ok) {
        const msg = String(result.message || res.status);
        // Hit the cap again — leave the rest queued for the next run.
        if (res.status === 429 || /daily|quota|rate limit|limit exceeded/i.test(msg)) {
          await patch(item.id, { attempts: item.attempts + 1, last_error: msg });
          stopped = true;
          break;
        }
        // A real failure (bad address etc). Give up after 3 tries.
        const attempts = item.attempts + 1;
        await patch(item.id, attempts >= 3
          ? { status: 'failed', attempts, last_error: msg }
          : { attempts, last_error: msg });
        failed++;
        continue;
      }

      await patch(item.id, { status: 'sent', sent_at: new Date().toISOString(), attempts: item.attempts + 1 });
      await fetch(`${SUPABASE_URL}/rest/v1/email_sent_log`, {
        method: 'POST',
        headers: svc({ 'Content-Profile': 'jobs' }),
        body: JSON.stringify({ to_email: item.to_email, email_type: item.email_type })
      }).catch(() => {});
      sent++;
    } catch (err) {
      console.error('Queue send threw', err);
      await patch(item.id, { attempts: item.attempts + 1, last_error: String(err.message || err) });
      failed++;
    }
  }

  console.log(`Email queue: sent ${sent}, failed ${failed}${stopped ? ', stopped at the cap' : ''}`);
  return { statusCode: 200, body: JSON.stringify({ sent, failed, stopped }) };
};

async function patch(id, fields) {
  await fetch(`${SUPABASE_URL}/rest/v1/email_queue?id=eq.${id}`, {
    method: 'PATCH',
    headers: svc({ 'Content-Profile': 'jobs' }),
    body: JSON.stringify(fields)
  }).catch(err => console.error('Could not update queue row', err));
}
