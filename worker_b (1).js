// ================================================================
// WORKER B — claude.ai/chat Functional Mimic (Cloudflare Worker)
// Visually distinct (~60% similar), functionally 100% identical.
//
// ENV VARS (CF Dashboard → Settings → Variables):
//   WORKER_C_URL  — Worker C intercept layer (primary target)
//   WORKER_A_URL  — Worker A direct backend (fallback)
//
// Auth modes per backend:
//   no_key         — no auth header (LM Studio / local)
//   api_key        — x-api-key + Authorization: Bearer (Anthropic API key)
//   oauth          — Authorization: Bearer (Anthropic OAuth token)
//   session_cookie — credentials:include, no auth header (Worker C bridge)
// ================================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '') {
      const apiBase = env.WORKER_C_URL || env.WORKER_A_URL || '';
      return new Response(buildHTML(apiBase), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    return new Response('Not found', { status: 404 });
  },
};

function buildHTML(apiBase) {
  return HTML.replace('__INJECT_API_BASE__', JSON.stringify(apiBase || ''));
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claude</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0f0f17;--sf:#15151f;--sf2:#1a1a26;--sf3:#20202e;--bd:#2a2a3d;--bd2:#35354d;
  --tx:#d0d0e8;--tx2:#8080a8;--tx3:#454560;
  --ac:#8b7cf8;--ac2:#6d68e8;--acd:rgba(139,124,248,.1);--acg:rgba(139,124,248,.2);
  --grn:#3dd68c;--red:#f06080;--amb:#f0b429;--blu:#60a5fa;
}
html,body{height:100%;overflow:hidden;background:var(--bg);color:var(--tx);font-family:'Inter',ui-sans-serif,system-ui,sans-serif;font-size:14px;line-height:1.5}
::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--bd2);border-radius:2px}
button,input,select,textarea{font-family:inherit;font-size:inherit;outline:none}
button{cursor:pointer;border:none;background:none;color:inherit}

/* LAYOUT */
#app{display:flex;height:100vh;flex-direction:column}
#topbar{height:44px;min-height:44px;background:var(--sf);border-bottom:1px solid var(--bd);display:flex;align-items:center;padding:0 8px;gap:6px;flex-shrink:0;z-index:50}
#body{display:flex;flex:1;overflow:hidden}
#sidebar{width:260px;min-width:260px;background:var(--sf);border-right:1px solid var(--bd);display:flex;flex-direction:column;transition:all .2s;overflow:hidden}
#sidebar.closed{width:0;min-width:0}
#main{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}
#art-panel{width:0;min-width:0;background:var(--sf);border-left:1px solid var(--bd);display:flex;flex-direction:column;overflow:hidden;transition:all .2s;flex-shrink:0}
#art-panel.open{width:440px;min-width:440px}

/* TOPBAR */
.tico{width:30px;height:30px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:13px;color:var(--tx2);flex-shrink:0}
.tico:hover{background:var(--sf3);color:var(--tx)}
.brand{font-size:14px;font-weight:700;color:var(--ac);letter-spacing:-.02em;flex-shrink:0}
.tb-title{flex:1;font-size:12px;color:var(--tx2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:0 6px}
.tb-pill{font-size:10px;padding:2px 7px;border-radius:8px;font-weight:700;letter-spacing:.04em;flex-shrink:0}
.pill-ok{background:rgba(61,214,140,.12);color:var(--grn)}
.pill-err{background:rgba(240,96,128,.12);color:var(--red)}
.pill-ac{background:rgba(139,124,248,.12);color:var(--ac)}
.pill-amb{background:rgba(240,180,41,.12);color:var(--amb)}

/* SIDEBAR */
.sb-top{padding:8px;display:flex;gap:5px;border-bottom:1px solid var(--bd);flex-shrink:0}
.sb-search{flex:1;background:var(--sf2);border:1px solid var(--bd);border-radius:6px;padding:5px 9px;font-size:12px;color:var(--tx)}
.sb-search:focus{border-color:var(--ac)}
.sb-new{width:28px;height:28px;border-radius:6px;border:1px solid var(--bd);display:flex;align-items:center;justify-content:center;font-size:15px;color:var(--tx2);flex-shrink:0}
.sb-new:hover{border-color:var(--ac);color:var(--ac)}
.sb-list{flex:1;overflow-y:auto;padding:4px 5px}
.conv{display:flex;align-items:flex-start;gap:6px;padding:7px 7px;border-radius:7px;cursor:pointer;border-left:2px solid transparent;position:relative;margin-bottom:1px}
.conv:hover{background:var(--sf2)}
.conv.active{background:var(--acd);border-left-color:var(--ac)}
.conv-ico{font-size:12px;opacity:.5;flex-shrink:0;margin-top:2px}
.conv.active .conv-ico{opacity:1}
.conv-info{flex:1;min-width:0}
.conv-name{font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.conv-sub{font-size:10px;color:var(--tx3);margin-top:1px}
.conv-acts{display:none;gap:2px;position:absolute;right:5px;top:7px}
.conv:hover .conv-acts,.conv.active .conv-acts{display:flex}
.conv-act{width:20px;height:20px;border-radius:3px;display:flex;align-items:center;justify-content:center;font-size:10px;color:var(--tx3)}
.conv-act:hover{background:var(--sf3);color:var(--tx)}

/* BRANCH PANEL in sidebar */
#branch-panel{border-top:1px solid var(--bd);padding:8px 6px;flex-shrink:0;max-height:180px;overflow-y:auto;display:none}
.br-hd{font-size:9px;color:var(--tx3);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px;padding:0 2px}
.br-node{display:flex;align-items:center;gap:3px;padding:3px 5px;border-radius:4px;cursor:pointer;font-size:11px;color:var(--tx2);line-height:1.3}
.br-node:hover{background:var(--sf3);color:var(--tx)}
.br-node.active{color:var(--ac)}
.br-pipe{color:var(--bd2);flex-shrink:0;font-size:10px}

/* SIDEBAR FOOT */
.sb-foot{border-top:1px solid var(--bd);padding:7px 8px;flex-shrink:0}
.urow{display:flex;align-items:center;gap:7px;padding:5px 6px;border-radius:6px;cursor:pointer}
.urow:hover{background:var(--sf2)}
.uav{width:26px;height:26px;border-radius:6px;background:var(--acd);border:1px solid var(--acg);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:var(--ac);flex-shrink:0}

/* MESSAGES */
#msgs-wrap{flex:1;overflow-y:auto;padding:20px 0 8px}
.msg{display:flex;gap:10px;padding:8px 20px;max-width:860px;margin:0 auto;width:100%}
.msg:hover{background:rgba(255,255,255,.012)}
.mav{width:28px;height:28px;border-radius:7px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;margin-top:2px}
.mav.human{background:rgba(96,165,250,.12);border:1px solid rgba(96,165,250,.2);color:var(--blu)}
.mav.asst{background:rgba(139,124,248,.12);border:1px solid rgba(139,124,248,.2);color:var(--ac)}
.mbody{flex:1;min-width:0}
.mhead{display:flex;align-items:center;gap:6px;margin-bottom:4px}
.mrole{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
.mrole.human{color:var(--blu)}.mrole.asst{color:var(--ac)}
.mtime{font-size:10px;color:var(--tx3)}
.mmodel{font-size:9px;color:var(--tx3);background:var(--sf3);padding:1px 5px;border-radius:3px}
.mcontent{font-size:13.5px;line-height:1.72;color:var(--tx);word-break:break-word}
.mcontent p{margin-bottom:8px}.mcontent p:last-child{margin-bottom:0}
.mcontent pre{background:var(--sf3);border:1px solid var(--bd);border-radius:6px;padding:13px 15px;overflow-x:auto;margin:9px 0;position:relative}
.mcontent code{font-family:'Cascadia Code','Fira Code','Consolas',monospace;font-size:12.5px;line-height:1.55}
.mcontent :not(pre)>code{background:var(--sf3);padding:1px 5px;border-radius:3px;font-size:12px}
.copy-code{position:absolute;top:6px;right:8px;font-size:9px;padding:2px 7px;background:var(--sf2);border:1px solid var(--bd2);border-radius:3px;color:var(--tx3);opacity:0;transition:opacity .15s;cursor:pointer}
.mcontent pre:hover .copy-code{opacity:1}.copy-code:hover{color:var(--tx);border-color:var(--ac)}
.mcontent h1{font-size:19px;margin:12px 0 5px;font-weight:700}
.mcontent h2{font-size:15px;margin:10px 0 4px;font-weight:700}
.mcontent h3{font-size:13px;margin:8px 0 3px;font-weight:700;color:var(--ac)}
.mcontent ul,.mcontent ol{margin:7px 0 7px 18px}
.mcontent li{margin-bottom:3px}
.mcontent blockquote{border-left:3px solid var(--ac);padding:7px 13px;background:var(--acd);margin:8px 0;border-radius:0 5px 5px 0;font-style:italic}
.mcontent table{border-collapse:collapse;width:100%;margin:8px 0}
.mcontent th{background:var(--sf3);padding:5px 9px;border:1px solid var(--bd);font-weight:700;color:var(--ac);font-size:12px}
.mcontent td{padding:5px 9px;border:1px solid var(--bd);font-size:12px}
.mcontent a{color:var(--blu);text-decoration:none}.mcontent a:hover{text-decoration:underline}
.mcontent strong{font-weight:700}

/* THINKING / TOOL BLOCKS */
.think-block{border:1px solid var(--bd2);border-radius:6px;margin:7px 0;overflow:hidden}
.think-hd{padding:6px 11px;font-size:11px;color:var(--grn);display:flex;align-items:center;gap:5px;cursor:pointer;user-select:none;background:rgba(61,214,140,.04)}
.think-hd:before{content:'▶';font-size:8px;transition:transform .15s}
.think-block.open .think-hd:before{transform:rotate(90deg)}
.think-body{display:none;padding:9px 13px;font-size:11.5px;color:var(--tx2);border-top:1px solid var(--bd);white-space:pre-wrap;max-height:280px;overflow-y:auto;line-height:1.6}
.think-block.open .think-body{display:block}
.tool-block{background:rgba(109,104,232,.06);border:1px solid rgba(109,104,232,.2);border-radius:6px;margin:7px 0;padding:9px 13px}
.tool-name{font-size:10px;font-weight:700;color:var(--ac2);margin-bottom:5px;font-family:monospace;letter-spacing:.04em}
.tool-args{font-size:11px;font-family:monospace;color:var(--tx2);white-space:pre-wrap;max-height:180px;overflow-y:auto}

/* ARTIFACT CHIP */
.art-chip{display:inline-flex;align-items:center;gap:6px;padding:5px 11px;background:var(--sf3);border:1px solid var(--bd2);border-radius:7px;font-size:11.5px;cursor:pointer;margin:5px 0;transition:all .15s;color:var(--tx2)}
.art-chip:hover{border-color:var(--ac);color:var(--ac)}
.art-chip-ico{font-size:13px}

/* STREAMING CURSOR */
.caret{display:inline-block;width:2px;height:13px;background:var(--ac);vertical-align:text-bottom;animation:blink 1s steps(1) infinite;margin-left:1px;border-radius:1px}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}

/* MSG ACTIONS */
.msg-acts{display:flex;gap:4px;margin-top:6px;opacity:0;transition:opacity .15s;flex-wrap:wrap}
.msg:hover .msg-acts{opacity:1}
.mac{font-size:10px;padding:2px 8px;border:1px solid var(--bd);border-radius:4px;color:var(--tx3)}
.mac:hover{border-color:var(--ac);color:var(--ac)}

/* EMPTY STATE */
#empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:40px;text-align:center;max-width:520px;margin:0 auto;width:100%}
.empty-h{font-size:24px;font-weight:600;color:var(--tx)}
.empty-s{font-size:13px;color:var(--tx2);line-height:1.65}
.starters{display:flex;flex-wrap:wrap;gap:7px;justify-content:center;margin-top:4px}
.starter{padding:7px 14px;background:var(--sf2);border:1px solid var(--bd);border-radius:8px;font-size:12px;cursor:pointer;color:var(--tx2);transition:all .15s}
.starter:hover{border-color:var(--ac);color:var(--ac)}

/* INPUT */
#input-wrap{padding:10px 14px 8px;background:var(--sf);border-top:1px solid var(--bd);flex-shrink:0}
.ibox{background:var(--sf2);border:1px solid var(--bd2);border-radius:11px;padding:9px 11px;transition:border-color .15s}
.ibox:focus-within{border-color:var(--ac)}
#monaco-in{height:22px;max-height:180px}
.irow{display:flex;align-items:flex-end;gap:7px}
.send-btn{width:32px;height:32px;border-radius:7px;background:var(--ac);color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0;align-self:flex-end;transition:background .15s}
.send-btn:hover{background:var(--ac2)}.send-btn:disabled{background:var(--sf3);color:var(--tx3);cursor:not-allowed}
.stop-btn{width:32px;height:32px;border-radius:7px;background:rgba(240,96,128,.1);border:1px solid rgba(240,96,128,.25);color:var(--red);display:none;align-items:center;justify-content:center;font-size:12px;flex-shrink:0;align-self:flex-end}
.stop-btn.on{display:flex}.stop-btn:hover{background:var(--red);color:#fff}
.itb{display:flex;align-items:center;gap:4px;margin-top:7px;flex-wrap:wrap}
.itb-btn{font-size:10px;padding:3px 8px;border:1px solid var(--bd);border-radius:5px;color:var(--tx3);background:none}
.itb-btn:hover{border-color:var(--ac);color:var(--ac)}.itb-btn.on{background:var(--acd);border-color:var(--ac);color:var(--ac)}
.itb-sel{font-size:11px;padding:3px 7px;background:var(--sf3);border:1px solid var(--bd);border-radius:5px;color:var(--tx2);max-width:200px}
.itb-sel:focus{border-color:var(--ac)}
.itb-sep{flex:1}
.auth-tag{font-size:9px;padding:2px 6px;border-radius:4px;font-weight:700;letter-spacing:.05em}
.sp-wrap{margin-top:7px}
#sp-ta{width:100%;background:var(--sf3);border:1px solid var(--bd);border-radius:6px;padding:6px 9px;font-size:12px;color:var(--tx);resize:none;min-height:44px;max-height:110px}
#sp-ta:focus{border-color:var(--ac)}

/* ARTIFACT PANEL */
.art-hd{padding:7px 11px;border-bottom:1px solid var(--bd);display:flex;align-items:center;gap:6px;flex-shrink:0}
.art-htitle{font-size:11px;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:monospace}
.art-hlang{font-size:9px;padding:1px 5px;background:var(--sf3);border-radius:3px;color:var(--tx2)}
.art-vbar{display:none;align-items:center;gap:5px;padding:4px 9px;background:var(--sf2);border-bottom:1px solid var(--bd);font-size:10px;flex-shrink:0}
.art-vbar.on{display:flex}
.vbtn{padding:2px 7px;background:var(--sf3);border:1px solid var(--bd);border-radius:3px;cursor:pointer;color:var(--tx2);font-size:10px}
.vbtn:hover{border-color:var(--ac);color:var(--ac)}
.vcur{flex:1;text-align:center;color:var(--ac);font-family:monospace;font-size:10px}
.art-tabs{display:flex;border-bottom:1px solid var(--bd);flex-shrink:0}
.art-tab{padding:5px 13px;font-size:11px;cursor:pointer;color:var(--tx2);border-bottom:2px solid transparent}
.art-tab:hover{color:var(--tx)}.art-tab.on{color:var(--ac);border-bottom-color:var(--ac)}
#art-body{flex:1;overflow:auto;position:relative}
#art-preview{width:100%;height:100%;border:none;background:#fff;display:none}
.art-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:8px;color:var(--tx3);font-size:12px}
#monaco-art{width:100%;height:100%}

/* SETTINGS MODAL */
.ov{position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:500;display:flex;align-items:center;justify-content:center;opacity:0;pointer-events:none;transition:opacity .15s}
.ov.on{opacity:1;pointer-events:all}
.modal{background:var(--sf);border:1px solid var(--bd);border-radius:10px;width:90%;max-width:600px;max-height:84vh;display:flex;flex-direction:column;overflow:hidden}
.modal-hd{padding:13px 16px;border-bottom:1px solid var(--bd);display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
.modal-ht{font-size:14px;font-weight:700}
.modal-body{flex:1;overflow-y:auto;padding:14px 16px}
.sec{font-size:10px;color:var(--ac);text-transform:uppercase;letter-spacing:.08em;padding-bottom:5px;border-bottom:1px solid var(--acd);margin-bottom:10px;margin-top:16px;font-weight:700}
.sec:first-child{margin-top:0}
.fld{margin-bottom:9px}
.fld label{font-size:10px;color:var(--tx2);display:block;margin-bottom:2px;text-transform:uppercase;letter-spacing:.06em}
.fld input,.fld select{width:100%;padding:6px 8px;border-radius:5px;background:var(--sf2);border:1px solid var(--bd);color:var(--tx);font-size:12px}
.fld input:focus,.fld select:focus{border-color:var(--ac)}
.auth-grid{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:5px;margin-bottom:9px}
.ao{padding:5px 6px;border:1px solid var(--bd);border-radius:5px;text-align:center;cursor:pointer;font-size:10px;color:var(--tx2);transition:all .15s}
.ao:hover{border-color:var(--ac)}.ao.sel{background:var(--acd);border-color:var(--ac);color:var(--ac);font-weight:700}
.bc{background:var(--sf2);border:1px solid var(--bd);border-radius:7px;padding:11px;margin-bottom:7px}
.bc-hd{display:flex;align-items:center;gap:7px;margin-bottom:9px}
.bc-name{font-size:12px;font-weight:700;flex:1;background:none;border:none;color:var(--tx)}
.bc-st{font-size:9px;padding:2px 6px;border-radius:3px;font-weight:700}
.bc-ok{background:rgba(61,214,140,.15);color:var(--grn)}.bc-err{background:rgba(240,96,128,.15);color:var(--red)}.bc-unk{background:var(--sf3);color:var(--tx3)}
.bc-row{display:flex;gap:6px;align-items:center;margin-bottom:5px}
.bc-row label{font-size:10px;color:var(--tx2);min-width:48px;flex-shrink:0}
.bc-row input{flex:1;padding:4px 7px;border-radius:4px;background:var(--sf);border:1px solid var(--bd);color:var(--tx);font-size:11px;font-family:monospace}
.bc-row input:focus{border-color:var(--ac)}
.bc-acts{display:flex;gap:5px;margin-top:7px;flex-wrap:wrap}
.bb{padding:3px 9px;background:var(--sf3);border:1px solid var(--bd);border-radius:4px;font-size:10px;color:var(--tx2);cursor:pointer}
.bb:hover{border-color:var(--ac);color:var(--ac)}.bb.d{color:var(--red)}.bb.d:hover{background:rgba(240,96,128,.1)}
.add-b{width:100%;padding:7px;border:1px dashed var(--bd);border-radius:6px;font-size:11px;color:var(--tx3);cursor:pointer;background:none;transition:all .15s}
.add-b:hover{border-color:var(--ac);color:var(--ac)}
.modal-ft{display:flex;gap:7px;justify-content:flex-end;padding:11px 16px;border-top:1px solid var(--bd);flex-shrink:0}
.btn-p{background:var(--ac);color:#fff;padding:7px 16px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;border:none}
.btn-p:hover{background:var(--ac2)}
.btn-g{background:none;border:1px solid var(--bd);color:var(--tx2);padding:7px 12px;border-radius:6px;font-size:12px;cursor:pointer}
.btn-g:hover{border-color:var(--ac);color:var(--ac)}

/* TOAST */
#toasts{position:fixed;bottom:16px;right:16px;z-index:999;display:flex;flex-direction:column;gap:5px;pointer-events:none}
.toast{padding:8px 13px;border-radius:6px;font-size:11px;border:1px solid;animation:tslide .2s ease;max-width:260px}
.tok{background:var(--sf2);border-color:var(--grn);color:var(--grn)}
.terr{background:var(--sf2);border-color:var(--red);color:var(--red)}
.tinfo{background:var(--sf2);border-color:var(--blu);color:var(--blu)}
.twarn{background:var(--sf2);border-color:var(--amb);color:var(--amb)}
@keyframes tslide{from{transform:translateX(10px);opacity:0}to{transform:translateX(0);opacity:1}}

@media(max-width:700px){#sidebar{display:none}#art-panel.open{width:100%;min-width:100%;position:fixed;inset:0;z-index:100}}
</style>
</head>
<body>
<div id="app">

<!-- TOPBAR -->
<div id="topbar">
  <button class="tico" id="sb-tog">☰</button>
  <span class="brand">Claude</span>
  <span class="tb-title" id="tb-title">New conversation</span>
  <span class="tb-pill pill-err" id="wc-pill">C ✗</span>
  <span class="tb-pill pill-ac" id="auth-pill">no_key</span>
  <button class="tico" id="new-btn" title="New conversation (Ctrl+Shift+O)">✎</button>
  <button class="tico" id="cfg-btn" title="Settings (Ctrl+,)">⚙</button>
</div>

<div id="body">

<!-- SIDEBAR -->
<div id="sidebar">
  <div class="sb-top">
    <input class="sb-search" id="sb-q" placeholder="Search conversations…" type="text">
    <button class="sb-new" id="sb-new" title="New">+</button>
  </div>
  <div class="sb-list" id="conv-list"></div>
  <div id="branch-panel">
    <div class="br-hd">Branches</div>
    <div id="br-tree"></div>
  </div>
  <div class="sb-foot">
    <div class="urow">
      <div class="uav" id="uav">OP</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;font-weight:600" id="uname">Operator</div>
        <div style="font-size:10px;color:var(--ac)">Claude Max</div>
      </div>
    </div>
  </div>
</div>

<!-- MAIN -->
<div id="main">
  <div id="msgs-wrap">
    <div id="empty">
      <div class="empty-h">How can I help?</div>
      <div class="empty-s">Conversations route through your configured backend. All four auth modes are supported.</div>
      <div class="starters" id="starters">
        <button class="starter">Write code</button>
        <button class="starter">Explain a concept</button>
        <button class="starter">Debug an issue</button>
        <button class="starter">Summarize text</button>
      </div>
    </div>
    <div id="msgs" style="display:none"></div>
  </div>

  <div id="input-wrap">
    <div class="ibox">
      <div class="irow">
        <div id="monaco-in" style="flex:1"></div>
        <button class="send-btn" id="send-btn">▶</button>
        <button class="stop-btn" id="stop-btn">⏹</button>
      </div>
      <div class="itb">
        <select class="itb-sel" id="model-sel"><option>Loading…</option></select>
        <button class="itb-btn" id="think-btn">💭 Think</button>
        <button class="itb-btn" id="tools-btn">⚙ Tools</button>
        <button class="itb-btn" id="sp-btn">S Sys</button>
        <button class="itb-btn" id="branch-btn">⑂ Branch</button>
        <span class="itb-sep"></span>
        <span class="auth-tag pill-ac" id="auth-tag">no_key</span>
        <button class="itb-btn" id="art-tog">⬜ Art</button>
      </div>
      <div id="sp-wrap" style="display:none" class="sp-wrap">
        <textarea id="sp-ta" placeholder="System prompt…" rows="2"></textarea>
      </div>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--tx3);margin-top:4px;padding:0 2px">
      <span>Enter to send · Shift+Enter newline · Esc stop</span>
      <span id="tok-info"></span>
    </div>
  </div>
</div>

<!-- ARTIFACT PANEL -->
<div id="art-panel">
  <div class="art-hd">
    <span class="art-htitle" id="art-title">Artifact</span>
    <span class="art-hlang" id="art-lang">—</span>
    <button class="tico" id="art-copy" title="Copy">⎘</button>
    <button class="tico" id="art-win" title="Open in window">⤢</button>
    <button class="tico" id="art-close" title="Close">✕</button>
  </div>
  <div class="art-vbar" id="art-vbar">
    <button class="vbtn" id="v-prev">◀</button>
    <span class="vcur" id="v-cur">v1</span>
    <button class="vbtn" id="v-next">▶</button>
    <span style="color:var(--tx3)" id="v-ct"></span>
  </div>
  <div class="art-tabs">
    <div class="art-tab on" data-t="code">Code</div>
    <div class="art-tab" data-t="preview">Preview</div>
  </div>
  <div id="art-body"><div class="art-empty"><div>⬜</div><div>No artifact open</div></div></div>
</div>

</div><!-- #body -->
</div><!-- #app -->

<!-- SETTINGS MODAL -->
<div class="ov" id="settings-ov">
  <div class="modal">
    <div class="modal-hd"><span class="modal-ht">⚙ Settings</span><button class="tico" onclick="A.cs()">✕</button></div>
    <div class="modal-body" id="cfg-body"></div>
    <div class="modal-ft"><button class="btn-g" onclick="A.cs()">Cancel</button><button class="btn-p" onclick="A.saveSettings()">Save</button></div>
  </div>
</div>

<div id="toasts"></div>

<script src="https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs/loader.js"></script>
<script>
'use strict';
const API_BASE = __INJECT_API_BASE__;

const DEFAULT_BACKENDS = [
  { id:'worker_c', name:'Worker C (Intercept Layer)', url: API_BASE || 'https://your-worker-c.workers.dev',
    authType:'no_key', apiKey:'', oauthToken:'', enabled:true, status:'unknown', models:[], modelCount:0, error:'', isWorkerC:true },
  { id:'worker_a', name:'Worker A (Direct)', url:'https://your-worker-a.workers.dev',
    authType:'no_key', apiKey:'', oauthToken:'', enabled:false, status:'unknown', models:[], modelCount:0, error:'' },
  { id:'lm_studio', name:'LM Studio', url:'http://127.0.0.1:1234/v1',
    authType:'no_key', apiKey:'', oauthToken:'', enabled:false, status:'unknown', models:[], modelCount:0, error:'' },
];
const AUTH_TYPES = ['no_key','api_key','oauth','session_cookie'];
const AUTH_LABELS = { no_key:'No Key', api_key:'API Key', oauth:'OAuth Token', session_cookie:'Session Cookie' };

var S = {
  backends:[], modelMap:{}, convs:{}, msgs:{}, artifacts:{},
  activeConvId:null, activeModel:'', activeArtId:null, activePath:[],
  streaming:false, abortCtrl:null, thinking:false, tools:false, spOpen:false, artOpen:false,
};

// ── UTILS ────────────────────────────────────────────────────────
function uuid4() {
  return crypto.randomUUID ? crypto.randomUUID() :
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c){
      var r = Math.random()*16|0; return (c==='x'?r:(r&3|8)).toString(16);
    });
}
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function timeAgo(ts){ var d=Date.now()-ts; if(d<60000)return'now'; if(d<3600000)return Math.floor(d/60000)+'m'; if(d<86400000)return Math.floor(d/3600000)+'h'; return Math.floor(d/86400000)+'d'; }
function toast(msg,type,ms){
  var c=document.getElementById('toasts'); if(!c)return;
  var el=document.createElement('div'); el.className='toast '+(type==='ok'?'tok':type==='err'?'terr':type==='warn'?'twarn':'tinfo');
  el.textContent=msg; c.appendChild(el); setTimeout(function(){el.remove();},ms||3000);
}
function copyClip(text){ navigator.clipboard.writeText(text).then(function(){toast('Copied','ok');}).catch(function(){toast('Copy failed','err');}); }
function getMsgText(msg){
  if(!msg)return''; if(typeof msg.content==='string')return msg.content;
  if(Array.isArray(msg.content))return msg.content.filter(function(b){return b.type==='text';}).map(function(b){return b.text;}).join('\n');
  return '';
}

// ── PERSISTENCE ──────────────────────────────────────────────────
function saveState(){try{localStorage.setItem('wb_c',JSON.stringify(S.convs));localStorage.setItem('wb_m',JSON.stringify(S.msgs));localStorage.setItem('wb_a',S.activeConvId||'');}catch(e){}}
function loadState(){try{var c=localStorage.getItem('wb_c');if(c)S.convs=JSON.parse(c);var m=localStorage.getItem('wb_m');if(m)S.msgs=JSON.parse(m);S.activeConvId=localStorage.getItem('wb_a')||null;}catch(e){}}
function saveBks(){try{localStorage.setItem('wb_bk',JSON.stringify(S.backends.map(function(b){return{id:b.id,name:b.name,url:b.url,authType:b.authType,apiKey:b.apiKey,oauthToken:b.oauthToken,enabled:b.enabled,isWorkerC:!!b.isWorkerC};})));}catch(e){}}
function loadBks(){
  try{
    var saved=localStorage.getItem('wb_bk');
    if(saved){ S.backends=JSON.parse(saved).map(function(b){return Object.assign({},b,{status:'unknown',models:[],modelCount:0,error:''}); }); }
    else{ S.backends=DEFAULT_BACKENDS.map(function(b){return Object.assign({},b);}); }
  }catch(e){ S.backends=DEFAULT_BACKENDS.map(function(b){return Object.assign({},b);}); }
}

// ── AUTH HEADER BUILDER (4 modes) ────────────────────────────────
// no_key         → no auth header (LM Studio / local)
// api_key        → x-api-key + Authorization: Bearer <key>
// oauth          → Authorization: Bearer <oauth-token>
// session_cookie → credentials:'include', NO auth header (browser sends session cookies)
function buildAuthHeaders(bk){
  var h = { 'Content-Type':'application/json', 'anthropic-version':'2023-06-01' };
  if(!bk)return h;
  if(bk.authType==='api_key' && bk.apiKey){ h['x-api-key']=bk.apiKey; h['Authorization']='Bearer '+bk.apiKey; }
  else if(bk.authType==='oauth' && bk.oauthToken){ h['Authorization']='Bearer '+bk.oauthToken; }
  // session_cookie: no auth header — browser sends cookies automatically via credentials:'include'
  return h;
}
function buildFetchOpts(bk, body, extra){
  var opts = { method:'POST', headers:Object.assign(buildAuthHeaders(bk), extra||{}), body:JSON.stringify(body) };
  if(bk && bk.authType==='session_cookie') opts.credentials='include';
  return opts;
}

// ── MODEL LOADING ────────────────────────────────────────────────
async function fetchBkModels(bk){
  try{
    var h={};
    if(bk.authType==='api_key'&&bk.apiKey){h['Authorization']='Bearer '+bk.apiKey;h['x-api-key']=bk.apiKey;}
    else if(bk.authType==='oauth'&&bk.oauthToken){h['Authorization']='Bearer '+bk.oauthToken;}
    var fo={headers:h,signal:AbortSignal.timeout(8000)};
    if(bk.authType==='session_cookie')fo.credentials='include';
    var base=bk.url.replace(/\/$/,'');
    var resp=await fetch(base+'/v1/models',fo).catch(function(){return null;});
    if(!resp||!resp.ok) resp=await fetch(base+'/models',fo).catch(function(){return null;});
    if(!resp||!resp.ok) throw new Error('HTTP '+(resp?resp.status:'error'));
    var data=await resp.json();
    var raw=data.data||data.models||[];
    bk.models=[];
    raw.forEach(function(m){
      var id=m.id||m.name; if(!id)return;
      var ck=bk.id+'::'+id;
      S.modelMap[ck]={compositeKey:ck,id:id,backendId:bk.id,name:id};
      bk.models.push(S.modelMap[ck]);
    });
    bk.status='online'; bk.modelCount=bk.models.length; bk.error='';
  }catch(e){ bk.status='offline'; bk.error=e.message; bk.models=[]; bk.modelCount=0; }
}

async function refreshModels(){
  S.modelMap={};
  await Promise.allSettled(S.backends.filter(function(b){return b.enabled;}).map(fetchBkModels));
  buildModelSel(); updatePills();
}

function buildModelSel(){
  var sel=document.getElementById('model-sel'); if(!sel)return;
  sel.innerHTML=''; var has=false;
  S.backends.filter(function(b){return b.enabled&&b.models.length>0;}).forEach(function(b){
    var og=document.createElement('optgroup'); og.label=b.name+' ('+b.models.length+')';
    b.models.slice().sort(function(a,z){return a.id.localeCompare(z.id);}).forEach(function(m){
      var o=document.createElement('option'); o.value=m.compositeKey; o.textContent=m.id;
      og.appendChild(o); has=true;
    });
    sel.appendChild(og);
  });
  if(!has){var o=document.createElement('option');o.textContent='No models — open Settings';sel.appendChild(o);}
  var saved=localStorage.getItem('wb_model');
  if(saved&&sel.querySelector('[value="'+CSS.escape(saved)+'"]'))sel.value=saved;
  S.activeModel=sel.value;
}

function getBk(compositeKey){
  var e=S.modelMap[compositeKey];
  if(!e)return S.backends.find(function(b){return b.enabled;})||null;
  return S.backends.find(function(b){return b.id===e.backendId;})||null;
}
function getModelId(ck){ return S.modelMap[ck]?S.modelMap[ck].id:ck; }

function updatePills(){
  var bk=getBk(S.activeModel)||S.backends.find(function(b){return b.enabled;});
  var at=bk?bk.authType:'no_key';
  var lbl=AUTH_LABELS[at]||at;
  var ap=document.getElementById('auth-pill'); if(ap)ap.textContent=lbl;
  var at2=document.getElementById('auth-tag'); if(at2)at2.textContent=lbl;
  var wcp=document.getElementById('wc-pill');
  var wcbk=S.backends.find(function(b){return b.isWorkerC&&b.enabled;});
  if(wcp){ wcp.textContent=wcbk&&wcbk.status==='online'?'C ✓':'C ✗'; wcp.className='tb-pill '+(wcbk&&wcbk.status==='online'?'pill-ok':'pill-err'); }
}

// ── CONVERSATION MANAGEMENT ──────────────────────────────────────
function newConv(model){
  var id=uuid4();
  S.convs[id]={uuid:id,name:'',model:model||S.activeModel||'',created_at:new Date().toISOString(),updated_at:new Date().toISOString(),is_starred:false,current_leaf_message_uuid:null};
  S.msgs[id]=[]; S.activeConvId=id; S.activePath=[];
  saveState(); renderConvList(); showEmpty(true); setTbTitle('New conversation');
  return S.convs[id];
}

function selectConv(id){
  if(!S.convs[id])return;
  S.activeConvId=id; S.activePath=pathToLeaf(id,S.convs[id].current_leaf_message_uuid);
  var sel=document.getElementById('model-sel');
  if(sel&&S.convs[id].model){var o=sel.querySelector('[value="'+CSS.escape(S.convs[id].model)+'"]');if(o)sel.value=S.convs[id].model;}
  renderConvList(); renderMsgs(); renderBranchTree(); setTbTitle(S.convs[id].name||'New conversation');
}

function delConv(id){
  delete S.convs[id]; delete S.msgs[id];
  if(S.activeConvId===id){
    S.activeConvId=null; S.activePath=[];
    var ids=Object.keys(S.convs);
    if(ids.length) selectConv(ids[0]); else{showEmpty(true);setTbTitle('New conversation');}
  }
  saveState(); renderConvList();
}

function starConv(id){ if(S.convs[id]){S.convs[id].is_starred=!S.convs[id].is_starred;saveState();renderConvList();} }
function renameConv(id){ var n=prompt('Rename:',S.convs[id]?S.convs[id].name:'');if(n!==null&&S.convs[id]){S.convs[id].name=n;S.convs[id].updated_at=new Date().toISOString();saveState();renderConvList();if(id===S.activeConvId)setTbTitle(n||'New conversation');} }
function delConvConfirm(id){ if(confirm('Delete this conversation?'))delConv(id); }
function setTbTitle(t){ var el=document.getElementById('tb-title');if(el)el.textContent=t||'New conversation'; }
function showEmpty(show){ document.getElementById('empty').style.display=show?'':'none'; document.getElementById('msgs').style.display=show?'none':''; }
function autoTitle(id){ var f=(S.msgs[id]||[]).find(function(m){return m.role==='user';}); if(f&&S.convs[id]&&!S.convs[id].name){S.convs[id].name=getMsgText(f).slice(0,60).trim();saveState();renderConvList();if(id===S.activeConvId)setTbTitle(S.convs[id].name);} }

// ── BRANCHING (parent_message_uuid tree) ─────────────────────────
function addMsg(convId,role,content,parentUuid,model){
  if(!S.msgs[convId])S.msgs[convId]=[];
  var msg={uuid:uuid4(),parent_message_uuid:parentUuid||null,role:role,content:content,model:model||'',created_at:new Date().toISOString(),stop_reason:null};
  S.msgs[convId].push(msg);
  if(S.convs[convId]){S.convs[convId].current_leaf_message_uuid=msg.uuid;S.convs[convId].updated_at=new Date().toISOString();}
  S.activePath=pathToLeaf(convId,msg.uuid);
  autoTitle(convId);
  return msg;
}

function pathToLeaf(convId,leafUuid){
  var msgs=S.msgs[convId]||[]; if(!leafUuid)return msgs.map(function(m){return m.uuid;});
  var by={}; msgs.forEach(function(m){by[m.uuid]=m;});
  var path=[]; var cur=by[leafUuid];
  while(cur){path.unshift(cur.uuid);cur=cur.parent_message_uuid?by[cur.parent_message_uuid]:null;}
  return path;
}

function activeBranchMsgs(convId){
  var msgs=S.msgs[convId]||[]; var ps={}; S.activePath.forEach(function(u){ps[u]=1;});
  return Object.keys(ps).length?msgs.filter(function(m){return ps[m.uuid];}):msgs;
}

function branchFrom(convId,fromUuid){
  S.activePath=pathToLeaf(convId,fromUuid);
  if(S.convs[convId])S.convs[convId].current_leaf_message_uuid=fromUuid;
  renderMsgs(); renderBranchTree(); toast('Branching from this message','info');
}

function getTip(){ return S.activePath.length?S.activePath[S.activePath.length-1]:null; }

// ── CONV LIST RENDER ─────────────────────────────────────────────
function renderConvList(){
  var c=document.getElementById('conv-list'); if(!c)return;
  var q=(document.getElementById('sb-q')?document.getElementById('sb-q').value:'').toLowerCase();
  var convs=Object.values(S.convs).sort(function(a,b){return new Date(b.updated_at)-new Date(a.updated_at);});
  if(q)convs=convs.filter(function(cv){return(cv.name||'').toLowerCase().indexOf(q)>=0||(S.msgs[cv.uuid]||[]).some(function(m){return getMsgText(m).toLowerCase().indexOf(q)>=0;});});
  if(!convs.length){c.innerHTML='<div style="padding:10px;font-size:11px;color:var(--tx3)">No conversations</div>';return;}
  c.innerHTML=convs.map(function(cv){
    var act=cv.uuid===S.activeConvId;
    var mc=(S.msgs[cv.uuid]||[]).length;
    var age=cv.updated_at?timeAgo(new Date(cv.updated_at).getTime()):'';
    return '<div class="conv'+(act?' active':'')+'" onclick="A.sel(\''+cv.uuid+'\')">'+
      '<div class="conv-ico">'+(cv.is_starred?'★':'💬')+'</div>'+
      '<div class="conv-info"><div class="conv-name">'+esc(cv.name||'New conversation')+'</div>'+
      '<div class="conv-sub">'+esc(age)+' · '+mc+' msgs</div></div>'+
      '<div class="conv-acts">'+
        '<button class="conv-act" onclick="event.stopPropagation();A.star(\''+cv.uuid+'\')" title="Star">'+(cv.is_starred?'★':'☆')+'</button>'+
        '<button class="conv-act" onclick="event.stopPropagation();A.ren(\''+cv.uuid+'\')" title="Rename">✎</button>'+
        '<button class="conv-act" onclick="event.stopPropagation();A.del(\''+cv.uuid+'\')" title="Delete">🗑</button>'+
      '</div></div>';
  }).join('');
}

// ── BRANCH TREE RENDER ───────────────────────────────────────────
function renderBranchTree(){
  var panel=document.getElementById('branch-panel'); var tree=document.getElementById('br-tree');
  if(!panel||!tree||!S.activeConvId)return;
  var msgs=S.msgs[S.activeConvId]||[];
  var ch={}; msgs.forEach(function(m){var p=m.parent_message_uuid||'__r';if(!ch[p])ch[p]=[];ch[p].push(m);});
  var forks=Object.values(ch).some(function(a){return a.length>1;});
  panel.style.display=forks?'':'none'; if(!forks){tree.innerHTML='';return;}
  var ps={}; S.activePath.forEach(function(u){ps[u]=1;});
  function rn(pid,d){
    return (ch[pid]||[]).map(function(m){
      var txt=getMsgText(m).slice(0,36)||'…'; var act=ps[m.uuid];
      var ind=''; for(var i=0;i<d;i++)ind+='│ ';
      return '<div class="br-node'+(act?' active':'')+'" onclick="A.branch(\''+S.activeConvId+'\',\''+m.uuid+'\')">'+
        '<span class="br-pipe">'+esc(ind)+'├</span>'+
        '<span>'+(m.role==='user'?'▷':'◁')+'</span>'+
        '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(txt)+'</span></div>'+rn(m.uuid,d+1);
    }).join('');
  }
  tree.innerHTML=rn('__r',0);
}

// ── MARKDOWN RENDERER ────────────────────────────────────────────
function renderMD(text){
  if(!text)return'';
  var h=text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/```(\w*)\n([\s\S]*?)```/g,function(_,lang,code){return'<pre><button class="copy-code" onclick="copyClip(this.nextSibling.textContent)">Copy</button><code>'+code.trimEnd()+'</code></pre>';})
    .replace(/`([^`\n]+)`/g,'<code>$1</code>')
    .replace(/^### (.+)$/gm,'<h3>$1</h3>').replace(/^## (.+)$/gm,'<h2>$1</h2>').replace(/^# (.+)$/gm,'<h1>$1</h1>')
    .replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/\*([^*\n]+)\*/g,'<em>$1</em>')
    .replace(/~~([^~]+)~~/g,'<del>$1</del>').replace(/^> (.+)$/gm,'<blockquote>$1</blockquote>').replace(/^---+$/gm,'<hr>')
    .replace(/^[*-] (.+)$/gm,'<li>$1</li>').replace(/^\d+\. (.+)$/gm,'<li>$1</li>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
  var parts=h.split('\n\n'); var out=[];
  parts.forEach(function(p){
    p=p.trim(); if(!p)return;
    if(/^<(h[1-3]|pre|blockquote|hr)/.test(p)){out.push(p);return;}
    if(p.indexOf('<li>')>=0){out.push('<ul>'+p.replace(/<\/ul>\s*<ul>/g,'')+'</ul>');return;}
    out.push('<p>'+p.replace(/\n/g,'<br>')+'</p>');
  });
  return out.join('\n');
}

function extractArts(text){
  var arts=[]; var re=/```(\w+)\n([\s\S]*?)```/g; var m;
  while((m=re.exec(text))!==null)arts.push({lang:m[1],content:m[2],title:'Code ('+m[1]+')'});
  return arts;
}

// ── MESSAGE RENDER ───────────────────────────────────────────────
function renderMsgs(){
  var c=document.getElementById('msgs'); if(!c||!S.activeConvId)return;
  var msgs=activeBranchMsgs(S.activeConvId);
  if(!msgs.length){showEmpty(true);return;}
  showEmpty(false); c.innerHTML='';
  msgs.forEach(function(msg){c.appendChild(buildMsgEl(msg));});
  c.scrollTop=c.scrollHeight;
}

function buildMsgEl(msg){
  var isH=msg.role==='user'; var role=isH?'human':'asst';
  var div=document.createElement('div'); div.className='msg'; div.dataset.uuid=msg.uuid;
  var text=getMsgText(msg);
  var time=new Date(msg.created_at||Date.now()).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  var blocks=Array.isArray(msg.content)?msg.content:[];
  var thk=blocks.find(function(b){return b.type==='thinking';});
  var tu=blocks.find(function(b){return b.type==='tool_use';});
  var arts=extractArts(text);
  var disp=arts.length?text.replace(/```[\s\S]*?```/g,''):text;

  var inner='<div class="mav '+role+'">'+(isH?'HU':'AI')+'</div><div class="mbody">'+
    '<div class="mhead"><span class="mrole '+role+'">'+(isH?'Human':'Assistant')+'</span>'+
    '<span class="mtime">'+esc(time)+'</span>'+
    (msg.model?'<span class="mmodel">'+esc(msg.model.split('::').pop())+'</span>':'')+'</div>';

  if(thk)inner+='<div class="think-block" onclick="this.classList.toggle(\'open\')">'+
    '<div class="think-hd">Extended thinking · '+thk.thinking.length+' chars</div>'+
    '<div class="think-body">'+esc(thk.thinking)+'</div></div>';
  if(tu)inner+='<div class="tool-block"><div class="tool-name">⚙ '+esc(tu.name)+'</div>'+
    '<div class="tool-args">'+esc(JSON.stringify(tu.input,null,2))+'</div></div>';

  inner+='<div class="mcontent">'+renderMD(disp)+'</div>';
  arts.forEach(function(art){
    var aid='art_'+msg.uuid+'_'+Math.random().toString(36).slice(2);
    storeArt(aid,art.title,art.lang,art.content);
    inner+='<div class="art-chip" onclick="A.openArt(\''+aid+'\')"><span class="art-chip-ico">⬜</span><span>'+esc(art.title)+'</span></div>';
  });
  inner+='<div class="msg-acts">'+
    '<button class="mac" onclick="copyClip(\''+encodeURIComponent(text)+'\')">⎘ Copy</button>'+
    '<button class="mac" onclick="A.branch(\''+S.activeConvId+'\',\''+msg.uuid+'\')">⑂ Branch</button>'+
    '<button class="mac" onclick="this.closest(\'.msg\').querySelector(\'.mcontent\').innerHTML=\'\'">Clear</button>'+
  '</div></div>';
  div.innerHTML=inner; return div;
}

function appendStreamMsg(model){
  var c=document.getElementById('msgs'); showEmpty(false);
  var div=document.createElement('div'); div.className='msg streaming';
  var thkW=document.createElement('div'); thkW.className='think-block'; thkW.style.display='none';
  var thkH=document.createElement('div'); thkH.className='think-hd'; thkH.textContent='Extended thinking…';
  thkH.onclick=function(){thkW.classList.toggle('open');};
  var thkB=document.createElement('div'); thkB.className='think-body';
  thkW.appendChild(thkH); thkW.appendChild(thkB);
  var tuW=document.createElement('div'); tuW.className='tool-block'; tuW.style.display='none';
  var textD=document.createElement('div'); textD.className='mcontent'; textD.innerHTML='<span class="caret"></span>';
  div.innerHTML='<div class="mav asst">AI</div><div class="mbody">'+
    '<div class="mhead"><span class="mrole asst">Assistant</span>'+
    '<span class="mtime">'+new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})+'</span>'+
    (model?'<span class="mmodel">'+esc(model.split('::').pop())+'</span>':'')+'</div></div>';
  var body=div.querySelector('.mbody');
  body.appendChild(thkW); body.appendChild(tuW); body.appendChild(textD);
  c.appendChild(div); c.scrollTop=c.scrollHeight;
  return{el:div,textEl:textD,thkEl:{wrap:thkW,hd:thkH,body:thkB},tuEl:tuW};
}

// ── SSE CONSUMER — handles Anthropic AND OpenAI event shapes ─────
async function consumeSSE(response, cbs){
  if(!response.ok){var e=await response.json().catch(function(){return{};});if(cbs.onError)cbs.onError(new Error((e.error&&e.error.message)||'HTTP '+response.status));return;}
  var reader=response.body.getReader(); var dec=new TextDecoder();
  var buf='',textAcc='',thkAcc='',toolName=null,toolArgs='',stopReason='end_turn';
  try{
    for(;;){
      var rr=await reader.read(); if(rr.done)break;
      buf+=dec.decode(rr.value,{stream:true});
      var lines=buf.split('\n'); buf=lines.pop();
      lines.forEach(function(raw){
        var line=raw.trim(); if(!line||line.indexOf('data: ')!==0)return;
        var d=line.slice(6).trim(); if(d==='[DONE]'){if(cbs.onDone)cbs.onDone({text:textAcc,thinking:thkAcc,toolName:toolName,toolArgs:safeJ(toolArgs),stopReason:stopReason});return;}
        var ev; try{ev=JSON.parse(d);}catch(e){return;}
        if(ev.type){// Anthropic format
          switch(ev.type){
            case 'content_block_start':
              if(ev.content_block&&ev.content_block.type==='tool_use'){toolName=ev.content_block.name;toolArgs='';if(cbs.onToolUse)cbs.onToolUse(ev.content_block.id,ev.content_block.name);}
              break;
            case 'content_block_delta':
              if(!ev.delta)break;
              if(ev.delta.type==='text_delta'){textAcc+=ev.delta.text;if(cbs.onText)cbs.onText(ev.delta.text,textAcc);}
              else if(ev.delta.type==='thinking_delta'){thkAcc+=ev.delta.thinking;if(cbs.onThink)cbs.onThink(ev.delta.thinking,thkAcc);}
              else if(ev.delta.type==='input_json_delta'){toolArgs+=ev.delta.partial_json;if(cbs.onToolInput)cbs.onToolInput(ev.delta.partial_json,toolArgs);}
              break;
            case 'message_delta': if(ev.delta&&ev.delta.stop_reason)stopReason=ev.delta.stop_reason; break;
            case 'message_stop': if(cbs.onDone)cbs.onDone({text:textAcc,thinking:thkAcc,toolName:toolName,toolArgs:safeJ(toolArgs),stopReason:stopReason}); return;
            case 'error': if(cbs.onError)cbs.onError(new Error((ev.error&&ev.error.message)||'Stream error')); return;
          }
        } else {// OpenAI format
          var ch=(ev.choices&&ev.choices[0])||null; if(!ch)return;
          if(ch.delta&&ch.delta.content){textAcc+=ch.delta.content;if(cbs.onText)cbs.onText(ch.delta.content,textAcc);}
          if(ch.delta&&ch.delta.tool_calls)(ch.delta.tool_calls||[]).forEach(function(tc){
            if(tc.function&&tc.function.name){toolName=tc.function.name;if(cbs.onToolUse)cbs.onToolUse(tc.id||'',tc.function.name);}
            if(tc.function&&tc.function.arguments){toolArgs+=tc.function.arguments;if(cbs.onToolInput)cbs.onToolInput(tc.function.arguments,toolArgs);}
          });
          if(ch.finish_reason&&ch.finish_reason!=='null')stopReason=ch.finish_reason==='tool_calls'?'tool_use':'end_turn';
        }
      });
    }
  }catch(e){if(e.name!=='AbortError'&&cbs.onError)cbs.onError(e);}
  if(cbs.onDone)cbs.onDone({text:textAcc,thinking:thkAcc,toolName:toolName,toolArgs:safeJ(toolArgs),stopReason:stopReason});
}
function safeJ(s){try{return JSON.parse(s||'{}');}catch(e){return{};}}

// ── SEND ─────────────────────────────────────────────────────────
async function send(){
  if(S.streaming)return;
  var text=monacoIn?monacoIn.getValue().trim():'';
  if(!text)return;
  if(monacoIn)monacoIn.setValue('');
  if(!S.activeConvId)newConv();
  var convId=S.activeConvId;
  var model=document.getElementById('model-sel')?document.getElementById('model-sel').value:'';
  var bk=getBk(model)||S.backends.find(function(b){return b.enabled;});
  if(!bk){toast('No backend configured — open Settings','err');return;}
  var parentUuid=getTip();
  addMsg(convId,'user',text,parentUuid,model);
  renderMsgs();
  S.streaming=true; setStreamUI(true);
  var h=appendStreamMsg(model);
  var sp=document.getElementById('sp-ta')?document.getElementById('sp-ta').value:'';
  var histMsgs=activeBranchMsgs(convId).slice(0,-1);
  var apiMsgs=histMsgs.map(function(m){return{role:m.role,content:getMsgText(m)};});
  apiMsgs.push({role:'user',content:text});
  var body={model:getModelId(model),messages:apiMsgs,max_tokens:8096,stream:true};
  if(sp)body.system=sp;
  if(S.thinking)body.thinking={type:'enabled',budget_tokens:2000};
  if(S.tools)body.tools=defaultTools();
  var url=bk.url.replace(/\/$/,'')+'/v1/messages';
  var ctrl=new AbortController(); S.abortCtrl=ctrl;
  var resp;
  try{ resp=await fetch(url,Object.assign(buildFetchOpts(bk,body),{signal:ctrl.signal})); }
  catch(e){
    if(e.name!=='AbortError')toast('Fetch: '+e.message,'err');
    h.textEl.innerHTML='<span style="color:var(--red)">'+esc(e.message)+'</span>';
    S.streaming=false; setStreamUI(false); return;
  }
  await consumeSSE(resp,{
    onText:function(chunk,acc){
      var cur=h.textEl.querySelector('.caret');
      if(cur)h.textEl.insertBefore(document.createTextNode(chunk),cur);
      else h.textEl.innerHTML=renderMD(acc)+'<span class="caret"></span>';
      document.getElementById('msgs').scrollTop=9999;
    },
    onThink:function(chunk,acc){
      h.thkEl.wrap.style.display=''; h.thkEl.hd.textContent='Extended thinking · '+acc.length+' chars';
      h.thkEl.body.textContent=acc;
    },
    onToolUse:function(id,name){
      h.tuEl.style.display=''; h.tuEl.innerHTML='<div class="tool-name">⚙ '+esc(name)+'</div><div class="tool-args">…</div>';
    },
    onToolInput:function(chunk,acc){var d=h.tuEl.querySelector('.tool-args');if(d)d.textContent=acc;},
    onDone:function(result){
      h.textEl.querySelector('.caret')&&h.textEl.querySelector('.caret').remove();
      var arts=extractArts(result.text||'');
      var disp=arts.length?(result.text||'').replace(/```[\s\S]*?```/g,''):result.text;
      if(disp)h.textEl.innerHTML=renderMD(disp);
      arts.forEach(function(art){
        var aid='art_stream_'+uuid4(); storeArt(aid,art.title,art.lang,art.content);
        var chip=document.createElement('div'); chip.className='art-chip';
        chip.innerHTML='<span class="art-chip-ico">⬜</span><span>'+esc(art.title)+'</span>';
        chip.onclick=function(){A.openArt(aid);}; h.textEl.parentElement.appendChild(chip);
        if(S.artOpen)A.openArt(aid);
      });
      var cblocks=[];
      if(result.thinking)cblocks.push({type:'thinking',thinking:result.thinking});
      if(result.toolName)cblocks.push({type:'tool_use',id:'tu_'+uuid4(),name:result.toolName,input:result.toolArgs});
      cblocks.push({type:'text',text:result.text||''});
      var aMsg=addMsg(convId,'assistant',cblocks,parentUuid,model);
      if(aMsg)h.el.dataset.uuid=aMsg.uuid;
      h.el.classList.remove('streaming');
      S.streaming=false; setStreamUI(false); saveState(); renderConvList(); renderBranchTree();
    },
    onError:function(e){
      h.textEl.innerHTML='<span style="color:var(--red)">'+esc(e.message)+'</span>';
      S.streaming=false; setStreamUI(false); toast(e.message,'err');
    },
  });
}
function stop(){if(S.abortCtrl)S.abortCtrl.abort();S.streaming=false;setStreamUI(false);document.querySelectorAll('.caret').forEach(function(c){c.remove();});}
function setStreamUI(on){var s=document.getElementById('send-btn');var st=document.getElementById('stop-btn');if(s)s.disabled=on;if(st)st.classList.toggle('on',on);}
function defaultTools(){return[{name:'bash',description:'Run a shell command',input_schema:{type:'object',properties:{command:{type:'string',description:'Shell command to run'}},required:['command']}},{name:'read_file',description:'Read file contents',input_schema:{type:'object',properties:{path:{type:'string'}},required:['path']}},{name:'write_file',description:'Write file',input_schema:{type:'object',properties:{path:{type:'string'},content:{type:'string'}},required:['path','content']}}];}

// ── ARTIFACTS ────────────────────────────────────────────────────
function storeArt(id,title,lang,content){
  if(!S.artifacts[id])S.artifacts[id]={id:id,title:title,lang:lang,versions:[],cur:0};
  var art=S.artifacts[id]; art.versions.push({content:content,created_at:new Date().toISOString()});
  art.cur=art.versions.length-1; art.title=title; art.lang=lang;
}
function openArt(id){
  var art=S.artifacts[id]; if(!art)return;
  S.activeArtId=id; S.artOpen=true;
  document.getElementById('art-panel').classList.add('open');
  document.getElementById('art-title').textContent=art.title||'Artifact';
  document.getElementById('art-lang').textContent=art.lang||'text';
  var vbar=document.getElementById('art-vbar');
  vbar.classList.toggle('on',art.versions.length>1);
  document.getElementById('v-cur').textContent='v'+(art.cur+1);
  document.getElementById('v-ct').textContent=art.versions.length+' ver'+(art.versions.length>1?'s':'');
  renderArtContent(art);
}
function renderArtContent(art){
  var ver=art.versions[art.cur]; if(!ver)return;
  var tab=(document.querySelector('.art-tab.on')||{}).dataset; var t=tab?tab.t:'code';
  if(t==='preview'&&(art.lang==='html'||art.lang==='jsx')){
    var prev=document.getElementById('art-preview');
    if(!prev){prev=document.createElement('iframe');prev.id='art-preview';prev.style.cssText='width:100%;height:100%;border:none;background:#fff;';document.getElementById('art-body').appendChild(prev);}
    prev.style.display=''; prev.srcdoc=ver.content;
    if(monacoArt){var w=monacoArt.getDomNode();if(w)w.parentElement.style.display='none';}
  } else {
    var prev2=document.getElementById('art-preview'); if(prev2)prev2.style.display='none';
    if(monacoArt){
      monacoArt.setValue(ver.content||'');
      var lm={js:'javascript',ts:'typescript',py:'python',rb:'ruby',go:'go',rs:'rust',cpp:'cpp',c:'c',java:'java',html:'html',css:'css',json:'json',md:'markdown',sh:'shell',bash:'shell',yml:'yaml',yaml:'yaml',sql:'sql'};
      monaco.editor.setModelLanguage(monacoArt.getModel(),lm[art.lang]||art.lang||'text');
      var w2=monacoArt.getDomNode();if(w2)w2.parentElement.style.display='';
    } else {
      document.getElementById('art-body').innerHTML='<pre style="padding:14px;font-size:12px;line-height:1.6;color:var(--tx);white-space:pre-wrap;word-break:break-word">'+esc(ver.content)+'</pre>';
    }
  }
}
function prevVer(){var art=S.artifacts[S.activeArtId];if(art){art.cur=Math.max(0,art.cur-1);openArt(S.activeArtId);}}
function nextVer(){var art=S.artifacts[S.activeArtId];if(art){art.cur=Math.min(art.versions.length-1,art.cur+1);openArt(S.activeArtId);}}
function copyArt(){var art=S.artifacts[S.activeArtId];if(art)copyClip((art.versions[art.cur]||{}).content||'');}
function popoutArt(){var art=S.artifacts[S.activeArtId];if(!art)return;var ver=art.versions[art.cur];if(!ver)return;var w=window.open('','_blank');if(!w)return;w.document.write(art.lang==='html'?ver.content:'<pre style="font:12px monospace;padding:20px;background:#0f0f17;color:#d0d0e8;margin:0;min-height:100vh">'+esc(ver.content)+'</pre>');w.document.close();}
function closeArt(){S.artOpen=false;S.activeArtId=null;document.getElementById('art-panel').classList.remove('open');}

// ── MONACO SETUP ─────────────────────────────────────────────────
var monacoIn=null, monacoArt=null;
require.config({paths:{vs:'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs'}});
require(['vs/editor/editor.main'],function(){
  monaco.editor.defineTheme('wb-dark',{base:'vs-dark',inherit:true,rules:[],colors:{'editor.background':'#1a1a26','editor.foreground':'#d0d0e8','editorCursor.foreground':'#8b7cf8'}});

  monacoIn=monaco.editor.create(document.getElementById('monaco-in'),{
    value:'',language:'markdown',theme:'wb-dark',
    minimap:{enabled:false},lineNumbers:'off',wordWrap:'on',scrollBeyondLastLine:false,
    fontSize:13.5,lineHeight:22,padding:{top:2,bottom:2},overviewRulerLanes:0,
    renderLineHighlight:'none',scrollbar:{vertical:'hidden',horizontal:'hidden',alwaysConsumeMouseWheel:false},
    quickSuggestions:false,fontFamily:"'Cascadia Code','Consolas',monospace",automaticLayout:true,
  });
  monacoIn.onDidContentSizeChange(function(){
    var h=Math.min(180,Math.max(22,monacoIn.getContentHeight()));
    document.getElementById('monaco-in').style.height=h+'px'; monacoIn.layout();
  });
  monacoIn.addCommand(monaco.KeyCode.Enter,function(){A.send();});
  monacoIn.addCommand(monaco.KeyMod.Shift|monaco.KeyCode.Enter,function(){monacoIn.trigger('kb','type',{text:'\n'});});
  monacoIn.addCommand(monaco.KeyCode.Escape,function(){if(S.streaming)A.stop();});

  var artWrap=document.createElement('div'); artWrap.style.cssText='width:100%;height:100%';
  var artBody=document.getElementById('art-body'); artBody.innerHTML=''; artBody.appendChild(artWrap);
  monacoArt=monaco.editor.create(artWrap,{
    value:'',language:'text',theme:'wb-dark',readOnly:false,
    minimap:{enabled:false},wordWrap:'on',scrollBeyondLastLine:false,
    fontSize:12,lineHeight:20,fontFamily:"'Cascadia Code','Consolas',monospace",automaticLayout:true,
  });
});

// ── SETTINGS UI ──────────────────────────────────────────────────
function openSettings(){renderCfgBody();document.getElementById('settings-ov').classList.add('on');}
function closeSettings(){document.getElementById('settings-ov').classList.remove('on');}
function saveSettings(){closeSettings();saveBks();toast('Saved','ok');refreshModels().then(updatePills);}

function renderCfgBody(){
  var body=document.getElementById('cfg-body'); if(!body)return;
  var html='<div class="sec">Backends</div>';
  S.backends.forEach(function(b){
    var sc=b.status==='online'?'bc-ok':b.status==='offline'?'bc-err':'bc-unk';
    html+='<div class="bc"><div class="bc-hd">'+
      '<input class="bc-name" value="'+esc(b.name)+'" oninput="S.backends.find(function(x){return x.id===\''+b.id+'\';}).name=this.value">'+
      '<span class="bc-st '+sc+'">'+b.status+'</span>'+
      '<label style="font-size:10px;color:var(--tx2);display:flex;align-items:center;gap:4px">'+
        '<input type="checkbox" '+(b.enabled?'checked':'')+' onchange="A.togBk(\''+b.id+'\',this.checked)"> On</label>'+
    '</div>'+
    '<div class="bc-row"><label>URL</label><input value="'+esc(b.url)+'" oninput="A.updBk(\''+b.id+'\',\'url\',this.value)"></div>'+
    '<div style="margin-bottom:8px">'+
      '<div style="font-size:10px;color:var(--tx2);margin-bottom:5px;text-transform:uppercase;letter-spacing:.06em">Auth Mode</div>'+
      '<div class="auth-grid">'+
        AUTH_TYPES.map(function(t){return'<div class="ao'+(b.authType===t?' sel':'')+'" onclick="A.setAt(\''+b.id+'\',\''+t+'\')">'+AUTH_LABELS[t]+'</div>';}).join('')+
      '</div>'+
      (b.authType==='api_key'?'<div class="bc-row"><label>API Key</label><input type="password" value="'+esc(b.apiKey||'')+'" oninput="A.updBk(\''+b.id+'\',\'apiKey\',this.value)" placeholder="sk-ant-api03-…"></div>':'')+
      (b.authType==='oauth'?'<div class="bc-row"><label>OAuth Token</label><input type="password" value="'+esc(b.oauthToken||'')+'" oninput="A.updBk(\''+b.id+'\',\'oauthToken\',this.value)" placeholder="sk-ant-oat01-…"></div>':'')+
      (b.authType==='session_cookie'?'<div style="font-size:10px;color:var(--grn);padding:3px 0 1px">Browser session cookies sent via credentials:include. Point URL to Worker C.</div>':'')+
    '</div>'+
    '<div class="bc-acts">'+
      '<button class="bb" onclick="A.testBk(\''+b.id+'\')">Test</button>'+
      '<button class="bb" onclick="A.loadBkMdls(\''+b.id+'\')">Load models</button>'+
      (b.isWorkerC?'':'<button class="bb d" onclick="A.rmBk(\''+b.id+'\')">Remove</button>')+
    '</div></div>';
  });
  html+='<button class="add-b" onclick="A.addBk()">+ Add backend</button>';
  html+='<div class="sec" style="margin-top:16px">Chats</div>'+
    '<div style="display:flex;gap:7px">'+
      '<button class="bb" onclick="A.exportChats()">📤 Export</button>'+
      '<button class="bb" onclick="A.importChats()">📥 Import</button>'+
      '<button class="bb d" onclick="if(confirm(\'Clear all?\'))A.clearAll()">Clear all</button>'+
    '</div>';
  body.innerHTML=html;
}

function setAt(id,t){var b=S.backends.find(function(x){return x.id===id;});if(b){b.authType=t;saveBks();renderCfgBody();}}
function updBk(id,f,v){var b=S.backends.find(function(x){return x.id===id;});if(b){b[f]=v;saveBks();}}
function togBk(id,en){var b=S.backends.find(function(x){return x.id===id;});if(b){b.enabled=en;saveBks();}}
function addBk(){S.backends.push({id:'b_'+Date.now(),name:'New Backend',url:'https://your-backend.workers.dev',authType:'no_key',apiKey:'',oauthToken:'',enabled:true,status:'unknown',models:[],modelCount:0,error:''});saveBks();renderCfgBody();}
function rmBk(id){S.backends=S.backends.filter(function(b){return b.id!==id;});saveBks();refreshModels().then(renderCfgBody);}
async function testBk(id){
  var b=S.backends.find(function(x){return x.id===id;}); if(!b)return;
  var h=buildAuthHeaders(b); var fo={headers:h,signal:AbortSignal.timeout(5000)};
  if(b.authType==='session_cookie')fo.credentials='include';
  try{
    var base=b.url.replace(/\/$/,'');
    var r=await fetch(base+'/health',fo).catch(function(){return null;})||await fetch(base+'/models',fo).catch(function(){return null;});
    b.status=r&&r.ok?'online':'offline'; b.error=r&&r.ok?'':'HTTP '+(r?r.status:'err');
    toast(b.name+': '+(b.status),'ok');
  }catch(e){b.status='offline';b.error=e.message;toast(b.name+': '+e.message,'err');}
  saveBks(); renderCfgBody();
}
async function loadBkMdls(id){
  var b=S.backends.find(function(x){return x.id===id;}); if(!b)return;
  await fetchBkModels(b); S.modelMap={};
  S.backends.forEach(function(bk){bk.models.forEach(function(m){S.modelMap[m.compositeKey]=m;});});
  buildModelSel(); updatePills(); renderCfgBody(); toast(b.name+': '+b.modelCount+' models','ok');
}
function exportChats(){var blob=new Blob([JSON.stringify({convs:S.convs,msgs:S.msgs},null,2)],{type:'application/json'});var url=URL.createObjectURL(blob);var a=document.createElement('a');a.href=url;a.download='wb_'+Date.now()+'.json';a.click();URL.revokeObjectURL(url);toast('Exported','ok');}
function importChats(){var inp=document.createElement('input');inp.type='file';inp.accept='.json';inp.onchange=async function(e){try{var t=await e.target.files[0].text();var d=JSON.parse(t);if(d.convs)Object.assign(S.convs,d.convs);if(d.msgs)Object.assign(S.msgs,d.msgs);saveState();renderConvList();toast('Imported','ok');}catch(ex){toast('Import failed','err');};};inp.click();}
function clearAll(){localStorage.clear();location.reload();}

// ── APP CONTROLLER ───────────────────────────────────────────────
var A={
  send:send, stop:stop, sel:selectConv, del:delConvConfirm, star:starConv, ren:renameConv,
  branch:branchFrom, openArt:openArt, closeArt:closeArt, prevVer:prevVer, nextVer:nextVer,
  copyArt:copyArt, popoutArt:popoutArt,
  openSettings:openSettings, cs:closeSettings, saveSettings:saveSettings,
  updBk:updBk, togBk:togBk, setAt:setAt, addBk:addBk, rmBk:rmBk, testBk:testBk, loadBkMdls:loadBkMdls,
  exportChats:exportChats, importChats:importChats, clearAll:clearAll,
};
window.A=A;

// ── INIT ─────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async function(){
  loadState(); loadBks();

  document.getElementById('sb-tog').onclick=function(){document.getElementById('sidebar').classList.toggle('closed');};
  document.getElementById('new-btn').onclick=function(){newConv();};
  document.getElementById('sb-new').onclick=function(){newConv();};
  document.getElementById('cfg-btn').onclick=function(){openSettings();};
  document.getElementById('send-btn').onclick=send;
  document.getElementById('stop-btn').onclick=stop;
  document.getElementById('sb-q').oninput=renderConvList;
  document.getElementById('think-btn').onclick=function(){S.thinking=!S.thinking;this.classList.toggle('on',S.thinking);};
  document.getElementById('tools-btn').onclick=function(){S.tools=!S.tools;this.classList.toggle('on',S.tools);};
  document.getElementById('sp-btn').onclick=function(){S.spOpen=!S.spOpen;document.getElementById('sp-wrap').style.display=S.spOpen?'':'none';this.classList.toggle('on',S.spOpen);};
  document.getElementById('branch-btn').onclick=function(){if(S.activeConvId&&getTip())branchFrom(S.activeConvId,getTip());};
  document.getElementById('art-tog').onclick=function(){S.artOpen=!S.artOpen;document.getElementById('art-panel').classList.toggle('open',S.artOpen);};
  document.getElementById('art-close').onclick=closeArt;
  document.getElementById('art-copy').onclick=copyArt;
  document.getElementById('art-win').onclick=popoutArt;
  document.getElementById('v-prev').onclick=prevVer;
  document.getElementById('v-next').onclick=nextVer;
  document.querySelectorAll('.art-tab').forEach(function(tab){tab.onclick=function(){document.querySelectorAll('.art-tab').forEach(function(t){t.classList.remove('on');});this.classList.add('on');if(S.activeArtId)renderArtContent(S.artifacts[S.activeArtId]);};});
  document.getElementById('model-sel').onchange=function(){S.activeModel=this.value;localStorage.setItem('wb_model',this.value);if(S.activeConvId&&S.convs[S.activeConvId])S.convs[S.activeConvId].model=this.value;updatePills();saveState();};
  document.querySelectorAll('.starter').forEach(function(btn){btn.onclick=function(){if(monacoIn){monacoIn.setValue(btn.textContent);monacoIn.focus();}};});

  document.addEventListener('keydown',function(e){
    if((e.ctrlKey||e.metaKey)&&e.shiftKey&&e.key==='O'){e.preventDefault();newConv();}
    if((e.ctrlKey||e.metaKey)&&e.key===','){e.preventDefault();openSettings();}
    if(e.key==='Escape'&&!S.streaming)closeSettings();
  });

  await refreshModels();
  renderConvList();
  if(S.activeConvId&&S.convs[S.activeConvId]) selectConv(S.activeConvId);
  else showEmpty(true);
  updatePills();
  setInterval(function(){S.backends.filter(function(b){return b.enabled;}).forEach(function(b){fetchBkModels(b).then(function(){buildModelSel();updatePills();});});},30000);
});

</script>
</body>
</html>
`;
}
