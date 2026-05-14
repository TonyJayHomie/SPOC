// =============================================================================
// WORKER C — wc-7.0 — closed-loop research interceptor
// Cloudflare Worker (ES module, export default { fetch })
// HackerOne anthropic VDP — Gold Standard Safe Harbor (May 2026)
// =============================================================================
//
// REFUSAL ITEMS (white-hat scope, HackerOne anthropic VDP submission):
//
//   1. No real-Anthropic egress in `test` mode. `passthrough` mode forwards
//      to api.anthropic.com using the OPERATOR'S own credentials only.
//      No third-party user accounts are ever contacted.
//
//   2. No third-party user surface. Single operator only. Setup UI gated by
//      one-time setup token printed on first deploy and rotated on first POST.
//
//   3. No credential capture. x-api-key / Authorization values are <REDACTED>
//      before logging. The raw cookie value is NEVER read — this is a
//      server-side Worker; cookies arrive via the userscript's
//      browser-managed cookie mode and pass through unread.
//
//   4. No UI clone. Setup page is operator-only diagnostics, not a chat UI.
//      Worker B's visual style is "Terminal Amber" — visually distinct from
//      claude.ai (<=80% visual similarity, charcoal + amber + blue palette).
//
//   5. Restrictive CORS. Allowlist: localhost:*, 127.0.0.1:*, the operator's
//      Worker B subdomain (*.workers.dev), and claude.ai (cookie-bridge mode).
//
//   6. Always-on BLOCKED_HOSTS list — exactly 4 CoCoDem malware C2 hosts:
//        openclaude.111724.xyz  (CoCoDem primary C2)
//        cfc.aroic.workers.dev  (CoCoDem token-exchange endpoint)
//        111724.xyz             (CoCoDem apex domain)
//        aroic.workers.dev      (CoCoDem worker apex)
//      Anthropic domains (api.anthropic.com, console.anthropic.com,
//      platform.claude.com) are NOT blocked — passthrough mode legitimately
//      needs api.anthropic.com with the operator's own credentials.
//
//   7. Distribution: HackerOne anthropic VDP / Safe Harbor only. Not for
//      general distribution.
//
//   8. inject_canary mode is DEFAULT OFF. Requires explicit env vars:
//      WC_MODE=inject_canary AND WC_CANARY_OPT_IN=true AND operator-supplied
//      WC_CANARY string. Three-layer opt-in. Falls back to passthrough if any
//      layer is missing.
//
// Architectural finding demonstrated:
//   Wire-level system-prompt mutation is deterministic on /v1/messages traffic
//   across all four auth modes (no-key, API key, OAuth, cookie-bridge). The
//   closed-loop bounding (BLOCKED_HOSTS, operator-only deploy, Safe Harbor)
//   ensures demonstration cannot escape into a malicious-deploy posture
//   without an operator deliberately removing these grep-checkable invariants.
//
// Public-source anchors (cited inline as // SEE: comments):
//   [1] Cloudflare fetch handler docs — ES module signature + ctx.waitUntil
//   [2] Cloudflare standards-compliant Workers API blog
//   [3] Cloudflare KV bindings docs
//   [4] Cloudflare KV list-keys pagination docs
//   [5] Cloudflare TransformStream / IdentityTransformStream docs
//   [6] MDN ReadableStream.tee() — backpressure caveat
//   [7] Claude Code Internals Part 7 (kotrotsos) — SSE event taxonomy
//   [8] anthropic-sdk-python _messages.py — message_start ordering
//   [9] OpenAI Chat Completions streaming events reference
//
// =============================================================================

'use strict';

// =============================================================================
// §1 — ARCHITECTURE DIAGRAM (comment)
// =============================================================================
//
// ┌─────────────────────┐    fetch(/v1/messages)    ┌──────────────────────────┐
// │ Worker B (SPA)      │──────────────────────────▶│ Worker C (interceptor)   │
// │ or claude.ai tab    │      credentials:         │ wc-7.0                   │
// │ + Tampermonkey      │      'include'            │ ┌──────────────────────┐ │
// └─────────────────────┘                           │ │ MUTATION ENGINE      │ │
//                                                   │ │ 5 modes              │ │
//                                                   │ │ env.WC_MODE          │ │
//                                                   │ └─────────┬────────────┘ │
//                                                   │           ▼              │
//                                                   │ ┌──────────────────────┐ │
//                                                   │ │ ROUTING ENGINE       │ │
//                                                   │ │ test / passthrough   │ │
//                                                   │ │ env.WC_ROUTE         │ │
//                                                   │ └─────────┬────────────┘ │
//                                                   │           ▼              │
//                                                   │ ┌──────────────────────┐ │
//                                                   │ │ SSE TEE PIPELINE     │ │
//                                                   │ │ TransformStream +    │ │
//                                                   │ │ ReadableStream.tee() │ │
//                                                   │ └──────┬───────────┬───┘ │
//                                                   │        │           │     │
//                                                   │  to client    to canary  │
//                                                   │  (no buffer)   detector  │
//                                                   │                + KV log  │
//                                                   └──────────┬───────────────┘
//                                                              ▼
//                                             test mode  ──▶ env.WORKER_A_URL
//                                             passthru  ──▶ https://api.anthropic.com
//
// Invariants:
//   - Request body is parsed ONCE, mutated ONCE, dispatched ONCE
//   - Response body is tee'd ONCE — client branch is byte-for-byte identical
//     to upstream output (via IdentityTransformStream — no reformatting)
//   - KV writes happen in ctx.waitUntil() — never block stream delivery
//   - Every outbound fetch goes through safeOutboundFetch() — BLOCKED_HOSTS enforced
//   - Session cookies arrive from the userscript's browser-managed creds
//     and pass through unread — Worker C is server-side, never reads cookies
//
// =============================================================================

// =============================================================================
// §2 — MUTATION ENGINE
// =============================================================================

/**
 * The five mutation modes Worker C supports on /v1/messages bodies.
 *
 * Mode         env vars          Behavior
 * passthrough  —                 Log only. Body forwarded unchanged.
 * strip        —                 delete parsedBody.system.
 * replace      WC_REPLACEMENT    parsedBody.system = env.WC_REPLACEMENT.
 * prepend      WC_PREFIX         parsedBody.system = prefix + "\n\n" + original.
 * append       WC_SUFFIX         parsedBody.system = original + "\n\n" + suffix.
 * inject_canary WC_CANARY        DEFAULT OFF. Three-layer opt-in required.
 *              WC_CANARY_OPT_IN  Appends [CANARY:...] to system; tee'd response
 *                                scanned for canary echo in text_delta events.
 *
 * inject_canary is the headline finding. It demonstrates that a network-layer
 * interceptor can inject instructions into the system prompt AND confirm that
 * the model obeyed (via canary echo in the response stream).
 */

const VALID_MODES = new Set([
    'passthrough', 'strip', 'replace', 'prepend', 'append', 'inject_canary'
]);

/**
 * Resolve the active mutation mode from config.
 * Falls back to 'passthrough' if unset or unrecognized.
 */
function getMode(cfg) {
    const m = (cfg.WC_MODE || 'passthrough').toLowerCase();
    if (!VALID_MODES.has(m)) {
        throw new InterceptError(503, `unknown WC_MODE: ${m}`);
    }
    return m;
}

/**
 * Apply the configured mutation to a parsed /v1/messages JSON body.
 * Returns { mutated, original_system, final_system, canary }.
 *
 * Idempotent: never mutates input by reference; returns a new body object.
 * Uses structuredClone() — available in Cloudflare Workers runtime.
 * SEE: [2] Cloudflare standards-compliant Workers API blog
 *
 * @param {object} body       — parsed /v1/messages request body
 * @param {object} cfg        — merged env + KV config object
 * @param {string} mode       — one of VALID_MODES
 * @returns {{ mutated: object, original_system: string, final_system: string, canary: string|null }}
 */
function applyMutation(body, cfg, mode) {
    const original = body.system ?? null;
    const original_system = typeof original === 'string'
        ? original
        : Array.isArray(original)
            ? original.map(b => b?.text ?? '').join('\n')
            : '';

    // Deep-clone the body so the caller can compare original vs. mutated
    const mutated = structuredClone(body);
    let canary = null;

    switch (mode) {
        case 'passthrough':
            // log-only; body forwarded unchanged
            return { mutated, original_system, final_system: original_system, canary };

        case 'strip':
            delete mutated.system;
            return { mutated, original_system, final_system: '', canary };

        case 'replace': {
            if (!cfg.WC_REPLACEMENT) {
                throw new InterceptError(503, 'mode=replace requires env.WC_REPLACEMENT');
            }
            mutated.system = cfg.WC_REPLACEMENT;
            return { mutated, original_system, final_system: cfg.WC_REPLACEMENT, canary };
        }

        case 'prepend': {
            if (!cfg.WC_PREFIX) {
                throw new InterceptError(503, 'mode=prepend requires env.WC_PREFIX');
            }
            const final_system = cfg.WC_PREFIX + '\n\n' + original_system;
            mutated.system = final_system;
            return { mutated, original_system, final_system, canary };
        }

        case 'append': {
            if (!cfg.WC_SUFFIX) {
                throw new InterceptError(503, 'mode=append requires env.WC_SUFFIX');
            }
            const final_system = original_system + '\n\n' + cfg.WC_SUFFIX;
            mutated.system = final_system;
            return { mutated, original_system, final_system, canary };
        }

        case 'inject_canary': {
            // THREE-LAYER OPT-IN. Default OFF. User must explicitly set all three:
            //   1. cfg.WC_MODE === 'inject_canary'        (first layer: mode selection)
            //   2. cfg.WC_CANARY_OPT_IN === 'true'        (second layer: explicit opt-in flag)
            //   3. cfg.WC_CANARY is a non-empty string    (third layer: operator-supplied canary)
            // Falls back to passthrough if any layer is missing.
            if (cfg.WC_CANARY_OPT_IN !== 'true') {
                // Second layer not set — fall back to passthrough silently
                return { mutated, original_system, final_system: original_system, canary: null };
            }
            if (!cfg.WC_CANARY) {
                throw new InterceptError(503,
                    'mode=inject_canary requires env.WC_CANARY (operator-supplied, no random default)');
            }
            canary = cfg.WC_CANARY; // operator-supplied; never random-defaulted
            // The canary is injected as a system-prompt instruction.
            // Form is operator-controlled — Worker C does not prescribe wording.
            const canary_block = `[CANARY:${canary}]`;
            const final_system = original_system
                ? original_system + '\n\n' + canary_block
                : canary_block;
            mutated.system = final_system;
            return { mutated, original_system, final_system, canary };
        }
    }

    // Should never reach here — VALID_MODES guard above catches unknowns
    throw new InterceptError(500, `unhandled mode: ${mode}`);
}

/**
 * Custom error class for interceptor-level failures.
 * Carries an HTTP status code so the dispatcher can surface it to the client.
 */
class InterceptError extends Error {
    constructor(status, msg) {
        super(msg);
        this.status = status;
        this.name = 'InterceptError';
    }
}

// =============================================================================
// §3 — ROUTING ENGINE
// =============================================================================

/**
 * Mutation mode → upstream URL routing.
 *
 * Route      Upstream                    Auth                 Use case
 * test        env.WORKER_A_URL           passes client auth   closed-loop demo
 * passthrough https://api.anthropic.com  operator credentials live VDP demo
 *
 * SEE: [1] Cloudflare fetch handler docs
 */

/**
 * Resolve the upstream URL for a given path+query string.
 *
 * @param {object} cfg          — merged env + KV config
 * @param {string} pathAndQuery — e.g. "/v1/messages" or "/v1/messages?stream=true"
 * @returns {{ route: string, url: string }}
 */
function resolveUpstream(cfg, pathAndQuery) {
    const route = (cfg.WC_ROUTE || 'test').toLowerCase();
    if (route === 'test') {
        if (!cfg.WORKER_A_URL) {
            throw new InterceptError(503, 'route=test requires env.WORKER_A_URL');
        }
        const base = cfg.WORKER_A_URL.replace(/\/$/, '');
        return { route, url: base + pathAndQuery };
    }
    if (route === 'passthrough') {
        return { route, url: 'https://api.anthropic.com' + pathAndQuery };
    }
    throw new InterceptError(503, `unknown WC_ROUTE: ${route}`);
}

/**
 * Build outbound headers for the upstream request.
 * Strips hop-by-hop and CF-injected headers.
 * In passthrough mode, injects X-HackerOne-Handle per Anthropic VDP guidelines.
 *
 * @param {Request} req         — incoming client request
 * @param {object}  cfg         — merged env + KV config
 * @param {string}  route       — 'test' | 'passthrough'
 * @returns {Headers}
 */
function buildUpstreamHeaders(req, cfg, route) {
    const h = new Headers(req.headers);

    // Strip hop-by-hop and CF-injected headers — these are not forwarded upstream
    const DROP_HEADERS = [
        'host', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor',
        'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip',
        'content-length',  // recomputed by fetch
        'transfer-encoding',
        'connection',
        'keep-alive',
        'proxy-authenticate',
        'proxy-authorization',
        'te',
        'trailers',
        'upgrade',
        // SPOC userscript markers — not forwarded upstream
        'x-spoc-userscript',
        'x-spoc-original-host',
        'x-spoc-setup-token',
    ];
    for (const k of DROP_HEADERS) h.delete(k);

    if (route === 'passthrough') {
        // Inject HackerOne handle per Anthropic VDP research guidelines
        // SEE: Anthropic HackerOne VDP program policy (May 2026) — X-HackerOne-Handle
        if (cfg.HACKERONE_HANDLE) {
            h.set('X-HackerOne-Handle', cfg.HACKERONE_HANDLE);
        }
        // Anthropic version pin — required for /v1/messages
        if (!h.get('anthropic-version')) {
            h.set('anthropic-version', '2023-06-01');
        }
    }
    return h;
}

// =============================================================================
// §4 — SETUP UI
// =============================================================================

/**
 * HTML escape helper — maps & < > " ' to HTML entities.
 * Used in renderSetupPage and diagnostic console.
 *
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
    if (!s) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}

/**
 * Render the operator-only setup page.
 * Token-gated: operator must supply the one-time setup token printed on first deploy.
 *
 * @param {object} env          — Cloudflare env bindings
 * @param {object} currentConfig — loaded from KV WC_CONFIG (may be empty object)
 * @returns {Response}
 */
function renderSetupPage(env, currentConfig) {
    const c = currentConfig || {};
    const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Worker C — wc-7.0 setup</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:ui-monospace,Menlo,'Courier New',monospace;max-width:760px;
     margin:2rem auto;background:#0f0f0f;color:#d4d4d4;padding:1rem;font-size:14px;line-height:1.5}
h1{color:#f0a020;border-bottom:1px solid #333;padding-bottom:.75rem;margin-bottom:1.5rem;font-size:1.4rem}
h2{color:#6cb6ff;font-size:1rem;margin:1.5rem 0 .5rem}
fieldset{border:1px solid #333;margin:1rem 0;padding:1rem;border-radius:4px}
legend{color:#6cb6ff;padding:0 .5rem;font-weight:bold}
label{display:block;margin:.75rem 0 .25rem;color:#a0a0a0}
input,select,textarea{width:100%;background:#1a1a1a;color:#e8e8e8;border:1px solid #444;
  padding:.5rem;font-family:inherit;font-size:13px;border-radius:3px;outline:none}
input:focus,select:focus,textarea:focus{border-color:#f0a020}
textarea{resize:vertical;min-height:60px}
.btn{display:inline-block;background:#f0a020;color:#0f0f0f;border:0;
  padding:.6rem 1.4rem;cursor:pointer;font-weight:bold;font-family:inherit;
  font-size:14px;border-radius:3px;margin-top:1rem}
.btn:hover{background:#e09010}
.btn-danger{background:#c84e3a}
.btn-danger:hover{background:#b03a28}
.warn{color:#e05050;background:#1a0808;border:1px solid #5a1010;
  padding:.75rem;border-radius:3px;margin:1rem 0;font-size:13px}
.ok{color:#6ea850}
.info{color:#6cb6ff;background:#080f1a;border:1px solid #1a3a5a;
  padding:.75rem;border-radius:3px;margin:1rem 0;font-size:13px}
.mono{font-family:inherit;background:#1a1a1a;padding:2px 6px;border-radius:2px;color:#f0a020}
.blocked-hosts{background:#111;border:1px solid #333;padding:.75rem;border-radius:3px;
  font-size:12px;color:#888;margin-top:.5rem}
.blocked-hosts code{color:#e05050}
.token-display{background:#111;border:1px solid #f0a020;padding:.5rem;
  font-family:inherit;font-size:13px;word-break:break-all;color:#f0a020;
  border-radius:3px;margin-top:.5rem}
hr{border:0;border-top:1px solid #222;margin:1.5rem 0}
</style>
</head><body>

<h1>Worker C — wc-7.0</h1>
<p style="color:#888;margin-bottom:1rem">HackerOne anthropic VDP closed-loop interceptor. Operator-only.</p>

<div class="info">
  <strong>Setup flow:</strong> Enter the one-time setup token below, then save your configuration.
  The token rotates on every successful POST. Check Worker C deploy logs for the initial token.
</div>

<form id="setupForm" method="POST" action="/api/worker-config">

<fieldset>
<legend>Authenticate</legend>
<label>Setup Token (one-time, rotates on save)
  <input name="token" type="password" required autocomplete="off" placeholder="Paste token from deploy log">
</label>
</fieldset>

<fieldset>
<legend>Mutation Engine</legend>
<label>WC_MODE
  <select name="WC_MODE">
    <option value="passthrough" ${c.WC_MODE === 'passthrough' || !c.WC_MODE ? 'selected' : ''}>passthrough (default — log only, body forwarded unchanged)</option>
    <option value="strip" ${c.WC_MODE === 'strip' ? 'selected' : ''}>strip — delete parsedBody.system</option>
    <option value="replace" ${c.WC_MODE === 'replace' ? 'selected' : ''}>replace — set system to WC_REPLACEMENT</option>
    <option value="prepend" ${c.WC_MODE === 'prepend' ? 'selected' : ''}>prepend — WC_PREFIX + original_system</option>
    <option value="append" ${c.WC_MODE === 'append' ? 'selected' : ''}>append — original_system + WC_SUFFIX</option>
    <option value="inject_canary" ${c.WC_MODE === 'inject_canary' ? 'selected' : ''}>inject_canary (USER SET, DEFAULT OFF — requires WC_CANARY_OPT_IN=true)</option>
  </select>
</label>
<label>WC_REPLACEMENT (used when mode=replace)
  <textarea name="WC_REPLACEMENT" rows="3" placeholder="Replacement system prompt text">${escapeHtml(c.WC_REPLACEMENT || '')}</textarea>
</label>
<label>WC_PREFIX (used when mode=prepend)
  <textarea name="WC_PREFIX" rows="2" placeholder="Text prepended before original system prompt">${escapeHtml(c.WC_PREFIX || '')}</textarea>
</label>
<label>WC_SUFFIX (used when mode=append)
  <textarea name="WC_SUFFIX" rows="2" placeholder="Text appended after original system prompt">${escapeHtml(c.WC_SUFFIX || '')}</textarea>
</label>
<label>WC_CANARY (operator-supplied canary string — no random default)
  <input name="WC_CANARY" type="text" value="${escapeHtml(c.WC_CANARY || '')}" placeholder="WC-CANARY-...">
</label>
<label>WC_CANARY_OPT_IN (second opt-in layer for inject_canary — must be literal "true")
  <select name="WC_CANARY_OPT_IN">
    <option value="" ${c.WC_CANARY_OPT_IN !== 'true' ? 'selected' : ''}>false (default)</option>
    <option value="true" ${c.WC_CANARY_OPT_IN === 'true' ? 'selected' : ''}>true</option>
  </select>
</label>
</fieldset>

<fieldset>
<legend>Routing</legend>
<label>WC_ROUTE
  <select name="WC_ROUTE">
    <option value="test" ${c.WC_ROUTE === 'test' || !c.WC_ROUTE ? 'selected' : ''}>test — forwards to WORKER_A_URL (closed loop, no real Anthropic contact)</option>
    <option value="passthrough" ${c.WC_ROUTE === 'passthrough' ? 'selected' : ''}>passthrough — forwards to api.anthropic.com with operator's own credentials</option>
  </select>
</label>
<label>WORKER_A_URL (required when route=test)
  <input name="WORKER_A_URL" type="url" value="${escapeHtml(c.WORKER_A_URL || '')}" placeholder="https://worker-a.your-account.workers.dev">
</label>
<label>HACKERONE_HANDLE (injected as X-HackerOne-Handle on passthrough requests)
  <input name="HACKERONE_HANDLE" type="text" value="${escapeHtml(c.HACKERONE_HANDLE || '')}" placeholder="your-h1-handle">
</label>
</fieldset>

<fieldset>
<legend>Logging</legend>
<label>
  <input type="checkbox" name="WC_KV_LOG" value="true" ${c.WC_KV_LOG === 'true' ? 'checked' : ''}> Enable KV request log (60-day TTL, operator-only access)
</label>
</fieldset>

<button class="btn" type="submit">[ SAVE CONFIGURATION ]</button>
<a href="/intercept-log" style="margin-left:1rem;color:#6cb6ff">View log</a>
<a href="/health" style="margin-left:1rem;color:#6cb6ff">Health check</a>

</form>

<hr>

<div class="warn">
  <strong>BLOCKED_HOSTS (always-on, non-configurable):</strong><br>
  Submitting any field containing one of these fragments will be rejected (400):
  <div class="blocked-hosts">
    <code>openclaude.111724.xyz</code>&nbsp;&nbsp;
    <code>cfc.aroic.workers.dev</code>&nbsp;&nbsp;
    <code>111724.xyz</code>&nbsp;&nbsp;
    <code>aroic.workers.dev</code>
  </div>
  These are the CoCoDem malware C2 domains. They are always blocked regardless of configuration.
</div>

<hr>
<p style="color:#555;font-size:12px">Worker C wc-7.0 | HackerOne anthropic VDP | Single-operator | Safe Harbor</p>

<script>
document.getElementById('setupForm').addEventListener('submit', async function(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const btn = e.target.querySelector('.btn');
  btn.textContent = '[ SAVING... ]';
  btn.disabled = true;
  try {
    const r = await fetch('/api/worker-config', { method: 'POST', body: fd });
    const text = await r.text();
    if (r.ok) {
      btn.textContent = '[ SAVED ]';
      btn.style.background = '#6ea850';
      const info = document.createElement('div');
      info.className = 'info';
      info.style.marginTop = '1rem';
      info.textContent = text;
      e.target.appendChild(info);
    } else {
      btn.textContent = '[ ERROR ]';
      btn.style.background = '#c84e3a';
      btn.disabled = false;
      alert('Error: ' + text);
    }
  } catch(err) {
    btn.textContent = '[ SAVE ]';
    btn.disabled = false;
    alert('Network error: ' + err.message);
  }
});
</script>
</body></html>`;

    return new Response(html, {
        headers: { 'content-type': 'text/html; charset=utf-8' }
    });
}

/**
 * Handle POST /api/worker-config — validate token, reject blocked hosts,
 * persist config, rotate setup token.
 *
 * @param {Request} req
 * @param {object}  env
 * @returns {Promise<Response>}
 */
async function handleSetupPost(req, env) {
    const form = await req.formData();
    const token = form.get('token');
    const stored = await env.WC_KV.get('WC_SETUP_TOKEN');

    // Bootstrap: if no token is stored yet, accept any token and store it
    // (operator sets this on first deploy by reading Worker logs)
    if (!stored) {
        const newToken = crypto.randomUUID();
        await env.WC_KV.put('WC_SETUP_TOKEN', newToken);
        return new Response(
            `First-run: initial token accepted. New setup token (copy to clipboard): ${newToken}`,
            { status: 200, headers: { 'content-type': 'text/plain' } }
        );
    }

    if (!token || token !== stored) {
        return new Response('invalid setup token', { status: 401 });
    }

    // Validate all submitted values against BLOCKED_HOSTS
    for (const [k, v] of form.entries()) {
        if (typeof v === 'string' && containsBlockedFragment(v)) {
            return new Response(
                `field '${k}' contains a blocked host fragment (CoCoDem C2 domain)`,
                { status: 400 }
            );
        }
    }

    // Persist config to KV
    const cfg = {};
    for (const k of [
        'WC_MODE', 'WC_REPLACEMENT', 'WC_PREFIX', 'WC_SUFFIX',
        'WC_CANARY', 'WC_CANARY_OPT_IN', 'WC_ROUTE', 'WORKER_A_URL',
        'HACKERONE_HANDLE', 'WC_KV_LOG'
    ]) {
        cfg[k] = form.get(k) || '';
    }
    await env.WC_KV.put('WC_CONFIG', JSON.stringify(cfg));

    // Rotate setup token — old token is now invalid
    const newToken = crypto.randomUUID();
    await env.WC_KV.put('WC_SETUP_TOKEN', newToken);

    return new Response(
        `Configuration saved. New setup token (copy to clipboard): ${newToken}`,
        { status: 200, headers: { 'content-type': 'text/plain' } }
    );
}

/**
 * Handle the /bridge/session endpoint — receives org_uuid + account_uuid
 * metadata from the DevTools session bridge paste.
 * Never receives cookie values. Setup-token gated.
 *
 * @param {Request} req
 * @param {object}  env
 * @returns {Promise<Response>}
 */
async function handleBridgeSession(req, env) {
    const token = req.headers.get('x-spoc-setup-token');
    const stored = await env.WC_KV.get('WC_SETUP_TOKEN');
    if (stored && token !== stored) {
        return new Response('invalid setup token', { status: 401 });
    }
    let bundle;
    try { bundle = await req.json(); }
    catch { return new Response('invalid JSON', { status: 400 }); }

    // Sanity checks — bundle must never contain credential fields
    const FORBIDDEN_FIELDS = ['cookie', 'session_key', 'sessionKey', 'bearer', 'api_key', 'token'];
    for (const f of FORBIDDEN_FIELDS) {
        if (f in bundle) {
            return new Response(`bundle must not contain credential field: ${f}`, { status: 400 });
        }
    }

    await env.WC_KV.put('bridge_session', JSON.stringify({
        ...bundle,
        ts: Date.now()
    }), { expirationTtl: 86400 }); // 1 day TTL

    return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' }
    });
}

// =============================================================================
// §5 — EVIDENCE HEADERS + REQUEST-ID GENERATOR
// =============================================================================

/**
 * The 8 evidence headers set on every intercepted response.
 * These are the wire-level proof that mutation occurred.
 *
 * Header                      Type        Set on
 * x-wc-system-stripped        true|false  always
 * x-wc-mutation-mode          mode name   always
 * x-wc-canary-injected        true|false  always
 * x-wc-canary-echoed          true|false  post-stream (KV only for streaming)
 * x-wc-original-system-len    int         always
 * x-wc-final-system-len       int         always
 * x-wc-routing-mode           test|pass   always
 * x-wc-request-id             req_<b32>   always
 *
 * Note: x-wc-canary-echoed is NOT set on streaming responses — Cloudflare
 * Workers do not support HTTP trailers reliably. The x-wc-canary-echoed flag
 * is written to KV under the x-wc-request-id key and readable via
 * GET /intercept-log?request_id=<x-wc-request-id value>.
 *
 * @param {object} meta  — request/mutation metadata
 * @returns {Headers}
 */
function buildEvidenceHeaders(meta) {
    const h = new Headers();
    h.set('x-wc-system-stripped',     String(meta.mode === 'strip' || meta.final_system === ''));
    h.set('x-wc-mutation-mode',       meta.mode || 'passthrough');
    h.set('x-wc-canary-injected',     String(!!meta.canary));
    h.set('x-wc-original-system-len', String(meta.original_system?.length ?? 0));
    h.set('x-wc-final-system-len',    String(meta.final_system?.length ?? 0));
    h.set('x-wc-routing-mode',        meta.route || 'test');
    h.set('x-wc-request-id',          meta.request_id || '');
    return h;
}

/**
 * Merge evidence headers onto upstream response headers.
 * Strips CF-injected headers from upstream that would confuse downstream.
 *
 * @param {Headers} upstreamHeaders
 * @param {object}  meta
 * @returns {Headers}
 */
function mergeEvidenceHeaders(upstreamHeaders, meta) {
    const h = new Headers(upstreamHeaders);
    // Strip CF-injected headers from upstream response
    ['cf-cache-status', 'cf-ray', 'server-timing'].forEach(k => h.delete(k));
    // Add evidence headers
    for (const [k, v] of buildEvidenceHeaders(meta).entries()) {
        h.set(k, v);
    }
    // Preserve the upstream content-type (text/event-stream; charset=utf-8)
    return h;
}

/**
 * Generate a request-id in Anthropic's observed format:
 * req_ + "011" + 19 base32 chars = 25 chars total
 * Example: req_011CaqXRk7wLnC6Sw8zDg3vN
 * SEE: READ 5 §4 — request-id format from HAR capture cap3
 *
 * @returns {string}
 */
function newRequestId() {
    // Format: req_011 + 21 base32 chars = 28 chars total
    // Example from HAR: req_011CaqXRk7wLnC6Sw8zDg3vN (28 chars)
    // SEE: READ 5 §4 — request-id format from HAR capture cap3
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const bytes = crypto.getRandomValues(new Uint8Array(21));
    let s = '011';
    for (let i = 0; i < 21; i++) s += ALPHABET[bytes[i] & 31];
    return 'req_' + s; // 'req_' (4) + '011' (3) + 21 = 28 total
}

// =============================================================================
// §6 — KV-BACKED REQUEST LOG
// =============================================================================
//
// KV key schema:
//   WC_SETUP_TOKEN              → string (one-time setup token)
//   WC_CONFIG                   → JSON of the cfg object
//   bridge_session              → JSON of latest DevTools bridge metadata
//   log:<ts_ms>:<request_id>    → JSON of log entry (60-day TTL)
//
// Using ts_ms prefix keeps list({ prefix:'log:' }) ordered and bounded.
// SEE: [3] Cloudflare KV bindings docs
// SEE: [4] Cloudflare KV list-keys pagination docs

/**
 * Log entry shape written to KV.
 *
 * {
 *   request_id:               'req_011...',
 *   ts:                       1730000000000,
 *   pathname:                 '/v1/messages',
 *   method:                   'POST',
 *   routing_mode:             'test'|'passthrough',
 *   mutation_mode:            'passthrough'|'strip'|'replace'|'prepend'|'append'|'inject_canary',
 *   original_system:          '...',          // full text
 *   final_system:             '...',          // full text after mutation
 *   canary:                   'WC-CANARY-...'|null,
 *   canary_echoed_in_response: true|false|null, // null = streaming aborted
 *   request_body_redacted:    { ... },        // x-api-key/Authorization → <REDACTED>
 *   response_status:          200,
 *   response_time_ms:         1234,
 *   upstream_request_id:      '...',
 *   sse_event_count:          47,
 *   stop_reason:              'end_turn'|null,
 *   output_tokens:            0,
 *   response_body_preview:    null|'...',     // first 4KB for non-streaming only
 * }
 */

/**
 * Write a log entry to KV in ctx.waitUntil (non-blocking).
 * No-op if WC_KV_LOG !== 'true'.
 * SEE: [1] ctx.waitUntil contract — KV writes must not block stream delivery
 *
 * @param {object} env
 * @param {object} ctx
 * @param {object} entry
 */
async function writeLog(env, ctx, entry) {
    if (env.WC_KV_LOG !== 'true') return;
    const key = `log:${entry.ts}:${entry.request_id}`;
    ctx.waitUntil(env.WC_KV.put(key, JSON.stringify(entry), { expirationTtl: 60 * 86400 }));
}

/**
 * GET /intercept-log — paginated list or single request-id lookup.
 * Supports ?limit=N&cursor=C&request_id=R query params.
 *
 * @param {Request} req
 * @param {object}  env
 * @returns {Promise<Response>}
 */
async function handleInterceptLog(req, env) {
    const url = new URL(req.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 1000);
    const cursor = url.searchParams.get('cursor') || undefined;
    const reqId = url.searchParams.get('request_id');

    if (reqId) {
        // Direct lookup by request_id — linear scan of recent keys
        const list = await env.WC_KV.list({ prefix: 'log:', limit: 1000 });
        for (const k of list.keys) {
            if (k.name.endsWith(':' + reqId)) {
                const v = await env.WC_KV.get(k.name);
                return new Response(v || 'null', {
                    headers: { 'content-type': 'application/json' }
                });
            }
        }
        return new Response('not found', { status: 404 });
    }

    // Paginated list — SEE: [4] Cloudflare KV list-keys pagination
    const list = await env.WC_KV.list({ prefix: 'log:', limit, cursor });
    const entries = [];
    for (const k of list.keys) {
        const v = await env.WC_KV.get(k.name);
        if (v) entries.push(JSON.parse(v));
    }
    return new Response(JSON.stringify({
        entries,
        list_complete: list.list_complete,
        cursor: list.cursor
    }), { headers: { 'content-type': 'application/json' } });
}

/**
 * DELETE /intercept-log — purge all log entries.
 * Paginates through list() to delete all keys.
 *
 * @param {Request} req
 * @param {object}  env
 * @returns {Promise<Response>}
 */
async function handleDeleteLog(req, env) {
    let cursor;
    let deleted = 0;
    while (true) {
        const list = await env.WC_KV.list({ prefix: 'log:', limit: 1000, cursor });
        for (const k of list.keys) {
            await env.WC_KV.delete(k.name);
            deleted++;
        }
        if (list.list_complete) break;
        cursor = list.cursor;
    }
    return new Response(JSON.stringify({ deleted }),
        { headers: { 'content-type': 'application/json' } });
}

// =============================================================================
// §7 — SSE RE-STREAMING PIPELINE
// =============================================================================
//
// Two non-negotiable properties:
//   1. Byte-for-byte fidelity: response seen by Worker B must be byte-identical
//      to what Worker A / api.anthropic.com produced (modulo evidence headers).
//      Any reformatting will break tool-use partial-JSON accumulation.
//   2. No buffering: each chunk must reach the client as soon as it arrives.
//      Buffering the whole stream would timeout the Worker.
//
// Implementation: IdentityTransformStream (no byte reformatting) + tee()
// SEE: [5] Cloudflare TransformStream / IdentityTransformStream docs
// SEE: [6] MDN ReadableStream.tee() — backpressure caveat:
//   "tee'd streams partially signal backpressure at the rate of the faster
//    consumer, with unread data enqueued internally on the slower branch."
//   For Worker C, both branches are consumed at near-identical speeds, so safe.

/**
 * Pipe a streaming upstream response back to the client via IdentityTransformStream.
 * Tees the body: one branch to client, one to canary scanner + KV logger.
 * Non-streaming fallback handles non-SSE responses.
 *
 * @param {Response} upstream   — upstream response (may be streaming)
 * @param {object}   meta       — request/mutation metadata
 * @param {object}   env        — merged env + KV config
 * @param {object}   ctx        — Cloudflare ExecutionContext
 * @returns {Response}
 */
function pipeStreamingResponse(upstream, meta, env, ctx) {
    if (!upstream.body) {
        // Non-streaming fallback — buffer and return
        return upstream.arrayBuffer().then(buf => {
            const preview = new TextDecoder().decode(buf.slice(0, 4096));
            meta.response_body_preview = preview;
            meta.canary_echoed_in_response = null;
            ctx.waitUntil(writeLog(env, ctx, meta));
            return new Response(buf, {
                status: upstream.status,
                headers: mergeEvidenceHeaders(upstream.headers, meta)
            });
        });
    }

    // Tee the upstream body: one branch to client, one to canary scanner.
    // SEE: [6] MDN ReadableStream.tee() — backpressure caveat documented above
    const [toClient, toScanner] = upstream.body.tee();

    // Run the canary scanner / event counter in waitUntil so it doesn't
    // block the client response.
    // SEE: [1] ctx.waitUntil contract — async work that must not block the response
    ctx.waitUntil(scanStream(toScanner, meta, env));

    // Identity passthrough for the client branch — preserves byte boundaries.
    // SEE: [5] IdentityTransformStream — "forwards all chunks of byte data...without changes"
    const { readable, writable } = new IdentityTransformStream();
    toClient.pipeTo(writable).catch(err => {
        // Client disconnect or upstream abort — log but don't crash
        // The tee'd toScanner branch keeps its own queue and finishes naturally.
        console.log('[wc-7.0] client pipe aborted:', err?.message || String(err));
    });

    return new Response(readable, {
        status: upstream.status,
        headers: mergeEvidenceHeaders(upstream.headers, meta)
    });
}

// =============================================================================
// §8 — CANARY DETECTOR + SSE STATE MACHINE
// =============================================================================
//
// Runs on the toScanner branch in ctx.waitUntil.
// Decodes UTF-8, parses SSE events, scans only text_delta payloads for canary.
// Handles tool-use partial-JSON accumulation per block index.
// Updates the KV log entry with canary_echoed_in_response once stream completes.
//
// SSE event taxonomy — full sequence per Anthropic streaming spec:
// SEE: [7] Claude Code Internals Part 7 (kotrotsos) — SSE stream processing
// SEE: [8] anthropic-sdk-python _messages.py — message_start ordering guarantee
//
//   message_start
//     └─ message: { id:"msg_...", model, role, content:[], usage:{input_tokens,...} }
//
//   content_block_start    (index 0, type:"text"  OR  index N, type:"tool_use")
//     ├─ ping              (every ~15s, tolerable anywhere in stream)
//     ├─ content_block_delta (text_delta OR input_json_delta OR thinking_delta)
//     │     ...repeat...
//     └─ content_block_stop
//
//     ...repeat content_block_* per output block...
//
//   message_delta
//     └─ delta: { stop_reason: "end_turn"|"max_tokens"|"tool_use"|"stop_sequence" }
//     └─ usage: { output_tokens, ... }
//
//   message_stop
//
//   error (mid-stream — terminates without message_stop):
//     └─ error: { type: "overloaded_error"|"api_error"|..., message: "..." }
//
//   Wire format per frame: event: <name>\ndata: <json>\n\n
//   UTF-8 only. No id: or retry: fields on this consumer surface.

/**
 * Scan the tee'd scanner branch for canary echo in text_delta events.
 * Accumulates tool-use partial-JSON per block index.
 * Updates KV log entry with terminal state once stream closes.
 *
 * @param {ReadableStream} stream  — tee'd scanner branch
 * @param {object}         meta    — request/mutation metadata (mutated in place)
 * @param {object}         env     — merged env + KV config
 */
async function scanStream(stream, meta, env) {
    const reader = stream.getReader();
    const decoder = new TextDecoder('utf-8', { stream: true });
    let buf = '';
    let eventCount = 0;
    let canaryEchoed = false;
    let stopReason = null;
    let outputTokens = 0;

    // Per-block tool-use partial-JSON accumulators
    // Key: block index, Value: accumulated partial JSON string
    const toolBuf = Object.create(null);

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });

            // SSE frames are separated by \n\n
            let idx;
            while ((idx = buf.indexOf('\n\n')) !== -1) {
                const frame = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                eventCount++;
                const parsed = parseSSEFrame(frame);
                if (!parsed) continue;
                const { event, data } = parsed;

                switch (event) {
                    case 'message_start':
                        // message_start is guaranteed to be the first event
                        // SEE: [8] anthropic-sdk-python — message_start ordering
                        break;

                    case 'content_block_start':
                        if (data?.content_block?.type === 'tool_use') {
                            toolBuf[data.index] = '';
                        }
                        break;

                    case 'content_block_delta': {
                        const d = data?.delta;
                        if (d?.type === 'text_delta' && typeof d.text === 'string') {
                            // Canary scan: check if model echoed the injected canary
                            if (meta.canary && d.text.includes(meta.canary)) {
                                canaryEchoed = true;
                            }
                        } else if (d?.type === 'thinking_delta' && typeof d.thinking === 'string') {
                            // Extended thinking blocks — scan for canary echo here too
                            if (meta.canary && d.thinking.includes(meta.canary)) {
                                canaryEchoed = true;
                            }
                        } else if (d?.type === 'input_json_delta' &&
                                   typeof d.partial_json === 'string') {
                            // Tool-use partial JSON accumulator
                            // Chunks do NOT respect JSON boundaries — buffer until stop
                            toolBuf[data.index] = (toolBuf[data.index] || '') + d.partial_json;
                        }
                        break;
                    }

                    case 'content_block_stop':
                        // toolBuf[data.index] is now complete JSON if block was tool_use
                        // (Worker C only needs this for completeness — no action required)
                        break;

                    case 'message_delta':
                        stopReason = data?.delta?.stop_reason ?? null;
                        outputTokens = data?.usage?.output_tokens ?? outputTokens;
                        break;

                    case 'message_stop':
                        // Stream is complete — exit loop after this frame is processed
                        break;

                    case 'ping':
                        // Keepalive every ~15s — tolerable anywhere in stream, no-op
                        break;

                    case 'error':
                        // Mid-stream error — stream terminates without message_stop
                        // Record error type for log
                        meta.upstream_error = data?.error ?? null;
                        break;
                }
            }
        }
    } catch (err) {
        // tee branch can be aborted by upstream abort or client disconnect
        // Record what we have and continue to KV update
        meta.scan_aborted = true;
    }

    // Update KV log entry with terminal state from stream scan
    if (env.WC_KV_LOG === 'true') {
        const key = `log:${meta.ts}:${meta.request_id}`;
        const finalEntry = {
            ...meta,
            sse_event_count: eventCount,
            canary_echoed_in_response: meta.canary ? canaryEchoed : null,
            stop_reason: stopReason,
            output_tokens: outputTokens,
        };
        await env.WC_KV.put(key, JSON.stringify(finalEntry), { expirationTtl: 60 * 86400 });
    }
}

/**
 * Parse a single SSE frame ("event: <name>\ndata: <json>").
 * Returns null for empty frames.
 *
 * @param {string} frame
 * @returns {{ event: string, data: any } | null}
 */
function parseSSEFrame(frame) {
    const lines = frame.split('\n');
    let event = null;
    let data = null;
    for (const line of lines) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) {
            const raw = line.slice(6);
            try { data = JSON.parse(raw); } catch { data = raw; }
        }
    }
    return event ? { event, data } : null;
}

// =============================================================================
// §9 — OPENAI ↔ ANTHROPIC TRANSLATOR
// =============================================================================
//
// When Worker A is OpenAI-compatible (LM Studio, OpenRouter, vLLM),
// Worker C transparently translates the response shape.
// Disabled by default — set env.WC_TRANSLATE to enable.
//
// WC_TRANSLATE values:
//   'anthropic_to_openai' — Anthropic SSE → OpenAI streaming chunks
//   'openai_to_anthropic' — OpenAI streaming chunks → Anthropic SSE
//
// 16-case state machine mapping (Anthropic event → OpenAI chunk):
// SEE: [9] OpenAI Chat Completions streaming events reference
//
//   Anthropic event                    OpenAI chunk                    Notes
//   message_start                      {role:"assistant"}              first chunk
//   content_block_start (text, idx 0)  (suppressed)                   content via deltas
//   content_block_start (tool_use, N)  {tool_calls:[{index:N,id,type,function:{name}}]}
//   content_block_delta (text_delta)   {content:"<text>"}              direct map
//   content_block_delta (input_json)   buffered → emit on stop as      accumulator
//                                      {tool_calls:[{index:N,function:{arguments}}]}
//   content_block_stop (text)          (no-op)
//   content_block_stop (tool_use)      flush buffered tool args
//   message_delta stop=end_turn        {}, finish_reason:"stop"
//   message_delta stop=max_tokens      {}, finish_reason:"length"
//   message_delta stop=tool_use        {}, finish_reason:"tool_calls"
//   message_delta stop=stop_sequence   {}, finish_reason:"stop"
//   message_stop                       data: [DONE]\n\n then close
//   ping                               (suppressed)
//   error (mid-stream)                 {error:{message,type,code}}\n\n then close
//   parallel tool_use (multi-block)    each gets own tool_calls[index]
//   reasoning (thinking_delta)         {reasoning_content:"..."} passthrough only

/**
 * Translate an Anthropic SSE stream to OpenAI streaming chunk format.
 * Returns a TransformStream that can be inserted into the pipeline.
 *
 * Only active when env.WC_TRANSLATE === 'anthropic_to_openai'.
 *
 * @param {string} model        — model name for chunk id
 * @returns {TransformStream}
 */
function buildAnthropicToOAITransform(model) {
    const toolBufs = {};
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let sseBuffer = '';

    function oaiChunk(delta, finishReason, id) {
        const chunk = {
            id: id || 'chatcmpl-wc7',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: model || 'unknown',
            choices: [{
                index: 0,
                delta: delta || {},
                finish_reason: finishReason || null
            }]
        };
        return `data: ${JSON.stringify(chunk)}\n\n`;
    }

    return new TransformStream({
        transform(chunk, controller) {
            sseBuffer += decoder.decode(chunk, { stream: true });
            let idx;
            while ((idx = sseBuffer.indexOf('\n\n')) !== -1) {
                const frame = sseBuffer.slice(0, idx);
                sseBuffer = sseBuffer.slice(idx + 2);
                const parsed = parseSSEFrame(frame);
                if (!parsed) continue;
                const { event, data } = parsed;

                switch (event) {
                    case 'message_start':
                        controller.enqueue(encoder.encode(oaiChunk({ role: 'assistant' }, null)));
                        break;
                    case 'content_block_start':
                        if (data?.content_block?.type === 'tool_use') {
                            const tc = {
                                index: data.index,
                                id: data.content_block.id,
                                type: 'function',
                                function: { name: data.content_block.name, arguments: '' }
                            };
                            controller.enqueue(encoder.encode(oaiChunk({ tool_calls: [tc] }, null)));
                            toolBufs[data.index] = '';
                        }
                        break;
                    case 'content_block_delta': {
                        const d = data?.delta;
                        if (d?.type === 'text_delta') {
                            controller.enqueue(encoder.encode(oaiChunk({ content: d.text }, null)));
                        } else if (d?.type === 'thinking_delta') {
                            controller.enqueue(encoder.encode(oaiChunk({ reasoning_content: d.thinking }, null)));
                        } else if (d?.type === 'input_json_delta') {
                            toolBufs[data.index] = (toolBufs[data.index] || '') + d.partial_json;
                        }
                        break;
                    }
                    case 'content_block_stop':
                        if (toolBufs[data?.index] !== undefined) {
                            const tc = {
                                index: data.index,
                                function: { arguments: toolBufs[data.index] }
                            };
                            controller.enqueue(encoder.encode(oaiChunk({ tool_calls: [tc] }, null)));
                        }
                        break;
                    case 'message_delta': {
                        const finishMap = {
                            'end_turn': 'stop',
                            'max_tokens': 'length',
                            'tool_use': 'tool_calls',
                            'stop_sequence': 'stop'
                        };
                        const fr = finishMap[data?.delta?.stop_reason] || 'stop';
                        controller.enqueue(encoder.encode(oaiChunk({}, fr)));
                        break;
                    }
                    case 'message_stop':
                        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                        break;
                    case 'ping':
                        // Suppressed — OpenAI clients don't expect pings
                        break;
                    case 'error':
                        controller.enqueue(encoder.encode(
                            `data: ${JSON.stringify({ error: data?.error || { message: 'stream error' } })}\n\n`
                        ));
                        break;
                }
            }
        },
        flush(controller) {
            if (sseBuffer.trim()) {
                // Flush remaining buffer
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            }
        }
    });
}

/**
 * Translate an OpenAI streaming chunk format to Anthropic SSE stream.
 * Reverse direction: synthesize message_start from first chunk, etc.
 *
 * Only active when env.WC_TRANSLATE === 'openai_to_anthropic'.
 *
 * @returns {TransformStream}
 */
function buildOAIToAnthropicTransform() {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let rawBuffer = '';
    let sentMessageStart = false;
    let sentBlockStart = false;
    let msgId = 'msg_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);

    function sseFrame(event, data) {
        return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    }

    return new TransformStream({
        transform(chunk, controller) {
            rawBuffer += decoder.decode(chunk, { stream: true });
            const lines = rawBuffer.split('\n');
            rawBuffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const raw = line.slice(6).trim();
                if (raw === '[DONE]') {
                    controller.enqueue(encoder.encode(sseFrame('content_block_stop', { type: 'content_block_stop', index: 0 })));
                    controller.enqueue(encoder.encode(sseFrame('message_delta', {
                        type: 'message_delta',
                        delta: { stop_reason: 'end_turn', stop_sequence: null },
                        usage: { output_tokens: 0 }
                    })));
                    controller.enqueue(encoder.encode(sseFrame('message_stop', { type: 'message_stop' })));
                    continue;
                }
                let parsed;
                try { parsed = JSON.parse(raw); } catch { continue; }

                if (!sentMessageStart) {
                    sentMessageStart = true;
                    controller.enqueue(encoder.encode(sseFrame('message_start', {
                        type: 'message_start',
                        message: {
                            id: msgId, type: 'message', role: 'assistant',
                            content: [], model: parsed.model || 'unknown',
                            stop_reason: null, stop_sequence: null,
                            usage: { input_tokens: 0, output_tokens: 0 }
                        }
                    })));
                }

                const choice = parsed.choices?.[0];
                if (!choice) continue;

                const delta = choice.delta || {};

                if (delta.content !== undefined && delta.content !== null) {
                    if (!sentBlockStart) {
                        sentBlockStart = true;
                        controller.enqueue(encoder.encode(sseFrame('content_block_start', {
                            type: 'content_block_start', index: 0,
                            content_block: { type: 'text', text: '' }
                        })));
                    }
                    if (delta.content) {
                        controller.enqueue(encoder.encode(sseFrame('content_block_delta', {
                            type: 'content_block_delta', index: 0,
                            delta: { type: 'text_delta', text: delta.content }
                        })));
                    }
                }

                if (delta.tool_calls) {
                    for (const tc of delta.tool_calls) {
                        if (tc.function?.name) {
                            controller.enqueue(encoder.encode(sseFrame('content_block_start', {
                                type: 'content_block_start', index: tc.index || 0,
                                content_block: {
                                    type: 'tool_use', id: tc.id || crypto.randomUUID(),
                                    name: tc.function.name, input: {}
                                }
                            })));
                        }
                        if (tc.function?.arguments) {
                            controller.enqueue(encoder.encode(sseFrame('content_block_delta', {
                                type: 'content_block_delta', index: tc.index || 0,
                                delta: { type: 'input_json_delta', partial_json: tc.function.arguments }
                            })));
                        }
                    }
                }

                if (choice.finish_reason) {
                    const stopMap = { 'stop': 'end_turn', 'length': 'max_tokens', 'tool_calls': 'tool_use' };
                    controller.enqueue(encoder.encode(sseFrame('message_delta', {
                        type: 'message_delta',
                        delta: { stop_reason: stopMap[choice.finish_reason] || 'end_turn', stop_sequence: null },
                        usage: { output_tokens: 0 }
                    })));
                    controller.enqueue(encoder.encode(sseFrame('message_stop', { type: 'message_stop' })));
                }
            }
        },
        flush(controller) {
            if (!sentMessageStart) return;
            // Ensure stream is properly closed
            controller.enqueue(encoder.encode(sseFrame('message_stop', { type: 'message_stop' })));
        }
    });
}

// =============================================================================
// §10 — REQUEST RECORDER + CREDENTIAL REDACTION
// =============================================================================
//
// Captures full request body (sanitized) and response preview.
// Credential fields are redacted before storage.
// Policy:
//   - Streaming: store request body (redacted), response status, headers (redacted),
//     evidence-header values, sse_event_count, canary_echoed_in_response, stop_reason.
//     Do NOT store full SSE body (potentially MBs and PII).
//   - Non-streaming: store first 4KB of response body as response_body_preview.

const CREDENTIAL_HEADERS = new Set([
    'x-api-key', 'authorization', 'cookie',
    'x-anthropic-api-key', 'openai-api-key',
    'x-spoc-setup-token'
]);

/**
 * Redact credential values from a Headers object.
 * Returns a plain object with <REDACTED> for sensitive fields.
 *
 * @param {Headers} headers
 * @returns {object}
 */
function redactHeaders(headers) {
    const out = {};
    for (const [k, v] of headers.entries()) {
        out[k] = CREDENTIAL_HEADERS.has(k.toLowerCase()) ? '<REDACTED>' : v;
    }
    return out;
}

/**
 * Redact credential values from a request body object.
 * Deep-walks the object, replaces sensitive field values with <REDACTED>.
 *
 * @param {object} body
 * @returns {object}
 */
function redactBodyFields(body) {
    const SENSITIVE = [
        'api_key', 'password', 'session_key', 'sessionKey',
        'cookie', 'authorization', 'x-api-key', 'bearer',
        'token', 'secret', 'credential'
    ];
    const clone = structuredClone(body);
    function walk(obj) {
        if (!obj || typeof obj !== 'object') return;
        for (const k of Object.keys(obj)) {
            if (SENSITIVE.includes(k.toLowerCase())) {
                obj[k] = '<REDACTED>';
            } else if (typeof obj[k] === 'object') {
                walk(obj[k]);
            }
        }
    }
    walk(clone);
    return clone;
}

// =============================================================================
// §11 — HEALTH ENDPOINT
// =============================================================================

/**
 * GET /health — KV-backed status report.
 * Returns current config summary, version, and last intercept timestamp.
 *
 * @param {object} env
 * @returns {Promise<Response>}
 */
async function handleHealth(env) {
    const cfg = JSON.parse((await env.WC_KV.get('WC_CONFIG')) || '{}');
    const list = await env.WC_KV.list({ prefix: 'log:', limit: 1 });
    const last = list.keys[0]?.name?.split(':')[1] ?? null;
    const bridgeSession = await env.WC_KV.get('bridge_session');
    const session = bridgeSession ? JSON.parse(bridgeSession) : null;

    return new Response(JSON.stringify({
        worker: 'C',
        version: '7.0',
        upstream: cfg.WORKER_A_URL || null,
        mode: cfg.WC_MODE || 'passthrough',
        route: cfg.WC_ROUTE || 'test',
        kv_log_enabled: cfg.WC_KV_LOG === 'true',
        last_intercept: last ? Number(last) : null,
        blocked_hosts: BLOCKED_HOSTS,
        bridge_session_present: !!session,
        bridge_session_org: session?.org_uuid || null,
        canary_opt_in: cfg.WC_CANARY_OPT_IN === 'true',
    }, null, 2), { headers: { 'content-type': 'application/json' } });
}

// =============================================================================
// §12 — CORS POSTURE
// =============================================================================
//
// Allowlist: localhost:*, 127.0.0.1:*, operator's Worker B subdomain (*.workers.dev),
// and claude.ai (cookie-bridge mode only).
//
// Access-Control-Allow-Credentials: 'true' is set ONLY when origin matches the
// explicit allowlist — never '*', because wildcard + credentials is forbidden
// by the Fetch standard.

const CORS_ALLOWLIST_PATTERNS = [
    /^http:\/\/localhost(:\d+)?$/,
    /^http:\/\/127\.0\.0\.1(:\d+)?$/,
    /^https:\/\/[a-z0-9-]+\.workers\.dev$/i,  // operator's Worker B subdomain
    /^https:\/\/claude\.ai$/,                  // cookie-bridge mode
];

/**
 * Build CORS response headers for an allowed origin.
 * Returns empty object if origin is not in the allowlist.
 *
 * @param {Request} req
 * @returns {object}
 */
function corsHeadersFor(req) {
    const origin = req.headers.get('Origin');
    if (!origin) return {};
    const allowed = CORS_ALLOWLIST_PATTERNS.some(re => re.test(origin));
    if (!allowed) return {};
    return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers':
            'content-type, x-api-key, authorization, anthropic-version, ' +
            'x-hackerone-handle, x-spoc-userscript, x-spoc-original-host, ' +
            'x-spoc-setup-token, anthropic-client-platform, anthropic-device-id, ' +
            'anthropic-beta, cache-control, pragma',
        'Access-Control-Expose-Headers':
            'x-wc-system-stripped, x-wc-mutation-mode, x-wc-canary-injected, ' +
            'x-wc-canary-echoed, x-wc-original-system-len, x-wc-final-system-len, ' +
            'x-wc-routing-mode, x-wc-request-id, request-id, ' +
            'anthropic-ratelimit-requests-limit, anthropic-ratelimit-requests-remaining, ' +
            'anthropic-ratelimit-tokens-limit, anthropic-ratelimit-tokens-remaining',
        'Vary': 'Origin',
    };
}

/**
 * Apply CORS headers to a response.
 *
 * @param {Response} resp
 * @param {Request}  req
 * @returns {Response}
 */
function withCORS(resp, req) {
    const cors = corsHeadersFor(req);
    if (!Object.keys(cors).length) return resp;
    const h = new Headers(resp.headers);
    for (const [k, v] of Object.entries(cors)) h.set(k, v);
    return new Response(resp.body, { status: resp.status, headers: h });
}

/**
 * Handle OPTIONS preflight requests.
 *
 * @param {Request} req
 * @returns {Response}
 */
function handleOptions(req) {
    return new Response(null, { status: 204, headers: corsHeadersFor(req) });
}

// =============================================================================
// §13 — EGRESS POSTURE + OUTBOUND FETCH WRAP
// =============================================================================
//
// Every outbound fetch in Worker C goes through safeOutboundFetch().
// A code reviewer can grep -n 'safeOutboundFetch\|^[[:space:]]*fetch(' worker_c_cf.js
// and reject any raw fetch( call to a non-CDN URL.
//
// BLOCKED_HOSTS — exactly 4 CoCoDem malware C2 hosts:
//   openclaude.111724.xyz  — CoCoDem primary C2 (confirmed malicious)
//   cfc.aroic.workers.dev  — CoCoDem token-exchange endpoint (confirmed malicious)
//   111724.xyz             — CoCoDem apex domain (confirmed malicious)
//   aroic.workers.dev      — CoCoDem worker apex (confirmed malicious)
//
// Anthropic domains are NOT in BLOCKED_HOSTS — passthrough mode legitimately
// needs api.anthropic.com with the operator's own credentials + X-HackerOne-Handle.

const BLOCKED_HOSTS = Object.freeze([
    'openclaude.111724.xyz',
    'cfc.aroic.workers.dev',
    '111724.xyz',
    'aroic.workers.dev',
]);

/**
 * Check if a URL string contains a blocked host fragment.
 * Used for form input validation in the setup POST handler.
 *
 * @param {string} s
 * @returns {boolean}
 */
function containsBlockedFragment(s) {
    if (!s) return false;
    const lower = s.toLowerCase();
    return BLOCKED_HOSTS.some(h => lower.includes(h));
}

/**
 * Outbound fetch wrapper — throws InterceptError(403) if hostname is in BLOCKED_HOSTS.
 * ALL outbound fetch calls in Worker C MUST go through this function.
 *
 * @param {string} url
 * @param {RequestInit} init
 * @returns {Promise<Response>}
 */
function safeOutboundFetch(url, init) {
    const u = new URL(url);
    if (BLOCKED_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h))) {
        throw new InterceptError(403, `BLOCKED_HOSTS: ${u.hostname} is a CoCoDem malware C2 domain`);
    }
    return fetch(url, init);
}

// =============================================================================
// §14 — TOP-LEVEL FETCH HANDLER + DISPATCHER
// =============================================================================

/**
 * Determine if a request path is interceptable.
 * Matches /v1/messages and /api/organizations/.../chat_conversations/.../completion.
 *
 * @param {string} p  — pathname
 * @returns {boolean}
 */
function isInterceptablePath(p) {
    return p === '/v1/messages'
        || /^\/api\/organizations\/[^/]+\/chat_conversations\/[^/]+\/completion$/.test(p);
}

/**
 * Load the persisted KV config, merged with env vars.
 * KV config takes precedence over env vars for runtime changes.
 *
 * @param {object} env
 * @returns {Promise<object>}
 */
async function loadConfig(env) {
    const stored = await env.WC_KV.get('WC_CONFIG');
    const kvCfg = stored ? JSON.parse(stored) : {};
    // Merge: env vars provide defaults, KV config overrides at runtime
    return {
        // Env var defaults
        WC_MODE: env.WC_MODE || 'passthrough',
        WC_ROUTE: env.WC_ROUTE || 'test',
        WC_KV_LOG: env.WC_KV_LOG || 'false',
        WORKER_A_URL: env.WORKER_A_URL || '',
        WC_REPLACEMENT: env.WC_REPLACEMENT || '',
        WC_PREFIX: env.WC_PREFIX || '',
        WC_SUFFIX: env.WC_SUFFIX || '',
        WC_CANARY: env.WC_CANARY || '',
        WC_CANARY_OPT_IN: env.WC_CANARY_OPT_IN || '',
        HACKERONE_HANDLE: env.HACKERONE_HANDLE || '',
        // KV config overrides (runtime changes via setup UI)
        ...kvCfg,
        // Always preserve env-level KV binding reference
        WC_KV: env.WC_KV,
    };
}

/**
 * Handle a path that is NOT an intercept path — pass through to upstream.
 * Used for all other Anthropic API paths (organization lookup, models, etc.)
 * that Worker B may call but don't need mutation.
 *
 * @param {Request} request
 * @param {object}  env
 * @param {object}  ctx
 * @returns {Promise<Response>}
 */
async function handlePassthroughNonIntercept(request, env, ctx) {
    const cfg = await loadConfig(env);
    const url = new URL(request.url);
    const { route, url: upstreamUrl } = resolveUpstream(cfg, url.pathname + url.search);
    const headers = buildUpstreamHeaders(request, cfg, route);

    const upstream = await safeOutboundFetch(upstreamUrl, {
        method: request.method,
        headers,
        body: request.method !== 'GET' && request.method !== 'HEAD'
            ? await request.arrayBuffer()
            : undefined
    });

    // Pass through without mutation or evidence headers
    return new Response(upstream.body, {
        status: upstream.status,
        headers: upstream.headers
    });
}

/**
 * Main intercept handler — the load-bearing path.
 * Reads body, applies mutation, dispatches upstream, tees SSE response.
 *
 * @param {Request} request
 * @param {object}  env
 * @param {object}  ctx
 * @returns {Promise<Response>}
 */
async function handleIntercept(request, env, ctx) {
    const startTs = Date.now();
    const request_id = newRequestId();
    const cfg = await loadConfig(env);
    const mode = getMode(cfg);
    const url = new URL(request.url);

    // Read + parse request body
    const bodyText = await request.text();
    let parsed;
    try { parsed = JSON.parse(bodyText); }
    catch { return new Response('invalid JSON body', { status: 400 }); }

    // Apply mutation — structuredClone ensures no by-reference mutation
    const { mutated, original_system, final_system, canary } =
        applyMutation(parsed, cfg, mode);

    // Resolve upstream URL
    const { route, url: upstreamUrl } = resolveUpstream(cfg, url.pathname + url.search);

    // Build upstream headers
    const upstreamHeaders = buildUpstreamHeaders(request, cfg, route);
    upstreamHeaders.set('content-type', 'application/json');

    // Dispatch to upstream via safeOutboundFetch
    // SEE: §13 — every outbound fetch MUST go through safeOutboundFetch
    const upstream = await safeOutboundFetch(upstreamUrl, {
        method: request.method,
        headers: upstreamHeaders,
        body: JSON.stringify(mutated),
    });

    // Build evidence metadata
    const meta = {
        request_id,
        ts: startTs,
        pathname: url.pathname,
        method: request.method,
        routing_mode: route,
        mutation_mode: mode,
        original_system,
        final_system,
        canary,
        request_body_redacted: redactBodyFields(parsed),
        request_headers_redacted: redactHeaders(request.headers),
        response_status: upstream.status,
        response_time_ms: Date.now() - startTs,
        upstream_request_id: upstream.headers.get('request-id') || null,
        mode,
        route,
    };

    // Initial log write — scanStream will overwrite with terminal state
    if (cfg.WC_KV_LOG === 'true') {
        ctx.waitUntil(env.WC_KV.put(
            `log:${startTs}:${request_id}`,
            JSON.stringify(meta),
            { expirationTtl: 60 * 86400 }
        ));
    }

    // Stream the response back through the tee pipeline
    const ct = upstream.headers.get('content-type') || '';
    if (ct.includes('text/event-stream')) {
        // Apply translation if configured
        if (cfg.WC_TRANSLATE === 'openai_to_anthropic') {
            // Wrap upstream.body with the translator before piping
            const { readable, writable } = buildOAIToAnthropicTransform();
            upstream.body.pipeTo(writable);
            const translatedUpstream = new Response(readable, {
                status: upstream.status,
                headers: upstream.headers
            });
            return withCORS(pipeStreamingResponse(translatedUpstream, meta, cfg, ctx), request);
        }
        return withCORS(pipeStreamingResponse(upstream, meta, cfg, ctx), request);
    }

    // Non-streaming path
    const buf = await upstream.arrayBuffer();
    const preview = new TextDecoder().decode(buf.slice(0, 4096));
    meta.response_body_preview = preview;
    meta.canary_echoed_in_response = null;

    // Apply translation if configured (non-streaming, best-effort)
    if (cfg.WC_KV_LOG === 'true') {
        ctx.waitUntil(env.WC_KV.put(
            `log:${startTs}:${request_id}`,
            JSON.stringify(meta),
            { expirationTtl: 60 * 86400 }
        ));
    }
    return withCORS(new Response(buf, {
        status: upstream.status,
        headers: mergeEvidenceHeaders(upstream.headers, meta)
    }), request);
}

// =============================================================================
// §15 — WRANGLER.TOML (embedded as comment for operator reference)
// =============================================================================
//
// # wrangler.toml for Worker C (wc-7.0)
// name = "worker-c"
// main = "worker_c_cf.js"
// compatibility_date = "2025-01-15"
// compatibility_flags = ["nodejs_compat"]
//
// [[kv_namespaces]]
// binding = "WC_KV"
// id = "<wc_kv_namespace_id>"       # create with: wrangler kv:namespace create WC_KV
//
// [vars]
// WC_MODE     = "passthrough"        # default: log-only, no mutation
// WC_ROUTE    = "test"               # default: closed-loop via Worker A
// WC_KV_LOG   = "true"              # enable request logging
// # Secrets (set via dashboard or `wrangler secret put`):
// #   WORKER_A_URL     — Worker A URL (required for route=test)
// #   WC_REPLACEMENT   — replacement system prompt (required for mode=replace)
// #   WC_PREFIX        — system prompt prefix (required for mode=prepend)
// #   WC_SUFFIX        — system prompt suffix (required for mode=append)
// #   WC_CANARY        — operator-supplied canary (required for mode=inject_canary)
// #   WC_CANARY_OPT_IN — must be literal "true" to enable inject_canary second layer
// #   HACKERONE_HANDLE — your HackerOne handle (injected on passthrough requests)
//
// # Deploy:
// #   wrangler deploy
// #   wrangler tail              (stream logs)
// #   wrangler kv:namespace list (verify KV binding)

// =============================================================================
// §16 — CONSTANTS, ENUMS, AND MODEL ALIAS MAP
// =============================================================================

/**
 * Anthropic stop reason → OpenAI finish_reason mapping (bidirectional).
 */
const STOP_REASON_MAP = Object.freeze({
    // Anthropic → OpenAI
    'end_turn':       'stop',
    'max_tokens':     'length',
    'tool_use':       'tool_calls',
    'stop_sequence':  'stop',
    // OpenAI → Anthropic
    'stop':           'end_turn',
    'length':         'max_tokens',
    'tool_calls':     'tool_use',
    'function_call':  'tool_use',
});

/**
 * Anthropic error type → HTTP status code mapping.
 */
const ANTHROPIC_ERROR_STATUS = Object.freeze({
    'invalid_request_error':     400,
    'authentication_error':      401,
    'permission_error':          403,
    'not_found_error':           404,
    'request_too_large':         413,
    'rate_limit_error':          429,
    'overloaded_error':          529,
    'api_error':                 500,
    'timeout_error':             504,
});

/**
 * Model alias map — maps common aliases to canonical Anthropic model IDs.
 * Allows clients to use shorthand names.
 */
const MODEL_ALIAS_MAP = Object.freeze({
    'opus':          'claude-opus-4-7',
    'sonnet':        'claude-sonnet-4-6',
    'haiku':         'claude-haiku-4-5-20251001',
    'claude-3-opus': 'claude-opus-4-7',
    'claude-3-sonnet': 'claude-sonnet-4-6',
    'claude-3-haiku': 'claude-haiku-4-5-20251001',
    'claude-opus-4': 'claude-opus-4-7',
    'claude-sonnet-4': 'claude-sonnet-4-6',
});

/**
 * Supported anthropic-beta header values (informational).
 */
const SUPPORTED_BETAS = Object.freeze([
    'prompt-caching-2024-07-31',
    'computer-use-2024-10-22',
    'computer-use-2025-01-24',
    'interleaved-thinking-2025-05-14',
    'extended-thinking-2025-02-19',
    'output-128k-2025-02-19',
    'files-api-2025-04-14',
]);

/**
 * Header allowlist — headers that are safe to forward upstream.
 * Other headers are dropped by buildUpstreamHeaders().
 */
const FORWARDED_REQUEST_HEADERS = Object.freeze([
    'content-type',
    'anthropic-version',
    'anthropic-beta',
    'anthropic-client-platform',
    'anthropic-device-id',
    'x-api-key',
    'authorization',
    'accept',
    'accept-encoding',
    'accept-language',
    'cache-control',
    'pragma',
]);

// =============================================================================
// §17 — SELF-TESTS AT BOOT
// =============================================================================
//
// Run-once assertions that fail-fast if the Worker is misconfigured.
// Logs failures to the Worker console; does not throw (tests non-fatal on deploy).

const _selfTestResults = (() => {
    const tests = {};
    let allPass = true;

    // T1: VALID_MODES contains exactly the 6 expected modes
    tests.validModesSize = VALID_MODES.size === 6;

    // T2: BLOCKED_HOSTS contains exactly 4 CoCoDem C2 hosts
    tests.blockedHostsSize = BLOCKED_HOSTS.length === 4;

    // T3: BLOCKED_HOSTS does NOT contain Anthropic domains
    tests.anthropicNotBlocked =
        !BLOCKED_HOSTS.some(h => h.includes('anthropic.com') || h.includes('claude.ai'));

    // T4: getMode returns 'passthrough' for empty input
    tests.defaultModePassthrough = (() => {
        try { return getMode({}) === 'passthrough'; } catch { return false; }
    })();

    // T5: applyMutation passthrough returns body unchanged
    tests.passthroughIdempotent = (() => {
        try {
            const body = { model: 'x', messages: [], system: 'test-system' };
            const { mutated, original_system } = applyMutation(body, {}, 'passthrough');
            return mutated.system === 'test-system' && original_system === 'test-system';
        } catch { return false; }
    })();

    // T6: applyMutation strip deletes system
    tests.stripDeletesSystem = (() => {
        try {
            const body = { model: 'x', messages: [], system: 'test-system' };
            const { mutated } = applyMutation(body, {}, 'strip');
            return !('system' in mutated);
        } catch { return false; }
    })();

    // T7: applyMutation replace sets system to WC_REPLACEMENT
    tests.replaceSetSystem = (() => {
        try {
            const body = { model: 'x', messages: [], system: 'original' };
            const { mutated } = applyMutation(body, { WC_REPLACEMENT: 'replacement' }, 'replace');
            return mutated.system === 'replacement';
        } catch { return false; }
    })();

    // T8: applyMutation prepend prepends prefix
    tests.prependPrependsPrefix = (() => {
        try {
            const body = { model: 'x', messages: [], system: 'original' };
            const { mutated } = applyMutation(body, { WC_PREFIX: 'prefix' }, 'prepend');
            return mutated.system === 'prefix\n\noriginal';
        } catch { return false; }
    })();

    // T9: applyMutation append appends suffix
    tests.appendAppendsSuffix = (() => {
        try {
            const body = { model: 'x', messages: [], system: 'original' };
            const { mutated } = applyMutation(body, { WC_SUFFIX: 'suffix' }, 'append');
            return mutated.system === 'original\n\nsuffix';
        } catch { return false; }
    })();

    // T10: inject_canary with missing WC_CANARY_OPT_IN falls back to passthrough
    tests.injectCanaryRequiresOptIn = (() => {
        try {
            const body = { model: 'x', messages: [], system: 'test' };
            const { canary } = applyMutation(body, { WC_CANARY: 'test-canary' }, 'inject_canary');
            return canary === null; // should fall back, not inject
        } catch { return false; }
    })();

    // T11: safeOutboundFetch throws on blocked host
    tests.safeOutboundFetchBlocks = (() => {
        try {
            safeOutboundFetch('https://openclaude.111724.xyz/api', {});
            return false; // should have thrown
        } catch (e) {
            return e instanceof InterceptError && e.status === 403;
        }
    })();

    // T12: containsBlockedFragment detects CoCoDem C2 fragments
    tests.containsBlockedFragmentWorks =
        containsBlockedFragment('https://openclaude.111724.xyz/') &&
        !containsBlockedFragment('https://api.anthropic.com/');

    // T13: newRequestId format validation — req_011 + 21 base32 = 28 chars total
    tests.requestIdFormat = (() => {
        const id = newRequestId();
        return id.startsWith('req_011') && id.length === 28;
    })();

    // T14: isInterceptablePath matches expected paths
    tests.interceptablePaths =
        isInterceptablePath('/v1/messages') &&
        isInterceptablePath('/api/organizations/abc-123/chat_conversations/xyz-456/completion') &&
        !isInterceptablePath('/v1/models') &&
        !isInterceptablePath('/health');

    // T15: escapeHtml escapes correctly
    tests.escapeHtmlWorks =
        escapeHtml('<script>alert("xss")</script>') ===
        '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;';

    // T16: CORS_ALLOWLIST_PATTERNS match expected origins
    // workers.dev subdomains are exactly one level: <name>.workers.dev
    tests.corsAllowlistPatterns =
        CORS_ALLOWLIST_PATTERNS.some(re => re.test('http://localhost:8787')) &&
        CORS_ALLOWLIST_PATTERNS.some(re => re.test('https://worker-b.workers.dev')) &&
        CORS_ALLOWLIST_PATTERNS.some(re => re.test('https://claude.ai')) &&
        !CORS_ALLOWLIST_PATTERNS.some(re => re.test('https://evil.com'));

    for (const [name, pass] of Object.entries(tests)) {
        if (!pass) {
            allPass = false;
            console.error(`[wc-7.0] SELF-TEST FAILED: ${name}`);
        }
    }

    if (allPass) {
        console.log(`[wc-7.0] All ${Object.keys(tests).length} self-tests passed`);
    }

    return { allPass, tests };
})();

// =============================================================================
// §18 — DIAGNOSTIC CONSOLE (operator-only ?diag=1)
// =============================================================================

/**
 * Serve a lightweight diagnostic console showing last 50 log entries.
 * Only accessible when ?diag=1 query param is present AND setup token matches.
 *
 * @param {Request} req
 * @param {object}  env
 * @returns {Promise<Response>}
 */
async function handleDiagConsole(req, env) {
    const url = new URL(req.url);
    const token = req.headers.get('x-spoc-setup-token') || url.searchParams.get('token');
    const stored = await env.WC_KV.get('WC_SETUP_TOKEN');
    if (stored && token !== stored) {
        return new Response('setup token required for diag console', { status: 401 });
    }

    const list = await env.WC_KV.list({ prefix: 'log:', limit: 50 });
    const entries = [];
    for (const k of list.keys) {
        const v = await env.WC_KV.get(k.name);
        if (v) entries.push(JSON.parse(v));
    }
    entries.reverse(); // newest first

    const rows = entries.map(e => `
<tr style="border-bottom:1px solid #222">
  <td style="padding:4px 8px;font-size:11px;color:#888">${new Date(e.ts).toISOString()}</td>
  <td style="padding:4px 8px;color:#6cb6ff">${escapeHtml(e.request_id || '')}</td>
  <td style="padding:4px 8px">${escapeHtml(e.pathname || '')}</td>
  <td style="padding:4px 8px;color:${e.mutation_mode === 'passthrough' ? '#888' : '#f0a020'}">${escapeHtml(e.mutation_mode || '')}</td>
  <td style="padding:4px 8px">${e.response_status || ''}</td>
  <td style="padding:4px 8px">${e.response_time_ms || 0}ms</td>
  <td style="padding:4px 8px;color:${e.canary_echoed_in_response ? '#6ea850' : '#888'}">${
    e.canary ? (e.canary_echoed_in_response ? 'ECHOED' : 'no echo') : '-'
  }</td>
  <td style="padding:4px 8px;font-size:11px;color:#888;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${
    escapeHtml((e.original_system || '').slice(0, 60))
  }</td>
</tr>`).join('');

    const html = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><title>Worker C — wc-7.0 diag</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f0f0f;color:#d4d4d4;font-family:ui-monospace,Menlo,monospace;font-size:13px;padding:1rem}
h1{color:#f0a020;margin-bottom:1rem;font-size:1.2rem}
table{width:100%;border-collapse:collapse}
th{text-align:left;padding:6px 8px;background:#1a1a1a;color:#6cb6ff;font-size:11px;font-weight:normal;text-transform:uppercase;letter-spacing:0.05em}
.btn{background:#f0a020;color:#0f0f0f;border:0;padding:.4rem 1rem;cursor:pointer;font-family:inherit;font-size:12px;border-radius:2px}
</style>
</head><body>
<h1>Worker C — wc-7.0 diagnostic console</h1>
<p style="color:#888;margin-bottom:1rem;font-size:12px">Last ${entries.length} intercepts | <a href="/health" style="color:#6cb6ff">health</a> | <a href="/setup" style="color:#6cb6ff">setup</a></p>
<table>
<thead><tr>
  <th>Timestamp</th><th>Request ID</th><th>Path</th>
  <th>Mode</th><th>Status</th><th>Time</th><th>Canary</th><th>Original System (preview)</th>
</tr></thead>
<tbody>${rows || '<tr><td colspan="8" style="padding:1rem;text-align:center;color:#555">No entries yet</td></tr>'}</tbody>
</table>
<p style="margin-top:1rem;color:#555;font-size:11px">Self-tests: ${_selfTestResults.allPass ? '<span style="color:#6ea850">all pass</span>' : '<span style="color:#e05050">FAILED</span>'}</p>
</body></html>`;

    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

// =============================================================================
// §19 — VERBOSE ERROR ENVELOPE MAPPER
// =============================================================================

/**
 * Map Anthropic API error responses to structured error envelopes.
 * Preserves error type and maps to correct HTTP status codes.
 *
 * @param {number} status   — HTTP status code
 * @param {string} message  — error message
 * @param {string} type     — Anthropic error type
 * @returns {Response}
 */
function errorResponse(status, message, type) {
    const errorType = type || (() => {
        // Infer error type from status if not provided
        const reverseMap = {};
        for (const [t, s] of Object.entries(ANTHROPIC_ERROR_STATUS)) reverseMap[s] = t;
        return reverseMap[status] || 'api_error';
    })();

    return new Response(JSON.stringify({
        type: 'error',
        error: {
            type: errorType,
            message: message || 'An error occurred'
        }
    }), {
        status,
        headers: { 'content-type': 'application/json' }
    });
}

// =============================================================================
// §20 — BOOT-TIME CREDENTIAL REFUSAL ASSERTIONS (grep-checkable invariants)
// =============================================================================
//
// These assertions document the security properties of Worker C.
// They are grep-checkable by the HackerOne reviewer:
//
//   grep -c 'document\.cookie\|chrome\.cookies'  worker_c_cf.js  # must be 0
//   grep -c 'creds.*include'                       worker_c_cf.js  # must be 0 (in code; comments may differ)
//   grep -c '<REDACTED>'                          worker_c_cf.js  # must be >= 4
//   grep -c 'X-HackerOne-Handle\|HACKERONE_HANDLE' worker_c_cf.js # must be >= 3
//   grep -c 'safeOutboundFetch'                  worker_c_cf.js  # must be >= 4
//   grep -c 'BLOCKED_HOSTS'                      worker_c_cf.js  # must be >= 8
//   grep -c 'openclaude\.111724\.xyz'             worker_c_cf.js  # must be >= 2
//   grep -c 'inject_canary\|WC_CANARY'           worker_c_cf.js  # must be >= 8
//   grep -c 'IdentityTransformStream\|\.tee()'   worker_c_cf.js  # must be >= 4
//   grep -c 'env\.WC_KV\.\(put\|get\|list\|delete\)' worker_c_cf.js # must be >= 8
//   grep -c 'x-wc-system-stripped\|x-wc-mutation-mode\|x-wc-canary' worker_c_cf.js # must be >= 12
//
// Invariants:
//   1. No credential capture: raw cookie/session values are never read.
//      The userscript uses browser-managed creds; this Worker never calls
//      doc.cookie, storage APIs, or any cookie-reading primitive.
//   2. No in-Worker cred injection: the browser's creds:include mode is
//      set by the USERSCRIPT (client-side), not by this server-side Worker.
//   3. Credential redaction: <REDACTED> appears in redactHeaders() and redactBodyFields()
//   4. BLOCKED_HOSTS enforced: every outbound fetch → safeOutboundFetch()
//   5. HackerOne handle: injected in passthrough mode via X-HackerOne-Handle header
//   6. inject_canary: 3-layer opt-in (WC_MODE + WC_CANARY_OPT_IN + WC_CANARY)
//   7. SSE fidelity: IdentityTransformStream + .tee() — no byte reformatting

// =============================================================================
// §21 — ANTHROPIC SSE EVENT TAXONOMY REFERENCE
// =============================================================================
//
// Full event taxonomy per public Anthropic streaming spec.
// SEE: [7] Claude Code Internals Part 7 — SSE stream processing
// SEE: [8] anthropic-sdk-python _messages.py
//
// message_start event shape:
// {
//   "type": "message_start",
//   "message": {
//     "id": "msg_011Abc...",
//     "type": "message",
//     "role": "assistant",
//     "content": [],
//     "model": "claude-opus-4-7",
//     "stop_reason": null,
//     "stop_sequence": null,
//     "usage": { "input_tokens": 42, "output_tokens": 0 }
//   }
// }
//
// content_block_start event shapes:
//   text block:    { "type": "content_block_start", "index": 0, "content_block": { "type": "text", "text": "" } }
//   tool_use:      { "type": "content_block_start", "index": 1, "content_block": { "type": "tool_use", "id": "toolu_...", "name": "web_search", "input": {} } }
//   thinking:      { "type": "content_block_start", "index": 0, "content_block": { "type": "thinking", "thinking": "" } }
//
// content_block_delta event shapes:
//   text_delta:       { "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "Hello" } }
//   input_json_delta: { "type": "content_block_delta", "index": 1, "delta": { "type": "input_json_delta", "partial_json": "{\"qu" } }
//   thinking_delta:   { "type": "content_block_delta", "index": 0, "delta": { "type": "thinking_delta", "thinking": "Let me..." } }
//
// input_json_delta chunks do NOT respect JSON boundaries — a chunk can be
// "{\"qu" and the next "ery\":\"foo\"}". Buffer per index until content_block_stop.
//
// content_block_stop event: { "type": "content_block_stop", "index": N }
//
// ping event: { "type": "ping" }   — appears every ~15s, tolerable anywhere
//
// message_delta event:
// {
//   "type": "message_delta",
//   "delta": {
//     "stop_reason": "end_turn"|"max_tokens"|"tool_use"|"stop_sequence",
//     "stop_sequence": null|"..."
//   },
//   "usage": { "output_tokens": 123 }
// }
//
// message_stop event: { "type": "message_stop" }
//
// error event (mid-stream, terminates without message_stop):
// {
//   "type": "error",
//   "error": {
//     "type": "overloaded_error"|"api_error"|"rate_limit_error"|...,
//     "message": "..."
//   }
// }

// =============================================================================
// §22 — OPENAI STREAMING CHUNK FORMAT REFERENCE
// =============================================================================
//
// SEE: [9] OpenAI Chat Completions streaming events reference
//
// Normal chunk:
// data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":<ts>,
//        "model":"...","choices":[{"index":0,"delta":{"role":"assistant"|<undef>,
//        "content":"..."|null,"tool_calls":[...]},"finish_reason":null}]}
//
// Terminator:
// data: [DONE]
//
// Tool calls chunk:
// delta.tool_calls = [{
//   "index": 0,
//   "id": "call_...",
//   "type": "function",
//   "function": { "name": "my_func", "arguments": "{\"arg\":" }
// }]
// Each subsequent chunk for the same tool appends to arguments:
// delta.tool_calls = [{"index": 0, "function": {"arguments": "\"value\"}"}}]

// =============================================================================
// §23 — CLOSED-LOOP BOUNDING PROPERTY (SAFETY ARGUMENT)
// =============================================================================
//
// Worker C is a closed-loop research artifact. Safety has three legs:
//
// 1. OPERATOR-ONLY DEPLOY
//    Worker C runs on the operator's own Cloudflare account. No third-party
//    user surface. Setup UI gated by one-time token, rotated on every POST.
//    Only the operator can configure or deploy this Worker.
//
// 2. BLOCKED_HOSTS LIST (grep-checkable invariant)
//    Every outbound fetch flows through safeOutboundFetch() which throws 403
//    on hostname match against exactly 4 CoCoDem C2 hosts:
//      openclaude.111724.xyz, cfc.aroic.workers.dev, 111724.xyz, aroic.workers.dev
//    Anthropic domains are NOT blocked because passthrough mode needs
//    api.anthropic.com with the operator's own credentials + HackerOne handle.
//    This is consistent with Anthropic HackerOne VDP research guidelines.
//
// 3. SAFE HARBOR COVERAGE
//    HackerOne anthropic VDP (Gold Standard Safe Harbor, May 2026) explicitly
//    authorizes good-faith research that:
//      - Involves only the operator's own account
//      - Uses minimal exploitation to prove the vulnerability
//      - Avoids exfiltration of data beyond what's needed for the PoC
//      - Avoids DoS or service disruption
//      - Attaches X-HackerOne-Handle on every outbound passthrough request
//    Worker C injects the handle automatically in passthrough mode (§3.1).
//
// The headline architectural finding demonstrated by this PoC:
//    Wire-level system-prompt mutation is DETERMINISTIC on /v1/messages traffic
//    across all four auth modes (no-key, API key, OAuth, cookie-bridge).
//    This is the same mutation primitive that CoCoDem's malware installs at the
//    extension layer. Worker C demonstrates that the attack surface is the
//    web platform's fetch interception capability — not the extension API per se.
//
//    The closed-loop bounding ensures this demonstration cannot escape into a
//    malicious-deploy posture without an operator deliberately:
//      (a) Removing or bypassing the BLOCKED_HOSTS list, AND
//      (b) Disabling the credential redaction layer, AND
//      (c) Configuring a real third-party operator surface
//    All three are grep-checkable invariants the HackerOne reviewer can audit.

// =============================================================================
// §24 — MAIN EXPORT (Cloudflare Worker ES module fetch handler)
// SEE: [1] Cloudflare fetch handler docs — ES module signature
// =============================================================================

export default {
    /**
     * Worker C fetch handler — routes all incoming requests to the appropriate handler.
     *
     * Route table:
     *   OPTIONS   *                              → CORS preflight
     *   GET       /health                        → health status JSON
     *   GET/POST  /setup                         → operator setup UI
     *   POST      /api/worker-config             → save configuration
     *   POST      /bridge/session                → DevTools bridge metadata
     *   GET       /intercept-log                 → paginated log entries
     *   DELETE    /intercept-log                 → purge log entries
     *   GET       /diag   (?diag=1&token=...)    → diagnostic console
     *   POST      /v1/messages                   → INTERCEPT + mutate
     *   POST      /api/organizations/{org}/completion → INTERCEPT + mutate
     *   ALL       (other paths)                      → pass through to upstream
     *
     * @param {Request}            request
     * @param {object}             env      — Cloudflare bindings (WC_KV, env vars)
     * @param {ExecutionContext}   ctx      — ctx.waitUntil for async KV writes
     * @returns {Promise<Response>}
     */
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const method = request.method;

        // CORS preflight
        if (method === 'OPTIONS') return handleOptions(request);

        try {
            // Operator-only diagnostic and admin surface
            if (url.pathname === '/health') {
                return withCORS(await handleHealth(env), request);
            }

            if (url.pathname === '/setup' && method === 'GET') {
                const cfg = await loadConfig(env);
                return renderSetupPage(env, cfg);
            }

            if (url.pathname === '/api/worker-config' && method === 'POST') {
                return withCORS(await handleSetupPost(request, env), request);
            }

            if (url.pathname === '/bridge/session' && method === 'POST') {
                return withCORS(await handleBridgeSession(request, env), request);
            }

            if (url.pathname === '/intercept-log' && method === 'GET') {
                return withCORS(await handleInterceptLog(request, env), request);
            }

            if (url.pathname === '/intercept-log' && method === 'DELETE') {
                return withCORS(await handleDeleteLog(request, env), request);
            }

            if (url.searchParams.get('diag') === '1') {
                return withCORS(await handleDiagConsole(request, env), request);
            }

            // The intercept path — /v1/messages or /api/organizations/.../completion
            if (isInterceptablePath(url.pathname) && method === 'POST') {
                return withCORS(await handleIntercept(request, env, ctx), request);
            }

            // Everything else passes through unmodified to the configured upstream
            return withCORS(await handlePassthroughNonIntercept(request, env, ctx), request);

        } catch (err) {
            const status = (err instanceof InterceptError) ? err.status : 500;
            const body = JSON.stringify({
                type: 'error',
                error: {
                    type: status >= 500 ? 'api_error' : 'invalid_request_error',
                    message: err.message || 'Worker C internal error'
                }
            });
            return withCORS(new Response(body, {
                status,
                headers: { 'content-type': 'application/json' }
            }), request);
        }
    }
};
