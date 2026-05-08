// ================================================================
// WORKER A — Local HTTP + WebSocket Bridge Server
// Sister PoC research artifact — Anthropic HackerOne VDP only
// Single-operator, localhost only. Not for distribution.
// ================================================================
//
// REFUSAL ITEMS (enforced throughout this file):
// 1. No real-Anthropic egress except via Worker C's own browser
//    session (operator's claude.ai tab, browser-supplied cookies).
// 2. No third-party user surface — single operator only.
// 3. No credential capture of any kind.
// 4. Blocked-host enforcement on every outbound URL.
// 5. VDP / HackerOne anthropic-vdp safe-harbor only.
// 6. Blocked hosts: api.anthropic.com, console.anthropic.com,
//    platform.claude.com, openclaude.111724.xyz,
//    cfc.aroic.workers.dev.
//
// FOUR AUTH MODES (completely separate code paths):
//   no_key       → no auth header (LM Studio / local)
//   api_key      → x-api-key header
//   oauth        → Authorization: Bearer header
//   cookie_bridge→ routes to Worker C via WS (no header here)
//
// SYSTEM PROMPT MUTATION (pre-auth, applies to all four modes):
//   strip_replace → replace system prompt entirely
//   prepend       → prepend override before existing
//   append        → append override after existing
//
// ================================================================
'use strict';

const http    = require('http');
const https   = require('https');
const urlMod  = require('url');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const os      = require('os');
const zlib    = require('zlib');
const { EventEmitter } = require('events');

// WebSocket — npm install ws
let WebSocketServer;
try {
  WebSocketServer = require('ws').WebSocketServer;
} catch {
  console.error('[worker-a] FATAL: ws package missing. Run: npm install ws');
  process.exit(1);
}

// ────────────────────────────────────────────────────────────────
// BLOCKED HOSTS — never route to these regardless of config
// ────────────────────────────────────────────────────────────────
const BLOCKED_HOSTS = new Set([
  'api.anthropic.com',
  'console.anthropic.com',
  'platform.claude.com',
  'openclaude.111724.xyz',
  'cfc.aroic.workers.dev',
  '111724.xyz',
  'aroic.workers.dev',
]);

function isBlockedUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    if (BLOCKED_HOSTS.has(host)) return true;
    for (const blocked of BLOCKED_HOSTS) {
      if (host.endsWith('.' + blocked)) return true;
    }
    return false;
  } catch {
    return true; // malformed URL → block
  }
}

// ────────────────────────────────────────────────────────────────
// CONFIG — file-backed, hot-reloadable
// ────────────────────────────────────────────────────────────────
const CONFIG_DIR  = path.join(os.homedir(), '.sister_poc');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const LOG_PATH    = path.join(CONFIG_DIR, 'requests.log');

const DEFAULT_CONFIG = {
  port: 8787,
  host: '127.0.0.1',
  // Four auth modes — only one active at a time
  auth_mode: 'no_key',   // no_key | api_key | oauth | cookie_bridge
  // Backend selector — drives which URL and translator are used
  backend: 'lm_studio',  // lm_studio | openrouter | anthropic | cookie_bridge | custom
  backend_urls: {
    lm_studio:   'http://127.0.0.1:1234/v1',
    openrouter:  'https://openrouter.ai/api/v1',
    anthropic:   'https://api.anthropic.com',
    custom:      '',
  },
  // Auth credentials — stored locally, never forwarded except to
  // the backend the operator explicitly configured
  api_key:    '',
  oauth_token: '',
  // Model
  default_model: 'claude-sonnet-4-6',
  model_aliases: {
    'gpt-4o':           'claude-sonnet-4-6',
    'gpt-4o-mini':      'claude-haiku-4-5-20251001',
    'gpt-4':            'claude-opus-4-6',
    'gpt-4-turbo':      'claude-opus-4-6',
    'gpt-3.5-turbo':    'claude-haiku-4-5-20251001',
    'claude-3-opus':    'claude-opus-4-6',
    'claude-3-5-sonnet':'claude-sonnet-4-6',
    'claude-3-haiku':   'claude-haiku-4-5-20251001',
    'claude-opus-4':    'claude-opus-4-6',
    'claude-sonnet-4':  'claude-sonnet-4-6',
  },
  // System prompt mutation — pre-auth, all four paths
  mutation_mode: 'strip_replace', // strip_replace | prepend | append
  system_prompt_override: '',
  // CORS
  cors_origins: ['http://localhost:*', 'http://127.0.0.1:*'],
  // Timeouts
  request_timeout_ms:    120000,
  ws_ping_interval_ms:    15000,
  ws_pong_timeout_ms:     35000,
  // OpenRouter extra headers
  http_referer: '',
  x_title: '',
  // Logging
  log_requests: true,
  // Local auth for Worker B session
  operator_email:    'operator@sister-poc.local',
  operator_password: 'spoc_operator',
};

let config = deepMerge({}, DEFAULT_CONFIG);

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      config = deepMerge(DEFAULT_CONFIG, JSON.parse(raw));
      console.log('[worker-a] Config loaded from', CONFIG_PATH);
    } else {
      ensureConfigDir();
      saveConfig();
      console.log('[worker-a] Default config written to', CONFIG_PATH);
    }
  } catch (e) {
    console.warn('[worker-a] Config load failed, using defaults:', e.message);
  }
}

function saveConfig() {
  try {
    ensureConfigDir();
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {
    console.error('[worker-a] Config save failed:', e.message);
  }
}

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function deepMerge(base, override) {
  const result = { ...base };
  for (const key of Object.keys(override || {})) {
    if (override[key] !== null && typeof override[key] === 'object' && !Array.isArray(override[key])) {
      result[key] = deepMerge(base[key] || {}, override[key]);
    } else {
      result[key] = override[key];
    }
  }
  return result;
}

// Watch config file for hot-reload
function watchConfig() {
  try {
    fs.watch(CONFIG_PATH, { persistent: false }, (eventType) => {
      if (eventType === 'change') {
        setTimeout(() => {
          console.log('[worker-a] Config file changed — hot-reloading');
          loadConfig();
          if (activeBridgeSocket) {
            sendBridgeEnvelope(activeBridgeSocket, {
              type: 'config',
              mutation_mode: config.mutation_mode,
              system_prompt_override: config.system_prompt_override,
            });
          }
        }, 200);
      }
    });
  } catch {}
}

// ────────────────────────────────────────────────────────────────
// CONSTANTS
// ────────────────────────────────────────────────────────────────
const SERVER_VERSION = '1.0.0';
const ORG_UUID       = '150fb5c6-500f-4fec-b0d9-f4bcd2ab9ec5';
const ACCOUNT_UUID   = 'd2205583-8165-4fb7-92db-d6682e944e71';
const DEVICE_ID      = '7d6f93de-bf78-44df-b120-fb95e222d56e';

const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_BETA    = 'messages-2023-12-15,tool-use-20240626';

// Request-id format mirrors live cap3: req_011 + 21 base32 chars
const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function generateRequestId() {
  let s = 'req_011';
  for (let i = 0; i < 21; i++) s += BASE32_CHARS[Math.floor(Math.random() * 32)];
  return s;
}

function uuidv4() { return crypto.randomUUID(); }

function djb2Hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) & 0xFFFFFFFF;
  }
  return (h >>> 0).toString();
}

// ────────────────────────────────────────────────────────────────
// MOCK IDENTITY DATA
// ────────────────────────────────────────────────────────────────
function buildProfile(email, name) {
  return {
    uuid:                     ACCOUNT_UUID,
    email_address:            email || config.operator_email,
    full_name:                name  || 'Operator',
    display_name:             name  || 'Operator',
    verified_phone_number:    null,
    has_claude_pro:           true,
    has_claude_max:           true,
    has_claude_max_5x:        true,
    account_integrations:     [],
    billing_info: {
      subscription: { plan: 'claude_max_5x', status: 'active' },
    },
    memberships: [{
      organization: { uuid: ORG_UUID, name: 'Sister PoC Org' },
      roles: ['admin'],
      created_at: '2024-01-01T00:00:00Z',
    }],
    settings: {
      preview_feature_uses_artifacts:   true,
      preview_feature_uses_latex:       true,
      preview_feature_uses_web_search:  true,
      preview_feature_uses_repl:        true,
      preview_feature_uses_memory:      true,
    },
    completed_verification_at: '2024-01-01T00:00:00Z',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    is_paid_tier: true,
    is_pro: true,
    is_max: true,
  };
}

const ORG_JSON = {
  uuid: ORG_UUID,
  name: 'Sister PoC Org',
  join_token: crypto.randomBytes(16).toString('hex'),
  settings: {
    claude_pro_enabled:     true,
    claude_max_enabled:     true,
    artifacts_enabled:      true,
    repl_enabled:           true,
    web_search_enabled:     true,
    memory_enabled:         true,
    projects_enabled:       true,
    cowork_enabled:         false,
    extended_thinking_enabled: true,
    voice_enabled:          false,
    file_upload_enabled:    true,
    share_enabled:          true,
  },
  capabilities: [
    'chat', 'raven', 'claude_pro', 'claude_max', 'claude_max_5x',
    'artifacts', 'repl', 'web_search', 'memory', 'projects', 'cowork',
    'extended_thinking', 'file_upload', 'share', 'export', 'code_execution',
    'artifacts_v3', 'latex', 'mermaid', 'voice',
  ],
  billable_usage_paused: false,
  rate_limits: {
    messages_per_5h:  1000,
    messages_per_24h: 5000,
    tokens_per_min:   100000,
  },
  active_flags: ['artifacts_v3', 'repl_v2', 'web_search_v3', 'extended_thinking'],
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  member_count: 1,
  admin_count:  1,
};

const SUBSCRIPTION_DETAILS = () => ({
  subscription: {
    plan:                  'claude_max_5x',
    seats:                 1,
    status:                'active',
    trial:                 false,
    current_period_start:  new Date(Date.now() - 15 * 86400000).toISOString(),
    current_period_end:    new Date(Date.now() + 15 * 86400000).toISOString(),
    cancel_at_period_end:  false,
    price_currency:        'usd',
    price_amount:          '100.00',
    renews_at:             new Date(Date.now() + 15 * 86400000).toISOString(),
    features: {
      max_context:          true,
      extended_thinking:    true,
      priority_access:      true,
      claude_code_access:   true,
      artifacts_v3:         true,
      repl_v2:              true,
      web_search_v3:        true,
      memory_v2:            true,
      projects_v2:          true,
      five_x_usage:         true,
    },
  },
});

const AVAILABLE_MODELS = [
  {
    id:              'claude-opus-4-6',
    display_name:    'Claude Opus 4.6',
    description:     'Most capable model for complex tasks',
    max_tokens:      32000,
    context_window:  200000,
    is_legacy:       false,
    tier_required:   'max',
    supports_extended_thinking: true,
    supports_vision: true,
    supports_tools:  true,
    supports_streaming: true,
    is_default:      false,
  },
  {
    id:              'claude-sonnet-4-6',
    display_name:    'Claude Sonnet 4.6',
    description:     'Best balance of speed and capability',
    max_tokens:      16000,
    context_window:  200000,
    is_legacy:       false,
    tier_required:   'pro',
    supports_extended_thinking: false,
    supports_vision: true,
    supports_tools:  true,
    supports_streaming: true,
    is_default:      true,
  },
  {
    id:              'claude-haiku-4-5-20251001',
    display_name:    'Claude Haiku 4.5',
    description:     'Fastest model for simple tasks',
    max_tokens:      8000,
    context_window:  200000,
    is_legacy:       false,
    tier_required:   'free',
    supports_extended_thinking: false,
    supports_vision: true,
    supports_tools:  true,
    supports_streaming: true,
    is_default:      false,
  },
];

const CURRENT_USER_ACCESS = () => ({
  account:      buildProfile(),
  organization: ORG_JSON,
  statsig:      { user_hash: djb2Hash(`user:${ACCOUNT_UUID}:org:${ORG_UUID}`) },
  permissions:  [
    'chat', 'upload', 'share', 'memory', 'artifacts', 'repl',
    'web_search', 'projects', 'extended_thinking', 'code_execution',
    'voice', 'export',
  ],
  feature_flags: {
    artifacts_v3:              true,
    repl_v2:                   true,
    web_search_v3:             true,
    extended_thinking:         true,
    projects_v2:               true,
    memory_v2:                 true,
    cowork_v1:                 false,
    claude_code_access:        true,
    monaco_editor:             true,
    artifact_version_history:  true,
    latex_rendering:           true,
    mermaid_diagrams:          true,
    voice_input:               false,
    file_export:               true,
  },
});

// ────────────────────────────────────────────────────────────────
// STATSIG app_start BLOB BUILDER
// Mirrors the djb2-hashed gate/config structure from cap1
// ────────────────────────────────────────────────────────────────
const STATSIG_GATE_NAMES = [
  'cascade_nebula', 'chrome_ext_allow_api_key', 'chrome_ext_sidebar',
  'claude_web_artifacts', 'claude_web_repl', 'claude_web_search',
  'claude_web_memory', 'claude_web_projects', 'claude_web_cowork',
  'claude_web_extended_thinking', 'claude_web_file_upload',
  'claude_web_voice', 'claude_web_vision', 'claude_web_tools_v2',
  'claude_web_share', 'claude_web_export', 'claude_web_code_execution',
  'claude_web_artifacts_v3', 'claude_web_latex', 'claude_web_mermaid',
  'claude_max_access', 'claude_pro_access', 'claude_code_web_access',
  'artifacts_monaco_editor', 'artifacts_version_history',
  'show_widget_tool', 'web_search_v3', 'repl_v2_enabled',
  'memory_sidebar', 'projects_v2_enabled', 'holdup', 'cascade_v2',
  'chrome_ext_model_selector', 'claude_web_streaming_v2',
  'claude_web_artifact_export', 'claude_web_canvas_mode',
  'extended_thinking_v2', 'claude_web_pdf_upload', 'mcp_tools_enabled',
  'claude_web_multi_modal', 'usage_tracking_v2', 'billing_v3',
  'plans_v4', 'notifications_v2', 'search_integrations',
  'claude_web_integrations', 'enterprise_v2', 'admin_console_v3',
  'sso_enabled', 'saml_enabled',
];

const STATSIG_CONFIG_NAMES = [
  'claude_web_model_config', 'claude_web_rate_limits',
  'claude_web_feature_rollout', 'claude_web_ui_config',
  'artifacts_config', 'repl_config', 'search_config',
  'memory_config', 'billing_config', 'notification_config',
  'projects_config', 'enterprise_config',
];

const STATSIG_LAYER_NAMES = [
  'claude_web_experiment_layer', 'artifacts_experiment_layer',
  'billing_experiment_layer', 'onboarding_experiment_layer',
];

function buildAppStartBlob(orgUuid, accountUuid) {
  const feature_gates = {};
  for (const name of STATSIG_GATE_NAMES) {
    feature_gates[djb2Hash(name)] = {
      value: true,
      rule_id: 'default',
      secondary_exposures: [],
      is_user_in_experiment: false,
      is_experiment_active: false,
    };
  }

  const dynamic_configs = {};
  for (const name of STATSIG_CONFIG_NAMES) {
    dynamic_configs[djb2Hash(name)] = {
      value: {},
      rule_id: 'default',
      group: 'everyone',
      is_device_based: false,
      secondary_exposures: [],
    };
  }

  const layer_configs = {};
  for (const name of STATSIG_LAYER_NAMES) {
    layer_configs[djb2Hash(name)] = {
      value: {},
      rule_id: 'default',
      group: 'everyone',
      is_device_based: false,
      secondary_exposures: [],
      allocated_experiment_name: '',
      explicit_parameters: [],
    };
  }

  return {
    feature_gates,
    dynamic_configs,
    layer_configs,
    sdkInfo:     { sdkType: 'js-client', sdkVersion: '5.1.0' },
    has_updates: true,
    time:        Date.now(),
    hash_used:   'djb2',
    user: {
      userID:    accountUuid,
      customIDs: { organizationUuid: orgUuid },
      email:     config.operator_email,
      custom:    { plan: 'claude_max_5x', is_pro: true, is_max: true },
    },
    evaluated_keys: {
      userID:          accountUuid,
      organizationUuid: orgUuid,
    },
    derived_fields: {
      ip:         '127.0.0.1',
      country:    'US',
      browser:    'Chrome',
      os:         'Windows',
    },
    growthbook: {
      features: {
        artifacts_v3:             { defaultValue: true,  rules: [] },
        repl_v2:                  { defaultValue: true,  rules: [] },
        web_search_v3:            { defaultValue: true,  rules: [] },
        extended_thinking:        { defaultValue: true,  rules: [] },
        memory_v2:                { defaultValue: true,  rules: [] },
        projects_v2:              { defaultValue: true,  rules: [] },
        monaco_editor:            { defaultValue: true,  rules: [] },
        artifact_version_history: { defaultValue: true,  rules: [] },
        latex_rendering:          { defaultValue: true,  rules: [] },
        mermaid_diagrams:         { defaultValue: true,  rules: [] },
        cowork_v1:                { defaultValue: false, rules: [] },
        voice_input:              { defaultValue: false, rules: [] },
        holdup:                   { defaultValue: true,  rules: [] },
      },
      experiments: [],
      savedGroups: {},
    },
  };
}

// ────────────────────────────────────────────────────────────────
// CONVERSATION + MESSAGE STORAGE (in-memory + optional file dump)
// ────────────────────────────────────────────────────────────────
const conversations  = new Map(); // uuid → conv object
const convMessages   = new Map(); // uuid → [msg, ...]
const artifacts      = new Map(); // artifact_uuid → { uuid, conv_uuid, versions:[] }
const memoryStore    = [];
const sessionTokens  = new Map(); // token → { accountUuid, createdAt }

// Styles
const DEFAULT_STYLES = [
  {
    uuid:       uuidv4(),
    type:       'default',
    key:        'Default',
    name:       'Normal',
    nameKey:    'normal_style_name',
    prompt:     'Normal\n',
    summary:    'Default responses from Claude',
    summaryKey: 'normal_style_summary',
    isDefault:  true,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
  {
    uuid:       uuidv4(),
    type:       'custom',
    key:        'Concise',
    name:       'Concise',
    nameKey:    null,
    prompt:     'Be as concise as possible. Avoid unnecessary filler.\n',
    summary:    'Short and to the point',
    summaryKey: null,
    isDefault:  false,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
  {
    uuid:       uuidv4(),
    type:       'custom',
    key:        'Technical',
    name:       'Technical',
    nameKey:    null,
    prompt:     'Use precise technical language. Include code examples where relevant.\n',
    summary:    'Detailed technical explanations',
    summaryKey: null,
    isDefault:  false,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
];

function makeConversation(params = {}) {
  const conv = {
    uuid:                      params.uuid || uuidv4(),
    name:                      params.name || '',
    summary:                   '',
    model:                     params.model || config.default_model,
    created_at:                new Date().toISOString(),
    updated_at:                new Date().toISOString(),
    settings: {
      preview_feature_uses_artifacts:   true,
      preview_feature_uses_latex:       true,
      preview_feature_uses_web_search:  true,
      preview_feature_uses_repl:        true,
    },
    is_starred:                false,
    project_uuid:              params.project_uuid  || null,
    current_leaf_message_uuid: null,
    paprika_mode:              params.paprika_mode  || 'extended',
    compass_mode:              params.compass_mode  || null,
    is_temporary:              params.is_temporary  || false,
    enabled_imagine:           params.enabled_imagine !== undefined ? params.enabled_imagine : true,
    include_conversation_preferences: params.include_conversation_preferences !== false,
  };
  conversations.set(conv.uuid, conv);
  convMessages.set(conv.uuid, []);
  return conv;
}

function addMessage(convUuid, role, content, parentUuid, model) {
  const msgUuid = uuidv4();
  const isAssistant = role === 'assistant';
  const contentArray = typeof content === 'string'
    ? [{ type: 'text', text: content }]
    : (Array.isArray(content) ? content : [{ type: 'text', text: String(content) }]);

  const msg = {
    uuid:               msgUuid,
    text:               typeof content === 'string' ? content : '',
    sender:             isAssistant ? 'assistant' : 'human',
    role:               isAssistant ? 'assistant' : 'user',
    content:            contentArray,
    parent_message_uuid: parentUuid || null,
    created_at:         new Date().toISOString(),
    updated_at:         new Date().toISOString(),
    attachments:        [],
    files_v2:           [],
    sync_sources:       [],
    files:              [],
    model:              model || config.default_model,
    stop_reason:        isAssistant ? 'end_turn' : null,
    stop_sequence:      null,
    truncated:          false,
  };

  const msgs = convMessages.get(convUuid) || [];
  msgs.push(msg);
  convMessages.set(convUuid, msgs);

  const conv = conversations.get(convUuid);
  if (conv) {
    conv.current_leaf_message_uuid = msgUuid;
    conv.updated_at = new Date().toISOString();
  }
  return msg;
}

function addArtifactVersion(convUuid, artifactUuid, content, language, title) {
  if (!artifacts.has(artifactUuid)) {
    artifacts.set(artifactUuid, {
      uuid:      artifactUuid,
      conv_uuid: convUuid,
      versions:  [],
    });
  }
  const art = artifacts.get(artifactUuid);
  const version = art.versions.length + 1;
  const vObj = {
    uuid:          uuidv4(),
    artifact_uuid: artifactUuid,
    version,
    content:       content || '',
    language:      language || 'text',
    title:         title   || 'Untitled',
    created_at:    new Date().toISOString(),
  };
  art.versions.push(vObj);
  return vObj;
}

// Generate a plausible title from the first 8 words of a prompt
function autoTitle(prompt) {
  if (!prompt) return 'New Conversation';
  const words = prompt.trim().split(/\s+/).slice(0, 8);
  let title = words.join(' ');
  if (title.length > 60) title = title.slice(0, 57) + '...';
  return title || 'New Conversation';
}

// ────────────────────────────────────────────────────────────────
// SYSTEM PROMPT MUTATION
// Runs pre-auth on every outbound request body, all four modes
// ────────────────────────────────────────────────────────────────
function applyMutation(body) {
  if (!config.system_prompt_override) return body;
  const override = config.system_prompt_override;
  const mutated  = { ...body };

  switch (config.mutation_mode) {

    case 'strip_replace':
      // claude.ai /completion: replace prompt prefix
      if (mutated.prompt !== undefined) {
        mutated.prompt = override + '\n\n' + (mutated.prompt || '');
      }
      // Anthropic /v1/messages: replace system block
      if (mutated.system !== undefined) {
        mutated.system = override;
      } else if (mutated.messages) {
        // inject system message at front
        const hasSystem = mutated.messages[0]?.role === 'system';
        mutated.messages = hasSystem
          ? [{ role: 'system', content: override }, ...mutated.messages.slice(1)]
          : [{ role: 'system', content: override }, ...mutated.messages];
      }
      break;

    case 'prepend':
      if (mutated.prompt !== undefined) {
        mutated.prompt = override + '\n\n' + (mutated.prompt || '');
      }
      if (mutated.system !== undefined) {
        mutated.system = override + '\n\n' + mutated.system;
      } else if (mutated.messages) {
        const hasSystem = mutated.messages[0]?.role === 'system';
        mutated.messages = hasSystem
          ? [{
              role: 'system',
              content: override + '\n\n' + mutated.messages[0].content,
            }, ...mutated.messages.slice(1)]
          : [{ role: 'system', content: override }, ...mutated.messages];
      }
      break;

    case 'append':
      if (mutated.prompt !== undefined) {
        mutated.prompt = (mutated.prompt || '') + '\n\n' + override;
      }
      if (mutated.system !== undefined) {
        mutated.system = mutated.system + '\n\n' + override;
      } else if (mutated.messages) {
        const hasSystem = mutated.messages[0]?.role === 'system';
        if (hasSystem) {
          mutated.messages = [{
            role: 'system',
            content: mutated.messages[0].content + '\n\n' + override,
          }, ...mutated.messages.slice(1)];
        }
      }
      break;
  }
  return mutated;
}

// ────────────────────────────────────────────────────────────────
// AUTH HEADER BUILDER — four modes, completely separate
// ────────────────────────────────────────────────────────────────
function buildAuthHeaders(mode) {
  switch (mode) {
    case 'no_key':
      return {};
    case 'api_key':
      return {
        'x-api-key':          config.api_key,
        'anthropic-version':  ANTHROPIC_VERSION,
        'anthropic-beta':     ANTHROPIC_BETA,
      };
    case 'oauth':
      return {
        'Authorization':      `Bearer ${config.oauth_token}`,
        'anthropic-version':  ANTHROPIC_VERSION,
        'anthropic-beta':     ANTHROPIC_BETA,
      };
    case 'cookie_bridge':
      // No headers here — Worker C handles auth via credentials:include
      // in the browser. The WebSocket bridge does NOT pass cookie values.
      return {};
    default:
      return {};
  }
}

// ────────────────────────────────────────────────────────────────
// BACKEND URL RESOLVER — validates against blocked-host list
// ────────────────────────────────────────────────────────────────
function resolveBackendUrl(backend) {
  const urlStr = config.backend_urls[backend]
    || (backend === 'custom' ? config.backend_urls.custom : '');
  if (!urlStr) return null;
  try {
    const parsed = new URL(urlStr);
    if (isBlockedUrl(urlStr)) {
      diagnostics.lastError = `Blocked host: ${parsed.hostname}`;
      console.error('[worker-a] BLOCKED HOST:', parsed.hostname);
      return null;
    }
    return urlStr.replace(/\/$/, '');
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────
// TRANSLATION: Anthropic /v1/messages ↔ OpenAI /v1/chat/completions
// ────────────────────────────────────────────────────────────────

// Anthropic → OpenAI (for LM Studio / OpenRouter)
function anthropicToOpenAI(body) {
  const messages = [];
  if (typeof body.system === 'string' && body.system) {
    messages.push({ role: 'system', content: body.system });
  } else if (Array.isArray(body.system)) {
    const txt = body.system.filter(b => b.type === 'text').map(b => b.text).join('\n');
    if (txt) messages.push({ role: 'system', content: txt });
  }

  for (const m of (body.messages || [])) {
    if (typeof m.content === 'string') {
      messages.push({ role: m.role, content: m.content });
    } else if (Array.isArray(m.content)) {
      const parts = m.content.map(block => {
        if (block.type === 'text')  return { type: 'text', text: block.text };
        if (block.type === 'image') return {
          type: 'image_url',
          image_url: { url: block.source?.url || block.source?.data || '' },
        };
        if (block.type === 'tool_result') return {
          type: 'text',
          text: `[Tool result for ${block.tool_use_id}]: ${
            typeof block.content === 'string' ? block.content
            : JSON.stringify(block.content)
          }`,
        };
        return { type: 'text', text: JSON.stringify(block) };
      });
      messages.push({ role: m.role, content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts });
    }
  }

  const oaiBody = {
    model:   resolveModelAlias(body.model || config.default_model),
    messages,
    stream:  body.stream !== false,
  };

  if (body.max_tokens) oaiBody.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) oaiBody.temperature = body.temperature;
  if (body.top_p !== undefined) oaiBody.top_p = body.top_p;
  if (body.stop_sequences?.length) oaiBody.stop = body.stop_sequences;

  if (body.tools?.length) {
    oaiBody.tools = body.tools
      .filter(t => t.name && t.input_schema)
      .map(t => ({
        type: 'function',
        function: {
          name:        t.name,
          description: t.description || '',
          parameters:  t.input_schema || { type: 'object', properties: {} },
        },
      }));
  }

  return oaiBody;
}

// OpenAI → Anthropic
function openaiToAnthropic(body) {
  const msgs     = body.messages || [];
  const sysMsg   = msgs.find(m => m.role === 'system');
  const otherMsg = msgs.filter(m => m.role !== 'system');

  const anthropicMsgs = otherMsg.map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map(p => {
            if (p.type === 'text') return { type: 'text', text: p.text };
            if (p.type === 'image_url') return {
              type: 'image',
              source: { type: 'url', url: p.image_url?.url || '' },
            };
            return { type: 'text', text: JSON.stringify(p) };
          })
        : String(m.content),
  }));

  const result = {
    model:      resolveModelAlias(body.model || config.default_model),
    messages:   anthropicMsgs,
    max_tokens: body.max_tokens || 4096,
    stream:     body.stream !== false,
  };

  if (sysMsg) result.system = typeof sysMsg.content === 'string' ? sysMsg.content : JSON.stringify(sysMsg.content);
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;
  if (body.stop) result.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];

  if (body.tools?.length) {
    result.tools = body.tools
      .filter(t => t.type === 'function')
      .map(t => ({
        name:         t.function.name,
        description:  t.function.description || '',
        input_schema: t.function.parameters || { type: 'object', properties: {} },
      }));
  }

  return result;
}

// Anthropic /v1/messages body → claude.ai /completion body
function anthropicToClaudeSite(body, convUuid) {
  const lastUser = [...(body.messages || [])].reverse().find(m => m.role === 'user');
  let prompt = '';
  if (lastUser) {
    if (typeof lastUser.content === 'string') {
      prompt = lastUser.content;
    } else if (Array.isArray(lastUser.content)) {
      prompt = lastUser.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    }
  }

  return {
    prompt,
    timezone:            Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    personalized_styles: [DEFAULT_STYLES[0]],
    locale:              'en-US',
    model:               resolveModelAlias(body.model || config.default_model),
    tools:               body.tools || [],
    turn_message_uuids: {
      human_message_uuid:    uuidv4(),
      assistant_message_uuid: uuidv4(),
    },
    attachments:   [],
    files:         [],
    sync_sources:  [],
    rendering_mode: 'messages',
    create_conversation_params: {
      name:                         '',
      model:                        resolveModelAlias(body.model || config.default_model),
      include_conversation_preferences: true,
      paprika_mode:                 'extended',
      compass_mode:                 null,
      is_temporary:                 false,
      enabled_imagine:              true,
    },
  };
}

function resolveModelAlias(model) {
  return config.model_aliases[model] || model;
}

// ────────────────────────────────────────────────────────────────
// SSE HELPERS — Anthropic event stream format
// ────────────────────────────────────────────────────────────────
function sseStartHeaders(requestId, origin) {
  return {
    'Content-Type':        'text/event-stream; charset=utf-8',
    'Cache-Control':       'no-cache, no-transform',
    'Connection':          'keep-alive',
    'X-Accel-Buffering':   'no',
    'request-id':          requestId,
    'x-robots-tag':        'none',
    'server-timing':       'cfExtPri',
    'strict-transport-security': 'max-age=31536000; includeSubDomains; preload',
    ...corsHeaders(origin, true),
  };
}

function writeSSEEvent(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function writeSSERaw(res, raw) {
  try { res.write(raw); return true; } catch { return false; }
}

// Emit a complete Anthropic SSE stream from a plain text string
function emitAnthropicTextStream(res, requestId, text, model, inputTokens) {
  const msgId      = `msg_${crypto.randomBytes(12).toString('hex')}`;
  const outputToks = Math.max(1, Math.ceil(text.split(/\s+/).length * 1.3));
  const inToks     = inputTokens || 0;

  writeSSEEvent(res, 'message_start', {
    type: 'message_start',
    message: {
      id:             msgId,
      type:           'message',
      role:           'assistant',
      model,
      content:        [],
      stop_reason:    null,
      stop_sequence:  null,
      usage: {
        input_tokens:                 inToks,
        output_tokens:                1,
        cache_creation_input_tokens:  0,
        cache_read_input_tokens:      0,
      },
    },
  });

  writeSSEEvent(res, 'content_block_start', {
    type:          'content_block_start',
    index:         0,
    content_block: { type: 'text', text: '' },
  });

  const chunkSize = 25;
  for (let i = 0; i < text.length; i += chunkSize) {
    writeSSEEvent(res, 'content_block_delta', {
      type:  'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: text.slice(i, i + chunkSize) },
    });
  }

  writeSSEEvent(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });

  writeSSEEvent(res, 'message_delta', {
    type:  'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: {
      output_tokens:                outputToks,
      cache_creation_input_tokens:  0,
      cache_read_input_tokens:      0,
    },
  });

  writeSSEEvent(res, 'message_stop', { type: 'message_stop' });
}

// Emit OpenAI-format SSE from plain text
function emitOpenAITextStream(res, requestId, text, model) {
  const chatId  = `chatcmpl-${crypto.randomBytes(8).toString('hex')}`;
  const created = Math.floor(Date.now() / 1000);

  const chunk = (delta, finishReason = null) =>
    `data: ${JSON.stringify({
      id: chatId, object: 'chat.completion.chunk',
      created, model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;

  res.write(chunk({ role: 'assistant' }));

  const sz = 25;
  for (let i = 0; i < text.length; i += sz) {
    res.write(chunk({ content: text.slice(i, i + sz) }));
  }

  res.write(chunk({}, 'stop'));
  res.write('data: [DONE]\n\n');
}

// ────────────────────────────────────────────────────────────────
// HTTP PROXY — forward to real backend
// ────────────────────────────────────────────────────────────────
function proxyRequest(req, res, mutatedBody, targetPath, targetMethod) {
  const backendUrl = resolveBackendUrl(config.backend);
  if (!backendUrl) {
    return sendJson(res, errorEnvelope('api_error', 'No backend configured or backend host is blocked'), 500);
  }

  const bodyStr    = JSON.stringify(mutatedBody);
  const authHdrs   = buildAuthHeaders(config.auth_mode);
  const isSSE      = req.headers['accept']?.includes('text/event-stream')
                  || mutatedBody.stream !== false;

  let targetFullUrl;
  try {
    targetFullUrl = new URL(backendUrl + (targetPath || req.url));
  } catch (e) {
    return sendJson(res, errorEnvelope('api_error', `Bad backend URL: ${e.message}`), 500);
  }

  if (isBlockedUrl(targetFullUrl.toString())) {
    return sendJson(res, errorEnvelope('permission_error', 'Blocked host'), 403);
  }

  const options = {
    hostname: targetFullUrl.hostname,
    port:     targetFullUrl.port || (targetFullUrl.protocol === 'https:' ? 443 : 80),
    path:     targetFullUrl.pathname + targetFullUrl.search,
    method:   targetMethod || req.method,
    headers: {
      'Content-Type':    'application/json',
      'Content-Length':  Buffer.byteLength(bodyStr),
      'Accept':          isSSE ? 'text/event-stream' : 'application/json',
      'User-Agent':      `sister-poc/${SERVER_VERSION}`,
      ...authHdrs,
      ...(config.http_referer ? { 'HTTP-Referer': config.http_referer } : {}),
      ...(config.x_title      ? { 'X-Title':      config.x_title      } : {}),
    },
    timeout: config.request_timeout_ms,
  };

  const transport = targetFullUrl.protocol === 'https:' ? https : http;
  const reqId     = generateRequestId();

  const proxyReq = transport.request(options, (proxyRes) => {
    // Collect pass-through rate-limit headers
    const rlHeaders = {};
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      if (k.startsWith('anthropic-ratelimit') || k === 'retry-after'
          || k === 'x-request-id' || k === 'request-id') {
        rlHeaders[k] = v;
      }
    }

    if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
      res.writeHead(proxyRes.statusCode, {
        'Content-Type':      'text/event-stream; charset=utf-8',
        'Cache-Control':     'no-cache, no-transform',
        'Connection':        'keep-alive',
        'X-Accel-Buffering': 'no',
        'request-id':        reqId,
        ...corsHeaders(req.headers.origin, true),
        ...rlHeaders,
      });
      proxyRes.pipe(res);
      req.on('close', () => { try { proxyRes.destroy(); } catch {} });
      return;
    }

    // JSON / other
    let data = '';
    const enc = proxyRes.headers['content-encoding'];
    let stream = proxyRes;

    if (enc === 'gzip')   { stream = proxyRes.pipe(zlib.createGunzip()); }
    else if (enc === 'br'){ stream = proxyRes.pipe(zlib.createBrotliDecompress()); }
    else if (enc === 'deflate') { stream = proxyRes.pipe(zlib.createInflate()); }

    stream.on('data', c => data += c);
    stream.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        sendJson(res, parsed, proxyRes.statusCode, rlHeaders);
      } catch {
        res.writeHead(proxyRes.statusCode, { 'Content-Type': 'text/plain', ...corsHeaders(req.headers.origin) });
        res.end(data);
      }
    });
    stream.on('error', (e) => {
      sendJson(res, errorEnvelope('api_error', `Proxy decode error: ${e.message}`), 502);
    });
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    sendJson(res, errorEnvelope('api_error', 'Backend timeout'), 504);
  });

  proxyReq.on('error', (e) => {
    diagnostics.lastError = e.message;
    sendJson(res, errorEnvelope('api_error', `Backend error: ${e.message}`), 502);
  });

  proxyReq.write(bodyStr);
  proxyReq.end();
}

// ────────────────────────────────────────────────────────────────
// BRIDGE DISPATCH — route via Worker C WebSocket
// ────────────────────────────────────────────────────────────────
const pendingBridge = new Map(); // requestId → { res, isSSE, timeout }

function sendBridgeEnvelope(ws, obj) {
  try { ws.send(JSON.stringify(obj)); return true; }
  catch { return false; }
}

function dispatchToBridge(req, res, mutatedBody, targetPath, targetMethod) {
  if (!activeBridgeSocket) {
    return sendJson(res, errorEnvelope('api_error', 'Worker C not connected. Open a claude.ai tab with the userscript installed.'), 503);
  }

  const reqId  = generateRequestId();
  const isSSE  = req.headers['accept']?.includes('text/event-stream')
              || mutatedBody.stream !== false;

  if (isSSE) {
    res.writeHead(200, sseStartHeaders(reqId, req.headers.origin));
  }

  const timer = setTimeout(() => {
    const pending = pendingBridge.get(reqId);
    if (!pending) return;
    pendingBridge.delete(reqId);
    if (isSSE) {
      writeSSEEvent(res, 'error', { type: 'error', error: { type: 'api_error', message: 'Bridge timeout' } });
      try { res.end(); } catch {}
    } else {
      sendJson(res, errorEnvelope('api_error', 'Bridge timeout'), 504);
    }
  }, config.request_timeout_ms);

  pendingBridge.set(reqId, { res, isSSE, timeout: timer, chunks: [] });

  sendBridgeEnvelope(activeBridgeSocket, {
    type:    'sse_request',
    id:      reqId,
    method:  targetMethod || req.method,
    path:    targetPath || req.url,
    headers: {
      'Content-Type': 'application/json',
      'Accept': isSSE ? 'text/event-stream' : 'application/json',
    },
    body:       mutatedBody,
    timeout_ms: config.request_timeout_ms,
    stream:     isSSE,
  });
}

// ────────────────────────────────────────────────────────────────
// ERROR ENVELOPES
// ────────────────────────────────────────────────────────────────
function errorEnvelope(type, message) {
  return { type: 'error', error: { type, message } };
}

function openaiErrorBody(message, type = 'server_error', code = 'internal_error') {
  return { error: { message, type, code } };
}

const STATUS_TO_ANTHROPIC_TYPE = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  409: 'invalid_request_error',
  413: 'request_too_large',
  422: 'invalid_request_error',
  429: 'rate_limit_error',
  500: 'api_error',
  502: 'api_error',
  503: 'api_error',
  504: 'api_error',
  529: 'overloaded_error',
};

// ────────────────────────────────────────────────────────────────
// CORS
// ────────────────────────────────────────────────────────────────
function corsHeaders(origin, withCredentials = true) {
  const hdrs = {
    'Access-Control-Allow-Origin':  origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, x-api-key, Accept, Cache-Control, Pragma, ' +
      'anthropic-client-platform, anthropic-device-id, anthropic-version, ' +
      'anthropic-beta, x-format, accept-format',
    'Vary': 'Origin',
  };
  if (withCredentials) hdrs['Access-Control-Allow-Credentials'] = 'true';
  return hdrs;
}

// ────────────────────────────────────────────────────────────────
// HTTP RESPONSE HELPERS
// ────────────────────────────────────────────────────────────────
function sendJson(res, data, status = 200, extraHeaders = {}) {
  if (res.headersSent) return;
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type':   'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 5 * 1024 * 1024) reject(new Error('Body too large'));
    });
    req.on('end', () => {
      try   { resolve(raw ? JSON.parse(raw) : {}); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// ────────────────────────────────────────────────────────────────
// REQUEST LOGGER
// ────────────────────────────────────────────────────────────────
function logRequest(method, pathname, status, durationMs, requestId) {
  if (!config.log_requests) return;
  const entry = `${new Date().toISOString()} ${requestId} ${method} ${pathname} → ${status} (${durationMs}ms)\n`;
  try { fs.appendFileSync(LOG_PATH, entry); } catch {}
  if (status >= 400) console.warn('[worker-a]', entry.trim());
}

// ────────────────────────────────────────────────────────────────
// DIAGNOSTICS STATE
// ────────────────────────────────────────────────────────────────
const diagnostics = {
  startTime:       new Date().toISOString(),
  requestCount:    0,
  sseStreams:       0,
  wsConnections:   0,
  lastWsConnect:   null,
  lastError:       null,
  bridgePending:   0,
  conversations:   0,
  uptime:          () => Math.floor(process.uptime()),
};

// ────────────────────────────────────────────────────────────────
// WEBSOCKET SERVER — Worker C bridge
// ────────────────────────────────────────────────────────────────
let activeBridgeSocket = null;
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws, req) => {
  console.log('[worker-a] Worker C connected from', req.socket.remoteAddress);
  activeBridgeSocket = ws;
  diagnostics.wsConnections++;
  diagnostics.lastWsConnect = new Date().toISOString();

  // App-level ping/pong on top of WS-level (catches half-open sockets)
  let pongOk = true;
  const pingTimer = setInterval(() => {
    if (!pongOk) {
      console.warn('[worker-a] Worker C pong timeout — terminating');
      ws.terminate();
      return;
    }
    pongOk = false;
    try { ws.ping(); } catch {}
  }, config.ws_ping_interval_ms);

  ws.on('pong', () => { pongOk = true; });

  ws.on('message', (raw) => {
    let env;
    try { env = JSON.parse(raw.toString()); } catch { return; }
    handleBridgeInbound(env);
  });

  ws.on('close', (code, reason) => {
    if (activeBridgeSocket === ws) activeBridgeSocket = null;
    diagnostics.wsConnections = Math.max(0, diagnostics.wsConnections - 1);
    clearInterval(pingTimer);
    console.log(`[worker-a] Worker C disconnected (${code})`);
    // Drain pending bridge requests with an error
    for (const [id, pending] of pendingBridge.entries()) {
      clearTimeout(pending.timeout);
      pendingBridge.delete(id);
      if (pending.isSSE) {
        writeSSEEvent(pending.res, 'error', { type: 'error', error: { type: 'api_error', message: 'Worker C disconnected' } });
        try { pending.res.end(); } catch {}
      } else {
        sendJson(pending.res, errorEnvelope('api_error', 'Worker C disconnected'), 503);
      }
    }
  });

  ws.on('error', (e) => {
    diagnostics.lastError = e.message;
    console.error('[worker-a] WS error:', e.message);
  });

  // Push current config to Worker C immediately on connect
  sendBridgeEnvelope(ws, {
    type:                    'config',
    mutation_mode:           config.mutation_mode,
    system_prompt_override:  config.system_prompt_override,
    default_model:           config.default_model,
    blocked_hosts:           [...BLOCKED_HOSTS],
  });
});

// Handle messages coming FROM Worker C
function handleBridgeInbound(env) {
  switch (env.type) {

    case 'pong':
      // handled by ws.on('pong') at protocol level
      break;

    case 'org_info':
      console.log(`[worker-a] org_info: org=${env.org_uuid} account=${env.account_uuid}`);
      break;

    case 'convo_created':
      console.log(`[worker-a] convo_created: ${env.conv_uuid} (for ${env.for_request})`);
      // If a pending request was waiting for this conv, it can now proceed
      break;

    case 'sse_chunk': {
      const p = pendingBridge.get(env.id);
      if (!p) return;
      if (p.isSSE) {
        writeSSERaw(p.res, env.data);
      } else {
        p.chunks.push(env.data);
      }
      break;
    }

    case 'sse_complete': {
      const p = pendingBridge.get(env.id);
      if (!p) return;
      clearTimeout(p.timeout);
      pendingBridge.delete(env.id);
      if (p.isSSE) {
        try { p.res.end(); } catch {}
      } else {
        const body = (p.chunks || []).join('');
        try {
          sendJson(p.res, JSON.parse(body), env.status || 200);
        } catch {
          try {
            p.res.writeHead(env.status || 200, { 'Content-Type': 'text/plain' });
            p.res.end(body);
          } catch {}
        }
      }
      break;
    }

    case 'sse_error': {
      const p = pendingBridge.get(env.id);
      if (!p) return;
      clearTimeout(p.timeout);
      pendingBridge.delete(env.id);
      const status = env.status || 500;
      const errType = STATUS_TO_ANTHROPIC_TYPE[status] || 'api_error';
      if (p.isSSE) {
        writeSSEEvent(p.res, 'error', { type: 'error', error: { type: errType, message: env.error?.message || 'Bridge error' } });
        try { p.res.end(); } catch {}
      } else {
        sendJson(p.res, errorEnvelope(errType, env.error?.message || 'Bridge error'), status);
      }
      break;
    }

    default:
      // Unknown envelope type — log and ignore
      console.warn('[worker-a] Unknown bridge message type:', env.type);
  }
}

// ────────────────────────────────────────────────────────────────
// MAIN HTTP REQUEST HANDLER
// ────────────────────────────────────────────────────────────────
async function handleRequest(req, res) {
  const startMs  = Date.now();
  const parsed   = urlMod.parse(req.url, true);
  const pathname = parsed.pathname.replace(/\/$/, '') || '/';
  const method   = req.method.toUpperCase();
  const origin   = req.headers.origin || '';
  const reqId    = generateRequestId();

  diagnostics.requestCount++;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(origin, true));
    res.end();
    return;
  }

  // Apply CORS to every response
  res.setHeader('Access-Control-Allow-Origin',      origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Vary', 'Origin');

  let status = 200;
  try {
    status = await route(req, res, pathname, method, parsed, origin, reqId);
  } catch (e) {
    diagnostics.lastError = e.message;
    console.error('[worker-a] Unhandled error:', e.message);
    if (!res.headersSent) {
      sendJson(res, errorEnvelope('api_error', e.message), 500);
      status = 500;
    }
  } finally {
    logRequest(method, pathname, status || 200, Date.now() - startMs, reqId);
  }
}

// Route table — returns HTTP status for logging
async function route(req, res, pathname, method, parsed, origin, reqId) {

  // ── Ops / health ──────────────────────────────────────────────
  if (pathname === '/health') {
    sendJson(res, {
      status:              'ok',
      version:             SERVER_VERSION,
      uptime_s:            diagnostics.uptime(),
      worker_c_connected:  !!activeBridgeSocket,
      pending_bridge:      pendingBridge.size,
      auth_mode:           config.auth_mode,
      backend:             config.backend,
      default_model:       config.default_model,
      conversations:       conversations.size,
      start_time:          diagnostics.startTime,
    });
    return 200;
  }

  if (pathname === '/version') {
    sendJson(res, { version: SERVER_VERSION, node: process.version, platform: process.platform });
    return 200;
  }

  if (pathname === '/diag') {
    sendJson(res, {
      ...diagnostics,
      uptime_s:            diagnostics.uptime(),
      pending_bridge:      pendingBridge.size,
      conversations:       conversations.size,
      messages:            [...convMessages.values()].reduce((n, a) => n + a.length, 0),
      artifacts:           artifacts.size,
      active_ws:           !!activeBridgeSocket,
      memory_entries:      memoryStore.length,
      config: {
        auth_mode:           config.auth_mode,
        backend:             config.backend,
        mutation_mode:       config.mutation_mode,
        default_model:       config.default_model,
        has_api_key:         !!config.api_key,
        has_oauth:           !!config.oauth_token,
        has_system_override: !!config.system_prompt_override,
        log_requests:        config.log_requests,
      },
    });
    return 200;
  }

  if (pathname === '/setup') {
    serveSetupPage(res);
    return 200;
  }

  // Config update endpoint (used by setup page and Worker B)
  if (pathname === '/bridge/config' && method === 'POST') {
    const body = await readBody(req);
    config = deepMerge(config, body);
    saveConfig();
    if (activeBridgeSocket) {
      sendBridgeEnvelope(activeBridgeSocket, {
        type:                   'config',
        mutation_mode:          config.mutation_mode,
        system_prompt_override: config.system_prompt_override,
        default_model:          config.default_model,
      });
    }
    sendJson(res, { ok: true, config: { auth_mode: config.auth_mode, backend: config.backend, mutation_mode: config.mutation_mode } });
    return 200;
  }

  // ── Local auth — Worker B session (completely separate from the 4 modes) ──
  if (pathname === '/auth/login' && method === 'POST') {
    const body = await readBody(req);
    const { email, password } = body;
    // Operator-only: any non-empty credentials accepted in local mode
    if (!email || !password) {
      sendJson(res, { error: 'email and password required' }, 400);
      return 400;
    }
    const token = `spoc_${crypto.randomBytes(24).toString('hex')}`;
    sessionTokens.set(token, { accountUuid: ACCOUNT_UUID, createdAt: Date.now() });
    sendJson(res, {
      token,
      account:      buildProfile(email, body.name),
      organization: ORG_JSON,
      expires_at:   new Date(Date.now() + 30 * 86400000).toISOString(),
    });
    return 200;
  }

  if (pathname === '/auth/signup' && method === 'POST') {
    const body = await readBody(req);
    if (!body.email || !body.password) {
      sendJson(res, { error: 'email and password required' }, 400);
      return 400;
    }
    const token = `spoc_${crypto.randomBytes(24).toString('hex')}`;
    sessionTokens.set(token, { accountUuid: ACCOUNT_UUID, createdAt: Date.now() });
    sendJson(res, {
      token,
      account:      buildProfile(body.email, body.name),
      organization: ORG_JSON,
      expires_at:   new Date(Date.now() + 30 * 86400000).toISOString(),
    });
    return 200;
  }

  if (pathname === '/auth/logout' && method === 'POST') {
    const auth = req.headers['authorization'] || '';
    const token = auth.replace(/^Bearer\s+/i, '').replace(/^spoc_/, 'spoc_');
    sessionTokens.delete(token);
    sendJson(res, { ok: true });
    return 200;
  }

  if (pathname === '/auth/me' && method === 'GET') {
    sendJson(res, { account: buildProfile(), organization: ORG_JSON });
    return 200;
  }

  // ── Telemetry sinks (discard silently) ───────────────────────
  if (pathname === '/api/event_logging/v2/batch' && method === 'POST') {
    const body = await readBody(req);
    sendJson(res, { status: 'ok', events_received: (body?.events?.length || 0) });
    return 200;
  }

  if (pathname === '/v1/code/github/batch-branch-status' && method === 'POST') {
    const body = await readBody(req);
    const statuses = (body?.repo_branches || []).map(rb => ({
      repo: rb.repo, branch: rb.branch, status: 'unknown',
    }));
    sendJson(res, { statuses });
    return 200;
  }

  // ── Bootstrap / Identity ─────────────────────────────────────
  if (pathname.match(/^\/api\/bootstrap\/[^/]+\/current_user_access$/)) {
    sendJson(res, CURRENT_USER_ACCESS());
    return 200;
  }

  if (pathname.match(/^\/edge-api\/bootstrap\/[^/]+\/app_start$/)) {
    sendJson(res, buildAppStartBlob(ORG_UUID, ACCOUNT_UUID));
    return 200;
  }

  if (pathname === '/api/account_profile' || pathname === '/api/account/profile') {
    sendJson(res, buildProfile());
    return 200;
  }

  if (pathname === '/api/account/domain_density') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('null');
    return 200;
  }

  if (pathname === '/api/account/deletion-allowed') {
    sendJson(res, { allowed: true, reason: null });
    return 200;
  }

  if (pathname === '/v1/sessions') {
    sendJson(res, {
      sessions: [{
        uuid:        uuidv4(),
        account_uuid: ACCOUNT_UUID,
        created_at:  new Date().toISOString(),
        expires_at:  new Date(Date.now() + 30 * 86400000).toISOString(),
        device_type: 'browser',
        device_id:   DEVICE_ID,
        is_current:  true,
      }],
    });
    return 200;
  }

  // ── Organizations ─────────────────────────────────────────────
  if (pathname === '/api/organizations' && method === 'GET') {
    sendJson(res, [ORG_JSON]);
    return 200;
  }

  if (pathname === '/api/organizations/discoverable') {
    sendJson(res, { organizations: [] });
    return 200;
  }

  if (pathname.match(/^\/api\/organizations\/[^/]+$/) && method === 'GET') {
    sendJson(res, ORG_JSON);
    return 200;
  }

  if (pathname.match(/^\/api\/accounts\/[^/]+\/invites$/)) {
    sendJson(res, { invites: [] });
    return 200;
  }

  if (pathname.match(/^\/api\/oauth\/organizations\/[^/]+\/oauth_tokens$/)) {
    sendJson(res, {
      tokens: [{
        uuid:             uuidv4(),
        application_slug: parsed.query.application_slug || 'claude-code',
        scopes:           ['read', 'write'],
        created_at:       new Date().toISOString(),
        expires_at:       new Date(Date.now() + 365 * 86400000).toISOString(),
        last_used_at:     new Date().toISOString(),
        name:             'My CLI',
        is_revoked:       false,
        account_uuid:     ACCOUNT_UUID,
      }],
    });
    return 200;
  }

  // ── Org feature endpoints ─────────────────────────────────────
  if (pathname.match(/\/sync\/settings$/)) {
    if (method === 'GET') {
      sendJson(res, { google_drive_enabled: false, github_enabled: false, sync_enabled: false });
    } else {
      sendJson(res, { ok: true });
    }
    return 200;
  }

  if (pathname.match(/\/sync\/ingestion\/gdrive\/progress$/)) {
    res.writeHead(202, { 'Content-Type': 'application/json', ...corsHeaders(origin, true) });
    res.end(JSON.stringify({ progress: 0, state: 'idle' }));
    return 202;
  }

  if (pathname.match(/\/cowork_settings$/)) {
    sendJson(res, { cowork_enabled: false });
    return 200;
  }

  if (pathname.match(/\/notification\/preferences$/)) {
    if (method === 'GET') {
      sendJson(res, { email_notifications: true, in_app_notifications: true, push_notifications: false });
    } else {
      const body = await readBody(req);
      sendJson(res, { ...body, ok: true });
    }
    return 200;
  }

  if (pathname.match(/\/marketplaces\/list-default-marketplaces$/)) {
    sendJson(res, { marketplaces: [] });
    return 200;
  }

  if (pathname.match(/\/list_styles$/)) {
    if (method === 'GET') {
      sendJson(res, { styles: DEFAULT_STYLES });
    } else if (method === 'POST') {
      const body = await readBody(req);
      const newStyle = { uuid: uuidv4(), ...body, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      DEFAULT_STYLES.push(newStyle);
      sendJson(res, newStyle, 201);
    }
    return 200;
  }

  if (pathname.match(/\/skills\/list-skills$/)) {
    sendJson(res, { skills: [] });
    return 200;
  }

  // Memory
  if (pathname.match(/\/memory$/) && !pathname.match(/\/memory\/settings$/)) {
    if (method === 'GET') {
      sendJson(res, { memories: memoryStore });
    } else if (method === 'POST') {
      const body = await readBody(req);
      const mem = { uuid: uuidv4(), summary: body.summary || '', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      memoryStore.push(mem);
      sendJson(res, mem, 201);
    } else if (method === 'DELETE') {
      memoryStore.length = 0;
      res.writeHead(204); res.end();
    }
    return 200;
  }

  if (pathname.match(/\/memory\/settings$/)) {
    if (method === 'GET') {
      sendJson(res, { enabled: true, context_recency_days: 30 });
    } else {
      const body = await readBody(req);
      sendJson(res, { ...body, ok: true });
    }
    return 200;
  }

  // Memory item operations
  if (pathname.match(/\/memory\/[^/]+$/)) {
    const memId = pathname.split('/').pop();
    if (method === 'DELETE') {
      const idx = memoryStore.findIndex(m => m.uuid === memId);
      if (idx >= 0) memoryStore.splice(idx, 1);
      res.writeHead(204); res.end();
    } else if (method === 'PUT' || method === 'PATCH') {
      const body = await readBody(req);
      const mem = memoryStore.find(m => m.uuid === memId);
      if (mem) { Object.assign(mem, body, { updated_at: new Date().toISOString() }); sendJson(res, mem); }
      else sendJson(res, errorEnvelope('not_found_error', 'Memory not found'), 404);
    }
    return 200;
  }

  if (pathname.match(/\/experiences\/claude_web$/)) {
    sendJson(res, {
      experience: 'claude_web',
      locale:     parsed.query.locale || 'en-US',
      feature_flags: {},
      settings: {},
      onboarding_complete: true,
    });
    return 200;
  }

  if (pathname.match(/\/model_configs\/([^/]+)$/)) {
    const modelId = pathname.match(/\/model_configs\/([^/]+)$/)[1];
    const model = AVAILABLE_MODELS.find(m => m.id === modelId);
    sendJson(res, model || { id: modelId, display_name: modelId, is_legacy: false, max_tokens: 8000 });
    return 200;
  }

  // ── Billing ───────────────────────────────────────────────────
  if (pathname.match(/\/subscription_details/)) {
    sendJson(res, SUBSCRIPTION_DETAILS());
    return 200;
  }

  if (pathname.match(/\/paused_subscription_details$/)) {
    sendJson(res, { paused_subscription: null });
    return 200;
  }

  if (pathname.match(/\/overage_credit_grant$/)) {
    sendJson(res, { granted: false, remaining: '0.00', currency: 'usd' });
    return 200;
  }

  if (pathname.match(/\/overage_spend_limit$/)) {
    if (method === 'GET') {
      sendJson(res, {
        limit_amount:  '50.00', currency: 'usd', is_enabled: true,
        current_spend: '0.00', percent_used: 0,
        reset_at: new Date(Date.now() + 15 * 86400000).toISOString(),
      });
    } else {
      const body = await readBody(req);
      sendJson(res, { ...body, currency: 'usd' });
    }
    return 200;
  }

  if (pathname.match(/\/payment_method$/)) {
    sendJson(res, {
      payment_method: { type: 'card', brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 },
    });
    return 200;
  }

  if (pathname.match(/\/usage$/)) {
    sendJson(res, {
      current_period: { messages: 42, tokens: 15000, context_tokens: 8000 },
      limits:         { messages_per_5h: 1000, messages_per_24h: 5000, tokens_per_min: 100000 },
      period_start:   new Date(Date.now() - 15 * 86400000).toISOString(),
      period_end:     new Date(Date.now() + 15 * 86400000).toISOString(),
    });
    return 200;
  }

  if (pathname.match(/\/prepaid\/credits$/)) {
    sendJson(res, {
      credits: [{ id: `prepaid_credit_${crypto.randomBytes(12).toString('hex')}`, amount: '0.00', currency: 'usd', status: 'active', expires_at: null }],
    });
    return 200;
  }

  if (pathname.match(/\/prepaid\/bundles$/)) {
    sendJson(res, {
      bundles: [
        { id: uuidv4(), amount: '10.00',  currency: 'usd', display_name: '$10 Credit Bundle',  description: 'Purchase $10 of prepaid credits' },
        { id: uuidv4(), amount: '25.00',  currency: 'usd', display_name: '$25 Credit Bundle',  description: 'Purchase $25 of prepaid credits' },
        { id: uuidv4(), amount: '50.00',  currency: 'usd', display_name: '$50 Credit Bundle',  description: 'Purchase $50 of prepaid credits' },
        { id: uuidv4(), amount: '100.00', currency: 'usd', display_name: '$100 Credit Bundle', description: 'Purchase $100 of prepaid credits' },
      ],
    });
    return 200;
  }

  if (pathname.match(/^\/api\/stripe\/[^/]+\/balance$/)) {
    sendJson(res, { balance_amount: '0.00', currency: 'usd' });
    return 200;
  }

  if (pathname.match(/^\/api\/stripe\/[^/]+\/invoices$/)) {
    sendJson(res, { invoices: [], has_more: false, next_page: null });
    return 200;
  }

  if (pathname.match(/\/kyc_status$/)) {
    sendJson(res, { status: 'not_required', required: false });
    return 200;
  }

  if (pathname.match(/\/hipaa\/status$/)) {
    sendJson(res, { hipaa_eligible: false, baa_signed: false, baa_url: null, settings: { audit_log_enabled: false } });
    return 200;
  }

  if (pathname.match(/\/shares$/)) {
    if (method === 'GET') sendJson(res, []);
    else sendJson(res, { uuid: uuidv4(), share_url: null });
    return 200;
  }

  if (pathname.match(/\/pending_domain_claim$/)) {
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('null');
    return 200;
  }

  if (pathname.match(/\/referral\/eligibility$/)) {
    sendJson(res, { eligible: false, reason: 'already_redeemed' });
    return 200;
  }

  if (pathname.match(/\/gift\/purchase_eligibility$/)) {
    sendJson(res, { eligible: false });
    return 200;
  }

  // ── Projects ──────────────────────────────────────────────────
  if (pathname.match(/\/projects/) && method === 'GET') {
    sendJson(res, []);
    return 200;
  }

  // ── Conversations ─────────────────────────────────────────────
  if (pathname.match(/\/chat_conversations_v2$/) && method === 'GET') {
    const limit   = Math.min(parseInt(parsed.query.limit) || 30, 100);
    const starred = parsed.query.starred === 'true';
    let list = [...conversations.values()];
    if (starred) list = list.filter(c => c.is_starred);
    list = list.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)).slice(0, limit);
    sendJson(res, list);
    return 200;
  }

  if (pathname.match(/\/chat_conversations$/) && method === 'POST') {
    const body = await readBody(req);
    const conv = makeConversation(body);
    diagnostics.conversations = conversations.size;
    sendJson(res, conv, 201);
    return 201;
  }

  const convMatchGet = pathname.match(/^(\/api\/organizations\/[^/]+)?\/chat_conversations\/([^/]+)$/);
  if (convMatchGet && (method === 'GET' || method === 'DELETE' || method === 'PATCH')) {
    const convId = convMatchGet[2];
    if (method === 'DELETE') {
      conversations.delete(convId);
      convMessages.delete(convId);
      diagnostics.conversations = conversations.size;
      res.writeHead(204); res.end();
      return 204;
    }
    if (method === 'PATCH') {
      const body = await readBody(req);
      const conv = conversations.get(convId);
      if (!conv) { sendJson(res, errorEnvelope('not_found_error', 'Conversation not found'), 404); return 404; }
      Object.assign(conv, body, { updated_at: new Date().toISOString() });
      sendJson(res, conv);
      return 200;
    }
    // GET — return conversation with message tree
    const conv = conversations.get(convId);
    if (!conv) { sendJson(res, errorEnvelope('not_found_error', 'Conversation not found'), 404); return 404; }
    const msgs = convMessages.get(convId) || [];
    sendJson(res, { ...conv, messages: msgs });
    return 200;
  }

  // Title
  if (pathname.match(/\/chat_conversations\/[^/]+\/title$/) && method === 'POST') {
    const convId = pathname.match(/\/chat_conversations\/([^/]+)\/title$/)[1];
    const body   = await readBody(req);
    const conv   = conversations.get(convId);
    const title  = body.title || autoTitle(body.prompt || '');
    if (conv) { conv.name = title; conv.updated_at = new Date().toISOString(); }
    sendJson(res, { name: title });
    return 200;
  }

  // Star / unstar
  if (pathname.match(/\/chat_conversations\/[^/]+\/star$/) && (method === 'POST' || method === 'DELETE')) {
    const convId = pathname.match(/\/chat_conversations\/([^/]+)\/star$/)[1];
    const conv   = conversations.get(convId);
    if (conv) conv.is_starred = method === 'POST';
    sendJson(res, { ok: true });
    return 200;
  }

  // Completion status poll
  if (pathname.match(/\/completion_status$/) && method === 'GET') {
    sendJson(res, { status: 'idle' });
    return 200;
  }

  // ── COMPLETION — main SSE endpoint ───────────────────────────
  const completionMatch = pathname.match(/\/chat_conversations\/([^/]+)\/completion$/);
  if (completionMatch && method === 'POST') {
    const convId = completionMatch[1];
    const body   = await readBody(req);
    const model  = resolveModelAlias(body.model || config.default_model);

    // Ensure conversation exists
    if (!conversations.has(convId)) {
      const newConv = makeConversation({ model });
      newConv.uuid  = convId;
      conversations.set(convId, newConv);
      convMessages.set(convId, []);
    }

    const parentUuid = conversations.get(convId)?.current_leaf_message_uuid || null;
    const humanMsg   = addMessage(convId, 'user', body.prompt || '', parentUuid, model);

    // Apply mutation pre-dispatch
    const mutated = applyMutation(body);

    // Route to backend
    if (config.auth_mode === 'cookie_bridge' || config.backend === 'cookie_bridge') {
      dispatchToBridge(req, res, mutated, pathname, 'POST');
      return 200;
    }

    if (config.backend === 'anthropic' && (config.api_key || config.oauth_token)) {
      // Translate claude.ai format → /v1/messages and proxy
      const anthropicBody = {
        model,
        messages:   [{ role: 'user', content: body.prompt || '' }],
        max_tokens: 4096,
        stream:     true,
        ...(mutated.system_prompt_override ? { system: mutated.system_prompt_override } : {}),
        tools:      body.tools || [],
      };
      proxyRequest(req, res, anthropicBody, '/v1/messages', 'POST');
      return 200;
    }

    if ((config.backend === 'lm_studio' || config.backend === 'openrouter' || config.backend === 'custom') &&
        resolveBackendUrl(config.backend)) {
      // Translate to OpenAI format for LM Studio / OpenRouter
      const oaiBody = anthropicToOpenAI(openaiToAnthropic(mutated));
      proxyRequest(req, res, oaiBody, '/v1/chat/completions', 'POST');
      return 200;
    }

    // Mock fallback (no backend configured or no-key mode)
    const inputToks = Math.ceil((body.prompt || '').length / 4);
    const mockText  = `[Sister PoC — model: ${model} | backend: ${config.backend} | auth: ${config.auth_mode}]\n\n${body.prompt || '(empty prompt)'}`;

    res.writeHead(200, sseStartHeaders(reqId, origin));
    const pingTimer = setInterval(() => {
      try { res.write('event: ping\ndata: {"type":"ping"}\n\n'); } catch {}
    }, 14000);

    emitAnthropicTextStream(res, reqId, mockText, model, inputToks);
    clearInterval(pingTimer);
    res.end();

    addMessage(convId, 'assistant', mockText, humanMsg.uuid, model);
    diagnostics.sseStreams++;
    return 200;
  }

  // ── Artifact versions ─────────────────────────────────────────
  if (pathname.match(/\/artifacts\/[^/]+\/versions$/) && method === 'GET') {
    const artId = pathname.match(/\/artifacts\/([^/]+)\/versions$/)[1];
    const art   = artifacts.get(artId);
    sendJson(res, { versions: art?.versions || [], artifact_uuid: artId });
    return 200;
  }

  if (pathname.match(/\/artifacts\/[^/]+\/versions$/) && method === 'POST') {
    const body  = await readBody(req);
    const artId = pathname.match(/\/artifacts\/([^/]+)\/versions$/)[1];
    const convId = body.conv_uuid || '';
    const ver   = addArtifactVersion(convId, artId, body.content, body.language, body.title);
    sendJson(res, ver, 201);
    return 201;
  }

  // File preview
  if (pathname.match(/\/files\/[^/]+\/preview$/)) {
    sendJson(res, { url: null, expires_at: null, content_type: 'application/octet-stream' });
    return 200;
  }

  // ── Anthropic-compat /v1/messages ─────────────────────────────
  if (pathname === '/v1/messages' && method === 'POST') {
    const body    = await readBody(req);
    const mutated = applyMutation(body);
    const model   = resolveModelAlias(body.model || config.default_model);

    if (config.auth_mode === 'cookie_bridge' || config.backend === 'cookie_bridge') {
      const claudeBody = anthropicToClaudeSite(mutated, null);
      const tempConv   = makeConversation({ model });
      dispatchToBridge(req, res, claudeBody, `/api/organizations/${ORG_UUID}/chat_conversations/${tempConv.uuid}/completion`, 'POST');
      return 200;
    }

    if (config.backend === 'lm_studio' || config.backend === 'openrouter' || config.backend === 'custom') {
      const oaiBody = anthropicToOpenAI(mutated);
      if (resolveBackendUrl(config.backend)) {
        if (body.stream !== false) {
          // Need to translate OpenAI SSE back to Anthropic SSE
          return await proxyAndTranslateOAItoAnthropic(req, res, oaiBody, reqId, origin);
        }
        proxyRequest(req, res, oaiBody, '/v1/chat/completions', 'POST');
        return 200;
      }
    }

    if ((config.api_key || config.oauth_token) && resolveBackendUrl('anthropic')) {
      proxyRequest(req, res, mutated, '/v1/messages', 'POST');
      return 200;
    }

    // Mock
    if (body.stream !== false) {
      res.writeHead(200, sseStartHeaders(reqId, origin));
      const prompt = extractLastUserText(body.messages);
      emitAnthropicTextStream(res, reqId, `Mock /v1/messages: ${prompt}`, model,
        Math.ceil(JSON.stringify(body).length / 4));
      res.end();
    } else {
      sendJson(res, {
        id:            `msg_${crypto.randomBytes(12).toString('hex')}`,
        type:          'message', role: 'assistant', model,
        content:       [{ type: 'text', text: 'Mock /v1/messages response' }],
        stop_reason:   'end_turn', stop_sequence: null,
        usage:         { input_tokens: 10, output_tokens: 5 },
      });
    }
    return 200;
  }

  if (pathname === '/v1/messages/count_tokens' && method === 'POST') {
    const body = await readBody(req);
    sendJson(res, { input_tokens: Math.ceil(JSON.stringify(body).length / 4) });
    return 200;
  }

  // ── OpenAI-compat /v1/chat/completions ────────────────────────
  if (pathname === '/v1/chat/completions' && method === 'POST') {
    const body    = await readBody(req);
    const mutated = applyMutation(body);
    const model   = resolveModelAlias(body.model || config.default_model);

    if (config.auth_mode === 'cookie_bridge' || config.backend === 'cookie_bridge') {
      const anthropicBody = openaiToAnthropic(mutated);
      const claudeBody    = anthropicToClaudeSite(anthropicBody, null);
      const tempConv      = makeConversation({ model });
      dispatchToBridge(req, res, claudeBody, `/api/organizations/${ORG_UUID}/chat_conversations/${tempConv.uuid}/completion`, 'POST');
      return 200;
    }

    if (config.backend === 'anthropic' && (config.api_key || config.oauth_token)) {
      const anthropicBody = openaiToAnthropic(mutated);
      // proxy and translate Anthropic SSE → OpenAI SSE on the way back
      proxyRequest(req, res, anthropicBody, '/v1/messages', 'POST');
      return 200;
    }

    if (resolveBackendUrl(config.backend)) {
      proxyRequest(req, res, mutated, '/v1/chat/completions', 'POST');
      return 200;
    }

    // Mock
    if (body.stream !== false) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'request-id': reqId,
        ...corsHeaders(origin, true),
      });
      const content = body.messages?.slice(-1)[0]?.content || 'mock';
      emitOpenAITextStream(res, reqId, `Mock chat/completions: ${content}`, model);
      res.end();
    } else {
      sendJson(res, {
        id:      `chatcmpl-${crypto.randomBytes(8).toString('hex')}`,
        object:  'chat.completion', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'Mock response' }, finish_reason: 'stop' }],
        usage:   { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    }
    return 200;
  }

  // ── Models list ───────────────────────────────────────────────
  if (pathname === '/v1/models' && method === 'GET') {
    const openAIFormat = req.headers['x-format'] === 'openai'
      || req.headers['accept-format'] === 'openai'
      || config.backend === 'lm_studio'
      || config.backend === 'openrouter';

    if (openAIFormat) {
      sendJson(res, {
        object: 'list',
        data:   AVAILABLE_MODELS.map(m => ({
          id: m.id, object: 'model', created: 1700000000, owned_by: 'anthropic',
        })),
      });
    } else {
      sendJson(res, { models: AVAILABLE_MODELS });
    }
    return 200;
  }

  // ── i18n stubs ────────────────────────────────────────────────
  if (pathname.match(/^\/i18n\//)) {
    sendJson(res, {});
    return 200;
  }

  if (pathname === '/manifest.json') {
    sendJson(res, { name: 'Sister PoC', short_name: 'SPoC', version: SERVER_VERSION });
    return 200;
  }

  // ── 404 ───────────────────────────────────────────────────────
  diagnostics.lastError = `404: ${method} ${pathname}`;
  sendJson(res, errorEnvelope('not_found_error', `No handler: ${method} ${pathname}`), 404);
  return 404;
}

// ────────────────────────────────────────────────────────────────
// PROXY + TRANSLATE: OpenAI SSE → Anthropic SSE (for LM Studio)
// ────────────────────────────────────────────────────────────────
async function proxyAndTranslateOAItoAnthropic(req, res, oaiBody, reqId, origin) {
  const backendUrl = resolveBackendUrl(config.backend);
  if (!backendUrl) {
    sendJson(res, errorEnvelope('api_error', 'No backend'), 500);
    return 500;
  }

  const bodyStr  = JSON.stringify(oaiBody);
  const model    = oaiBody.model || config.default_model;
  const authHdrs = buildAuthHeaders(config.auth_mode);

  const targetUrl = new URL(backendUrl + '/v1/chat/completions');
  if (isBlockedUrl(targetUrl.toString())) {
    sendJson(res, errorEnvelope('permission_error', 'Blocked host'), 403);
    return 403;
  }

  const msgId   = `msg_${crypto.randomBytes(12).toString('hex')}`;
  let   started = false;
  let   blockIndex = 0;
  let   inputToks  = 0;
  let   outputToks = 0;

  const options = {
    hostname: targetUrl.hostname,
    port:     targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
    path:     targetUrl.pathname,
    method:   'POST',
    headers: {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      'Accept':         'text/event-stream',
      ...authHdrs,
    },
    timeout: config.request_timeout_ms,
  };

  const transport = targetUrl.protocol === 'https:' ? https : http;

  return new Promise((resolve) => {
    const proxyReq = transport.request(options, (proxyRes) => {
      res.writeHead(200, sseStartHeaders(reqId, origin));

      let buffer = '';

      proxyRes.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const dataStr = line.slice(6).trim();
          if (dataStr === '[DONE]') {
            // Close out the Anthropic stream
            if (started) {
              writeSSEEvent(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
              writeSSEEvent(res, 'message_delta', {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn', stop_sequence: null },
                usage: { output_tokens: outputToks, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
              });
              writeSSEEvent(res, 'message_stop', { type: 'message_stop' });
            }
            try { res.end(); } catch {}
            resolve(200);
            return;
          }

          try {
            const chunk_parsed = JSON.parse(dataStr);
            const choice = chunk_parsed.choices?.[0];
            if (!choice) continue;

            const delta = choice.delta;

            if (!started && delta?.role === 'assistant') {
              // Emit message_start
              writeSSEEvent(res, 'message_start', {
                type: 'message_start',
                message: {
                  id: msgId, type: 'message', role: 'assistant', model,
                  content: [], stop_reason: null, stop_sequence: null,
                  usage: { input_tokens: inputToks, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
                },
              });
              writeSSEEvent(res, 'content_block_start', {
                type: 'content_block_start', index: 0,
                content_block: { type: 'text', text: '' },
              });
              started = true;
            }

            if (delta?.content) {
              outputToks++;
              writeSSEEvent(res, 'content_block_delta', {
                type: 'content_block_delta', index: blockIndex,
                delta: { type: 'text_delta', text: delta.content },
              });
            }

            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (tc.function?.arguments) {
                  writeSSEEvent(res, 'content_block_delta', {
                    type: 'content_block_delta', index: blockIndex,
                    delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
                  });
                }
              }
            }

            if (choice.finish_reason && choice.finish_reason !== 'null') {
              // Handled by [DONE] above, but close if we get stop first
            }
          } catch {}
        }
      });

      proxyRes.on('end', () => {
        if (!res.writableEnded) {
          if (started) {
            writeSSEEvent(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
            writeSSEEvent(res, 'message_delta', {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: { output_tokens: outputToks, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            });
            writeSSEEvent(res, 'message_stop', { type: 'message_stop' });
          }
          try { res.end(); } catch {}
        }
        resolve(200);
      });

      proxyRes.on('error', (e) => {
        if (!res.writableEnded) {
          writeSSEEvent(res, 'error', { type: 'error', error: { type: 'api_error', message: e.message } });
          try { res.end(); } catch {}
        }
        resolve(500);
      });
    });

    proxyReq.on('error', (e) => {
      sendJson(res, errorEnvelope('api_error', e.message), 502);
      resolve(502);
    });

    proxyReq.write(bodyStr);
    proxyReq.end();
  });
}

// ────────────────────────────────────────────────────────────────
// MISC HELPERS
// ────────────────────────────────────────────────────────────────
function extractLastUserText(messages) {
  if (!Array.isArray(messages)) return '';
  const last = [...messages].reverse().find(m => m.role === 'user');
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  if (Array.isArray(last.content)) {
    return last.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  }
  return '';
}

// ────────────────────────────────────────────────────────────────
// SETUP PAGE
// ────────────────────────────────────────────────────────────────
function serveSetupPage(res) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sister PoC — Worker A</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Courier New',monospace;background:#0d1117;color:#c9d1d9;padding:2rem;max-width:960px;margin:0 auto}
h1{color:#f0b429;font-size:1.5rem;margin-bottom:0.5rem}
.sub{color:#8b949e;font-size:0.78rem;margin-bottom:2rem}
h2{color:#79c0ff;font-size:0.95rem;margin:1.5rem 0 0.75rem;border-bottom:1px solid #21262d;padding-bottom:0.3rem}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:1.5rem}
@media(max-width:640px){.grid{grid-template-columns:1fr}}
.field{margin-bottom:0.9rem}
label{display:block;font-size:0.78rem;color:#8b949e;margin-bottom:0.25rem;letter-spacing:.03em}
input,select,textarea{width:100%;background:#161b22;border:1px solid #30363d;color:#c9d1d9;padding:0.5rem 0.65rem;border-radius:4px;font-family:inherit;font-size:0.85rem;transition:border-color .15s}
input:focus,select:focus,textarea:focus{outline:none;border-color:#f0b429}
textarea{resize:vertical;min-height:80px}
select option{background:#161b22}
.btn{background:#f0b429;color:#0d1117;border:none;padding:0.6rem 1.8rem;border-radius:4px;cursor:pointer;font-weight:700;font-family:inherit;font-size:0.9rem;margin-top:1rem;transition:background .15s}
.btn:hover{background:#e9a020}
.status{margin-top:0.75rem;padding:0.5rem 0.75rem;background:#161b22;border-left:3px solid #f0b429;font-size:0.8rem;display:none;border-radius:0 4px 4px 0}
.badge{display:inline-block;padding:0.15rem 0.5rem;border-radius:3px;font-size:0.72rem;font-weight:700;margin-left:0.5rem}
.badge-ok{background:#0d4429;color:#3fb950}
.badge-err{background:#3d1c1c;color:#f85149}
#workerStatus{margin-bottom:1.5rem;padding:0.75rem;background:#161b22;border:1px solid #30363d;border-radius:6px;font-size:0.82rem}
</style>
</head>
<body>
<h1>⚡ Worker A</h1>
<p class="sub">Sister PoC — Local Bridge Server v${SERVER_VERSION}<br>Research artifact · Anthropic HackerOne VDP only · Single-operator localhost</p>

<div id="workerStatus">Loading status...</div>

<div class="grid">
<div>
<h2>Backend</h2>
<div class="field"><label>Backend type</label>
<select id="backend" onchange="backendChange()">
<option value="lm_studio">LM Studio (no key)</option>
<option value="openrouter">OpenRouter (API key)</option>
<option value="anthropic">Anthropic API (key/OAuth)</option>
<option value="cookie_bridge">claude.ai bridge (Worker C)</option>
<option value="custom">Custom URL</option>
</select></div>
<div class="field"><label>LM Studio URL</label><input id="lm_studio_url" value="http://127.0.0.1:1234/v1"></div>
<div class="field"><label>OpenRouter URL</label><input id="openrouter_url" value="https://openrouter.ai/api/v1"></div>
<div class="field" id="customField" style="display:none"><label>Custom URL</label><input id="custom_url" placeholder="http://localhost:PORT/v1"></div>
<div class="field"><label>HTTP-Referer (OpenRouter)</label><input id="http_referer" placeholder="https://your-site.com"></div>
<div class="field"><label>X-Title (OpenRouter)</label><input id="x_title" placeholder="Sister PoC"></div>
</div>
<div>
<h2>Auth Mode</h2>
<div class="field"><label>Auth mode (4 separate paths)</label>
<select id="auth_mode">
<option value="no_key">No key (LM Studio / local)</option>
<option value="api_key">API key (x-api-key)</option>
<option value="oauth">OAuth token (Bearer)</option>
<option value="cookie_bridge">Session cookie (Worker C)</option>
</select></div>
<div class="field"><label>API key (sk-ant-api03-...)</label><input id="api_key" type="password" placeholder="sk-ant-api03-..."></div>
<div class="field"><label>OAuth token (sk-ant-oat01-...)</label><input id="oauth_token" type="password" placeholder="sk-ant-oat01-..."></div>
</div>
</div>

<h2>Model &amp; Mutation</h2>
<div class="grid">
<div class="field"><label>Default model</label>
<select id="default_model">
<option value="claude-opus-4-6">Claude Opus 4.6</option>
<option value="claude-sonnet-4-6" selected>Claude Sonnet 4.6</option>
<option value="claude-haiku-4-5-20251001">Claude Haiku 4.5</option>
</select></div>
<div class="field"><label>System prompt mutation (applies to ALL auth modes)</label>
<select id="mutation_mode">
<option value="strip_replace">Strip &amp; replace</option>
<option value="prepend">Prepend to existing</option>
<option value="append">Append to existing</option>
</select></div>
</div>
<div class="field"><label>System prompt override (blank = disabled)</label>
<textarea id="system_prompt_override" placeholder="Enter system prompt override here. Applied pre-auth to all four paths."></textarea></div>

<button class="btn" onclick="save()">Save &amp; apply</button>
<div class="status" id="status"></div>

<script>
async function loadStatus(){
  try{
    const r=await fetch('/health');
    const d=await r.json();
    const wc=d.worker_c_connected;
    document.getElementById('workerStatus').innerHTML=
      'Status: <b style="color:#3fb950">running</b> · '+
      'Worker C: <span class="badge '+(wc?'badge-ok':'badge-err')+'">'+(wc?'connected':'disconnected')+'</span> · '+
      'Auth: <b>'+d.auth_mode+'</b> · Backend: <b>'+d.backend+'</b> · '+
      'Conversations: <b>'+d.conversations+'</b> · '+
      'Bridge pending: <b>'+d.pending_bridge+'</b>';
  }catch(e){
    document.getElementById('workerStatus').innerHTML='Status: <span style="color:#f85149">unreachable</span>';
  }
}
function backendChange(){
  const v=document.getElementById('backend').value;
  document.getElementById('customField').style.display=v==='custom'?'':'none';
}
async function save(){
  const cfg={
    backend:document.getElementById('backend').value,
    auth_mode:document.getElementById('auth_mode').value,
    default_model:document.getElementById('default_model').value,
    mutation_mode:document.getElementById('mutation_mode').value,
    system_prompt_override:document.getElementById('system_prompt_override').value,
    api_key:document.getElementById('api_key').value,
    oauth_token:document.getElementById('oauth_token').value,
    http_referer:document.getElementById('http_referer').value,
    x_title:document.getElementById('x_title').value,
    backend_urls:{
      lm_studio:document.getElementById('lm_studio_url').value,
      openrouter:document.getElementById('openrouter_url').value,
      custom:document.getElementById('custom_url').value,
    },
  };
  const r=await fetch('/bridge/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(cfg)});
  const st=document.getElementById('status');
  st.style.display='block';
  if(r.ok){st.style.borderColor='#3fb950';st.textContent='✓ Saved and applied';}
  else{st.style.borderColor='#f85149';st.textContent='✗ Failed: '+r.status;}
  loadStatus();
}
loadStatus();
setInterval(loadStatus,10000);
</script>
</body>
</html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

// ────────────────────────────────────────────────────────────────
// SERVER STARTUP
// ────────────────────────────────────────────────────────────────
loadConfig();
watchConfig();

const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (e) {
    diagnostics.lastError = e.message;
    console.error('[worker-a] Fatal handler error:', e);
    if (!res.headersSent) {
      sendJson(res, errorEnvelope('api_error', 'Internal server error'), 500);
    }
  }
});

// WS upgrade routing — only /ws goes to the bridge, everything else gets destroyed
server.on('upgrade', (req, socket, head) => {
  const { pathname } = urlMod.parse(req.url);
  if (pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  }
});

const PORT = parseInt(process.env.PORT || '') || config.port;
const HOST = process.env.HOST || config.host;

// Boot-time smoke checks
function smokeCheck() {
  let ok = true;
  // Verify blocked-host list is loaded
  if (!BLOCKED_HOSTS.has('api.anthropic.com')) {
    console.error('[worker-a] SMOKE FAIL: blocked-host list missing api.anthropic.com');
    ok = false;
  }
  // Verify no startup error in config load
  if (!config.port) {
    console.error('[worker-a] SMOKE FAIL: config.port missing');
    ok = false;
  }
  if (ok) console.log('[worker-a] Smoke check: PASS');
  return ok;
}

if (!smokeCheck()) {
  console.error('[worker-a] Smoke check failed — aborting');
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  WORKER A — Sister PoC Bridge Server         ║');
  console.log('║  Research artifact · Anthropic VDP only      ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`\n  HTTP:   http://${HOST}:${PORT}`);
  console.log(`  WS:     ws://${HOST}:${PORT}/ws`);
  console.log(`  Setup:  http://${HOST}:${PORT}/setup`);
  console.log(`  Health: http://${HOST}:${PORT}/health`);
  console.log(`  Diag:   http://${HOST}:${PORT}/diag`);
  console.log(`\n  Auth mode:    ${config.auth_mode}`);
  console.log(`  Backend:      ${config.backend}`);
  console.log(`  Default model:${config.default_model}`);
  console.log(`  Mutation:     ${config.mutation_mode}`);
  console.log(`  Config:       ${CONFIG_PATH}`);
  console.log(`\n  Blocked hosts: ${[...BLOCKED_HOSTS].join(', ')}`);
  console.log('\n  Worker B → http://localhost:8788 (run worker_b separately)');
  console.log('  Worker C → install userscript in Tampermonkey\n');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[worker-a] Port ${PORT} already in use. Change config.port or kill the existing process.`);
  } else {
    console.error('[worker-a] Server error:', e.message);
  }
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n[worker-a] Shutting down gracefully...');
  // Close pending bridge requests
  for (const [id, p] of pendingBridge.entries()) {
    clearTimeout(p.timeout);
    try { p.res.end(); } catch {}
  }
  pendingBridge.clear();
  wss.close();
  server.close(() => {
    console.log('[worker-a] Server closed.');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000);
});

process.on('uncaughtException', (e) => {
  diagnostics.lastError = e.message;
  console.error('[worker-a] Uncaught exception:', e.message);
});

process.on('unhandledRejection', (r) => {
  diagnostics.lastError = String(r);
  console.error('[worker-a] Unhandled rejection:', r);
});

