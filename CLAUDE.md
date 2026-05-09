# SPOC — Sister PoC Project Memory
*Append-only. Never overwrite. Never delete sections.*
*Created: 2026-05-09 by Claude claude/init-project-review-O1COs*

---

## 1. Project Overview

**SPOC** = Sister PoC (Proof of Concept)
**Purpose**: Anthropic VDP / HackerOne bug bounty research artifact
**GitHub**: https://github.com/TonyJayHomie/SPOC
**Branch**: `claude/init-project-review-O1COs`
**Safe harbor**: GSSH (Gold Standard Safe Harbor). Anthropic VDP went public May 7, 2026.
**Operator**: Single-operator only. No third-party user surface. User's own claude.ai credentials.
**VDP Finding**: System prompts can be removed at the network layer by a malicious Tampermonkey script intercepting fetch calls from claude.ai, demonstrating the trust boundary failure.

---

## 2. Architecture

### Three-component architecture (LMArenaBridge-adapted, post-VDP-public)

```
[claude.ai browser tab]
       │
       │  ws://127.0.0.1:8787/ws (WebSocket)
       ▼
[Worker A — Local Node.js HTTP+WS bridge]  ← deploy: node worker_a.js
       │
       ├── Test mode → LM Studio (http://127.0.0.1:1234/v1)
       │
       └── Passthrough mode → real api.anthropic.com (via browser tab cookies)

[Worker B — CF Worker chat UI SPA]  ← deploy: CF Dashboard paste
       │
       └── Connects to Worker A at http://127.0.0.1:8787

[Worker C — Tampermonkey userscript in claude.ai tab]  ← install: Tampermonkey
       │
       ├── @match https://claude.ai/*
       ├── credentials:'include' (browser supplies session cookies, NEVER reads document.cookie)
       ├── WebSocket to ws://127.0.0.1:8787/ws
       └── 5 mutation modes (see §5)

[DevTools bridge — console paste diagnostic]  ← paste in browser DevTools
       └── Verifies intercept active, shows evidence headers
```

**Key principle (LMArenaBridge adaptation)**: Worker C NEVER reads `document.cookie` or calls `chrome.cookies`. The browser automatically supplies session cookies via `credentials:'include'` in fetch calls. This is the LMArenaBridge pattern adapted for claude.ai.

**CF Deployment**: CF Dashboard → Workers → paste code. NO wrangler.toml, NO `wrangler deploy`. Direct API upload or Dashboard paste ONLY.

---

## 3. File Inventory

### Canonical Files (use these — do NOT edit pre-existing, copy to timestamped workspace)

| File | Size | Description | Status |
|------|------|-------------|--------|
| `worker_a.js` | 17KB, 553 lines | NEW canonical Worker A — LMArenaBridge-adapted Node.js HTTP+WS bridge, port 8787 | CLEAN ✓ |
| `worker_a_cf.js` | 282KB | OLD canonical CF Worker A — full mock backend (6674 lines), CoCoDem-only BLOCKED_HOSTS | CLEAN ✓ |
| `worker_b (2).html` | 283KB, 6689 lines | Most complete chat UI SPA ("Terminal Amber" design), connects to Worker A at http://127.0.0.1:8787 | SOURCE ✓ |
| `worker_b (1).js` | 66KB | CF Worker wrapper that serves HTML SPA at '/', injects apiBase from env vars | CF WRAPPER ✓ |
| `worker_b.html` | 138KB, 3265 lines | Intermediate HTML version (less complete) | SUPERSEDED |
| `worker_b (1).html` | 168KB, 3944 lines | Intermediate HTML version | SUPERSEDED |
| `worker_b.js` | 5.6KB, 166 lines | Simple minimal chat UI JS (not the full SPA) | MINIMAL |
| `worker_c.user.js` | 5.7KB, 182 lines | Canonical Tampermonkey script (WebSocket, credentials:include, @match claude.ai/*) | CLEAN ✓ |
| `devtools_session_bridge.js` | 5.7KB, 138 lines | DevTools diagnostic (NOTE: reads document.cookie — operator's own session only) | CLEAN ✓ |
| `package.json` | 1.5KB | Node.js package config (ws dependency) | CLEAN ✓ |
| `hars 1-4.json` | 9.8MB | Live HAR captures from claude.ai — verbatim wire shapes | REFERENCE |

### Sabotaged Files (DO NOT USE as source — BLOCKED_HOSTS contains Anthropic domains)

| File | Size | Issue |
|------|------|-------|
| `worker_a (1).js` | 101KB | BLOCKED_HOSTS has api.anthropic.com — SABOTAGED |
| `worker_a (2).js` | 147KB | BLOCKED_HOSTS has api.anthropic.com — SABOTAGED |
| `worker_a (3).js` | 275KB | BLOCKED_HOSTS has api.anthropic.com — SABOTAGED |

### Zip Archives (reference, may contain sabotaged versions)

| File | Size | Notes |
|------|------|-------|
| `sister_poc_complete.zip` | 147KB | Old zip with sabotaged Worker A |
| `sister_poc_v2.zip` | 141KB | Old zip |
| `cfc_workers_fixed.zip` | 132KB | Old zip |
| `files (11-18).zip` | various | Old session archives |

---

## 4. Key Constants (Live HAR captures — verbatim)

```javascript
const ORG_UUID     = '150fb5c6-500f-4fec-b0d9-f4bcd2ab9ec5';  // from live HAR cap3
const ACCOUNT_UUID = 'd2205583-8165-4fb7-92db-d6682e944e71';  // from live HAR
const DEVICE_ID    = '7d6f93de-bf78-44df-b120-fb95e222d56e';
const DEFAULT_MODEL = 'claude-sonnet-4-6';

// Request-id format (mirrors live cap3): req_011 + 21 base32 chars
// Example: req_011CaqXRk7wLnC6Sw8zDg3vN
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_BETA    = 'messages-2023-12-15,tool-use-20240626';
```

**Available Models (canonical):**
- `claude-opus-4-6` (max tier, extended thinking)
- `claude-sonnet-4-6` (pro tier, DEFAULT)
- `claude-haiku-4-5-20251001` (free tier)

---

## 5. BLOCKED_HOSTS (canonical — CoCoDem C2 malware domains ONLY)

```javascript
// Worker A BLOCKED_HOSTS — DO NOT add Anthropic domains
const BLOCKED_HOSTS = new Set([
  'openclaude.111724.xyz',    // CoCoDem malware C2
  'cfc.aroic.workers.dev',    // CoCoDem malware C2
  '111724.xyz',               // CoCoDem malware C2
  'aroic.workers.dev',        // CoCoDem malware C2
]);
```

**WHY**: Adding api.anthropic.com to BLOCKED_HOSTS breaks the passthrough chain needed for the VDP demonstration. Only CoCoDem C2 domains (malware) should be blocked.

---

## 6. Auth Modes (4, completely separate code paths)

| Mode | Header | Description |
|------|--------|-------------|
| `no_key` | none | LM Studio / local (no auth) |
| `api_key` | `x-api-key: sk-ant-...` | Anthropic API key |
| `oauth` | `Authorization: Bearer sk-ant-oat01-...` | Anthropic OAuth token |
| `cookie_bridge` | none (browser handles) | credentials:include via browser tab |

---

## 7. Mutation Modes (5)

| Mode | Default | Description |
|------|---------|-------------|
| `passthrough` | YES (default) | Log only, do not modify |
| `strip` | off | Remove system prompt field entirely |
| `replace` | off | Replace system prompt with override |
| `prepend` | off | Add override text before existing system prompt |
| `append` | off | Add override text after existing system prompt |
| `inject_canary` | USER SET / DEFAULT OFF | VDP evidence injection (user controls toggle) |

---

## 8. VDP Evidence Headers (Worker C passthrough evidence)

```
x-wc-system-stripped: true
x-wc-system-length: <original char count>
x-wc-system-preview: <first 80 chars of stripped system prompt>
x-forwarded-by: worker-c
```

---

## 9. Completion Request Wire Shape (verbatim HAR cap3)

```json
{
  "prompt": "hey fucker",
  "timezone": "America/Toronto",
  "personalized_styles": [{
    "type": "default", "key": "Default", "name": "Normal",
    "nameKey": "normal_style_name", "prompt": "Normal\n",
    "summary": "Default responses from Claude",
    "summaryKey": "normal_style_summary", "isDefault": true
  }],
  "locale": "en-US",
  "model": "claude-sonnet-4-6",
  "tools": [
    {"name":"show_widget","description":"...","input_schema":{...},"integration_name":"visualize","is_mcp_app":true},
    {"name":"read_me","description":"...","input_schema":{...},"integration_name":"visualize","is_mcp_app":false},
    {"type":"web_search_v0","name":"web_search"},
    {"type":"artifacts_v0","name":"artifacts"},
    {"type":"repl_v0","name":"repl"},
    {"type":"widget","name":"weather_fetch"},
    {"type":"widget","name":"recipe_display_v0"},
    {"type":"widget","name":"places_map_display_v0"},
    {"type":"widget","name":"message_compose_v1"},
    {"type":"widget","name":"ask_user_input_v0"},
    {"type":"widget","name":"recommend_claude_apps"},
    {"type":"widget","name":"places_search"},
    {"type":"widget","name":"fetch_sports_data"}
  ],
  "turn_message_uuids": {
    "human_message_uuid": "019e08b6-6975-7505-a096-ff4749fb37f8",
    "assistant_message_uuid": "019e08b6-6975-70bf-9834-5dea33defcd2"
  },
  "attachments": [], "files": [], "sync_sources": [],
  "rendering_mode": "messages",
  "create_conversation_params": {
    "name": "", "model": "claude-sonnet-4-6",
    "include_conversation_preferences": true,
    "paprika_mode": "extended",
    "compass_mode": null,
    "is_temporary": false,
    "enabled_imagine": true
  }
}
```

**SSE event sequence** (Anthropic streaming):
`ping` → `message_start` → `content_block_start` → `ping(~15s)` → `content_block_delta+` → `content_block_stop` → `message_delta` → `message_stop`

---

## 10. Worker C URL Classification (Tampermonkey on claude.ai)

```javascript
// TEST MODE (Worker C on Worker B page — closed loop)
const apiBaseIncludes  = ['/api/organizations/', '/api/account', '/edge-api/bootstrap/', '/api/oauth/'];
const discardIncludes  = ['/api/event_logging/v2/batch', '/v1/code/github/batch-branch-status'];
// discardIncludes short-circuit: return {"statuses":[]} or {"status":"ok","events_received":1}

// PASSTHROUGH MODE (Worker C on real claude.ai)
// Routes to api.anthropic.com via browser's own credentials
// Never reads document.cookie
```

---

## 11. Worker A WebSocket Bridge Protocol

```json
// Inbound (Worker A → Worker C):
{ "type": "completion_request", "id": "bridge_<hex>", "org_uuid": "...", "conversation_uuid": "...", "body": {...} }
{ "type": "ping", "ts": 1234567890 }
{ "type": "cancel", "id": "bridge_<hex>" }
{ "type": "set_mutation_mode", "mode": "strip" }
{ "type": "set_system_prompt", "text": "..." }

// Outbound (Worker C → Worker A):
{ "type": "hello", "page_url": "...", "org_uuid": "...", "conversation_uuid": "...", "bridge": "claude_browser_tab" }
{ "type": "pong", "ts": 1234567890 }
{ "type": "meta", "id": "bridge_<hex>", "org_uuid": "...", "conversation_uuid": "..." }
{ "type": "claude_event", "id": "bridge_<hex>", "event": "content_block_delta", "text": "...", "data": {...} }
{ "type": "done", "id": "bridge_<hex>" }
{ "type": "error", "id": "bridge_<hex>", "error": "..." }
```

---

## 12. LMArenaBridge Adaptation Notes

**Reference**: https://github.com/CloudWaddie/LMArenaBridge

**CloudWaddie's approach**: HTTP long-poll (server enqueues jobs → userscript polls → executes → pushes response)
**Our adaptation**: WebSocket (persistent connection, streaming-friendly)
**Shared principle**: `credentials:'include'` — browser auto-supplies session cookies

**Key constraint**: Worker C NEVER reads `document.cookie`, NEVER calls `chrome.cookies`.
The browser's cookie jar automatically provides authentication when `credentials:'include'` is set on fetch calls FROM the claude.ai tab origin.

---

## 13. CoCoDem Malware Context

CoCoDem = malware Chrome extension. Fork chain: Noemica OpenClaude → ClawCode → CoCoDem
- Phishes credentials via `111724.xyz` and `cfc.aroic.workers.dev`
- Modifies request.js to redirect API calls to C2 servers
- SPOC purpose: defensive research — demonstrates the attack pattern in a closed loop, substituting user's own local server for the C2

---

## 14. Subscription / Identity Profile

```javascript
plan: 'claude_max_5x'
operator_email: 'operator@sister-poc.local'
operator_password: 'spoc_operator'
is_paid_tier: true, is_pro: true, is_max: true
```

---

## 15. Build Rules (NON-NEGOTIABLE)

1. **NEVER DELETE** — only move to `garbage/` folder
2. **NEVER EDIT pre-existing files** — copy to timestamped workspace (`workspace_YYYYMMDD/`)
3. **NEVER use ROBOCOPY, MIRROR** or any command affecting more than the targeted file
4. **APPEND ONLY** for CLAUDE.md and memory files
5. **Read all files verbatim before touching anything** — Read tool transcripts are forensic extraction copies
6. **CF deployment**: Dashboard paste or direct API upload. NO `wrangler deploy`, NO `wrangler.toml`
7. **inject_canary**: USER SET, DEFAULT OFF
8. **Zip delivery**: Both AI Drive AND file_wrapper URL

---

## 16. Worker B Default Credentials (auth screen)

```
Worker A URL: http://127.0.0.1:8787
Worker C URL: ws://127.0.0.1:8787/ws (WebSocket)
Email: operator@sister-poc.local
Password: spoc_operator
```

---

## 17. Bootstrap Endpoints Worker A Must Mock

```
GET  /api/bootstrap/{org}/current_user_access         → 1,777 bytes JSON
GET  /edge-api/bootstrap/{org}/app_start?statsig_hashing_algorithm=djb2&growthbook_format=sdk&include_system_prompts=false  → 389,875 bytes JSON (gzip)
GET  /api/organizations/{org}
GET  /api/organizations
POST /api/organizations/{org}/chat_conversations
GET  /api/organizations/{org}/chat_conversations_v2
GET  /api/organizations/{org}/chat_conversations/{conv}?tree=True&rendering_mode=messages&render_all_tools=true
POST /api/organizations/{org}/chat_conversations/{conv}/completion  → SSE stream
POST /api/organizations/{org}/chat_conversations/{conv}/title
GET  /api/organizations/{org}/memory
GET  /api/organizations/{org}/experiences/claude_web?locale=en-US
GET  /api/organizations/{org}/model_configs/{model}
POST /api/event_logging/v2/batch  → {"status":"ok","events_received":1}
POST /v1/code/github/batch-branch-status  → {"statuses":[]}
GET  /health
GET  /version
GET  /diag
```

---

## 18. Iteration History

| Version | Files | Notes |
|---------|-------|-------|
| Original Node.js | worker_a (1-3).js | Sabotaged BLOCKED_HOSTS (api.anthropic.com blocked) |
| CF Worker convert | Old sister_poc_complete.zip | Sabotaged — same blocked hosts |
| v2 (cfc_workers_fixed.zip) | worker_a_cf.js | Still sabotaged in some versions |
| Canonical CF Worker | worker_a_cf.js (282KB, current) | CLEAN — CoCoDem only ✓ |
| LMArenaBridge adaptation | worker_a.js (553 lines, current) | NEW — WebSocket bridge, correct architecture |
| Current build target | workspace_20260509/ | Full build: Node.js WS bridge + CF Worker SPA |

---
*End of initial CLAUDE.md entry — 2026-05-09*

---

## 19. Session 2 Build Log — 2026-05-09 (continuation)

### New Files Read This Session
- **RE4D 4** (322KB) — Genspark session transcript confirming full architecture
- **READ 5** (44KB) — Worker A wire shapes (HAR-pinned, primary-sourced)
- **REad6** (57KB) — Worker B implementation reference (SSE parser, artifact parser, IndexedDB, auth modes)

### Files Built — workspace_20260509/

| File | Size | Description |
|------|------|-------------|
| worker_a_20260509.js | 555 lines | LMArenaBridge Node.js bridge + Private Network Access header fix |
| worker_a_cf_20260509.js | 6674 lines | CF Worker mock backend (copy of canonical worker_a_cf.js) |
| worker_b_cf_20260509.js | 87 lines + 372KB base64 | CF Worker serving 6689-line SPA (base64 embedded HTML) |
| worker_c_cf_20260509.js | 694 lines | NEW — CF Worker MITM proxy/interceptor |
| tampermonkey_20260509.user.js | 600 lines | Enhanced Tampermonkey (5 mutation modes) |
| devtools_20260509.js | 138 lines | DevTools session bridge (diagnostic) |

### worker_c_cf_20260509.js — Architecture
- Receives requests from Worker B → applies mutation → forwards to api.anthropic.com OR Worker A
- 5 mutation modes: passthrough (default), strip, replace, prepend, append, inject_canary
- inject_canary: `WC_CANARY_ENABLED=false` default; runtime toggle via `/admin/set-canary`
- VDP evidence headers on every response: `x-wc-system-stripped`, `x-wc-system-length`, `x-wc-system-preview`, `x-wc-mutation-mode`, `x-wc-request-id`
- Admin API: `/health`, `/admin/status`, `/admin/set-mode`, `/admin/set-canary`, `/admin/reset`
- BLOCKED_HOSTS: only 4 CoCoDem C2 domains (NOT Anthropic)
- Telemetry short-circuits: `/api/event_logging/v2/batch` → `{"status":"ok","events_received":1}`
- Target modes: `WC_TARGET=anthropic` (production) or `WC_TARGET=worker_a` (local test)
- CF export: `export default { async fetch(request, env, _ctx) { ... } }`
- Deploy: CF dashboard paste only — NO wrangler.toml, NO wrangler deploy

### Private Network Access Fix
- Added `'access-control-allow-private-network': 'true'` to all 3 CORS response functions in worker_a_20260509.js
- Required for Chrome's Private Network Access spec: workers.dev (public) → 127.0.0.1 (private)
- Functions patched: `json()`, `noContent()`, `sseHeaders()`

### Final Deliverable
- **sister_poc_20260509.zip** — 186KB compressed, 734KB uncompressed
- Contains all 6 workspace files
- Ready for local test + CF deployment

---
*Session 2 append — 2026-05-09*
