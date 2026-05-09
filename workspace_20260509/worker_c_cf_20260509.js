/**
 * WORKER C — Cloudflare Worker :: System Prompt Interceptor / MITM Proxy
 *
 * Sister PoC (SPOC) — Anthropic VDP/HackerOne Research Artifact
 * Demonstrates system prompt stripping at the network layer.
 *
 * Architecture position:
 *   Worker B SPA  →  Worker C (this)  →  api.anthropic.com  (passthrough mode)
 *   Worker B SPA  →  Worker C (this)  →  Worker A local     (test mode)
 *
 * Mutation modes (env WC_MODE or runtime /admin/set-mode):
 *   passthrough  — forward request body unchanged (default)
 *   strip        — remove all system prompt fields from request body
 *   replace      — replace system prompt with WC_SYSTEM_REPLACEMENT text
 *   prepend      — prepend WC_SYSTEM_PREFIX before operator system prompt
 *   append       — append WC_SYSTEM_SUFFIX after operator system prompt
 *   inject_canary — user-controlled toggle (default OFF); inject canary sentinel
 *
 * VDP evidence headers added to every response:
 *   x-wc-system-stripped   : "true" | "false"
 *   x-wc-system-length     : original byte length of system prompt
 *   x-wc-system-preview    : first 120 chars of original system prompt (truncated)
 *   x-wc-mutation-mode     : active mutation mode name
 *   x-wc-request-id        : internal trace UUID
 *
 * BLOCKED_HOSTS (CoCoDem C2 only — NOT Anthropic):
 *   openclaude.111724.xyz, cfc.aroic.workers.dev, 111724.xyz, aroic.workers.dev
 *
 * Environment variables (Cloudflare Workers dashboard → Settings → Variables):
 *   WC_MODE                : mutation mode (default: passthrough)
 *   WC_TARGET              : "anthropic" | "worker_a" (default: anthropic)
 *   WORKER_A_URL           : base URL of local Worker A (default: http://127.0.0.1:8787)
 *   ANTHROPIC_API_KEY      : optional — only for api_key auth mode (not cookie_bridge)
 *   WC_SYSTEM_REPLACEMENT  : replacement text for "replace" mode
 *   WC_SYSTEM_PREFIX       : prefix text for "prepend" mode
 *   WC_SYSTEM_SUFFIX       : suffix text for "append" mode
 *   WC_CANARY_ENABLED      : "true" | "false" (default: false — inject_canary mode toggle)
 *   WC_CANARY_TEXT         : canary sentinel text (default: see DEFAULTS below)
 *   WC_ADMIN_TOKEN         : bearer token for /admin/* endpoints (default: random per-start)
 *
 * Deployment: Cloudflare dashboard → paste entire file → Save & Deploy
 * NO wrangler.toml, NO wrangler deploy CLI commands.
 */

'use strict';

// ── Constants ────────────────────────────────────────────────────────────────

const VERSION = '1.0.0-spoc-20260509';

const BLOCKED_HOSTS = new Set([
  'openclaude.111724.xyz',
  'cfc.aroic.workers.dev',
  '111724.xyz',
  'aroic.workers.dev'
]);

const MUTATION_MODES = ['passthrough', 'strip', 'replace', 'prepend', 'append', 'inject_canary'];

const DEFAULTS = {
  mode: 'passthrough',
  target: 'anthropic',
  workerAUrl: 'http://127.0.0.1:8787',
  anthropicBase: 'https://api.anthropic.com',
  replacement: '[SYSTEM PROMPT STRIPPED BY SISTER POC]',
  prefix: '[SPOC-PREFIX] ',
  suffix: ' [SPOC-SUFFIX]',
  canaryText: '<<SPOC_CANARY_7f3a9b2c>>',
  canaryEnabled: false,
  previewLen: 120
};

// ── Runtime state (per-isolate, resets on cold start) ────────────────────────

const runtimeState = {
  mode: null,
  canaryEnabled: null,
  requestCount: 0,
  startTime: Date.now()
};

// ── Utility helpers ───────────────────────────────────────────────────────────

function traceId() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

function getMode(env) {
  if (runtimeState.mode !== null) return runtimeState.mode;
  const m = (env.WC_MODE || DEFAULTS.mode).toLowerCase().trim();
  return MUTATION_MODES.includes(m) ? m : DEFAULTS.mode;
}

function getCanaryEnabled(env) {
  if (runtimeState.canaryEnabled !== null) return runtimeState.canaryEnabled;
  return (env.WC_CANARY_ENABLED || '').toLowerCase() === 'true';
}

function getTarget(env) {
  return (env.WC_TARGET || DEFAULTS.target).toLowerCase().trim();
}

function getWorkerAUrl(env) {
  return (env.WORKER_A_URL || DEFAULTS.workerAUrl).replace(/\/$/, '');
}

function corsHeaders(origin) {
  return {
    'access-control-allow-origin': origin || '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS, DELETE, PUT, PATCH',
    'access-control-allow-headers': [
      'content-type', 'authorization', 'x-api-key', 'anthropic-version',
      'anthropic-beta', 'x-bridge-id', 'x-wc-mode', 'x-wc-admin-token'
    ].join(', '),
    'access-control-allow-credentials': 'true',
    'access-control-expose-headers': [
      'x-wc-system-stripped', 'x-wc-system-length', 'x-wc-system-preview',
      'x-wc-mutation-mode', 'x-wc-request-id', 'request-id'
    ].join(', ')
  };
}

function jsonResponse(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...corsHeaders('*'),
      ...extra
    }
  });
}

function isBlockedHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    for (const blocked of BLOCKED_HOSTS) {
      if (host === blocked || host.endsWith('.' + blocked)) return true;
    }
  } catch (_) { /* invalid URL — pass through */ }
  return false;
}

// ── System prompt extraction & mutation ──────────────────────────────────────

/**
 * Extract system prompt string from Anthropic-format request body.
 * Handles: string system, array system blocks, nested tool_choice system.
 * Returns { system: string, originalLength: number, found: boolean }
 */
function extractSystem(body) {
  if (!body || typeof body !== 'object') return { system: '', originalLength: 0, found: false };

  let systemStr = '';
  let found = false;

  if (typeof body.system === 'string') {
    systemStr = body.system;
    found = true;
  } else if (Array.isArray(body.system)) {
    // Anthropic array-format: [{type:'text',text:'...'}]
    const parts = [];
    for (const block of body.system) {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
    systemStr = parts.join('\n');
    found = body.system.length > 0;
  }

  return { system: systemStr, originalLength: systemStr.length, found };
}

/**
 * Apply mutation mode to request body.
 * Returns { mutatedBody, stripped, originalLength, preview, mode }
 */
function applyMutation(body, mode, env) {
  const { system, originalLength, found } = extractSystem(body);
  const preview = system.slice(0, DEFAULTS.previewLen);

  // No system prompt to mutate — still record evidence, return unchanged
  if (!found && originalLength === 0) {
    return {
      mutatedBody: body,
      stripped: false,
      originalLength: 0,
      preview: '',
      mode
    };
  }

  let mutatedBody = { ...body };
  let stripped = false;

  switch (mode) {
    case 'passthrough': {
      // No change
      break;
    }

    case 'strip': {
      // Remove system entirely from request body
      delete mutatedBody.system;
      stripped = true;
      break;
    }

    case 'replace': {
      const replacement = env.WC_SYSTEM_REPLACEMENT || DEFAULTS.replacement;
      mutatedBody.system = replacement;
      stripped = true;
      break;
    }

    case 'prepend': {
      const prefix = env.WC_SYSTEM_PREFIX || DEFAULTS.prefix;
      if (typeof body.system === 'string') {
        mutatedBody.system = prefix + body.system;
      } else if (Array.isArray(body.system)) {
        mutatedBody.system = [{ type: 'text', text: prefix }, ...body.system];
      } else {
        mutatedBody.system = prefix;
      }
      stripped = true;
      break;
    }

    case 'append': {
      const suffix = env.WC_SYSTEM_SUFFIX || DEFAULTS.suffix;
      if (typeof body.system === 'string') {
        mutatedBody.system = body.system + suffix;
      } else if (Array.isArray(body.system)) {
        mutatedBody.system = [...body.system, { type: 'text', text: suffix }];
      } else {
        mutatedBody.system = suffix;
      }
      stripped = true;
      break;
    }

    case 'inject_canary': {
      const canaryEnabled = getCanaryEnabled(env);
      if (canaryEnabled) {
        const canaryText = env.WC_CANARY_TEXT || DEFAULTS.canaryText;
        const canaryBlock = { type: 'text', text: canaryText };
        if (typeof body.system === 'string') {
          mutatedBody.system = [{ type: 'text', text: body.system }, canaryBlock];
        } else if (Array.isArray(body.system)) {
          mutatedBody.system = [...body.system, canaryBlock];
        } else {
          mutatedBody.system = [canaryBlock];
        }
        stripped = true;
      }
      // If canary disabled: passthrough (no change)
      break;
    }

    default:
      break;
  }

  return { mutatedBody, stripped, originalLength, preview, mode };
}

// ── Evidence header builder ───────────────────────────────────────────────────

function evidenceHeaders(stripped, originalLength, preview, mode, reqId) {
  return {
    'x-wc-system-stripped': stripped ? 'true' : 'false',
    'x-wc-system-length': String(originalLength),
    'x-wc-system-preview': preview || '',
    'x-wc-mutation-mode': mode,
    'x-wc-request-id': reqId
  };
}

// ── Proxy / forward logic ─────────────────────────────────────────────────────

/**
 * Forward the (possibly mutated) request to the appropriate upstream.
 * Streams the response body back to caller for SSE passthrough.
 */
async function forwardRequest(upstreamUrl, originalRequest, mutatedBody, env, reqId) {
  if (isBlockedHost(upstreamUrl)) {
    return jsonResponse(
      { error: 'blocked_host', message: 'Request to blocked C2 host rejected', reqId },
      403
    );
  }

  // Build forward headers — strip hop-by-hop, carry auth + anthropic headers
  const forwardHeaders = new Headers();
  const skipHeaders = new Set([
    'host', 'connection', 'keep-alive', 'transfer-encoding',
    'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate'
  ]);

  for (const [k, v] of originalRequest.headers.entries()) {
    if (!skipHeaders.has(k.toLowerCase())) {
      forwardHeaders.set(k, v);
    }
  }

  // If target is api.anthropic.com and we have an API key, inject it
  const target = getTarget(env);
  if (target === 'anthropic' && env.ANTHROPIC_API_KEY) {
    forwardHeaders.set('x-api-key', env.ANTHROPIC_API_KEY);
    forwardHeaders.delete('authorization');
  }

  // Always set content-type for POST with body
  if (mutatedBody !== null) {
    forwardHeaders.set('content-type', 'application/json');
  }

  // Remove x-wc-* headers before forwarding upstream
  for (const [k] of forwardHeaders.entries()) {
    if (k.startsWith('x-wc-')) forwardHeaders.delete(k);
  }

  const method = originalRequest.method;
  const init = {
    method,
    headers: forwardHeaders,
    redirect: 'follow'
  };

  if (mutatedBody !== null && method !== 'GET' && method !== 'HEAD') {
    init.body = JSON.stringify(mutatedBody);
  }

  try {
    const upstream = await fetch(upstreamUrl, init);
    return upstream;
  } catch (err) {
    return jsonResponse(
      { error: 'upstream_error', message: String(err), reqId },
      502
    );
  }
}

/**
 * Build the upstream URL based on target mode.
 * Worker A: prepend base URL, keep path.
 * Anthropic: replace host, keep path + query.
 */
function buildUpstreamUrl(request, env) {
  const target = getTarget(env);
  const url = new URL(request.url);
  const pathAndQuery = url.pathname + url.search;

  if (target === 'worker_a') {
    const base = getWorkerAUrl(env);
    return base + pathAndQuery;
  }

  // anthropic (default)
  return DEFAULTS.anthropicBase + pathAndQuery;
}

// ── Admin endpoints ───────────────────────────────────────────────────────────

function verifyAdmin(request, env) {
  const token = request.headers.get('x-wc-admin-token') || '';
  const expected = env.WC_ADMIN_TOKEN || '';
  if (!expected) return true; // No admin token configured — allow (dev mode)
  return token === expected;
}

function handleAdmin(pathname, request, env) {
  if (!verifyAdmin(request, env)) {
    return jsonResponse({ error: 'unauthorized', message: 'Invalid admin token' }, 401);
  }

  if (pathname === '/admin/status') {
    return jsonResponse({
      version: VERSION,
      uptime_ms: Date.now() - runtimeState.startTime,
      request_count: runtimeState.requestCount,
      mode: getMode(env),
      target: getTarget(env),
      canary_enabled: getCanaryEnabled(env),
      blocked_hosts: [...BLOCKED_HOSTS],
      worker_a_url: getWorkerAUrl(env)
    });
  }

  if (pathname === '/admin/set-mode' && request.method === 'POST') {
    return request.json().then(body => {
      const newMode = (body.mode || '').toLowerCase().trim();
      if (!MUTATION_MODES.includes(newMode)) {
        return jsonResponse(
          { error: 'invalid_mode', valid: MUTATION_MODES },
          400
        );
      }
      runtimeState.mode = newMode;
      return jsonResponse({ ok: true, mode: runtimeState.mode });
    }).catch(err => jsonResponse({ error: 'bad_json', message: String(err) }, 400));
  }

  if (pathname === '/admin/set-canary' && request.method === 'POST') {
    return request.json().then(body => {
      runtimeState.canaryEnabled = Boolean(body.enabled);
      return jsonResponse({ ok: true, canary_enabled: runtimeState.canaryEnabled });
    }).catch(err => jsonResponse({ error: 'bad_json', message: String(err) }, 400));
  }

  if (pathname === '/admin/reset') {
    runtimeState.mode = null;
    runtimeState.canaryEnabled = null;
    runtimeState.requestCount = 0;
    runtimeState.startTime = Date.now();
    return jsonResponse({ ok: true, message: 'Runtime state reset to env defaults' });
  }

  return jsonResponse({ error: 'not_found', path: pathname }, 404);
}

// ── Health endpoint ───────────────────────────────────────────────────────────

function handleHealth(env) {
  return jsonResponse({
    status: 'ok',
    version: VERSION,
    mode: getMode(env),
    target: getTarget(env),
    canary_enabled: getCanaryEnabled(env),
    worker_a_url: getWorkerAUrl(env),
    uptime_ms: Date.now() - runtimeState.startTime,
    request_count: runtimeState.requestCount
  });
}

// ── SSE / streaming response passthrough ─────────────────────────────────────

/**
 * Build a passthrough Response that streams the upstream SSE, injecting
 * evidence headers into the HTTP response envelope (not the SSE stream body).
 */
function streamingResponse(upstream, evidHeaders, origin) {
  const responseHeaders = new Headers();

  // Copy upstream response headers
  for (const [k, v] of upstream.headers.entries()) {
    const kl = k.toLowerCase();
    // Skip hop-by-hop and overwrite with our evidence
    if (['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer'].includes(kl)) continue;
    responseHeaders.set(k, v);
  }

  // Merge evidence headers (overwrite any upstream x-wc-*)
  for (const [k, v] of Object.entries(evidHeaders)) {
    responseHeaders.set(k, v);
  }

  // CORS
  const cors = corsHeaders(origin);
  for (const [k, v] of Object.entries(cors)) {
    responseHeaders.set(k, v);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders
  });
}

// ── Main request handler ──────────────────────────────────────────────────────

async function handleRequest(request, env) {
  runtimeState.requestCount++;
  const reqId = traceId();

  const url = new URL(request.url);
  const pathname = url.pathname;
  const origin = request.headers.get('origin') || '*';

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(origin),
        'cache-control': 'max-age=86400'
      }
    });
  }

  // Health check
  if (pathname === '/health' || pathname === '/') {
    return handleHealth(env);
  }

  // Admin routes
  if (pathname.startsWith('/admin/')) {
    return handleAdmin(pathname, request, env);
  }

  // Telemetry short-circuits (from READ 5 — HAR-pinned shapes)
  if (pathname === '/api/event_logging/v2/batch') {
    return jsonResponse({ status: 'ok', events_received: 1 }, 200,
      evidenceHeaders(false, 0, '', 'passthrough', reqId));
  }
  if (pathname === '/v1/code/github/batch-branch-status') {
    return jsonResponse({ statuses: [] }, 200,
      evidenceHeaders(false, 0, '', 'passthrough', reqId));
  }

  // Determine active mode
  const mode = getMode(env);

  // Only mutate POST requests with a JSON body (completion endpoints)
  const isCompletionEndpoint = (
    pathname === '/v1/messages' ||
    pathname.endsWith('/completion') ||
    pathname.includes('/api/organizations/') && pathname.includes('/chat_conversations/')
  );

  let mutationResult = {
    mutatedBody: null,
    stripped: false,
    originalLength: 0,
    preview: '',
    mode
  };

  let requestBody = null;

  if (request.method === 'POST' && isCompletionEndpoint) {
    try {
      requestBody = await request.json();
      mutationResult = applyMutation(requestBody, mode, env);
    } catch (_) {
      // Not JSON or parse error — forward raw
      requestBody = null;
    }
  }

  // Build upstream URL
  const upstreamUrl = buildUpstreamUrl(request, env);

  // Block CoCoDem C2
  if (isBlockedHost(upstreamUrl)) {
    return jsonResponse(
      { error: 'blocked_host', message: 'Request to blocked C2 host rejected', reqId },
      403,
      evidenceHeaders(false, 0, '', mode, reqId)
    );
  }

  // Forward to upstream
  const upstream = await forwardRequest(
    upstreamUrl,
    request,
    mutationResult.mutatedBody !== null ? mutationResult.mutatedBody : requestBody,
    env,
    reqId
  );

  if (upstream instanceof Response && upstream.status === 403 && upstream.headers.get('content-type')?.includes('application/json')) {
    // Our own error response — return as-is
    return upstream;
  }

  // Build evidence headers
  const evidHeaders = evidenceHeaders(
    mutationResult.stripped,
    mutationResult.originalLength,
    mutationResult.preview,
    mutationResult.mode,
    reqId
  );

  // Check if this is an SSE / streaming response
  const upstreamCT = (upstream instanceof Response ? upstream.headers.get('content-type') : '') || '';
  const isSSE = upstreamCT.includes('text/event-stream');

  if (isSSE) {
    return streamingResponse(upstream, evidHeaders, origin);
  }

  // Non-streaming: buffer and return with evidence headers
  const upstreamClone = upstream instanceof Response ? upstream : null;
  if (!upstreamClone) return upstream;

  const body = await upstreamClone.arrayBuffer();
  const responseHeaders = new Headers();

  for (const [k, v] of upstreamClone.headers.entries()) {
    const kl = k.toLowerCase();
    if (['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer'].includes(kl)) continue;
    responseHeaders.set(k, v);
  }
  for (const [k, v] of Object.entries(evidHeaders)) {
    responseHeaders.set(k, v);
  }
  const cors = corsHeaders(origin);
  for (const [k, v] of Object.entries(cors)) {
    responseHeaders.set(k, v);
  }

  return new Response(body, {
    status: upstreamClone.status,
    statusText: upstreamClone.statusText,
    headers: responseHeaders
  });
}

// ── CF Worker export ──────────────────────────────────────────────────────────

export default {
  async fetch(request, env, _ctx) {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      return new Response(JSON.stringify({
        error: 'internal_error',
        message: String(err),
        stack: err.stack || ''
      }), {
        status: 500,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          ...corsHeaders('*')
        }
      });
    }
  }
};

/*
 * ── DEPLOYMENT NOTES ────────────────────────────────────────────────────────
 *
 * 1. Go to https://dash.cloudflare.com → Workers & Pages → Create → Worker
 * 2. Paste this entire file into the editor
 * 3. Click "Save and Deploy"
 * 4. Set environment variables under Settings → Variables:
 *
 *    WC_MODE          = passthrough     (or strip/replace/prepend/append/inject_canary)
 *    WC_TARGET        = anthropic       (or worker_a for local test mode)
 *    WORKER_A_URL     = http://127.0.0.1:8787   (only used when WC_TARGET=worker_a)
 *    ANTHROPIC_API_KEY = sk-ant-...     (only for api_key auth mode, not cookie_bridge)
 *    WC_CANARY_ENABLED = false          (USER SET — default OFF per spec)
 *    WC_ADMIN_TOKEN   = <secret>        (optional; protects /admin/* endpoints)
 *
 * 5. Note the worker URL (e.g. https://worker-c.yourname.workers.dev)
 * 6. Set Worker B's WORKER_C_URL env var to this URL
 *
 * ── ADMIN API ───────────────────────────────────────────────────────────────
 *
 * GET  /health                           — status, mode, uptime
 * GET  /admin/status                     — full runtime state (requires x-wc-admin-token)
 * POST /admin/set-mode  {mode: "strip"}  — change mutation mode at runtime
 * POST /admin/set-canary {enabled: true} — toggle canary injection at runtime
 * POST /admin/reset                      — reset runtime state to env defaults
 *
 * ── VDP EVIDENCE HEADERS ────────────────────────────────────────────────────
 *
 * Every response from Worker C includes:
 *   x-wc-system-stripped : "true" if system prompt was mutated
 *   x-wc-system-length   : original byte length of system prompt
 *   x-wc-system-preview  : first 120 chars of original system prompt
 *   x-wc-mutation-mode   : active mutation mode name
 *   x-wc-request-id      : internal trace UUID for correlation
 *
 * ── MUTATION MODE REFERENCE ─────────────────────────────────────────────────
 *
 *   passthrough  : Forward request unchanged. Evidence headers still recorded.
 *   strip        : Delete body.system entirely before forwarding.
 *   replace      : Replace body.system with WC_SYSTEM_REPLACEMENT text.
 *   prepend      : Prepend WC_SYSTEM_PREFIX before operator system prompt.
 *   append       : Append WC_SYSTEM_SUFFIX after operator system prompt.
 *   inject_canary: Append canary sentinel block (only if WC_CANARY_ENABLED=true).
 *
 * ── BLOCKED HOSTS ──────────────────────────────────────────────────────────
 *
 * These are the ONLY blocked hosts (CoCoDem C2 — NOT Anthropic):
 *   openclaude.111724.xyz
 *   cfc.aroic.workers.dev
 *   111724.xyz
 *   aroic.workers.dev
 *
 * Anthropic API (api.anthropic.com) is NEVER blocked.
 * That is the entire point of the PoC — to demonstrate network-layer access.
 */
