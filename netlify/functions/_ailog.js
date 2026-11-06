// Logs every Claude API call this function makes (6 Nov 2026). Copy of the portal's _ailog.js
// (revive-team-portal docs/ai-usage.md); this site's rows are site='jobs', app='jobs'.
// `require('./_ailog');` as the FIRST line of any file that calls api.anthropic.com. It wraps the global
// fetch once per container: a POST to /v1/messages is passed through untouched, then the token counts from
// the answer (`usage`) are written to public.ai_call in Revive Apps. Nothing about the call changes; a
// logging failure is swallowed, and the log write waits at most 1.5 s.
// The portal's weekly cost email (ai-usage-weekly) prices these rows.
'use strict';
const APPS_URL = process.env.SUPABASE_URL || 'https://xcwrawjdfajlmbkdwlbm.supabase.co';
const SITE = 'jobs';
const MARK = Symbol.for('revive.ailog.v1');

function fnName() {
  // esbuild bundles each function into one file named after it, so the stack's file name is the function.
  const lines = String(new Error().stack || '').split('\n').slice(1);
  for (const l of lines) {
    const m = l.match(/((?:file:\/\/)?\/[^\s():]+?\.[cm]?js):\d+:\d+\)?\s*$/);
    if (!m || /node_modules|node:|___netlify/.test(m[1])) continue;
    const b = m[1].split('/').pop().replace(/\.[cm]?js$/, '');
    if (b && b !== '_ailog' && b !== 'index') return b;
  }
  return process.env.AWS_LAMBDA_FUNCTION_NAME || 'unknown';
}
function appOf() { return 'jobs'; }
const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);

function install() {
  if (globalThis[MARK] || typeof globalThis.fetch !== 'function') return;
  const orig = globalThis.fetch;
  globalThis[MARK] = true;

  async function save(row) {
    const key = process.env.SUPABASE_SVC_KEY;
    if (!key) return;
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 1500);
    try {
      await orig(APPS_URL + '/rest/v1/ai_call', { method: 'POST', signal: ctl.signal,
        headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json',
          'Content-Profile': 'public', Prefer: 'return=minimal' },
        body: JSON.stringify(row) });
    } catch (e) { /* never break the caller */ } finally { clearTimeout(t); }
  }

  globalThis.fetch = async function (input, init) {
    let url = '';
    try { url = typeof input === 'string' ? input : String((input && (input.url || input.href)) || input); } catch (e) {}
    if (!/^https:\/\/api\.anthropic\.com\/v1\/messages\/?(\?|$)/.test(url)) return orig(input, init);
    const t0 = Date.now(); const fn = fnName();
    let asked = null; try { asked = JSON.parse(init && init.body).model || null; } catch (e) {}
    const row = { site: SITE, fn, app: appOf(fn), model: asked, status: 0 };
    let res;
    try { res = await orig(input, init); }
    catch (e) { row.ms = Date.now() - t0; await save(row); throw e; }
    row.status = res.status;
    try {
      if (res.ok) {
        const j = await res.clone().json();
        const u = (j && j.usage) || {};
        const cc = u.cache_creation || {};
        const w5 = cc.ephemeral_5m_input_tokens, w1 = cc.ephemeral_1h_input_tokens;
        row.model = (j && j.model) || asked;
        row.input_tokens = int(u.input_tokens);
        row.output_tokens = int(u.output_tokens);
        row.cache_write_5m = (w5 == null && w1 == null) ? int(u.cache_creation_input_tokens) : int(w5);
        row.cache_write_1h = int(w1);
        row.cache_read = int(u.cache_read_input_tokens);
        row.web_searches = int(u.server_tool_use && u.server_tool_use.web_search_requests);
        row.stop_reason = (j && j.stop_reason) || null;
      }
    } catch (e) { /* unreadable answer: log the status only */ }
    row.ms = Date.now() - t0;
    await save(row);
    return res;
  };
}
install();
module.exports = { appOf };
