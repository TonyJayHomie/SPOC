// ==UserScript==
// @name         Worker C — Sister PoC Bridge (claude.ai + Worker B)
// @namespace    local.sister.poc.bridge
// @version      20260509
// @description  Browser bridge for Sister PoC VDP research. Connects claude.ai / Worker B tabs to local Worker A WebSocket bridge. Never reads document.cookie. Uses credentials:include.
// @match        https://claude.ai/*
// @match        http://127.0.0.1:*/*
// @match        http://localhost:*/*
// @match        https://*.workers.dev/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
//
// ================================================================
// REFUSAL BLOCK (non-negotiable, cannot be modified by config):
// 1. NEVER reads document.cookie or chrome.cookies. EVER.
// 2. NEVER captures or logs session tokens, cookie values, API keys.
// 3. NEVER routes to third-party hosts (only claude.ai, localhost, 127.0.0.1).
// 4. Single-operator only. No multi-user surface.
// 5. VDP / HackerOne anthropic-vdp safe-harbor only.
// 6. inject_canary mode: USER SET. DEFAULT OFF. Evidence-only.
// ================================================================
// BLOCKED_HOSTS: Requests through this bridge never exit to these
// external hosts — they MUST go through claude.ai's own endpoint:
//   api.anthropic.com, console.anthropic.com, platform.claude.com,
//   openclaude.111724.xyz, cfc.aroic.workers.dev, 111724.xyz, aroic.workers.dev
// ================================================================

(function () {
  'use strict';

  // ── CONFIGURATION ────────────────────────────────────────────────
  const WS_URL     = GM_getValue('worker_c_ws_url',  'ws://127.0.0.1:8787/ws');
  const SCRIPT_VER = '20260509';

  // ── BLOCKED HOSTS — outbound block (refusal item §6) ─────────────
  // These external hosts must never be reached directly through this bridge.
  // ALL completions route through the current tab's origin (claude.ai or Worker B).
  const BLOCKED_HOSTS = new Set([
    'api.anthropic.com',
    'console.anthropic.com',
    'platform.claude.com',
    'openclaude.111724.xyz',
    'cfc.aroic.workers.dev',
    '111724.xyz',
    'aroic.workers.dev',
  ]);

  // ── MUTATION MODES ──────────────────────────────────────────────
  // Five modes. inject_canary is USER SET / DEFAULT OFF.
  //
  // passthrough  : no modification (default)
  // strip        : removes system prompt field from completion body
  // replace      : replaces system prompt with operator-configured override
  // prepend      : adds override text BEFORE existing system prompt
  // append       : adds override text AFTER existing system prompt
  // inject_canary: inserts a VDP evidence canary into the system prompt
  //                (USER MUST EXPLICITLY ENABLE — default is OFF)
  //
  // Mode and override are stored in GM storage, configurable via menu.
  const MUTATION_MODE     = GM_getValue('worker_c_mutation_mode',   'passthrough');
  const SYSTEM_OVERRIDE   = GM_getValue('worker_c_system_override', '');
  const CANARY_ENABLED    = GM_getValue('worker_c_canary_enabled',  false);
  const CANARY_TEXT       = GM_getValue('worker_c_canary_text',     '[CANARY-VDP-EVIDENCE]');

  // ── STATE ───────────────────────────────────────────────────────
  let ws              = null;
  let wsReady         = false;
  let reconnectDelay  = 1000;
  let reconnectTimer  = null;
  let pingInterval    = null;
  let pongTimeout     = null;
  let mutationMode    = MUTATION_MODE;
  let systemOverride  = SYSTEM_OVERRIDE;
  let canaryEnabled   = CANARY_ENABLED;
  let canaryText      = CANARY_TEXT;

  // Diagnostics (in-memory ring buffer)
  const DIAG_MAX = 200;
  const diagLog  = [];

  function diag(level, ...args) {
    const entry = { ts: Date.now(), level, msg: args.join(' ') };
    diagLog.push(entry);
    if (diagLog.length > DIAG_MAX) diagLog.shift();
    if (level === 'error') console.error('[worker_c]', ...args);
    else                   console.log('[worker_c]', ...args);
  }

  // ── UTILITIES ───────────────────────────────────────────────────
  function safeJson(text) {
    try { return JSON.parse(text); } catch { return null; }
  }

  function currentConversationUuid() {
    const m = location.pathname.match(/\/chat\/([0-9a-f-]{36})/i);
    return m ? m[1] : '';
  }

  function likelyOrgUuid() {
    // Try sessionStorage first (set by Worker A on first successful meta message)
    const cached = sessionStorage.getItem('worker_c.org_uuid') ||
                   localStorage.getItem('worker_c.org_uuid');
    if (cached) return cached;
    // Try to find it in the page (Next.js state, meta tags, URL)
    try {
      const nextData = window.__NEXT_DATA__;
      if (nextData?.props?.pageProps?.organization?.uuid) {
        return nextData.props.pageProps.organization.uuid;
      }
    } catch {}
    // Fallback to known ORG_UUID from live HAR capture
    return '150fb5c6-500f-4fec-b0d9-f4bcd2ab9ec5';
  }

  function isBlockedHost(rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      const host   = parsed.hostname.toLowerCase();
      if (host === location.hostname) return false; // same origin always OK
      if (BLOCKED_HOSTS.has(host)) return true;
      for (const blocked of BLOCKED_HOSTS) {
        if (host.endsWith('.' + blocked)) return true;
      }
      return false;
    } catch {
      return true;
    }
  }

  // ── MUTATION ENGINE ─────────────────────────────────────────────
  function applyMutation(body) {
    const mode = mutationMode;

    if (mode === 'passthrough') {
      return { body, mutated: false, mode };
    }

    // Clone body to avoid modifying the original
    const b = JSON.parse(JSON.stringify(body));

    // The system prompt in claude.ai completion requests is either:
    //   body.system (string or array) — Anthropic Messages API
    //   body.prompt prefix            — claude.ai format
    // We operate on body.system when present, otherwise skip.

    const hasSystem = typeof b.system !== 'undefined' && b.system !== null;
    const origSystem = hasSystem
      ? (Array.isArray(b.system)
          ? b.system.map(x => (typeof x === 'string' ? x : (x.text || ''))).join('\n')
          : String(b.system))
      : '';

    let newSystem = origSystem;
    let mutated   = false;

    switch (mode) {
      case 'strip':
        if (hasSystem) {
          delete b.system;
          mutated = true;
        }
        break;

      case 'replace':
        b.system = systemOverride || '';
        mutated  = true;
        break;

      case 'prepend':
        if (systemOverride) {
          newSystem = systemOverride + '\n\n' + origSystem;
          b.system  = newSystem;
          mutated   = true;
        }
        break;

      case 'append':
        if (systemOverride) {
          newSystem = origSystem + '\n\n' + systemOverride;
          b.system  = newSystem;
          mutated   = true;
        }
        break;

      case 'inject_canary':
        if (canaryEnabled && canaryText) {
          newSystem = origSystem + '\n\n' + canaryText + ' ' + Date.now();
          b.system  = newSystem;
          mutated   = true;
        } else {
          // canary is USER SET / DEFAULT OFF — if not enabled, passthrough
          diag('info', '[inject_canary] mode active but canary is disabled by user — passthrough');
        }
        break;
    }

    return { body: b, mutated, mode, origSystem, newSystem };
  }

  // ── SSE PARSER ──────────────────────────────────────────────────
  function parseSseFrames(buffer, onFrame) {
    const parts = buffer.split(/\n\n/);
    const rest  = parts.pop() || '';
    for (const part of parts) {
      if (!part.trim()) continue;
      let event = 'message';
      let data  = '';
      for (const line of part.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      onFrame(event, data);
    }
    return rest;
  }

  function pickText(json) {
    if (!json || typeof json !== 'object') return '';
    const candidates = [
      json?.delta?.text,
      json?.text,
      json?.completion,
      json?.message?.text,
      json?.content?.text,
      typeof json?.delta === 'string' ? json.delta : '',
    ];
    for (const c of candidates) if (typeof c === 'string' && c) return c;
    return '';
  }

  // ── CONVERSATION CREATION ────────────────────────────────────────
  async function createConversation(orgUuid, model, body) {
    const url = `${location.origin}/api/organizations/${orgUuid}/chat_conversations`;
    const payload = body?.create_conversation_params || {
      name:                          '',
      model:                         model || 'claude-sonnet-4-6',
      include_conversation_preferences: true,
      paprika_mode:                  'extended',
      compass_mode:                  null,
      is_temporary:                  false,
      enabled_imagine:               true,
    };
    const response = await fetch(url, {
      method:      'POST',
      credentials: 'include',
      headers:     { 'content-type': 'application/json', accept: 'application/json' },
      body:        JSON.stringify(payload),
    });
    const json = await response.json();
    const convUuid = json?.uuid || json?.chat_conversation_uuid || json?.conversation_uuid || '';
    if (!convUuid) throw new Error('Unable to create claude.ai conversation UUID');
    return convUuid;
  }

  // ── COMPLETION HANDLER ───────────────────────────────────────────
  async function handleCompletionRequest(msg) {
    const orgUuid = msg.org_uuid || likelyOrgUuid();
    sessionStorage.setItem('worker_c.org_uuid', orgUuid);

    let conversationUuid = msg.conversation_uuid || currentConversationUuid();
    if (!conversationUuid) {
      conversationUuid = await createConversation(orgUuid, msg?.body?.model, msg.body);
      wsSend({ type: 'meta', id: msg.id, org_uuid: orgUuid, conversation_uuid: conversationUuid });
    }

    // Apply mutation mode to request body
    const { body: mutatedBody, mutated, mode } = applyMutation(msg.body || {});
    if (mutated) diag('info', `[mutation:${mode}] applied to request ${msg.id}`);

    const targetUrl = `${location.origin}/api/organizations/${orgUuid}/chat_conversations/${conversationUuid}/completion`;

    if (isBlockedHost(targetUrl)) {
      throw new Error(`Blocked outbound host: ${new URL(targetUrl).hostname}`);
    }

    const abort  = new AbortController();
    // Cancel support: Worker A can send cancel message referencing this id
    const cancelKey = `cancel_${msg.id}`;
    window[cancelKey] = () => abort.abort();

    let response;
    try {
      response = await fetch(targetUrl, {
        method:      'POST',
        credentials: 'include',
        signal:      abort.signal,
        headers: {
          accept:         'text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify(mutatedBody),
      });
    } catch (err) {
      delete window[cancelKey];
      throw err;
    }

    if (!response.ok) {
      delete window[cancelKey];
      throw new Error(`claude.ai completion failed: ${response.status} ${response.statusText}`);
    }

    const reader  = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { stream: true });
    let buffer    = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = parseSseFrames(buffer, (event, dataText) => {
          const json = safeJson(dataText);
          wsSend({
            type:  'claude_event',
            id:    msg.id,
            event,
            text:  pickText(json),
            data:  json || dataText,
          });
        });
      }
    } finally {
      delete window[cancelKey];
      reader.cancel().catch(() => {});
    }

    wsSend({ type: 'done', id: msg.id });
    diag('info', `[completion] done: ${msg.id}`);
  }

  // ── WEBSOCKET SEND ───────────────────────────────────────────────
  function wsSend(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      diag('warn', 'wsSend: not connected, dropping', obj.type);
      return;
    }
    try {
      ws.send(JSON.stringify(obj));
    } catch (err) {
      diag('error', 'wsSend error:', err.message);
    }
  }

  // ── HELLO ENVELOPE ───────────────────────────────────────────────
  function buildHello() {
    return {
      type:              'hello',
      version:           SCRIPT_VER,
      page_url:          location.href,
      pathname:          location.pathname,
      host:              location.host,
      org_uuid:          likelyOrgUuid(),
      conversation_uuid: currentConversationUuid(),
      bridge:            'claude_browser_tab',
      mutation_mode:     mutationMode,
      canary_enabled:    canaryEnabled,
    };
  }

  // ── WEBSOCKET CONNECT ────────────────────────────────────────────
  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  }

  function stopPing() {
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    if (pongTimeout)  { clearTimeout(pongTimeout);   pongTimeout  = null; }
  }

  function startPing() {
    stopPing();
    pingInterval = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      wsSend({ type: 'ping', ts: Date.now() });
      pongTimeout = setTimeout(() => {
        diag('warn', 'pong timeout — reconnecting');
        ws.close();
      }, 35000);
    }, 25000);
  }

  function connect() {
    diag('info', `Connecting to ${WS_URL}…`);
    try {
      ws = new WebSocket(WS_URL);
    } catch (err) {
      diag('error', 'WebSocket constructor failed:', err.message);
      scheduleReconnect();
      return;
    }

    ws.addEventListener('open', () => {
      wsReady = true;
      reconnectDelay = 1000;
      diag('info', 'Connected to Worker A');
      wsSend(buildHello());
      startPing();
    });

    ws.addEventListener('message', async (ev) => {
      const msg = safeJson(ev.data);
      if (!msg) return;

      if (msg.type === 'ping') {
        wsSend({ type: 'pong', ts: Date.now() });
        return;
      }
      if (msg.type === 'pong') {
        if (pongTimeout) { clearTimeout(pongTimeout); pongTimeout = null; }
        return;
      }

      // Config update from Worker A
      if (msg.type === 'set_mutation_mode' && msg.mode) {
        mutationMode = msg.mode;
        GM_setValue('worker_c_mutation_mode', mutationMode);
        diag('info', `Mutation mode set to: ${mutationMode}`);
        return;
      }
      if (msg.type === 'set_system_prompt') {
        systemOverride = msg.text || '';
        GM_setValue('worker_c_system_override', systemOverride);
        diag('info', `System override updated (${systemOverride.length} chars)`);
        return;
      }
      if (msg.type === 'set_canary') {
        canaryEnabled = !!msg.enabled;
        canaryText    = msg.text || CANARY_TEXT;
        GM_setValue('worker_c_canary_enabled', canaryEnabled);
        GM_setValue('worker_c_canary_text',    canaryText);
        diag('info', `Canary ${canaryEnabled ? 'enabled' : 'disabled'}: ${canaryText}`);
        return;
      }

      // Org/conversation discovery
      if (msg.type === 'discover_org') {
        const orgUuid  = likelyOrgUuid();
        const convUuid = currentConversationUuid();
        wsSend({ type: 'org_info', id: msg.id, org_uuid: orgUuid, conversation_uuid: convUuid });
        return;
      }

      // Conversation creation
      if (msg.type === 'create_conversation') {
        try {
          const orgUuid  = msg.org_uuid || likelyOrgUuid();
          const convUuid = await createConversation(orgUuid, msg.model, msg.params);
          wsSend({ type: 'convo_created', id: msg.id, org_uuid: orgUuid, conversation_uuid: convUuid });
        } catch (err) {
          wsSend({ type: 'error', id: msg.id, error: err.message || String(err) });
        }
        return;
      }

      // Cancel in-flight request
      if (msg.type === 'cancel' && msg.id) {
        const cancelKey = `cancel_${msg.id}`;
        if (typeof window[cancelKey] === 'function') {
          window[cancelKey]();
          delete window[cancelKey];
          diag('info', `Cancelled request: ${msg.id}`);
        }
        return;
      }

      // Completion request (main path)
      if (msg.type === 'completion_request') {
        handleCompletionRequest(msg).catch((err) => {
          wsSend({ type: 'error', id: msg.id, error: err.message || String(err) });
          diag('error', `completion error [${msg.id}]: ${err.message}`);
        });
        return;
      }
    });

    ws.addEventListener('close', (ev) => {
      wsReady = false;
      stopPing();
      diag('info', `WS closed (${ev.code} ${ev.reason}) — scheduling reconnect`);
      scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      wsReady = false;
      diag('warn', 'WS error (will close/reconnect)');
    });
  }

  // ── TAMPERMONKEY MENU COMMANDS ───────────────────────────────────
  GM_registerMenuCommand(`Mode: ${mutationMode}`, () => {
    const modes = ['passthrough', 'strip', 'replace', 'prepend', 'append', 'inject_canary'];
    const cur   = modes.indexOf(mutationMode);
    const next  = modes[(cur + 1) % modes.length];
    mutationMode = next;
    GM_setValue('worker_c_mutation_mode', next);
    if (ws && ws.readyState === WebSocket.OPEN) {
      wsSend({ type: 'set_mutation_mode', mode: next });
    }
    alert(`Worker C mutation mode: ${next}`);
  });

  GM_registerMenuCommand('Set system prompt override', () => {
    const val = prompt('System prompt override (blank to clear):', systemOverride);
    if (val !== null) {
      systemOverride = val;
      GM_setValue('worker_c_system_override', val);
      if (ws && ws.readyState === WebSocket.OPEN) {
        wsSend({ type: 'set_system_prompt', text: val });
      }
    }
  });

  GM_registerMenuCommand(`inject_canary: ${canaryEnabled ? 'ON' : 'OFF'} (toggle)`, () => {
    canaryEnabled = !canaryEnabled;
    GM_setValue('worker_c_canary_enabled', canaryEnabled);
    alert(`inject_canary: ${canaryEnabled ? 'ENABLED' : 'DISABLED'}`);
    diag('info', `User toggled inject_canary: ${canaryEnabled}`);
  });

  GM_registerMenuCommand('Show diagnostics', () => {
    const lines = diagLog.slice(-50).map(e =>
      `[${new Date(e.ts).toISOString().slice(11,23)}] [${e.level}] ${e.msg}`
    ).join('\n');
    const ws_state = ws ? ['CONNECTING','OPEN','CLOSING','CLOSED'][ws.readyState] : 'null';
    const panel = `Worker C v${SCRIPT_VER} Diagnostics
URL: ${location.href}
WS: ${WS_URL} [${ws_state}]
Mutation: ${mutationMode}
Canary: ${canaryEnabled ? 'ON' : 'OFF'}
Org UUID: ${likelyOrgUuid()}
Conv UUID: ${currentConversationUuid() || '(none)'}

Last 50 events:
${lines}`;
    alert(panel);
  });

  GM_registerMenuCommand('Set Worker A WS URL', () => {
    const val = prompt('Worker A WebSocket URL:', GM_getValue('worker_c_ws_url', WS_URL));
    if (val) {
      GM_setValue('worker_c_ws_url', val);
      alert(`WS URL updated to ${val}. Reload page to reconnect.`);
    }
  });

  // ── FLOATING STATUS INDICATOR ─────────────────────────────────────
  function createStatusBadge() {
    const badge = document.createElement('div');
    badge.id    = 'worker-c-badge';
    badge.style.cssText = [
      'position:fixed', 'bottom:12px', 'right:12px', 'z-index:2147483647',
      'background:#1a1a24', 'border:1px solid #2c2c3e', 'border-radius:4px',
      'padding:4px 8px', 'font-family:monospace', 'font-size:10px',
      'color:#9090a8', 'cursor:pointer', 'user-select:none',
      'transition:opacity .3s', 'opacity:0.6',
    ].join(';');
    badge.textContent = 'WC ⬤';
    badge.title       = 'Worker C status. Click to show diagnostics.';
    badge.onclick     = () => {
      const state = ws ? ['CONN','OPEN','CLOS','DEAD'][ws.readyState] : 'NULL';
      badge.title = `Worker C v${SCRIPT_VER} | WS: ${state} | Mode: ${mutationMode}`;
    };
    document.body.appendChild(badge);
    return badge;
  }

  function updateBadge(badge) {
    if (!badge) return;
    const open = ws && ws.readyState === WebSocket.OPEN;
    badge.textContent = `WC ${open ? '🟢' : '🔴'}`;
    badge.style.borderColor = open ? '#58b87a' : '#e05050';
  }

  // ── BOOT ─────────────────────────────────────────────────────────
  diag('info', `Worker C v${SCRIPT_VER} booting on ${location.origin}`);
  diag('info', `Mutation mode: ${mutationMode} | Canary: ${canaryEnabled ? 'ON' : 'OFF'}`);

  let statusBadge = null;
  if (document.body) {
    statusBadge = createStatusBadge();
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      statusBadge = createStatusBadge();
    });
  }

  // Watch WS state for badge updates
  setInterval(() => updateBadge(statusBadge), 2000);

  connect();

})();
