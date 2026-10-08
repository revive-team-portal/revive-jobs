// TEMPORARY end-to-end test of send-email type 'custom' — delete after use
const crypto = require('crypto');
const H = '32cd1de1a10398bd614c87ba236e2ab3bb2165cfb6661f3ac60f69955116ae6d';
const APP_ID = 'd6a7f3eb-b708-4cea-857d-5d6ed462821a';
exports.handler = async (event) => {
  const k = String((event.queryStringParameters || {}).k || '');
  const got = crypto.createHash('sha256').update(k).digest();
  if (!crypto.timingSafeEqual(got, Buffer.from(H, 'hex'))) return { statusCode: 403, body: 'nope' };
  const URL_ = process.env.SUPABASE_URL, SVC = process.env.SUPABASE_SVC_KEY;
  const out = {};
  const gl = await fetch(URL_ + '/auth/v1/admin/generate_link', { method: 'POST',
    headers: { apikey: SVC, Authorization: 'Bearer ' + SVC, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', email: 'jobs@revivealicious.com' }) });
  const gj = await gl.json();
  const hashed = gj.hashed_token || (gj.properties && gj.properties.hashed_token);
  const vr = await fetch(URL_ + '/auth/v1/verify', { method: 'POST',
    headers: { apikey: SVC, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: hashed }) });
  const vj = await vr.json();
  out.gotSession = !!vj.access_token;
  const call = async (auth, body) => {
    const r = await fetch('https://jobs.revive.co.nz/.netlify/functions/send-email', { method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, auth ? { Authorization: 'Bearer ' + auth } : {}),
      body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  out.badToken = await call('not-a-token', { type: 'custom', applicationId: APP_ID, subject: 's', body: 'b' });
  out.custom = await call(vj.access_token, { type: 'custom', applicationId: APP_ID, bulk: true,
    subject: 'Test — {{job_title}}', body: 'Hi {{first_name}},\n\nThis is a test of the custom email.\n\nKind regards,\n{{employer_name}}' });
  out.rejection = await call(null, { type: 'rejection', bulk: true, applicationId: APP_ID, jobId: '42d08988-9abc-4f85-bfb9-07d4b8f3a917',
    applicantName: 'Zz Test Custom Email', applicantEmail: 'delivered@resend.dev', jobTitle: 'Waffle Maker' });
  // Leftover from the 7 Oct status test (docs/jobs.md Open items)
  const del = await fetch(URL_ + '/storage/v1/object/jobs-resumes/42d08988-9abc-4f85-bfb9-07d4b8f3a917/eae7c9b1-0b1a-4e7d-9084-df01dfa0a92e_application-form.pdf',
    { method: 'DELETE', headers: { apikey: SVC, Authorization: 'Bearer ' + SVC } });
  out.leftoverDelete = del.status;
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out) };
};
