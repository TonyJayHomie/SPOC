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
  const entry = {
    ts:         new Date().toISOString(),
    id:         requestId,
    method,
    path:       pathname,
    status,
    duration_ms: durationMs,
  };
  appendToRequestLog(entry);
  if (!config.log_requests) return;
  const line = `${entry.ts} ${requestId} ${method} ${pathname} → ${status} (${durationMs}ms)\n`;
  try { fs.appendFileSync(LOG_PATH, line); } catch {}
  if (status >= 400) process.stderr.write('[worker-a] ' + line);
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
// EXTENDED SSE EMITTERS — tool_use and extended_thinking blocks
// ────────────────────────────────────────────────────────────────

// Emit a complete Anthropic SSE stream that includes tool_use blocks
// toolCalls: [{ name, input: {…}, id? }]
function emitAnthropicToolUseStream(res, requestId, toolCalls, model, textBefore) {
  const msgId     = `msg_${crypto.randomBytes(12).toString('hex')}`;
  const inputToks = 50;

  writeSSEEvent(res, 'message_start', {
    type: 'message_start',
    message: {
      id: msgId, type: 'message', role: 'assistant', model,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: inputToks, output_tokens: 1,
               cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  });

  let blockIdx = 0;

  // Optional text before tool call
  if (textBefore) {
    writeSSEEvent(res, 'content_block_start', {
      type: 'content_block_start', index: blockIdx,
      content_block: { type: 'text', text: '' },
    });
    const sz = 25;
    for (let i = 0; i < textBefore.length; i += sz) {
      writeSSEEvent(res, 'content_block_delta', {
        type: 'content_block_delta', index: blockIdx,
        delta: { type: 'text_delta', text: textBefore.slice(i, i + sz) },
      });
    }
    writeSSEEvent(res, 'content_block_stop', { type: 'content_block_stop', index: blockIdx });
    blockIdx++;
  }

  // Tool call blocks
  let outputToks = textBefore ? Math.ceil(textBefore.split(/\s+/).length * 1.3) : 0;
  for (const tc of toolCalls) {
    const toolId = tc.id || `toolu_${crypto.randomBytes(10).toString('hex')}`;
    const inputStr = JSON.stringify(tc.input || {});
    outputToks += Math.ceil(inputStr.length / 4);

    writeSSEEvent(res, 'content_block_start', {
      type: 'content_block_start', index: blockIdx,
      content_block: { type: 'tool_use', id: toolId, name: tc.name, input: {} },
    });

    // Stream input JSON as partial_json deltas
    const sz = 30;
    for (let i = 0; i < inputStr.length; i += sz) {
      writeSSEEvent(res, 'content_block_delta', {
        type: 'content_block_delta', index: blockIdx,
        delta: { type: 'input_json_delta', partial_json: inputStr.slice(i, i + sz) },
      });
    }

    writeSSEEvent(res, 'content_block_stop', { type: 'content_block_stop', index: blockIdx });
    blockIdx++;
  }

  writeSSEEvent(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: { output_tokens: outputToks,
             cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  });
  writeSSEEvent(res, 'message_stop', { type: 'message_stop' });
}

// Emit extended_thinking + optional text
function emitAnthropicThinkingStream(res, requestId, thinkingText, responseText, model) {
  const msgId     = `msg_${crypto.randomBytes(12).toString('hex')}`;
  const thinkingId = `thinking_${crypto.randomBytes(10).toString('hex')}`;

  writeSSEEvent(res, 'message_start', {
    type: 'message_start',
    message: {
      id: msgId, type: 'message', role: 'assistant', model,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 50, output_tokens: 1,
               cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  });

  // thinking block
  writeSSEEvent(res, 'content_block_start', {
    type: 'content_block_start', index: 0,
    content_block: { type: 'thinking', thinking: '' },
  });
  const sz = 30;
  for (let i = 0; i < thinkingText.length; i += sz) {
    writeSSEEvent(res, 'content_block_delta', {
      type: 'content_block_delta', index: 0,
      delta: { type: 'thinking_delta', thinking: thinkingText.slice(i, i + sz) },
    });
  }
  writeSSEEvent(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });

  // text block
  writeSSEEvent(res, 'content_block_start', {
    type: 'content_block_start', index: 1,
    content_block: { type: 'text', text: '' },
  });
  for (let i = 0; i < responseText.length; i += sz) {
    writeSSEEvent(res, 'content_block_delta', {
      type: 'content_block_delta', index: 1,
      delta: { type: 'text_delta', text: responseText.slice(i, i + sz) },
    });
  }
  writeSSEEvent(res, 'content_block_stop', { type: 'content_block_stop', index: 1 });

  const outputToks = Math.ceil((thinkingText.length + responseText.length) / 4);
  writeSSEEvent(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: outputToks,
             cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  });
  writeSSEEvent(res, 'message_stop', { type: 'message_stop' });
}

// ────────────────────────────────────────────────────────────────
// RATE LIMIT TRACKER — synthesise anthropic-ratelimit-* headers
// ────────────────────────────────────────────────────────────────
const rlState = {
  requests_limit:         1000,
  requests_remaining:     1000,
  requests_reset:         new Date(Date.now() + 3600000).toISOString(),
  tokens_limit:           100000,
  tokens_remaining:       100000,
  tokens_reset:           new Date(Date.now() + 60000).toISOString(),
  input_tokens_limit:     80000,
  input_tokens_remaining: 80000,
  input_tokens_reset:     new Date(Date.now() + 60000).toISOString(),
  output_tokens_limit:    20000,
  output_tokens_remaining:20000,
  output_tokens_reset:    new Date(Date.now() + 60000).toISOString(),
};

function consumeRateLimit(inputToks, outputToks) {
  rlState.requests_remaining = Math.max(0, rlState.requests_remaining - 1);
  rlState.tokens_remaining   = Math.max(0, rlState.tokens_remaining - inputToks - outputToks);
  rlState.input_tokens_remaining  = Math.max(0, rlState.input_tokens_remaining - inputToks);
  rlState.output_tokens_remaining = Math.max(0, rlState.output_tokens_remaining - outputToks);
  // Reset counters hourly
  const now = Date.now();
  if (now > new Date(rlState.requests_reset).getTime()) {
    rlState.requests_remaining = rlState.requests_limit;
    rlState.requests_reset = new Date(now + 3600000).toISOString();
  }
  if (now > new Date(rlState.tokens_reset).getTime()) {
    rlState.tokens_remaining = rlState.tokens_limit;
    rlState.tokens_reset = new Date(now + 60000).toISOString();
  }
}

function buildRateLimitHeaders() {
  return {
    'anthropic-ratelimit-requests-limit':            String(rlState.requests_limit),
    'anthropic-ratelimit-requests-remaining':        String(rlState.requests_remaining),
    'anthropic-ratelimit-requests-reset':            rlState.requests_reset,
    'anthropic-ratelimit-tokens-limit':              String(rlState.tokens_limit),
    'anthropic-ratelimit-tokens-remaining':          String(rlState.tokens_remaining),
    'anthropic-ratelimit-tokens-reset':              rlState.tokens_reset,
    'anthropic-ratelimit-input-tokens-limit':        String(rlState.input_tokens_limit),
    'anthropic-ratelimit-input-tokens-remaining':    String(rlState.input_tokens_remaining),
    'anthropic-ratelimit-input-tokens-reset':        rlState.input_tokens_reset,
    'anthropic-ratelimit-output-tokens-limit':       String(rlState.output_tokens_limit),
    'anthropic-ratelimit-output-tokens-remaining':   String(rlState.output_tokens_remaining),
    'anthropic-ratelimit-output-tokens-reset':       rlState.output_tokens_reset,
  };
}

// ────────────────────────────────────────────────────────────────
// PROJECTS STORE — full CRUD with members, docs, files
// ────────────────────────────────────────────────────────────────
const projects     = new Map(); // project_uuid → project
const projectDocs  = new Map(); // project_uuid → [doc, ...]
const projectFiles = new Map(); // project_uuid → [file, ...]

function makeProject(params = {}) {
  const proj = {
    uuid:           params.uuid || uuidv4(),
    name:           params.name || 'Untitled Project',
    description:    params.description || '',
    summary:        params.summary || '',
    created_at:     new Date().toISOString(),
    updated_at:     new Date().toISOString(),
    creator_uuid:   ACCOUNT_UUID,
    organization_uuid: ORG_UUID,
    is_private:     params.is_private !== false,
    archived_at:    null,
    color:          params.color || '#4A9EFF',
    emoji:          params.emoji || null,
    member_count:   1,
    conversation_count: 0,
    members: [{
      uuid:        ACCOUNT_UUID,
      role:        'admin',
      joined_at:   new Date().toISOString(),
      permissions: ['read', 'write', 'admin'],
    }],
    settings: {
      default_model:          params.model || config.default_model,
      artifacts_enabled:      true,
      memory_enabled:         true,
      web_search_enabled:     true,
      repl_enabled:           true,
      prompt_template:        params.prompt_template || '',
    },
  };
  projects.set(proj.uuid, proj);
  projectDocs.set(proj.uuid, []);
  projectFiles.set(proj.uuid, []);
  return proj;
}

function makeProjectDoc(projUuid, params = {}) {
  const doc = {
    uuid:        uuidv4(),
    project_uuid: projUuid,
    title:       params.title || 'Untitled',
    content:     params.content || '',
    mime_type:   params.mime_type || 'text/plain',
    size:        (params.content || '').length,
    created_at:  new Date().toISOString(),
    updated_at:  new Date().toISOString(),
    creator_uuid: ACCOUNT_UUID,
  };
  const list = projectDocs.get(projUuid) || [];
  list.push(doc);
  projectDocs.set(projUuid, list);
  return doc;
}

// ────────────────────────────────────────────────────────────────
// FILE STORE — mock multipart upload
// ────────────────────────────────────────────────────────────────
const fileStore = new Map(); // file_uuid → file object

function makeFileRecord(filename, mimeType, size, convUuid) {
  const fid = uuidv4();
  const record = {
    file_uuid:    fid,
    id:           fid,
    filename:     filename || 'upload.bin',
    mime_type:    mimeType || 'application/octet-stream',
    size:         size || 0,
    status:       'processed',
    created_at:   new Date().toISOString(),
    expires_at:   new Date(Date.now() + 3600000).toISOString(),
    conversation_uuid: convUuid || null,
    download_url: null,
    preview_url:  null,
    metadata:     {},
  };
  fileStore.set(fid, record);
  return record;
}

// Parse Content-Type boundary for multipart (basic)
function parseMultipartBoundary(contentType) {
  const m = contentType?.match(/boundary=([^\s;]+)/i);
  return m ? m[1] : null;
}

// ────────────────────────────────────────────────────────────────
// SHARE STORE — share links
// ────────────────────────────────────────────────────────────────
const shareStore = new Map(); // share_uuid → share

function makeShare(convUuid, params = {}) {
  const sh = {
    uuid:             uuidv4(),
    conversation_uuid: convUuid,
    share_token:      crypto.randomBytes(24).toString('base64url'),
    title:            params.title || '',
    is_public:        params.is_public !== false,
    created_at:       new Date().toISOString(),
    updated_at:       new Date().toISOString(),
    expires_at:       params.expires_at || null,
    view_count:       0,
    settings: {
      show_user_messages: true,
      show_system_prompt: false,
    },
  };
  sh.share_url = `http://localhost:${config.port || 8787}/share/${sh.share_token}`;
  shareStore.set(sh.uuid, sh);
  return sh;
}

// ────────────────────────────────────────────────────────────────
// NOTIFICATION STORE
// ────────────────────────────────────────────────────────────────
const notifications = [];

function addNotification(type, title, body, data = {}) {
  notifications.push({
    uuid:       uuidv4(),
    type,
    title,
    body,
    data,
    read:       false,
    created_at: new Date().toISOString(),
  });
}

// ────────────────────────────────────────────────────────────────
// MESSAGE BRANCHING — parent_message_uuid tree support
// ────────────────────────────────────────────────────────────────

// Build a linear message list from a conversation by following the
// leaf → root path through parent_message_uuid links
function buildMessageChain(convUuid, leafUuid) {
  const all = convMessages.get(convUuid) || [];
  if (!leafUuid) return all;

  const byUuid = new Map(all.map(m => [m.uuid, m]));
  const chain  = [];
  let cur      = byUuid.get(leafUuid);
  const visited = new Set();

  while (cur && !visited.has(cur.uuid)) {
    visited.add(cur.uuid);
    chain.unshift(cur);
    cur = byUuid.get(cur.parent_message_uuid);
  }
  return chain;
}

// Get all branches from a given message uuid
function getMessageBranches(convUuid, fromUuid) {
  const all = convMessages.get(convUuid) || [];
  return all.filter(m => m.parent_message_uuid === fromUuid);
}

// ────────────────────────────────────────────────────────────────
// CLAUDE CODE SPECIFIC — /v1/code/* endpoints
// ────────────────────────────────────────────────────────────────
const claudeCodeSessions = new Map(); // session_id → session

function makeCodeSession(params = {}) {
  const s = {
    id:           uuidv4(),
    account_uuid: ACCOUNT_UUID,
    org_uuid:     ORG_UUID,
    created_at:   new Date().toISOString(),
    last_active:  new Date().toISOString(),
    model:        params.model || config.default_model,
    working_dir:  params.working_dir || '/home/user',
    git_root:     params.git_root || null,
    tools_enabled: true,
    status:       'active',
    message_count: 0,
    token_count:   0,
    settings: {
      max_context:          200000,
      auto_compact:         true,
      permission_mode:      'default',
    },
  };
  claudeCodeSessions.set(s.id, s);
  return s;
}

// Permission request store for Claude Code
const permissionRequests = new Map();

function makePermissionRequest(sessionId, toolName, params) {
  const pr = {
    id:         uuidv4(),
    session_id: sessionId,
    tool_name:  toolName,
    params,
    status:     'pending',
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30000).toISOString(),
  };
  permissionRequests.set(pr.id, pr);
  return pr;
}

// ────────────────────────────────────────────────────────────────
// ADMIN / ORG MEMBER MANAGEMENT STORE
// ────────────────────────────────────────────────────────────────
const orgMembers = new Map([[ACCOUNT_UUID, {
  uuid:          ACCOUNT_UUID,
  email:         config.operator_email || 'operator@sister-poc.local',
  full_name:     'Operator',
  display_name:  'Operator',
  role:          'admin',
  status:        'active',
  joined_at:     '2024-01-01T00:00:00Z',
  last_active:   new Date().toISOString(),
  permissions:   ['read', 'write', 'admin', 'billing'],
}]]);

const orgInvites = new Map();

function makeOrgInvite(email, role) {
  const inv = {
    uuid:             uuidv4(),
    email,
    role:             role || 'member',
    status:           'pending',
    invited_by_uuid:  ACCOUNT_UUID,
    created_at:       new Date().toISOString(),
    expires_at:       new Date(Date.now() + 7 * 86400000).toISOString(),
    token:            crypto.randomBytes(32).toString('base64url'),
  };
  orgInvites.set(inv.uuid, inv);
  return inv;
}

// ────────────────────────────────────────────────────────────────
// FEATURE FLAG OVERRIDES (operator can toggle in setup)
// ────────────────────────────────────────────────────────────────
const featureFlagOverrides = new Map();

function getEffectiveFeatureFlags() {
  const base = {
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
    tool_use_v2:               true,
    computer_use_beta:         false,
    prompt_caching:            true,
  };
  for (const [k, v] of featureFlagOverrides.entries()) {
    base[k] = v;
  }
  return base;
}

// ────────────────────────────────────────────────────────────────
// CONVERSATION EXPORT
// ────────────────────────────────────────────────────────────────
function exportConversation(convUuid, format) {
  const conv = conversations.get(convUuid);
  if (!conv) return null;
  const msgs = convMessages.get(convUuid) || [];

  if (format === 'json') {
    return JSON.stringify({ conversation: conv, messages: msgs }, null, 2);
  }

  // markdown
  let md = `# ${conv.name || 'Conversation'}\n\n`;
  md += `**Model:** ${conv.model}\n`;
  md += `**Created:** ${conv.created_at}\n\n---\n\n`;

  for (const msg of msgs) {
    const role = msg.sender === 'human' ? '## Human' : '## Assistant';
    const text = msg.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');
    md += `${role}\n\n${text}\n\n`;
  }
  return md;
}

// ────────────────────────────────────────────────────────────────
// USAGE ANALYTICS — per-day bucketing
// ────────────────────────────────────────────────────────────────
const usageBuckets = new Map(); // YYYY-MM-DD → { messages, tokens, input_tokens, output_tokens }

function recordUsage(inputToks, outputToks) {
  const today = new Date().toISOString().slice(0, 10);
  if (!usageBuckets.has(today)) {
    usageBuckets.set(today, { messages: 0, tokens: 0, input_tokens: 0, output_tokens: 0 });
  }
  const b = usageBuckets.get(today);
  b.messages++;
  b.tokens       += inputToks + outputToks;
  b.input_tokens  += inputToks;
  b.output_tokens += outputToks;
  consumeRateLimit(inputToks, outputToks);
}

function buildUsageTimeline(days = 30) {
  const result = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const b = usageBuckets.get(d) || { messages: 0, tokens: 0, input_tokens: 0, output_tokens: 0 };
    result.push({ date: d, ...b });
  }
  return result;
}

// ────────────────────────────────────────────────────────────────
// MCP TOOLS STORE — mock MCP server list
// ────────────────────────────────────────────────────────────────
const mcpServers = new Map();

function makeMcpServer(params = {}) {
  const srv = {
    uuid:        uuidv4(),
    name:        params.name || 'My MCP Server',
    url:         params.url  || 'http://localhost:3001/sse',
    type:        params.type || 'sse',
    status:      'connected',
    tools:       params.tools || [],
    created_at:  new Date().toISOString(),
    updated_at:  new Date().toISOString(),
  };
  mcpServers.set(srv.uuid, srv);
  return srv;
}

// ────────────────────────────────────────────────────────────────
// ATTACHMENT HELPERS — multipart body parsing (raw)
// ────────────────────────────────────────────────────────────────

// Reads raw body as Buffer for multipart uploads
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => {
      chunks.push(c);
      if (chunks.reduce((s, b) => s + b.length, 0) > 10 * 1024 * 1024) {
        reject(new Error('Upload too large (max 10MB)'));
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Extract filename from Content-Disposition header value
function parseContentDisposition(header) {
  const m = header?.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i);
  return m ? decodeURIComponent(m[1].trim()) : 'upload.bin';
}

// ────────────────────────────────────────────────────────────────
// LOG BUFFER — recent requests for setup page viewer
// ────────────────────────────────────────────────────────────────
const requestLog = [];
const MAX_LOG_ENTRIES = 500;

function appendToRequestLog(entry) {
  requestLog.push(entry);
  if (requestLog.length > MAX_LOG_ENTRIES) requestLog.shift();
}

// ────────────────────────────────────────────────────────────────
// SESSION TOKEN VALIDATION — Worker B / local auth guard
// ────────────────────────────────────────────────────────────────

// Extract local Bearer token from Authorization header
function extractLocalToken(req) {
  const auth = req.headers['authorization'] || '';
  const m    = auth.match(/^Bearer\s+(spoc_[a-f0-9]+)$/i);
  return m ? m[1] : null;
}

// Validate a local session token (created by /auth/login or /auth/signup)
// Returns { valid: true, accountUuid } or { valid: false }
function validateLocalToken(token) {
  if (!token) return { valid: false };
  const sess = sessionTokens.get(token);
  if (!sess) return { valid: false };
  // Expire after 30 days
  if (Date.now() - sess.createdAt > 30 * 86400000) {
    sessionTokens.delete(token);
    return { valid: false };
  }
  return { valid: true, accountUuid: sess.accountUuid };
}

// Middleware check — call in route if you need authentication
// Returns true if the request has a valid session token OR an Anthropic API key
// (For Worker A, we're permissive since it's single-operator localhost)
function isAuthenticated(req) {
  // Local session token
  const token = extractLocalToken(req);
  if (token && validateLocalToken(token).valid) return true;
  // API key in header (operator testing directly against Worker A)
  if (req.headers['x-api-key'] || req.headers['authorization']?.startsWith('Bearer sk-ant-')) return true;
  // In no-key mode, accept unauthenticated requests (operator is testing locally)
  if (config.auth_mode === 'no_key') return true;
  return false;
}

// Build current user context from a valid token (or default operator)
function sessionToAccount(token) {
  const valid = token ? validateLocalToken(token) : { valid: false };
  return buildProfile(
    valid.valid ? (sessionTokens.get(token)?.email || config.operator_email) : config.operator_email
  );
}

// ────────────────────────────────────────────────────────────────
// IDEMPOTENCY KEY DEDUPLICATION
// Prevents duplicate conversation creation / messages on retry
// ────────────────────────────────────────────────────────────────
const idempotencyCache = new Map(); // key → { status, response, ts }
const IDEMPOTENCY_TTL  = 24 * 3600000; // 24 hours

function checkIdempotency(key) {
  if (!key) return null;
  const cached = idempotencyCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.ts > IDEMPOTENCY_TTL) {
    idempotencyCache.delete(key);
    return null;
  }
  return cached;
}

function recordIdempotency(key, status, responseBody) {
  if (!key) return;
  idempotencyCache.set(key, { status, response: responseBody, ts: Date.now() });
  // Garbage collect old entries every 500 new ones
  if (idempotencyCache.size % 500 === 0) {
    const cutoff = Date.now() - IDEMPOTENCY_TTL;
    for (const [k, v] of idempotencyCache.entries()) {
      if (v.ts < cutoff) idempotencyCache.delete(k);
    }
  }
}

// ────────────────────────────────────────────────────────────────
// RATE LIMIT HEADERS — inject into all JSON responses
// ────────────────────────────────────────────────────────────────

// Wraps sendJson to optionally include rate-limit headers
function sendJsonWithRL(res, data, status = 200, extraHeaders = {}) {
  sendJson(res, data, status, { ...buildRateLimitHeaders(), ...extraHeaders });
}

// ────────────────────────────────────────────────────────────────
// WEBHOOK EVENT DISPATCH HOOKS
// Call these at key points in the request lifecycle
// ────────────────────────────────────────────────────────────────
function onConversationCreated(conv) {
  dispatchWebhookEvent('conversation.created', {
    conversation_uuid: conv.uuid,
    name:              conv.name,
    model:             conv.model,
    org_uuid:          ORG_UUID,
    created_at:        conv.created_at,
  });
  audit('conversation.create', 'conversation', conv.uuid, { name: conv.name, model: conv.model });
}

function onMessageCreated(convUuid, msg, model) {
  dispatchWebhookEvent('message.created', {
    message_uuid:      msg.uuid,
    conversation_uuid: convUuid,
    role:              msg.role,
    model:             model || config.default_model,
    org_uuid:          ORG_UUID,
    created_at:        msg.created_at,
  });
  audit('message.create', 'message', msg.uuid, { conversation_uuid: convUuid, role: msg.role });
}

function onCompletionDone(convUuid, assistantText, inputToks, outputToks, model) {
  dispatchWebhookEvent('completion.done', {
    conversation_uuid: convUuid,
    model:             model || config.default_model,
    input_tokens:      inputToks,
    output_tokens:     outputToks,
    org_uuid:          ORG_UUID,
    completed_at:      new Date().toISOString(),
  });
  recordUsage(inputToks, outputToks);
}

// ────────────────────────────────────────────────────────────────
// RESPONSE HELPER WITH IDEMPOTENCY SUPPORT
// ────────────────────────────────────────────────────────────────
function sendJsonIdempotent(res, req, data, status = 200, extraHeaders = {}) {
  const key = req.headers['idempotency-key'];
  recordIdempotency(key, status, data);
  sendJson(res, data, status, extraHeaders);
}

// ────────────────────────────────────────────────────────────────
// COMPREHENSIVE BOOTSTRAP PAYLOAD BUILDER
// Combines current_user_access + feature flags + statsig for
// Worker B's initial page load
// ────────────────────────────────────────────────────────────────
function buildFullBootstrap() {
  return {
    ...CURRENT_USER_ACCESS(),
    feature_flags:      getEffectiveFeatureFlags(),
    statsig:            buildAppStartBlob(ORG_UUID, ACCOUNT_UUID),
    styles:             DEFAULT_STYLES,
    models:             AVAILABLE_MODELS,
    rate_limits:        rlState,
    server_info: {
      version:           SERVER_VERSION,
      worker_c_connected: !!activeBridgeSocket,
      auth_mode:          config.auth_mode,
      backend:            config.backend,
      default_model:      config.default_model,
      mutation_mode:      config.mutation_mode,
    },
  };
}

// ────────────────────────────────────────────────────────────────
// STREAMING SSE PING HELPER
// Keeps a response stream alive by writing periodic pings
// Returns the interval handle so the caller can clearInterval
// ────────────────────────────────────────────────────────────────
function startSSEPing(res, intervalMs = 14000) {
  return setInterval(() => {
    try { res.write('event: ping\ndata: {"type":"ping"}\n\n'); }
    catch { /* stream closed — caller handles via req.on('close') */ }
  }, intervalMs);
}

// ────────────────────────────────────────────────────────────────
// MODEL CAPABILITY QUERY
// ────────────────────────────────────────────────────────────────
function getModelCapabilities(modelId) {
  const model = AVAILABLE_MODELS.find(m => m.id === resolveModelAlias(modelId));
  if (!model) return null;
  return {
    id:                        model.id,
    display_name:              model.display_name,
    context_window:            model.context_window || 200000,
    max_output_tokens:         model.max_tokens,
    supports_extended_thinking: model.supports_extended_thinking,
    supports_vision:           model.supports_vision,
    supports_tools:            model.supports_tools,
    supports_streaming:        model.supports_streaming,
    tier_required:             model.tier_required,
    is_available:              true,
    limitations: {
      no_system_prompt:        false,
      max_images_per_request:  5,
      max_tool_definitions:    64,
      max_tool_results:        64,
    },
  };
}

// ────────────────────────────────────────────────────────────────
// MIME TYPE HELPERS
// ────────────────────────────────────────────────────────────────
function mimeFromFilename(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  const map = {
    pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    txt: 'text/plain', md: 'text/markdown', html: 'text/html', css: 'text/css',
    js: 'application/javascript', json: 'application/json',
    py: 'text/x-python', rb: 'text/x-ruby', sh: 'text/x-shellscript',
    ts: 'application/typescript', tsx: 'application/typescript',
    csv: 'text/csv', xml: 'application/xml', yaml: 'application/x-yaml',
    zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  return map[ext] || 'application/octet-stream';
}

// ────────────────────────────────────────────────────────────────
// ANTHROPIC STREAMING RESPONSE → OPENAI STREAMING RESPONSE
// Inverse translation for routes that speak OpenAI to a client
// ────────────────────────────────────────────────────────────────
async function proxyAndTranslateAnthropicToOAI(req, res, anthropicBody, reqId, origin) {
  const backendUrl = resolveBackendUrl(config.backend);
  if (!backendUrl) {
    sendJson(res, openaiErrorBody('No backend configured'), 500);
    return 500;
  }

  const bodyStr  = JSON.stringify(anthropicBody);
  const model    = resolveModelAlias(anthropicBody.model || config.default_model);
  const authHdrs = buildAuthHeaders(config.auth_mode);
  const targetUrl = new URL(backendUrl + '/v1/messages');

  if (isBlockedUrl(targetUrl.toString())) {
    sendJson(res, openaiErrorBody('Blocked host'), 403);
    return 403;
  }

  const chatId  = `chatcmpl-${crypto.randomBytes(8).toString('hex')}`;
  const created = Math.floor(Date.now() / 1000);

  const options = {
    hostname: targetUrl.hostname,
    port:     targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
    path:     targetUrl.pathname,
    method:   'POST',
    headers: {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      'Accept':         'text/event-stream',
      'User-Agent':     `worker-a/${SERVER_VERSION}`,
      ...authHdrs,
    },
    timeout: config.request_timeout_ms,
  };

  const transport = targetUrl.protocol === 'https:' ? https : http;

  return new Promise((resolve) => {
    const proxyReq = transport.request(options, (proxyRes) => {
      if (proxyRes.statusCode >= 400) {
        let err = '';
        proxyRes.on('data', c => err += c);
        proxyRes.on('end', () => {
          try { sendJson(res, JSON.parse(err), proxyRes.statusCode); }
          catch { sendJson(res, openaiErrorBody('Backend error ' + proxyRes.statusCode), proxyRes.statusCode); }
          resolve(proxyRes.statusCode);
        });
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache', 'Connection': 'keep-alive',
        'request-id': reqId, ...corsHeaders(origin, true),
      });

      // Emit role chunk first
      res.write(`data: ${JSON.stringify({
        id: chatId, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      })}\n\n`);

      let buffer = '';

      proxyRes.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith('data: ')) continue;
          const dataStr = line.slice(6).trim();
          if (dataStr === '[DONE]') {
            res.write(`data: ${JSON.stringify({ id: chatId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
            res.write('data: [DONE]\n\n');
            try { res.end(); } catch {}
            resolve(200);
            return;
          }
          try {
            const ev = JSON.parse(dataStr);
            if (ev.type === 'content_block_delta' && ev.delta?.text) {
              res.write(`data: ${JSON.stringify({ id: chatId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: ev.delta.text }, finish_reason: null }] })}\n\n`);
            } else if (ev.type === 'content_block_delta' && ev.delta?.partial_json) {
              // Tool use delta
              res.write(`data: ${JSON.stringify({ id: chatId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ev.delta.partial_json } }] }, finish_reason: null }] })}\n\n`);
            } else if (ev.type === 'message_stop') {
              res.write(`data: ${JSON.stringify({ id: chatId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
              res.write('data: [DONE]\n\n');
              try { res.end(); } catch {}
              resolve(200);
            }
          } catch {}
        }
      });

      proxyRes.on('end', () => {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ id: chatId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
          res.write('data: [DONE]\n\n');
          try { res.end(); } catch {}
        }
        resolve(200);
      });

      proxyRes.on('error', e => {
        if (!res.writableEnded) { try { res.end(); } catch {} }
        resolve(500);
      });
    });

    proxyReq.on('error', e => {
      sendJson(res, openaiErrorBody(e.message), 502);
      resolve(502);
    });

    proxyReq.write(bodyStr);
    proxyReq.end();
  });
}

// ────────────────────────────────────────────────────────────────
// COMPLETE BOOTSTRAP — used by Worker B for initial page load
// ────────────────────────────────────────────────────────────────

// Build the full set of data Worker B needs to boot its UI in one call
function buildWorkerBBootstrap() {
  return {
    version:        SERVER_VERSION,
    account:        buildProfile(),
    organization:   ORG_JSON,
    models:         AVAILABLE_MODELS,
    styles:         DEFAULT_STYLES,
    feature_flags:  getEffectiveFeatureFlags(),
    rate_limits:    rlState,
    subscription:   SUBSCRIPTION_DETAILS(),
    auth_mode:      config.auth_mode,
    backend:        config.backend,
    default_model:  config.default_model,
    mutation_mode:  config.mutation_mode,
    worker_c_connected: !!activeBridgeSocket,
    server_version: SERVER_VERSION,
    blocked_hosts:  [...BLOCKED_HOSTS],
    capabilities: {
      extended_thinking: getEffectiveFeatureFlags().extended_thinking,
      tool_use:          true,
      vision:            true,
      artifacts:         getEffectiveFeatureFlags().artifacts_v3,
      code_execution:    getEffectiveFeatureFlags().repl_v2,
      web_search:        getEffectiveFeatureFlags().web_search_v3,
      memory:            getEffectiveFeatureFlags().memory_v2,
      projects:          getEffectiveFeatureFlags().projects_v2,
      voice:             getEffectiveFeatureFlags().voice_input,
      computer_use:      getEffectiveFeatureFlags().computer_use_beta,
    },
  };
}

// ────────────────────────────────────────────────────────────────
// CONVERSATION STATE MACHINE HELPERS
// Used by completion route to manage conversation lifecycle
// ────────────────────────────────────────────────────────────────

// Ensure a conversation exists, creating it if necessary
// Returns the conversation object
function ensureConversation(convId, params = {}) {
  if (conversations.has(convId)) return conversations.get(convId);
  const conv = makeConversation({ ...params });
  conv.uuid = convId;
  conversations.set(convId, conv);
  convMessages.set(convId, []);
  onConversationCreated(conv);
  return conv;
}

// Store human message and return it
function storeHumanMessage(convId, prompt, model, parentUuid) {
  const msg = addMessage(convId, 'user', prompt || '', parentUuid, model);
  onMessageCreated(convId, msg, model);
  return msg;
}

// Store assistant response and return it
function storeAssistantMessage(convId, text, model, parentUuid) {
  const msg = addMessage(convId, 'assistant', text, parentUuid, model);
  onMessageCreated(convId, msg, model);
  return msg;
}

// ────────────────────────────────────────────────────────────────
// TOKEN ESTIMATION UTILITIES
// ────────────────────────────────────────────────────────────────

// Rough token estimator: ~4 chars / token for English text
function estimateInputTokens(body) {
  const parts = [];
  if (body.system) parts.push(typeof body.system === 'string' ? body.system : JSON.stringify(body.system));
  if (body.prompt) parts.push(body.prompt);
  if (body.messages) {
    for (const m of body.messages) {
      if (typeof m.content === 'string') parts.push(m.content);
      else if (Array.isArray(m.content)) {
        parts.push(...m.content.filter(b => b.type === 'text').map(b => b.text));
      }
    }
  }
  return Math.max(1, Math.ceil(parts.join(' ').length / 4));
}

// ────────────────────────────────────────────────────────────────
// BATCH OPERATIONS HELPERS
// ────────────────────────────────────────────────────────────────
const batchStore = new Map(); // batch_id → { id, status, results, created_at, ... }

function createBatch(requests, params = {}) {
  const batchId = `msgbatch_${crypto.randomBytes(12).toString('hex')}`;
  const batch = {
    id:                batchId,
    type:              'message_batch',
    processing_status: 'in_progress',
    request_counts:    { processing: requests.length, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
    created_at:        new Date().toISOString(),
    expires_at:        new Date(Date.now() + 29 * 86400000).toISOString(),
    ended_at:          null,
    results_url:       `/v1/messages/batches/${batchId}/results`,
    cancel_initiated_at: null,
    results:           [],
    metadata:          params.metadata || {},
  };
  batchStore.set(batchId, batch);

  // Process synchronously for mock (in real API this would be async)
  setTimeout(() => {
    batch.results = requests.slice(0, 100).map(r => ({
      custom_id: r.custom_id,
      result: {
        type: 'succeeded',
        message: {
          id:            `msg_${crypto.randomBytes(12).toString('hex')}`,
          type:          'message', role: 'assistant',
          model:         resolveModelAlias(r.params?.model || config.default_model),
          content:       [{ type: 'text', text: `Mock batch response for ${r.custom_id}` }],
          stop_reason:   'end_turn', stop_sequence: null,
          usage:         { input_tokens: 10, output_tokens: 8 },
        },
      },
    }));
    batch.processing_status = 'ended';
    batch.ended_at = new Date().toISOString();
    batch.request_counts = { processing: 0, succeeded: batch.results.length, errored: 0, canceled: 0, expired: 0 };
  }, 100);

  return batch;
}

// ────────────────────────────────────────────────────────────────
// HELPER: Inject rate-limit headers into SSE response
// ────────────────────────────────────────────────────────────────
function addRLToSSEHeaders(headers) {
  return { ...headers, ...buildRateLimitHeaders() };
}

// ────────────────────────────────────────────────────────────────
// CONVERSATION TAGS STORE
// ────────────────────────────────────────────────────────────────
const conversationTags = new Map(); // tag_name → [conv_uuid, ...]
const convTagMap       = new Map(); // conv_uuid → Set<tag_name>

function addTagToConv(convUuid, tagName) {
  if (!convTagMap.has(convUuid)) convTagMap.set(convUuid, new Set());
  convTagMap.get(convUuid).add(tagName);
  if (!conversationTags.has(tagName)) conversationTags.set(tagName, []);
  const list = conversationTags.get(tagName);
  if (!list.includes(convUuid)) list.push(convUuid);
}

function removeTagFromConv(convUuid, tagName) {
  convTagMap.get(convUuid)?.delete(tagName);
  const list = conversationTags.get(tagName);
  if (list) {
    const idx = list.indexOf(convUuid);
    if (idx >= 0) list.splice(idx, 1);
    if (list.length === 0) conversationTags.delete(tagName);
  }
}

function getConvTags(convUuid) {
  return [...(convTagMap.get(convUuid) || new Set())];
}

function getAllTags() {
  return [...conversationTags.entries()].map(([name, convs]) => ({
    name, conversation_count: convs.length,
  }));
}

// ────────────────────────────────────────────────────────────────
// USER PREFERENCES STORE — per-user settings beyond global config
// ────────────────────────────────────────────────────────────────
const userPreferences = {
  theme:                     'dark',
  font_size:                 'medium',
  send_on_enter:             true,
  show_thinking_by_default:  false,
  auto_title:                true,
  show_token_counts:         false,
  default_model:             config.default_model,
  keyboard_shortcuts_enabled: true,
  compact_mode:              false,
  sidebar_collapsed:         false,
  artifacts_auto_open:       true,
  artifact_theme:            'dark',
  code_theme:                'github-dark',
  show_line_numbers:         true,
  latex_rendering:           true,
  mermaid_rendering:         true,
  notifications: {
    desktop:                 true,
    sounds:                  false,
    mention_only:            false,
  },
  privacy: {
    allow_training:          false,
    analytics:               false,
  },
  locale:                    'en-US',
  timezone:                  Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
};

// ────────────────────────────────────────────────────────────────
// MESSAGE REACTIONS — emoji reactions on messages
// ────────────────────────────────────────────────────────────────
const messageReactions = new Map(); // msg_uuid → [{ emoji, count, reacted_by }]

function addReaction(msgUuid, emoji) {
  if (!messageReactions.has(msgUuid)) messageReactions.set(msgUuid, []);
  const reactions = messageReactions.get(msgUuid);
  const existing  = reactions.find(r => r.emoji === emoji);
  if (existing) {
    existing.count++;
    if (!existing.reacted_by.includes(ACCOUNT_UUID)) existing.reacted_by.push(ACCOUNT_UUID);
  } else {
    reactions.push({ emoji, count: 1, reacted_by: [ACCOUNT_UUID] });
  }
  return reactions;
}

function removeReaction(msgUuid, emoji) {
  const reactions = messageReactions.get(msgUuid);
  if (!reactions) return [];
  const idx = reactions.findIndex(r => r.emoji === emoji);
  if (idx >= 0) {
    reactions[idx].count = Math.max(0, reactions[idx].count - 1);
    if (reactions[idx].count === 0) reactions.splice(idx, 1);
  }
  return reactions;
}

// ────────────────────────────────────────────────────────────────
// DRAFT STORE — saved conversation drafts
// ────────────────────────────────────────────────────────────────
const draftStore = new Map(); // draft_id → draft

function makeDraft(params = {}) {
  const draft = {
    uuid:             uuidv4(),
    conversation_uuid: params.conversation_uuid || null,
    content:          params.content  || '',
    model:            params.model    || config.default_model,
    attachments:      params.attachments || [],
    created_at:       new Date().toISOString(),
    updated_at:       new Date().toISOString(),
    auto_saved:       true,
  };
  draftStore.set(draft.uuid, draft);
  return draft;
}

// ────────────────────────────────────────────────────────────────
// QUICK ACTIONS STORE — saved quick-action templates
// ────────────────────────────────────────────────────────────────
const quickActions = new Map();

function makeQuickAction(params = {}) {
  const qa = {
    uuid:        uuidv4(),
    name:        params.name    || 'Quick Action',
    icon:        params.icon    || '⚡',
    prompt:      params.prompt  || '',
    model:       params.model   || config.default_model,
    tools:       params.tools   || [],
    pinned:      params.pinned  || false,
    use_count:   0,
    created_at:  new Date().toISOString(),
    updated_at:  new Date().toISOString(),
  };
  quickActions.set(qa.uuid, qa);
  return qa;
}

// Seed a few default quick actions
makeQuickAction({ name: 'Explain Code',    icon: '💻', prompt: 'Explain what this code does:\n\n', pinned: true });
makeQuickAction({ name: 'Summarize',       icon: '📝', prompt: 'Summarize the following concisely:\n\n', pinned: true });
makeQuickAction({ name: 'Fix Grammar',     icon: '✏️',  prompt: 'Fix any grammar and spelling errors in:\n\n', pinned: false });
makeQuickAction({ name: 'Write Tests',     icon: '🧪', prompt: 'Write comprehensive tests for:\n\n', pinned: false });
makeQuickAction({ name: 'Debug',           icon: '🔍', prompt: 'Find and fix the bug in:\n\n', pinned: true });

// ────────────────────────────────────────────────────────────────
// KEYBOARD SHORTCUTS MANIFEST (for Worker B)
// ────────────────────────────────────────────────────────────────
const KEYBOARD_SHORTCUTS = [
  { id: 'new_conv',          keys: ['Ctrl+Shift+O'],    action: 'new_conversation',        label: 'New conversation',       category: 'navigation' },
  { id: 'search',            keys: ['Ctrl+K'],           action: 'open_search',             label: 'Search conversations',   category: 'navigation' },
  { id: 'settings',          keys: ['Ctrl+,'],           action: 'open_settings',           label: 'Open settings',          category: 'navigation' },
  { id: 'send',              keys: ['Enter'],            action: 'send_message',            label: 'Send message',           category: 'compose' },
  { id: 'send_newline',      keys: ['Shift+Enter'],      action: 'insert_newline',          label: 'Insert newline',         category: 'compose' },
  { id: 'focus_input',       keys: ['Escape'],           action: 'focus_input',             label: 'Focus input',            category: 'compose' },
  { id: 'stop',              keys: ['Ctrl+Backspace'],   action: 'stop_generation',         label: 'Stop generation',        category: 'compose' },
  { id: 'regenerate',        keys: ['Ctrl+Shift+R'],     action: 'regenerate',              label: 'Regenerate last',        category: 'compose' },
  { id: 'copy_last',         keys: ['Ctrl+Shift+C'],     action: 'copy_last_response',      label: 'Copy last response',     category: 'compose' },
  { id: 'sidebar',           keys: ['Ctrl+B'],           action: 'toggle_sidebar',          label: 'Toggle sidebar',         category: 'view' },
  { id: 'artifacts',         keys: ['Ctrl+Shift+A'],     action: 'toggle_artifacts',        label: 'Toggle artifacts panel', category: 'view' },
  { id: 'dark',              keys: ['Ctrl+Shift+D'],     action: 'toggle_theme',            label: 'Toggle dark mode',       category: 'view' },
  { id: 'export',            keys: ['Ctrl+Shift+E'],     action: 'export_conversation',     label: 'Export conversation',    category: 'conversation' },
  { id: 'star',              keys: ['Ctrl+Shift+S'],     action: 'toggle_star',             label: 'Star conversation',      category: 'conversation' },
  { id: 'delete',            keys: ['Ctrl+Delete'],      action: 'delete_conversation',     label: 'Delete conversation',    category: 'conversation' },
];

// ────────────────────────────────────────────────────────────────
// STATUS PAGE — service uptime mock
// ────────────────────────────────────────────────────────────────
const SERVICE_COMPONENTS = [
  { id: 'api',        name: 'API',              status: 'operational', uptime_pct: 99.98 },
  { id: 'web_app',    name: 'Web Application',  status: 'operational', uptime_pct: 99.97 },
  { id: 'claude_2',   name: 'Claude Opus 4.6',  status: 'operational', uptime_pct: 99.95 },
  { id: 'claude_3',   name: 'Claude Sonnet 4.6',status: 'operational', uptime_pct: 99.96 },
  { id: 'claude_4',   name: 'Claude Haiku 4.5', status: 'operational', uptime_pct: 99.99 },
  { id: 'file_upload',name: 'File Uploads',     status: 'operational', uptime_pct: 99.93 },
  { id: 'artifacts',  name: 'Artifacts',        status: 'operational', uptime_pct: 99.94 },
  { id: 'websockets', name: 'Real-time',        status: 'operational', uptime_pct: 99.96 },
];

// ────────────────────────────────────────────────────────────────
// TELEMETRY HELPERS — build Statsig log_event payloads
// ────────────────────────────────────────────────────────────────
function buildStatsigLog(eventName, value, metadata = {}) {
  return {
    eventName,
    value,
    user: {
      userID:    ACCOUNT_UUID,
      customIDs: { organizationUuid: ORG_UUID },
    },
    metadata: {
      sessionID: uuidv4(),
      stableID:  DEVICE_ID,
      ...metadata,
    },
    time: Date.now(),
  };
}

// ────────────────────────────────────────────────────────────────
// ANTHROPIC ERROR FORMAT BUILDER
// Matches exact error response format from Anthropic API v2023-06-01
// ────────────────────────────────────────────────────────────────
function buildAnthropicError(type, message, params = {}) {
  return {
    type: 'error',
    error: {
      type,
      message,
      ...(params.param ? { param: params.param } : {}),
    },
  };
}

// Map HTTP status to Anthropic error types (complete)
const HTTP_TO_ANTHROPIC = {
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
  503: 'overloaded_error',
  504: 'api_error',
  529: 'overloaded_error',
};

// ────────────────────────────────────────────────────────────────
// CLAUDE.AI SPECIFIC — extra endpoints from the claude.ai web app
// ────────────────────────────────────────────────────────────────

// The claude.ai web app tracks "paprika mode" (extended context) and
// "compass mode" (other model configs). These stubs return valid responses.

function buildPaprikaSettings() {
  return {
    paprika_mode:    'extended',
    compass_mode:    null,
    max_tokens:      16000,
    context_window:  200000,
    web_search:      true,
    artifacts:       true,
    repl:            true,
    memory:          true,
    imagine:         true,
    tools:           ['web_search', 'repl', 'artifacts', 'memory', 'computer_use'],
  };
}

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

  // Idempotency key — replay cached response if present
  const idempKey = req.headers['idempotency-key'];
  if (idempKey && (method === 'POST' || method === 'PUT')) {
    const cached = checkIdempotency(idempKey);
    if (cached) {
      sendJson(res, cached.response, cached.status, { 'Idempotency-Key': idempKey, 'X-Idempotency-Replayed': 'true' });
      logRequest(method, pathname, cached.status, Date.now() - startMs, reqId);
      return;
    }
  }

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

  // ── Conversation export ──────────────────────────────────────
  if (pathname.match(/\/chat_conversations\/[^/]+\/export$/) && method === 'GET') {
    const convId = pathname.match(/\/chat_conversations\/([^/]+)\/export$/)[1];
    const fmt    = parsed.query.format || 'json';
    const data   = exportConversation(convId, fmt);
    if (!data) { sendJson(res, errorEnvelope('not_found_error', 'Conversation not found'), 404); return 404; }
    if (fmt === 'markdown') {
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="conversation-${convId}.md"`,
        ...corsHeaders(origin),
      });
      res.end(data);
    } else {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="conversation-${convId}.json"`,
        ...corsHeaders(origin),
      });
      res.end(data);
    }
    return 200;
  }

  // Conversation message tree (branching)
  if (pathname.match(/\/chat_conversations\/[^/]+\/messages$/) && method === 'GET') {
    const convId  = pathname.match(/\/chat_conversations\/([^/]+)\/messages$/)[1];
    const leafId  = parsed.query.leaf_uuid || conversations.get(convId)?.current_leaf_message_uuid;
    const chain   = buildMessageChain(convId, leafId);
    sendJson(res, { messages: chain, leaf_uuid: leafId });
    return 200;
  }

  if (pathname.match(/\/chat_conversations\/[^/]+\/branches$/)) {
    const convId  = pathname.match(/\/chat_conversations\/([^/]+)\/branches$/)[1];
    const fromId  = parsed.query.from_uuid;
    const branches = getMessageBranches(convId, fromId);
    sendJson(res, { branches });
    return 200;
  }

  // ── File upload ───────────────────────────────────────────────
  if (pathname === '/api/files' && method === 'POST') {
    const ct        = req.headers['content-type'] || '';
    const boundary  = parseMultipartBoundary(ct);
    if (boundary) {
      // Multipart upload — parse boundary sections
      const rawBuf  = await readRawBody(req);
      const rawStr  = rawBuf.toString('latin1');
      const parts   = rawStr.split(`--${boundary}`).filter(p => p.trim() && p.trim() !== '--');
      const records = [];
      for (const part of parts) {
        const [headerSection, ...bodyParts] = part.split('\r\n\r\n');
        const headers = headerSection.trim();
        const body    = bodyParts.join('\r\n\r\n').replace(/\r\n$/, '');
        const filename = parseContentDisposition(headers.match(/Content-Disposition:[^\r\n]*/i)?.[0]);
        const mimeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);
        const mime = mimeMatch?.[1]?.trim() || 'application/octet-stream';
        records.push(makeFileRecord(filename, mime, body.length));
      }
      sendJson(res, { files: records }, 201);
    } else {
      // JSON metadata-only file record
      const body = await readBody(req);
      const rec  = makeFileRecord(body.filename || 'upload.bin', body.mime_type, body.size || 0);
      sendJson(res, rec, 201);
    }
    return 201;
  }

  if (pathname.match(/^\/api\/files\/([^/]+)$/) && method === 'GET') {
    const fid = pathname.match(/^\/api\/files\/([^/]+)$/)[1];
    const rec = fileStore.get(fid);
    if (!rec) { sendJson(res, errorEnvelope('not_found_error', 'File not found'), 404); return 404; }
    sendJson(res, rec);
    return 200;
  }

  if (pathname.match(/^\/api\/files\/([^/]+)$/) && method === 'DELETE') {
    const fid = pathname.match(/^\/api\/files\/([^/]+)$/)[1];
    fileStore.delete(fid);
    res.writeHead(204); res.end();
    return 204;
  }

  // Organization file upload (legacy path)
  if (pathname.match(/\/file_uploads$/) && method === 'POST') {
    const body = await readBody(req);
    const rec  = makeFileRecord(body.filename || 'upload.bin', body.file_type || 'application/octet-stream', body.file_size || 0);
    sendJson(res, { file_uuid: rec.file_uuid, ...rec }, 201);
    return 201;
  }

  // ── Shares ─────────────────────────────────────────────────────
  if (pathname.match(/\/chat_conversations\/[^/]+\/shares$/) && method === 'GET') {
    const convId  = pathname.match(/\/chat_conversations\/([^/]+)\/shares$/)[1];
    const convShares = [...shareStore.values()].filter(s => s.conversation_uuid === convId);
    sendJson(res, convShares);
    return 200;
  }

  if (pathname.match(/\/chat_conversations\/[^/]+\/shares$/) && method === 'POST') {
    const convId = pathname.match(/\/chat_conversations\/([^/]+)\/shares$/)[1];
    const body   = await readBody(req);
    const sh     = makeShare(convId, body);
    sendJson(res, sh, 201);
    return 201;
  }

  if (pathname.match(/\/shares\/([^/]+)$/) && method === 'DELETE') {
    const shareId = pathname.match(/\/shares\/([^/]+)$/)[1];
    shareStore.delete(shareId);
    res.writeHead(204); res.end();
    return 204;
  }

  // Public share view
  if (pathname.match(/^\/share\/([^/]+)$/)) {
    const token = pathname.match(/^\/share\/([^/]+)$/)[1];
    const sh    = [...shareStore.values()].find(s => s.share_token === token);
    if (!sh) { sendJson(res, errorEnvelope('not_found_error', 'Share not found'), 404); return 404; }
    sh.view_count++;
    const conv = conversations.get(sh.conversation_uuid);
    const msgs = convMessages.get(sh.conversation_uuid) || [];
    sendJson(res, { share: sh, conversation: conv, messages: msgs });
    return 200;
  }

  // ── Notifications ─────────────────────────────────────────────
  if (pathname.match(/\/notifications$/) && method === 'GET') {
    const unreadOnly = parsed.query.unread === 'true';
    const list = unreadOnly ? notifications.filter(n => !n.read) : notifications;
    sendJson(res, { notifications: list, unread_count: notifications.filter(n => !n.read).length });
    return 200;
  }

  if (pathname.match(/\/notifications\/mark_all_read$/) && method === 'POST') {
    for (const n of notifications) n.read = true;
    sendJson(res, { ok: true });
    return 200;
  }

  if (pathname.match(/\/notifications\/([^/]+)\/read$/) && method === 'POST') {
    const nid = pathname.match(/\/notifications\/([^/]+)\/read$/)[1];
    const n   = notifications.find(x => x.uuid === nid);
    if (n) n.read = true;
    sendJson(res, { ok: true });
    return 200;
  }

  // ── Projects CRUD ─────────────────────────────────────────────
  const projListMatch = pathname.match(/\/organizations\/[^/]+\/projects$/);
  if (projListMatch) {
    if (method === 'GET') {
      const list = [...projects.values()]
        .filter(p => !p.archived_at)
        .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
      sendJson(res, list);
    } else if (method === 'POST') {
      const body = await readBody(req);
      const proj = makeProject(body);
      sendJson(res, proj, 201);
    }
    return 200;
  }

  const projMatch = pathname.match(/\/organizations\/[^/]+\/projects\/([^/]+)$/);
  if (projMatch) {
    const projId = projMatch[1];
    if (method === 'GET') {
      const proj = projects.get(projId);
      if (!proj) { sendJson(res, errorEnvelope('not_found_error', 'Project not found'), 404); return 404; }
      sendJson(res, proj);
    } else if (method === 'PATCH' || method === 'PUT') {
      const body = await readBody(req);
      const proj = projects.get(projId);
      if (!proj) { sendJson(res, errorEnvelope('not_found_error', 'Project not found'), 404); return 404; }
      Object.assign(proj, body, { updated_at: new Date().toISOString() });
      sendJson(res, proj);
    } else if (method === 'DELETE') {
      projects.delete(projId);
      projectDocs.delete(projId);
      projectFiles.delete(projId);
      res.writeHead(204); res.end();
    }
    return 200;
  }

  // Project docs
  if (pathname.match(/\/projects\/[^/]+\/documents?$/) ) {
    const projId = pathname.match(/\/projects\/([^/]+)\/documents?$/)[1];
    if (method === 'GET') {
      sendJson(res, { documents: projectDocs.get(projId) || [] });
    } else if (method === 'POST') {
      const body = await readBody(req);
      const doc  = makeProjectDoc(projId, body);
      sendJson(res, doc, 201);
    }
    return 200;
  }

  if (pathname.match(/\/projects\/[^/]+\/documents?\/([^/]+)$/)) {
    const [, projId, docId] = pathname.match(/\/projects\/([^/]+)\/documents?\/([^/]+)$/) || [];
    if (method === 'DELETE') {
      const list = projectDocs.get(projId) || [];
      projectDocs.set(projId, list.filter(d => d.uuid !== docId));
      res.writeHead(204); res.end();
    } else if (method === 'GET') {
      const doc = (projectDocs.get(projId) || []).find(d => d.uuid === docId);
      if (!doc) { sendJson(res, errorEnvelope('not_found_error', 'Document not found'), 404); return 404; }
      sendJson(res, doc);
    } else if (method === 'PATCH') {
      const body = await readBody(req);
      const doc  = (projectDocs.get(projId) || []).find(d => d.uuid === docId);
      if (doc) Object.assign(doc, body, { updated_at: new Date().toISOString() });
      sendJson(res, doc || {});
    }
    return 200;
  }

  // ── Project conversations ─────────────────────────────────────
  if (pathname.match(/\/projects\/[^/]+\/conversations?$/) && method === 'GET') {
    const projId = pathname.match(/\/projects\/([^/]+)\/conversations?$/)[1];
    const list = [...conversations.values()].filter(c => c.project_uuid === projId);
    sendJson(res, list);
    return 200;
  }

  // ── Org member management ─────────────────────────────────────
  if (pathname.match(/\/organizations\/[^/]+\/members?$/) && method === 'GET') {
    sendJson(res, [...orgMembers.values()]);
    return 200;
  }

  if (pathname.match(/\/organizations\/[^/]+\/invitations?$/) && method === 'GET') {
    sendJson(res, { invites: [...orgInvites.values()] });
    return 200;
  }

  if (pathname.match(/\/organizations\/[^/]+\/invitations?$/) && method === 'POST') {
    const body = await readBody(req);
    const inv  = makeOrgInvite(body.email, body.role);
    sendJson(res, inv, 201);
    return 201;
  }

  if (pathname.match(/\/organizations\/[^/]+\/invitations?\/([^/]+)$/) && method === 'DELETE') {
    const invId = pathname.match(/\/invitations?\/([^/]+)$/)[1];
    orgInvites.delete(invId);
    res.writeHead(204); res.end();
    return 204;
  }

  if (pathname.match(/\/organizations\/[^/]+\/members?\/([^/]+)$/) && method === 'DELETE') {
    const memberId = pathname.match(/\/members?\/([^/]+)$/)[1];
    orgMembers.delete(memberId);
    res.writeHead(204); res.end();
    return 204;
  }

  if (pathname.match(/\/organizations\/[^/]+\/members?\/([^/]+)\/role$/) && method === 'POST') {
    const body     = await readBody(req);
    const memberId = pathname.match(/\/members?\/([^/]+)\/role$/)[1];
    const member   = orgMembers.get(memberId);
    if (member) member.role = body.role;
    sendJson(res, member || {});
    return 200;
  }

  // ── Feature flags ─────────────────────────────────────────────
  if (pathname.match(/\/feature_flags$/) && method === 'GET') {
    sendJson(res, getEffectiveFeatureFlags());
    return 200;
  }

  if (pathname.match(/\/feature_flags$/) && method === 'POST') {
    const body = await readBody(req);
    for (const [k, v] of Object.entries(body)) {
      featureFlagOverrides.set(k, v);
    }
    sendJson(res, getEffectiveFeatureFlags());
    return 200;
  }

  // ── Usage analytics ───────────────────────────────────────────
  if (pathname.match(/\/analytics\/usage$/) && method === 'GET') {
    const days     = parseInt(parsed.query.days) || 30;
    const timeline = buildUsageTimeline(days);
    const totals   = timeline.reduce((acc, d) => {
      acc.messages      += d.messages;
      acc.tokens        += d.tokens;
      acc.input_tokens  += d.input_tokens;
      acc.output_tokens += d.output_tokens;
      return acc;
    }, { messages: 0, tokens: 0, input_tokens: 0, output_tokens: 0 });
    sendJson(res, { timeline, totals, period_days: days });
    return 200;
  }

  // ── MCP servers ───────────────────────────────────────────────
  if (pathname.match(/\/mcp\/servers?$/) && method === 'GET') {
    sendJson(res, { servers: [...mcpServers.values()] });
    return 200;
  }

  if (pathname.match(/\/mcp\/servers?$/) && method === 'POST') {
    const body = await readBody(req);
    const srv  = makeMcpServer(body);
    sendJson(res, srv, 201);
    return 201;
  }

  if (pathname.match(/\/mcp\/servers?\/([^/]+)$/) && method === 'DELETE') {
    const srvId = pathname.match(/\/mcp\/servers?\/([^/]+)$/)[1];
    mcpServers.delete(srvId);
    res.writeHead(204); res.end();
    return 204;
  }

  // ── Claude Code endpoints ─────────────────────────────────────
  if (pathname === '/v1/code/sessions' && method === 'GET') {
    sendJson(res, { sessions: [...claudeCodeSessions.values()] });
    return 200;
  }

  if (pathname === '/v1/code/sessions' && method === 'POST') {
    const body = await readBody(req);
    const sess = makeCodeSession(body);
    sendJson(res, sess, 201);
    return 201;
  }

  if (pathname.match(/\/v1\/code\/sessions\/([^/]+)$/) && method === 'GET') {
    const sessId = pathname.match(/\/v1\/code\/sessions\/([^/]+)$/)[1];
    const sess   = claudeCodeSessions.get(sessId);
    if (!sess) { sendJson(res, errorEnvelope('not_found_error', 'Session not found'), 404); return 404; }
    sendJson(res, sess);
    return 200;
  }

  if (pathname.match(/\/v1\/code\/sessions\/([^/]+)$/) && method === 'DELETE') {
    const sessId = pathname.match(/\/v1\/code\/sessions\/([^/]+)$/)[1];
    claudeCodeSessions.delete(sessId);
    res.writeHead(204); res.end();
    return 204;
  }

  if (pathname.match(/\/v1\/code\/sessions\/([^/]+)\/messages$/) && method === 'POST') {
    const sessId   = pathname.match(/\/v1\/code\/sessions\/([^/]+)\/messages$/)[1];
    const body     = await readBody(req);
    const sess     = claudeCodeSessions.get(sessId);
    const model    = resolveModelAlias((sess?.model) || config.default_model);
    const mutated  = applyMutation(body);

    if (sess) {
      sess.last_active = new Date().toISOString();
      sess.message_count++;
    }

    if (config.auth_mode === 'cookie_bridge' || config.backend === 'cookie_bridge') {
      dispatchToBridge(req, res, mutated, '/v1/messages', 'POST');
      return 200;
    }

    if (config.api_key || config.oauth_token) {
      proxyRequest(req, res, mutated, '/v1/messages', 'POST');
      return 200;
    }

    // Mock code session response
    const prompt   = extractLastUserText(body.messages);
    const inputTok = Math.ceil(prompt.length / 4);
    const mockResp = `[Sister PoC Claude Code mock]\nSession: ${sessId}\nModel: ${model}\n\nResponse to: ${prompt}`;

    if (body.stream !== false) {
      res.writeHead(200, { ...sseStartHeaders(reqId, origin), ...buildRateLimitHeaders() });
      emitAnthropicTextStream(res, reqId, mockResp, model, inputTok);
      res.end();
    } else {
      sendJson(res, {
        id: `msg_${crypto.randomBytes(12).toString('hex')}`,
        type: 'message', role: 'assistant', model,
        content: [{ type: 'text', text: mockResp }],
        stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: inputTok, output_tokens: Math.ceil(mockResp.length / 4) },
      }, 200, buildRateLimitHeaders());
    }
    recordUsage(inputTok, Math.ceil(mockResp.length / 4));
    return 200;
  }

  // Claude Code permission requests
  if (pathname.match(/\/v1\/code\/sessions\/([^/]+)\/permissions$/) && method === 'GET') {
    const sessId = pathname.match(/\/v1\/code\/sessions\/([^/]+)\/permissions$/)[1];
    const pending = [...permissionRequests.values()].filter(p => p.session_id === sessId && p.status === 'pending');
    sendJson(res, { permissions: pending });
    return 200;
  }

  if (pathname.match(/\/v1\/code\/permissions\/([^/]+)\/respond$/) && method === 'POST') {
    const prId = pathname.match(/\/v1\/code\/permissions\/([^/]+)\/respond$/)[1];
    const body = await readBody(req);
    const pr   = permissionRequests.get(prId);
    if (!pr) { sendJson(res, errorEnvelope('not_found_error', 'Permission request not found'), 404); return 404; }
    pr.status = body.granted ? 'granted' : 'denied';
    pr.responded_at = new Date().toISOString();
    sendJson(res, pr);
    return 200;
  }

  if (pathname === '/v1/code/github/repos' && method === 'GET') {
    sendJson(res, { repos: [] });
    return 200;
  }

  if (pathname.match(/\/v1\/code\/github\//)) {
    sendJson(res, { status: 'ok', data: null });
    return 200;
  }

  // ── Extended thinking completion mode ─────────────────────────
  // Worker B will set x-thinking: 1 to get a thinking-block response
  if (pathname === '/v1/messages/thinking' && method === 'POST') {
    const body    = await readBody(req);
    const mutated = applyMutation(body);
    const model   = resolveModelAlias(body.model || config.default_model);

    if (config.backend !== 'lm_studio' || config.api_key || config.oauth_token) {
      proxyRequest(req, res, mutated, '/v1/messages', 'POST');
      return 200;
    }

    const prompt      = extractLastUserText(body.messages);
    const thinking    = `Let me think through this step by step.\n\nThe user asked: "${prompt}"\n\nI need to consider:\n1. The core question\n2. Relevant context\n3. Best approach\n\nAfter careful consideration, I'll provide a comprehensive answer.`;
    const response    = `Based on my analysis: ${prompt || 'I understand your query.'}\n\n[Sister PoC extended thinking mock response]`;

    res.writeHead(200, { ...sseStartHeaders(reqId, origin), ...buildRateLimitHeaders() });
    emitAnthropicThinkingStream(res, reqId, thinking, response, model);
    res.end();
    recordUsage(Math.ceil(prompt.length / 4), Math.ceil((thinking + response).length / 4));
    return 200;
  }

  // ── Tool-use test endpoint ─────────────────────────────────────
  if (pathname === '/v1/messages/tools' && method === 'POST') {
    const body    = await readBody(req);
    const mutated = applyMutation(body);
    const model   = resolveModelAlias(body.model || config.default_model);

    if (config.api_key || config.oauth_token) {
      proxyRequest(req, res, mutated, '/v1/messages', 'POST');
      return 200;
    }

    // Mock tool_use response with the first defined tool
    const tools    = body.tools || [];
    const firstTool = tools[0];
    if (!firstTool) {
      sendJson(res, errorEnvelope('invalid_request_error', 'No tools defined'), 400);
      return 400;
    }

    const toolCalls = [{
      name:  firstTool.name,
      input: Object.fromEntries(
        Object.entries(firstTool.input_schema?.properties || {})
          .map(([k, v]) => [k, v.type === 'number' ? 42 : v.type === 'boolean' ? true : 'example'])
      ),
    }];

    res.writeHead(200, { ...sseStartHeaders(reqId, origin), ...buildRateLimitHeaders() });
    emitAnthropicToolUseStream(res, reqId, toolCalls, model, 'I\'ll use the requested tool:');
    res.end();
    recordUsage(50, 30);
    return 200;
  }

  // ── Rate limit headers endpoint ────────────────────────────────
  if (pathname === '/v1/rate_limits' && method === 'GET') {
    sendJson(res, rlState);
    return 200;
  }

  // ── Request log (for setup page) ──────────────────────────────
  if (pathname === '/debug/logs' && method === 'GET') {
    const limit = parseInt(parsed.query.limit) || 100;
    sendJson(res, { logs: requestLog.slice(-limit).reverse() });
    return 200;
  }

  if (pathname === '/debug/logs' && method === 'DELETE') {
    requestLog.length = 0;
    sendJson(res, { ok: true });
    return 200;
  }

  if (pathname === '/debug/conversations' && method === 'GET') {
    sendJson(res, {
      conversations: [...conversations.values()],
      message_counts: Object.fromEntries([...convMessages.entries()].map(([k, v]) => [k, v.length])),
      artifact_counts: Object.fromEntries([...artifacts.entries()].map(([k, v]) => [k, v.versions.length])),
    });
    return 200;
  }

  if (pathname === '/debug/reset' && method === 'POST') {
    // Reset all in-memory state
    conversations.clear();
    convMessages.clear();
    artifacts.clear();
    memoryStore.length = 0;
    projects.clear();
    projectDocs.clear();
    projectFiles.clear();
    shareStore.clear();
    fileStore.clear();
    notifications.length = 0;
    mcpServers.clear();
    claudeCodeSessions.clear();
    permissionRequests.clear();
    requestLog.length = 0;
    diagnostics.requestCount  = 0;
    diagnostics.sseStreams     = 0;
    diagnostics.conversations  = 0;
    console.log('[worker-a] State reset via /debug/reset');
    sendJson(res, { ok: true, message: 'All in-memory state cleared' });
    return 200;
  }

  // ── Generic org sub-resource catch-all (returns empty) ────────
  // Handles any unrecognized /api/organizations/*/something paths
  if (pathname.match(/^\/api\/organizations\/[^/]+\//) && method === 'GET') {
    sendJson(res, []);
    return 200;
  }

  // ── Webhooks ──────────────────────────────────────────────────
  if (pathname.match(/\/webhooks?$/) && method === 'GET') {
    sendJson(res, { webhooks: [...webhooks.values()] });
    return 200;
  }

  if (pathname.match(/\/webhooks?$/) && method === 'POST') {
    const body = await readBody(req);
    if (!body.url) { sendJson(res, errorEnvelope('invalid_request_error', 'url required'), 400); return 400; }
    if (isBlockedUrl(body.url)) { sendJson(res, errorEnvelope('invalid_request_error', 'Blocked URL'), 400); return 400; }
    const wh = makeWebhook(body);
    audit('webhook.create', 'webhook', wh.uuid, { name: wh.name });
    sendJson(res, wh, 201);
    return 201;
  }

  if (pathname.match(/\/webhooks?\/([^/]+)$/) && method === 'GET') {
    const whId = pathname.match(/\/webhooks?\/([^/]+)$/)[1];
    const wh   = webhooks.get(whId);
    if (!wh) { sendJson(res, errorEnvelope('not_found_error', 'Webhook not found'), 404); return 404; }
    sendJson(res, wh);
    return 200;
  }

  if (pathname.match(/\/webhooks?\/([^/]+)$/) && (method === 'PATCH' || method === 'PUT')) {
    const body = await readBody(req);
    const whId = pathname.match(/\/webhooks?\/([^/]+)$/)[1];
    const wh   = webhooks.get(whId);
    if (!wh) { sendJson(res, errorEnvelope('not_found_error', 'Webhook not found'), 404); return 404; }
    if (body.url && isBlockedUrl(body.url)) { sendJson(res, errorEnvelope('invalid_request_error', 'Blocked URL'), 400); return 400; }
    Object.assign(wh, body, { updated_at: new Date().toISOString() });
    sendJson(res, wh);
    return 200;
  }

  if (pathname.match(/\/webhooks?\/([^/]+)$/) && method === 'DELETE') {
    const whId = pathname.match(/\/webhooks?\/([^/]+)$/)[1];
    webhooks.delete(whId);
    webhookDeliveries.delete(whId);
    audit('webhook.delete', 'webhook', whId, {});
    res.writeHead(204); res.end();
    return 204;
  }

  if (pathname.match(/\/webhooks?\/([^/]+)\/deliveries?$/)) {
    const whId = pathname.match(/\/webhooks?\/([^/]+)\/deliveries?$/)[1];
    const dels = webhookDeliveries.get(whId) || [];
    sendJson(res, { deliveries: dels.slice(-50).reverse() });
    return 200;
  }

  if (pathname.match(/\/webhooks?\/([^/]+)\/test$/) && method === 'POST') {
    const body = await readBody(req);
    const whId = pathname.match(/\/webhooks?\/([^/]+)\/test$/)[1];
    const wh   = webhooks.get(whId);
    if (!wh) { sendJson(res, errorEnvelope('not_found_error', 'Webhook not found'), 404); return 404; }
    const del = recordWebhookDelivery(whId, 'test', body || { test: true }, 200);
    dispatchWebhookEvent('test', { webhook_id: whId, timestamp: new Date().toISOString() });
    sendJson(res, del);
    return 200;
  }

  // ── API Keys ──────────────────────────────────────────────────
  if (pathname.match(/\/api_keys?$/) && method === 'GET') {
    // Never return key_value in list response
    const keyList = [...apiKeys.values()].map(({ key_value, ...rest }) => rest);
    sendJson(res, { api_keys: keyList });
    return 200;
  }

  if (pathname.match(/\/api_keys?$/) && method === 'POST') {
    const body = await readBody(req);
    const key  = makeApiKey(body);
    audit('api_key.create', 'api_key', key.uuid, { name: key.name });
    // Return key_value once on creation only
    sendJson(res, key, 201);
    return 201;
  }

  if (pathname.match(/\/api_keys?\/([^/]+)$/) && method === 'GET') {
    const keyId = pathname.match(/\/api_keys?\/([^/]+)$/)[1];
    const key   = apiKeys.get(keyId);
    if (!key) { sendJson(res, errorEnvelope('not_found_error', 'API key not found'), 404); return 404; }
    const { key_value, ...rest } = key;
    sendJson(res, rest);
    return 200;
  }

  if (pathname.match(/\/api_keys?\/([^/]+)$/) && method === 'DELETE') {
    const keyId = pathname.match(/\/api_keys?\/([^/]+)$/)[1];
    const key   = apiKeys.get(keyId);
    if (key) { key.is_active = false; audit('api_key.revoke', 'api_key', keyId, {}); }
    res.writeHead(204); res.end();
    return 204;
  }

  if (pathname.match(/\/api_keys?\/([^/]+)\/rotate$/) && method === 'POST') {
    const keyId  = pathname.match(/\/api_keys?\/([^/]+)\/rotate$/)[1];
    const oldKey = apiKeys.get(keyId);
    if (!oldKey) { sendJson(res, errorEnvelope('not_found_error', 'API key not found'), 404); return 404; }
    oldKey.is_active = false;
    const newKey = makeApiKey({ name: oldKey.name + ' (rotated)', scopes: oldKey.scopes });
    audit('api_key.rotate', 'api_key', keyId, { new_key_id: newKey.uuid });
    sendJson(res, newKey, 201);
    return 201;
  }

  // ── Audit Log ─────────────────────────────────────────────────
  if (pathname.match(/\/audit_log$/) && method === 'GET') {
    const limit  = Math.min(parseInt(parsed.query.limit)  || 50, 200);
    const offset = parseInt(parsed.query.offset) || 0;
    const action = parsed.query.action;
    const rtype  = parsed.query.resource_type;
    let entries  = [...auditLog];
    if (action) entries = entries.filter(e => e.action === action);
    if (rtype)  entries = entries.filter(e => e.resource_type === rtype);
    entries = entries.reverse().slice(offset, offset + limit);
    sendJson(res, { entries, total: auditLog.length, limit, offset });
    return 200;
  }

  // ── SSO Configuration ─────────────────────────────────────────
  if (pathname.match(/\/sso\/config$/) && method === 'GET') {
    const { ...pub } = ssoConfig;
    delete pub.sso_url; // Don't expose in mock
    sendJson(res, pub);
    return 200;
  }

  if (pathname.match(/\/sso\/config$/) && method === 'POST') {
    const body = await readBody(req);
    Object.assign(ssoConfig, body);
    audit('sso.config.update', 'sso_config', ORG_UUID, { provider: body.provider });
    sendJson(res, ssoConfig);
    return 200;
  }

  if (pathname.match(/\/sso\/metadata$/) && method === 'GET') {
    const metadataXml = `<?xml version="1.0" encoding="UTF-8"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${ssoConfig.entity_id}">
  <SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${ssoConfig.acs_url}" index="0"/>
  </SPSSODescriptor>
</EntityDescriptor>`;
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end(metadataXml);
    return 200;
  }

  if (pathname.match(/\/auth\/saml\/acs$/) && method === 'POST') {
    // Mock SAML assertion consumer service
    const token = `saml_${crypto.randomBytes(24).toString('hex')}`;
    sessionTokens.set(token, { accountUuid: ACCOUNT_UUID, createdAt: Date.now(), via: 'saml' });
    audit('sso.login', 'session', token, { provider: ssoConfig.provider });
    // Redirect to Worker B
    res.writeHead(302, { 'Location': '/?sso=success&token=' + token });
    res.end();
    return 302;
  }

  // ── SCIM v2 ───────────────────────────────────────────────────
  if (pathname === '/scim/v2/Users' && method === 'GET') {
    const filter = parsed.query.filter || '';
    let users = [...scimUsers.values()];
    if (filter.match(/userName eq ["']([^"']+)["']/i)) {
      const uname = filter.match(/userName eq ["']([^"']+)["']/i)[1];
      users = users.filter(u => u.userName === uname);
    }
    sendJson(res, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: users.length,
      startIndex:   1,
      itemsPerPage: users.length,
      Resources:    users,
    });
    return 200;
  }

  if (pathname === '/scim/v2/Users' && method === 'POST') {
    const body = await readBody(req);
    const uid  = uuidv4();
    const user = {
      id:          uid,
      externalId:  body.externalId || null,
      userName:    body.userName   || body.emails?.[0]?.value || '',
      displayName: body.displayName || body.name?.formatted || '',
      active:      body.active !== false,
      emails:      body.emails || [],
      name:        body.name   || {},
      roles:       [{ value: ssoConfig.default_role, display: ssoConfig.default_role }],
      meta: {
        resourceType: 'User',
        created:      new Date().toISOString(),
        lastModified: new Date().toISOString(),
        version:      'W/"1"',
        location:     `/scim/v2/Users/${uid}`,
      },
    };
    scimUsers.set(uid, user);
    audit('scim.user.create', 'scim_user', uid, { userName: user.userName });
    sendJson(res, user, 201);
    return 201;
  }

  if (pathname.match(/^\/scim\/v2\/Users\/([^/]+)$/) && method === 'GET') {
    const uid  = pathname.match(/^\/scim\/v2\/Users\/([^/]+)$/)[1];
    const user = scimUsers.get(uid);
    if (!user) { sendJson(res, { status: 404, detail: 'User not found' }, 404); return 404; }
    sendJson(res, user);
    return 200;
  }

  if (pathname.match(/^\/scim\/v2\/Users\/([^/]+)$/) && (method === 'PUT' || method === 'PATCH')) {
    const body = await readBody(req);
    const uid  = pathname.match(/^\/scim\/v2\/Users\/([^/]+)$/)[1];
    const user = scimUsers.get(uid);
    if (!user) { sendJson(res, { status: 404, detail: 'User not found' }, 404); return 404; }
    Object.assign(user, body, { id: uid, 'meta.lastModified': new Date().toISOString() });
    audit('scim.user.update', 'scim_user', uid, {});
    sendJson(res, user);
    return 200;
  }

  if (pathname.match(/^\/scim\/v2\/Users\/([^/]+)$/) && method === 'DELETE') {
    const uid = pathname.match(/^\/scim\/v2\/Users\/([^/]+)$/)[1];
    scimUsers.delete(uid);
    audit('scim.user.delete', 'scim_user', uid, {});
    res.writeHead(204); res.end();
    return 204;
  }

  if (pathname === '/scim/v2/Groups' && method === 'GET') {
    sendJson(res, { schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: 0, startIndex: 1, itemsPerPage: 0, Resources: [] });
    return 200;
  }

  if (pathname === '/scim/v2/ServiceProviderConfig') {
    sendJson(res, {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      patch:       { supported: true },
      bulk:        { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter:      { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort:        { supported: false },
      etag:        { supported: false },
      authenticationSchemes: [{
        name: 'OAuth Bearer Token', description: 'Authentication Scheme using the OAuth Bearer Token Standard',
        specUri: 'http://www.rfc-editor.org/info/rfc6750', type: 'oauthbearertoken', primary: true,
      }],
    });
    return 200;
  }

  // ── Computer Use Beta ─────────────────────────────────────────
  if (pathname === '/v1/computer_use/sessions' && method === 'GET') {
    sendJson(res, { sessions: [...computerUseSessions.values()] });
    return 200;
  }

  if (pathname === '/v1/computer_use/sessions' && method === 'POST') {
    const body = await readBody(req);
    const sess = makeComputerUseSession(body);
    audit('computer_use.session.create', 'computer_use_session', sess.uuid, {});
    sendJson(res, sess, 201);
    return 201;
  }

  if (pathname.match(/^\/v1\/computer_use\/sessions\/([^/]+)$/) && method === 'GET') {
    const sessId = pathname.match(/^\/v1\/computer_use\/sessions\/([^/]+)$/)[1];
    const sess   = computerUseSessions.get(sessId);
    if (!sess) { sendJson(res, errorEnvelope('not_found_error', 'Session not found'), 404); return 404; }
    sendJson(res, sess);
    return 200;
  }

  if (pathname.match(/^\/v1\/computer_use\/sessions\/([^/]+)\/screenshot$/) && method === 'GET') {
    // Return a minimal 1x1 PNG in base64 for testing
    const png1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    sendJson(res, {
      session_id:    pathname.match(/\/sessions\/([^/]+)\//)[1],
      screenshot:    png1x1,
      content_type:  'image/png',
      captured_at:   new Date().toISOString(),
      resolution:    { width: 1280, height: 800 },
    });
    return 200;
  }

  if (pathname.match(/^\/v1\/computer_use\/sessions\/([^/]+)\/action$/) && method === 'POST') {
    const body   = await readBody(req);
    const sessId = pathname.match(/^\/v1\/computer_use\/sessions\/([^/]+)\/action$/)[1];
    const sess   = computerUseSessions.get(sessId);
    if (!sess) { sendJson(res, errorEnvelope('not_found_error', 'Session not found'), 404); return 404; }
    sess.updated_at = new Date().toISOString();
    sendJson(res, {
      session_id: sessId,
      action:     body.action || 'unknown',
      success:    true,
      result:     null,
      screenshot: null,
    });
    return 200;
  }

  // ── Voice / Audio ─────────────────────────────────────────────
  if (pathname.match(/\/voice\/capabilities$/) && method === 'GET') {
    sendJson(res, buildVoiceCapabilities());
    return 200;
  }

  if (pathname.match(/\/voice\/transcribe$/) && method === 'POST') {
    sendJson(res, {
      text:       '[Voice transcription not available in mock mode]',
      confidence: 0.0,
      language:   'en-US',
      duration_s: 0,
    });
    return 200;
  }

  if (pathname.match(/\/voice\/synthesize$/) && method === 'POST') {
    sendJson(res, {
      audio_url: null,
      duration_s: 0,
      format: 'mp3',
      message: 'Voice synthesis not available in mock mode',
    });
    return 200;
  }

  // ── Integrations ──────────────────────────────────────────────
  if (pathname.match(/\/integrations$/) && method === 'GET') {
    sendJson(res, { integrations: [...integrations.values()] });
    return 200;
  }

  if (pathname.match(/\/integrations$/) && method === 'POST') {
    const body = await readBody(req);
    const integ = makeIntegration(body.type || 'custom', body);
    audit('integration.connect', 'integration', integ.uuid, { type: integ.type });
    sendJson(res, integ, 201);
    return 201;
  }

  if (pathname.match(/\/integrations\/([^/]+)$/) && method === 'DELETE') {
    const intId = pathname.match(/\/integrations\/([^/]+)$/)[1];
    integrations.delete(intId);
    res.writeHead(204); res.end();
    return 204;
  }

  // Google Drive specific
  if (pathname.match(/\/integrations\/gdrive\//) ) {
    if (method === 'GET') sendJson(res, { files: [], next_page_token: null });
    else sendJson(res, { ok: true });
    return 200;
  }

  // GitHub specific
  if (pathname.match(/\/integrations\/github\//) ) {
    if (method === 'GET') sendJson(res, { repos: [], installations: [] });
    else sendJson(res, { ok: true });
    return 200;
  }

  // ── Prompt Templates ──────────────────────────────────────────
  if (pathname.match(/\/prompt_templates?$/) && method === 'GET') {
    const isPublic = parsed.query.public === 'true';
    let list = [...promptTemplates.values()];
    if (isPublic) list = list.filter(p => p.is_public);
    sendJson(res, { templates: list });
    return 200;
  }

  if (pathname.match(/\/prompt_templates?$/) && method === 'POST') {
    const body = await readBody(req);
    const pt   = makePromptTemplate(body);
    audit('prompt_template.create', 'prompt_template', pt.uuid, { name: pt.name });
    sendJson(res, pt, 201);
    return 201;
  }

  if (pathname.match(/\/prompt_templates?\/([^/]+)$/) && method === 'GET') {
    const ptId = pathname.match(/\/prompt_templates?\/([^/]+)$/)[1];
    const pt   = promptTemplates.get(ptId);
    if (!pt) { sendJson(res, errorEnvelope('not_found_error', 'Template not found'), 404); return 404; }
    sendJson(res, pt);
    return 200;
  }

  if (pathname.match(/\/prompt_templates?\/([^/]+)$/) && (method === 'PATCH' || method === 'PUT')) {
    const body = await readBody(req);
    const ptId = pathname.match(/\/prompt_templates?\/([^/]+)$/)[1];
    const pt   = promptTemplates.get(ptId);
    if (!pt) { sendJson(res, errorEnvelope('not_found_error', 'Template not found'), 404); return 404; }
    Object.assign(pt, body, { updated_at: new Date().toISOString() });
    sendJson(res, pt);
    return 200;
  }

  if (pathname.match(/\/prompt_templates?\/([^/]+)$/) && method === 'DELETE') {
    const ptId = pathname.match(/\/prompt_templates?\/([^/]+)$/)[1];
    promptTemplates.delete(ptId);
    res.writeHead(204); res.end();
    return 204;
  }

  if (pathname.match(/\/prompt_templates?\/([^/]+)\/use$/) && method === 'POST') {
    const ptId = pathname.match(/\/prompt_templates?\/([^/]+)\/use$/)[1];
    const pt   = promptTemplates.get(ptId);
    if (pt) pt.use_count++;
    sendJson(res, { ok: true, use_count: pt?.use_count || 0 });
    return 200;
  }

  // ── Conversation search ───────────────────────────────────────
  if (pathname.match(/\/search\/conversations$/) || pathname.match(/\/chat_conversations\/search$/)) {
    const q     = method === 'GET' ? (parsed.query.q || '') : (await readBody(req)).query || '';
    const limit = parseInt(parsed.query.limit) || 20;
    const results = searchConversations(q, limit);
    sendJson(res, { results, total: results.length, query: q });
    return 200;
  }

  // ── Conversation regenerate ───────────────────────────────────
  if (pathname.match(/\/chat_conversations\/([^/]+)\/regenerate$/) && method === 'POST') {
    const convId  = pathname.match(/\/chat_conversations\/([^/]+)\/regenerate$/)[1];
    const body    = await readBody(req);
    const conv    = conversations.get(convId);
    if (!conv) { sendJson(res, errorEnvelope('not_found_error', 'Conversation not found'), 404); return 404; }

    const contBody = buildContinuationBody(convId, null, body.model || conv.model);
    const mutated  = applyMutation(contBody);
    const model    = resolveModelAlias(body.model || conv.model || config.default_model);

    if (config.auth_mode === 'cookie_bridge' || config.backend === 'cookie_bridge') {
      dispatchToBridge(req, res, mutated, `/api/organizations/${ORG_UUID}/chat_conversations/${convId}/completion`, 'POST');
      return 200;
    }

    const mockText   = `[Regenerated response for conversation ${convId}]`;
    const inputToks  = Math.ceil(JSON.stringify(contBody).length / 4);
    res.writeHead(200, { ...sseStartHeaders(reqId, origin), ...buildRateLimitHeaders() });
    emitAnthropicTextStream(res, reqId, mockText, model, inputToks);
    res.end();
    recordUsage(inputToks, Math.ceil(mockText.length / 4));
    return 200;
  }

  // ── Conversation continue (pass additional user text) ─────────
  if (pathname.match(/\/chat_conversations\/([^/]+)\/continue$/) && method === 'POST') {
    const convId = pathname.match(/\/chat_conversations\/([^/]+)\/continue$/)[1];
    const body   = await readBody(req);
    const conv   = conversations.get(convId);
    if (!conv) { sendJson(res, errorEnvelope('not_found_error', 'Conversation not found'), 404); return 404; }

    const contBody = buildContinuationBody(convId, body.prompt, body.model || conv.model);
    const mutated  = applyMutation(contBody);
    const model    = resolveModelAlias(body.model || conv.model || config.default_model);

    if (config.auth_mode === 'cookie_bridge' || config.backend === 'cookie_bridge') {
      dispatchToBridge(req, res, mutated, `/api/organizations/${ORG_UUID}/chat_conversations/${convId}/completion`, 'POST');
      return 200;
    }

    if (resolveBackendUrl(config.backend)) {
      proxyRequest(req, res, anthropicToOpenAI(mutated), '/v1/chat/completions', 'POST');
      return 200;
    }

    const mockText  = `[Continuation response] ${body.prompt || ''}`;
    const inputToks = Math.ceil(JSON.stringify(contBody).length / 4);
    res.writeHead(200, { ...sseStartHeaders(reqId, origin), ...buildRateLimitHeaders() });
    emitAnthropicTextStream(res, reqId, mockText, model, inputToks);
    res.end();
    recordUsage(inputToks, Math.ceil(mockText.length / 4));
    return 200;
  }

  // ── Model aliases management ──────────────────────────────────
  if (pathname === '/bridge/model_aliases' && method === 'GET') {
    sendJson(res, { aliases: config.model_aliases });
    return 200;
  }

  if (pathname === '/bridge/model_aliases' && method === 'POST') {
    const body = await readBody(req);
    config.model_aliases = { ...config.model_aliases, ...body };
    saveConfig();
    sendJson(res, { aliases: config.model_aliases });
    return 200;
  }

  // ── WS bridge status ──────────────────────────────────────────
  if (pathname === '/bridge/status' && method === 'GET') {
    sendJson(res, {
      connected:       !!activeBridgeSocket,
      pending_requests: pendingBridge.size,
      last_connect:    diagnostics.lastWsConnect,
      ws_url:          `ws://${HOST || '127.0.0.1'}:${PORT || 8787}/ws`,
    });
    return 200;
  }

  if (pathname === '/bridge/disconnect' && method === 'POST') {
    if (activeBridgeSocket) {
      activeBridgeSocket.terminate();
      activeBridgeSocket = null;
      sendJson(res, { ok: true, message: 'Worker C disconnected' });
    } else {
      sendJson(res, { ok: false, message: 'Worker C not connected' });
    }
    return 200;
  }

  // ── Blocked hosts management ──────────────────────────────────
  if (pathname === '/bridge/blocked_hosts' && method === 'GET') {
    sendJson(res, { hosts: [...BLOCKED_HOSTS] });
    return 200;
  }

  // (Adding to blocked hosts is allowed, removing the hardcoded ones is not)
  if (pathname === '/bridge/blocked_hosts' && method === 'POST') {
    const body = await readBody(req);
    const toAdd = body.hosts || [];
    for (const h of toAdd) {
      if (typeof h === 'string' && h.trim()) BLOCKED_HOSTS.add(h.trim().toLowerCase());
    }
    sendJson(res, { hosts: [...BLOCKED_HOSTS] });
    return 200;
  }

  // ── Prompt caching config ─────────────────────────────────────
  if (pathname === '/v1/cache/control' && method === 'POST') {
    const body = await readBody(req);
    sendJson(res, { cache_creation: body, ok: true });
    return 200;
  }

  // ── Batch messages (Anthropic batch API) ─────────────────────
  if (pathname === '/v1/messages/batches' && method === 'POST') {
    const body    = await readBody(req);
    const requests = body.requests || [];
    const batchId  = `msgbatch_${crypto.randomBytes(12).toString('hex')}`;

    if (config.api_key || config.oauth_token) {
      proxyRequest(req, res, body, '/v1/messages/batches', 'POST');
      return 200;
    }

    // Mock batch processing
    const results = requests.slice(0, 100).map(r => ({
      custom_id: r.custom_id,
      result: {
        type: 'succeeded',
        message: {
          id:           `msg_${crypto.randomBytes(12).toString('hex')}`,
          type:         'message',
          role:         'assistant',
          model:        resolveModelAlias(r.params?.model || config.default_model),
          content:      [{ type: 'text', text: `Mock batch response for ${r.custom_id}` }],
          stop_reason:  'end_turn',
          stop_sequence: null,
          usage:        { input_tokens: 10, output_tokens: 8 },
        },
      },
    }));

    sendJson(res, {
      id:               batchId,
      type:             'message_batch',
      processing_status: 'ended',
      request_counts:   { processing: 0, succeeded: results.length, errored: 0, canceled: 0, expired: 0 },
      ended_at:         new Date().toISOString(),
      created_at:       new Date().toISOString(),
      expires_at:       new Date(Date.now() + 29 * 86400000).toISOString(),
      results_url:      `/v1/messages/batches/${batchId}/results`,
    }, 202);
    return 202;
  }

  if (pathname.match(/^\/v1\/messages\/batches\/([^/]+)\/results$/)) {
    const batchId = pathname.match(/^\/v1\/messages\/batches\/([^/]+)\/results$/)[1];
    sendJson(res, { data: [], has_more: false, first_id: null, last_id: null });
    return 200;
  }

  if (pathname.match(/^\/v1\/messages\/batches\/([^/]+)$/) && method === 'GET') {
    const batchId = pathname.match(/^\/v1\/messages\/batches\/([^/]+)$/)[1];
    sendJson(res, {
      id: batchId, type: 'message_batch', processing_status: 'ended',
      request_counts: { processing: 0, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
      ended_at: new Date().toISOString(), created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 29 * 86400000).toISOString(),
      results_url: `/v1/messages/batches/${batchId}/results`,
    });
    return 200;
  }

  // ── Completions with rate-limit headers ───────────────────────
  // Patch the main /v1/messages handler to add RL headers when serving mock
  // (the proxy path already passes through whatever the backend sends)

  // ── Server-sent events test endpoint ─────────────────────────
  if (pathname === '/v1/sse_test' && method === 'GET') {
    res.writeHead(200, sseStartHeaders(reqId, origin));
    const messages = [
      'Worker A SSE test — event 1 of 5',
      'Event 2: connection stable',
      'Event 3: ping/pong working',
      'Event 4: rate-limit headers forwarded',
      'Event 5: stream complete',
    ];
    let i = 0;
    const iv = setInterval(() => {
      if (i >= messages.length || res.writableEnded) { clearInterval(iv); try { res.end(); } catch {} return; }
      writeSSEEvent(res, 'test_message', { index: i, text: messages[i] });
      i++;
    }, 300);
    req.on('close', () => { clearInterval(iv); });
    return 200;
  }

  // ── Catch-all for organization sub-resources ──────────────────
  if (pathname.match(/^\/api\/organizations\/[^/]+\//) && method === 'GET') {
    sendJson(res, []);
    return 200;
  }

  // ── Worker B bootstrap ───────────────────────────────────────
  if (pathname === '/bootstrap' && method === 'GET') {
    sendJson(res, buildWorkerBBootstrap());
    return 200;
  }

  if (pathname === '/bootstrap/full' && method === 'GET') {
    sendJson(res, {
      ...buildWorkerBBootstrap(),
      conversations: [...conversations.values()].slice(0, 20),
      projects:      [...projects.values()].slice(0, 10),
      memory:        memoryStore.slice(0, 20),
      notifications: notifications.filter(n => !n.read).slice(0, 10),
    });
    return 200;
  }

  // ── Model capabilities ────────────────────────────────────────
  if (pathname.match(/^\/v1\/models\/([^/]+)\/capabilities$/) && method === 'GET') {
    const modelId = pathname.match(/^\/v1\/models\/([^/]+)\/capabilities$/)[1];
    const caps    = getModelCapabilities(modelId);
    if (!caps) { sendJson(res, errorEnvelope('not_found_error', 'Model not found'), 404); return 404; }
    sendJson(res, caps);
    return 200;
  }

  // ── Token validation (Worker B calls this) ────────────────────
  if (pathname === '/auth/validate' && method === 'GET') {
    const token  = extractLocalToken(req);
    const result = validateLocalToken(token);
    if (!result.valid) { sendJson(res, { valid: false }, 401); return 401; }
    sendJson(res, { valid: true, account: buildProfile() });
    return 200;
  }

  // ── Session list ──────────────────────────────────────────────
  if (pathname === '/auth/sessions' && method === 'GET') {
    sendJson(res, {
      sessions: [...sessionTokens.entries()].map(([token, sess]) => ({
        token_hint:   token.slice(0, 12) + '...',
        account_uuid: sess.accountUuid,
        created_at:   new Date(sess.createdAt).toISOString(),
        expires_at:   new Date(sess.createdAt + 30 * 86400000).toISOString(),
        via:          sess.via || 'password',
      })),
    });
    return 200;
  }

  if (pathname === '/auth/sessions/revoke_all' && method === 'POST') {
    const count = sessionTokens.size;
    sessionTokens.clear();
    audit('auth.sessions.revoke_all', 'session', 'all', { count });
    sendJson(res, { ok: true, revoked: count });
    return 200;
  }

  // ── Idempotency management ────────────────────────────────────
  if (pathname === '/bridge/idempotency' && method === 'GET') {
    sendJson(res, { cached: idempotencyCache.size, ttl_ms: IDEMPOTENCY_TTL });
    return 200;
  }

  if (pathname === '/bridge/idempotency' && method === 'DELETE') {
    idempotencyCache.clear();
    sendJson(res, { ok: true });
    return 200;
  }

  // ── Batch list ────────────────────────────────────────────────
  if (pathname === '/v1/messages/batches' && method === 'GET') {
    const limit = parseInt(parsed.query.limit) || 20;
    const after = parsed.query.after_id;
    let batches = [...batchStore.values()].reverse();
    if (after) {
      const idx = batches.findIndex(b => b.id === after);
      if (idx >= 0) batches = batches.slice(idx + 1);
    }
    batches = batches.slice(0, limit);
    sendJson(res, { data: batches, has_more: batchStore.size > limit, first_id: batches[0]?.id || null, last_id: batches[batches.length - 1]?.id || null });
    return 200;
  }

  if (pathname.match(/^\/v1\/messages\/batches\/([^/]+)\/cancel$/) && method === 'POST') {
    const batchId = pathname.match(/^\/v1\/messages\/batches\/([^/]+)\/cancel$/)[1];
    const batch   = batchStore.get(batchId);
    if (!batch) { sendJson(res, errorEnvelope('not_found_error', 'Batch not found'), 404); return 404; }
    batch.processing_status = 'ended';
    batch.cancel_initiated_at = new Date().toISOString();
    batch.ended_at = new Date().toISOString();
    sendJson(res, batch);
    return 200;
  }

  // ── Config export (strips credentials) ───────────────────────
  if (pathname === '/bridge/config/export' && method === 'GET') {
    const safe = { ...config };
    delete safe.api_key;
    delete safe.oauth_token;
    sendJson(res, safe);
    return 200;
  }

  if (pathname === '/bridge/config/import' && method === 'POST') {
    const body = await readBody(req);
    const safe = { ...body };
    delete safe.api_key;
    delete safe.oauth_token;
    config = deepMerge(config, safe);
    saveConfig();
    sendJson(res, { ok: true });
    return 200;
  }

  // ── Maintenance GC ────────────────────────────────────────────
  if (pathname === '/bridge/gc' && method === 'POST') {
    const body    = await readBody(req);
    const maxAge  = (body.max_age_hours || 168) * 3600000; // default 7 days
    const cutoff  = Date.now() - maxAge;
    let deleted   = 0;
    for (const [id, conv] of conversations.entries()) {
      if (new Date(conv.updated_at).getTime() < cutoff) {
        conversations.delete(id);
        convMessages.delete(id);
        deleted++;
      }
    }
    let sessDeleted = 0;
    for (const [token, sess] of sessionTokens.entries()) {
      if (Date.now() - sess.createdAt > 30 * 86400000) { sessionTokens.delete(token); sessDeleted++; }
    }
    let idempDeleted = 0;
    for (const [key, val] of idempotencyCache.entries()) {
      if (Date.now() - val.ts > IDEMPOTENCY_TTL) { idempotencyCache.delete(key); idempDeleted++; }
    }
    diagnostics.conversations = conversations.size;
    sendJson(res, { conversations_deleted: deleted, sessions_expired: sessDeleted, idempotency_cleared: idempDeleted, remaining: { conversations: conversations.size, sessions: sessionTokens.size } });
    return 200;
  }

  // ── Usage timeline for analytics panel ───────────────────────
  if (pathname === '/bridge/usage_timeline' && method === 'GET') {
    const days = parseInt(parsed.query.days) || 7;
    sendJson(res, buildUsageTimeline(days));
    return 200;
  }

  // ── SSE connection test ───────────────────────────────────────
  if (pathname === '/v1/sse_test' && method === 'GET') {
    res.writeHead(200, sseStartHeaders(reqId, origin));
    const msgs = ['SSE test 1/5', 'SSE test 2/5', 'SSE test 3/5', 'SSE test 4/5', 'SSE test 5/5 — done'];
    let i = 0;
    const iv = setInterval(() => {
      if (i >= msgs.length || res.writableEnded) { clearInterval(iv); try { res.end(); } catch {} return; }
      writeSSEEvent(res, 'test_message', { index: i, text: msgs[i], ts: Date.now() });
      i++;
    }, 300);
    req.on('close', () => clearInterval(iv));
    return 200;
  }

  // ── Favicon ───────────────────────────────────────────────────
  if (pathname === '/favicon.ico') {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'max-age=86400' });
    res.end(png);
    return 200;
  }

  // ── Conversation tags ─────────────────────────────────────────
  if (pathname.match(/\/chat_conversations\/([^/]+)\/tags$/) && method === 'GET') {
    const convId = pathname.match(/\/chat_conversations\/([^/]+)\/tags$/)[1];
    sendJson(res, { tags: getConvTags(convId) });
    return 200;
  }

  if (pathname.match(/\/chat_conversations\/([^/]+)\/tags$/) && method === 'POST') {
    const convId = pathname.match(/\/chat_conversations\/([^/]+)\/tags$/)[1];
    const body   = await readBody(req);
    const tags   = Array.isArray(body.tags) ? body.tags : [body.tag].filter(Boolean);
    for (const tag of tags) addTagToConv(convId, String(tag).slice(0, 64));
    sendJson(res, { tags: getConvTags(convId) });
    return 200;
  }

  if (pathname.match(/\/chat_conversations\/([^/]+)\/tags\/([^/]+)$/) && method === 'DELETE') {
    const [, convId, tag] = pathname.match(/\/chat_conversations\/([^/]+)\/tags\/([^/]+)$/);
    removeTagFromConv(convId, decodeURIComponent(tag));
    sendJson(res, { tags: getConvTags(convId) });
    return 200;
  }

  if (pathname === '/tags' && method === 'GET') {
    sendJson(res, { tags: getAllTags() });
    return 200;
  }

  if (pathname.match(/^\/tags\/([^/]+)\/conversations$/) && method === 'GET') {
    const tag    = decodeURIComponent(pathname.match(/^\/tags\/([^/]+)\/conversations$/)[1]);
    const convIds = conversationTags.get(tag) || [];
    const convs   = convIds.map(id => conversations.get(id)).filter(Boolean);
    sendJson(res, convs);
    return 200;
  }

  // ── User preferences ──────────────────────────────────────────
  if (pathname.match(/\/preferences$/) && method === 'GET') {
    sendJson(res, userPreferences);
    return 200;
  }

  if (pathname.match(/\/preferences$/) && (method === 'PATCH' || method === 'PUT')) {
    const body = await readBody(req);
    Object.assign(userPreferences, body);
    sendJson(res, userPreferences);
    return 200;
  }

  if (pathname.match(/\/preferences\/([^/]+)$/) && method === 'GET') {
    const key = pathname.match(/\/preferences\/([^/]+)$/)[1];
    if (key in userPreferences) {
      sendJson(res, { [key]: userPreferences[key] });
    } else {
      sendJson(res, errorEnvelope('not_found_error', `Preference '${key}' not found`), 404);
    }
    return 200;
  }

  if (pathname.match(/\/preferences\/([^/]+)$/) && method === 'PUT') {
    const body = await readBody(req);
    const key  = pathname.match(/\/preferences\/([^/]+)$/)[1];
    userPreferences[key] = body.value;
    sendJson(res, { [key]: userPreferences[key] });
    return 200;
  }

  // ── Message reactions ─────────────────────────────────────────
  if (pathname.match(/\/messages\/([^/]+)\/reactions$/) && method === 'GET') {
    const msgId = pathname.match(/\/messages\/([^/]+)\/reactions$/)[1];
    sendJson(res, { reactions: messageReactions.get(msgId) || [] });
    return 200;
  }

  if (pathname.match(/\/messages\/([^/]+)\/reactions$/) && method === 'POST') {
    const body  = await readBody(req);
    const msgId = pathname.match(/\/messages\/([^/]+)\/reactions$/)[1];
    const rxns  = addReaction(msgId, body.emoji || '👍');
    sendJson(res, { reactions: rxns });
    return 200;
  }

  if (pathname.match(/\/messages\/([^/]+)\/reactions\/([^/]+)$/) && method === 'DELETE') {
    const [, msgId, emoji] = pathname.match(/\/messages\/([^/]+)\/reactions\/([^/]+)$/);
    const rxns  = removeReaction(msgId, decodeURIComponent(emoji));
    sendJson(res, { reactions: rxns });
    return 200;
  }

  // ── Drafts ────────────────────────────────────────────────────
  if (pathname.match(/\/drafts$/) && method === 'GET') {
    sendJson(res, { drafts: [...draftStore.values()].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)) });
    return 200;
  }

  if (pathname.match(/\/drafts$/) && method === 'POST') {
    const body  = await readBody(req);
    const draft = makeDraft(body);
    sendJson(res, draft, 201);
    return 201;
  }

  if (pathname.match(/\/drafts\/([^/]+)$/) && (method === 'PATCH' || method === 'PUT')) {
    const body    = await readBody(req);
    const draftId = pathname.match(/\/drafts\/([^/]+)$/)[1];
    const draft   = draftStore.get(draftId);
    if (!draft) { sendJson(res, errorEnvelope('not_found_error', 'Draft not found'), 404); return 404; }
    Object.assign(draft, body, { updated_at: new Date().toISOString() });
    sendJson(res, draft);
    return 200;
  }

  if (pathname.match(/\/drafts\/([^/]+)$/) && method === 'DELETE') {
    const draftId = pathname.match(/\/drafts\/([^/]+)$/)[1];
    draftStore.delete(draftId);
    res.writeHead(204); res.end();
    return 204;
  }

  // ── Quick actions ─────────────────────────────────────────────
  if (pathname.match(/\/quick_actions?$/) && method === 'GET') {
    const pinned = parsed.query.pinned === 'true';
    let qas = [...quickActions.values()];
    if (pinned) qas = qas.filter(qa => qa.pinned);
    qas.sort((a, b) => b.pinned - a.pinned || b.use_count - a.use_count);
    sendJson(res, { quick_actions: qas });
    return 200;
  }

  if (pathname.match(/\/quick_actions?$/) && method === 'POST') {
    const body = await readBody(req);
    const qa   = makeQuickAction(body);
    sendJson(res, qa, 201);
    return 201;
  }

  if (pathname.match(/\/quick_actions?\/([^/]+)$/) && (method === 'PATCH' || method === 'PUT')) {
    const body = await readBody(req);
    const qaId = pathname.match(/\/quick_actions?\/([^/]+)$/)[1];
    const qa   = quickActions.get(qaId);
    if (!qa) { sendJson(res, errorEnvelope('not_found_error', 'Quick action not found'), 404); return 404; }
    Object.assign(qa, body, { updated_at: new Date().toISOString() });
    sendJson(res, qa);
    return 200;
  }

  if (pathname.match(/\/quick_actions?\/([^/]+)$/) && method === 'DELETE') {
    const qaId = pathname.match(/\/quick_actions?\/([^/]+)$/)[1];
    quickActions.delete(qaId);
    res.writeHead(204); res.end();
    return 204;
  }

  if (pathname.match(/\/quick_actions?\/([^/]+)\/use$/) && method === 'POST') {
    const qaId = pathname.match(/\/quick_actions?\/([^/]+)\/use$/)[1];
    const qa   = quickActions.get(qaId);
    if (qa) qa.use_count++;
    sendJson(res, { ok: true, prompt: qa?.prompt || '' });
    return 200;
  }

  // ── Keyboard shortcuts ────────────────────────────────────────
  if (pathname.match(/\/keyboard_shortcuts$/) && method === 'GET') {
    sendJson(res, { shortcuts: KEYBOARD_SHORTCUTS });
    return 200;
  }

  // ── Status page ───────────────────────────────────────────────
  if (pathname === '/status' || pathname === '/api/status') {
    sendJson(res, {
      page: { id: 'sister-poc', name: 'Sister PoC', url: `http://localhost:${config.port}`, updated_at: new Date().toISOString() },
      status: { indicator: 'none', description: 'All Systems Operational' },
      components: SERVICE_COMPONENTS,
      incidents: [],
    });
    return 200;
  }

  // ── Paprika / compass settings ────────────────────────────────
  if (pathname.match(/\/paprika_settings$/) && method === 'GET') {
    sendJson(res, buildPaprikaSettings());
    return 200;
  }

  // ── Statsig log events (sink) ─────────────────────────────────
  if (pathname.match(/\/v1\/statsig\/log_event$/) || pathname.match(/\/statsig\/log_events$/)) {
    const body = await readBody(req);
    sendJson(res, { success: true, events_received: (body?.events?.length || 0) });
    return 200;
  }

  // ── Conversation import ───────────────────────────────────────
  if (pathname.match(/\/chat_conversations\/import$/) && method === 'POST') {
    const body = await readBody(req);
    const convs = Array.isArray(body) ? body : [body];
    const imported = [];
    for (const c of convs) {
      const conv = makeConversation({ ...c, uuid: c.uuid || uuidv4() });
      if (Array.isArray(c.messages)) {
        for (const m of c.messages) {
          addMessage(conv.uuid, m.role || m.sender, m.content || m.text, m.parent_message_uuid, m.model);
        }
      }
      imported.push(conv);
    }
    sendJson(res, { imported: imported.length, conversations: imported });
    return 200;
  }

  // ── Claude Code batch status ──────────────────────────────────
  if (pathname === '/v1/code/status' && method === 'GET') {
    sendJson(res, {
      sessions:    claudeCodeSessions.size,
      active:      [...claudeCodeSessions.values()].filter(s => s.status === 'active').length,
      version:     SERVER_VERSION,
      capabilities: ['file_ops', 'shell', 'browser', 'memory'],
    });
    return 200;
  }

  // ── Rate limit headers route ──────────────────────────────────
  if (pathname === '/v1/rate_limits' && method === 'GET') {
    sendJson(res, rlState);
    return 200;
  }

  // ── Bootstrap ────────────────────────────────────────────────
  if (pathname === '/bootstrap' && method === 'GET') {
    sendJson(res, buildWorkerBBootstrap());
    return 200;
  }

  // ── Generic org sub-resource catch-all ────────────────────────
  if (pathname.match(/^\/api\/organizations\/[^/]+\//) && method === 'GET') {
    sendJson(res, []);
    return 200;
  }

  // ── Generic GET catch-all for unmapped v1/* endpoints ─────────
  if (pathname.match(/^\/v1\//) && method === 'GET') {
    sendJson(res, { data: [], has_more: false });
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
// Full tool-use accumulator: handles text + tool_calls deltas
// ────────────────────────────────────────────────────────────────
async function proxyAndTranslateOAItoAnthropic(req, res, oaiBody, reqId, origin) {
  const backendUrl = resolveBackendUrl(config.backend);
  if (!backendUrl) {
    sendJson(res, errorEnvelope('api_error', 'No backend configured'), 500);
    return 500;
  }

  const bodyStr  = JSON.stringify(oaiBody);
  const model    = resolveModelAlias(oaiBody.model || config.default_model);
  const authHdrs = buildAuthHeaders(config.auth_mode);
  const targetUrl = new URL(backendUrl + '/v1/chat/completions');

  if (isBlockedUrl(targetUrl.toString())) {
    sendJson(res, errorEnvelope('permission_error', 'Blocked host'), 403);
    return 403;
  }

  const msgId      = `msg_${crypto.randomBytes(12).toString('hex')}`;
  let started      = false;
  let textBlockIdx = 0;
  let inputToks    = 0;
  let outputToks   = 0;
  let hasToolUse   = false;

  // Tool-call accumulator: maps tool index → partial call object
  const toolCallAcc = new Map();
  // tool_block_index: tracks which Anthropic content block index each tool occupies
  const toolBlockMap = new Map(); // OAI tool index → anthropic block index

  const options = {
    hostname: targetUrl.hostname,
    port:     targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
    path:     targetUrl.pathname,
    method:   'POST',
    headers: {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      'Accept':         'text/event-stream',
      'User-Agent':     `worker-a/${SERVER_VERSION}`,
      ...authHdrs,
    },
    timeout: config.request_timeout_ms,
  };

  const transport = targetUrl.protocol === 'https:' ? https : http;

  return new Promise((resolve) => {
    const proxyReq = transport.request(options, (proxyRes) => {
      if (!proxyRes.statusCode || proxyRes.statusCode >= 400) {
        let errBody = '';
        proxyRes.on('data', c => errBody += c);
        proxyRes.on('end', () => {
          let errType = STATUS_TO_ANTHROPIC_TYPE[proxyRes.statusCode] || 'api_error';
          let errMsg  = 'Backend error ' + proxyRes.statusCode;
          try { const parsed = JSON.parse(errBody); errMsg = parsed.error?.message || parsed.message || errMsg; } catch {}
          sendJson(res, errorEnvelope(errType, errMsg), proxyRes.statusCode);
          resolve(proxyRes.statusCode);
        });
        return;
      }

      // Start Anthropic SSE response
      res.writeHead(200, { ...sseStartHeaders(reqId, origin), ...buildRateLimitHeaders() });

      let buffer = '';

      // Flush the Anthropic message_start
      const flushMessageStart = (inToks) => {
        inputToks = inToks || 0;
        writeSSEEvent(res, 'message_start', {
          type: 'message_start',
          message: {
            id: msgId, type: 'message', role: 'assistant', model,
            content: [], stop_reason: null, stop_sequence: null,
            usage: { input_tokens: inputToks, output_tokens: 1,
                     cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
        });
        started = true;
      };

      // Open a text content block (if we have text content)
      const openTextBlock = () => {
        writeSSEEvent(res, 'content_block_start', {
          type: 'content_block_start', index: textBlockIdx,
          content_block: { type: 'text', text: '' },
        });
      };

      // Close current text block and open a tool_use block at blockIdx
      const openToolBlock = (oaiIdx, toolId, toolName, blockIdx) => {
        if (textBlockIdx === blockIdx - 1 && started) {
          // Close text block first
          writeSSEEvent(res, 'content_block_stop', {
            type: 'content_block_stop', index: textBlockIdx,
          });
        }
        writeSSEEvent(res, 'content_block_start', {
          type: 'content_block_start', index: blockIdx,
          content_block: { type: 'tool_use', id: toolId, name: toolName, input: {} },
        });
        toolBlockMap.set(oaiIdx, blockIdx);
      };

      proxyRes.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;
          if (!line.startsWith('data: ')) continue;

          const dataStr = line.slice(6).trim();

          if (dataStr === '[DONE]') {
            // Finalize: close any open text block, then any tool blocks, then message
            if (started) {
              // If we have accumulated tool calls, emit them now
              if (toolCallAcc.size > 0) {
                hasToolUse = true;
                for (const [oaiIdx, tc] of toolCallAcc.entries()) {
                  const blockIdx = toolBlockMap.get(oaiIdx);
                  if (blockIdx !== undefined) {
                    writeSSEEvent(res, 'content_block_stop', { type: 'content_block_stop', index: blockIdx });
                  }
                }
              } else {
                // Close text block
                writeSSEEvent(res, 'content_block_stop', { type: 'content_block_stop', index: textBlockIdx });
              }

              const stopReason = hasToolUse ? 'tool_use' : 'end_turn';
              writeSSEEvent(res, 'message_delta', {
                type: 'message_delta',
                delta: { stop_reason: stopReason, stop_sequence: null },
                usage: { output_tokens: outputToks,
                         cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
              });
              writeSSEEvent(res, 'message_stop', { type: 'message_stop' });
            }
            try { res.end(); } catch {}
            recordUsage(inputToks, outputToks);
            resolve(200);
            return;
          }

          let ev;
          try { ev = JSON.parse(dataStr); } catch { continue; }

          // Extract usage from the OpenAI response if available
          if (ev.usage) {
            inputToks  = ev.usage.prompt_tokens    || inputToks;
            outputToks = ev.usage.completion_tokens || outputToks;
          }

          const choice = ev.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta || {};

          // First message with role
          if (!started && delta.role === 'assistant') {
            flushMessageStart(inputToks);
            openTextBlock();
          }

          if (!started) {
            flushMessageStart(inputToks);
            openTextBlock();
          }

          // Plain text delta
          if (typeof delta.content === 'string' && delta.content) {
            outputToks++;
            writeSSEEvent(res, 'content_block_delta', {
              type: 'content_block_delta', index: textBlockIdx,
              delta: { type: 'text_delta', text: delta.content },
            });
          }

          // Tool calls delta (incremental JSON arguments)
          if (delta.tool_calls?.length) {
            hasToolUse = true;
            for (const tcDelta of delta.tool_calls) {
              const idx = tcDelta.index ?? 0;

              if (!toolCallAcc.has(idx)) {
                // First chunk for this tool call
                const toolId   = tcDelta.id    || `toolu_${crypto.randomBytes(10).toString('hex')}`;
                const toolName = tcDelta.function?.name || 'unknown_tool';
                toolCallAcc.set(idx, { id: toolId, name: toolName, arguments: '' });

                // Assign an Anthropic block index
                // Close text block first (only if it was opened and is still the "current" block)
                if (started && !hasToolUse) {
                  writeSSEEvent(res, 'content_block_stop', { type: 'content_block_stop', index: textBlockIdx });
                }

                const blockIdx = toolBlockMap.size === 0 ? (textBlockIdx + 1) : Math.max(...toolBlockMap.values()) + 1;
                openToolBlock(idx, toolId, toolName, blockIdx);
              }

              const tc = toolCallAcc.get(idx);
              if (tcDelta.function?.arguments) {
                tc.arguments += tcDelta.function.arguments;
                outputToks++;
                const blockIdx = toolBlockMap.get(idx);
                if (blockIdx !== undefined) {
                  writeSSEEvent(res, 'content_block_delta', {
                    type: 'content_block_delta', index: blockIdx,
                    delta: { type: 'input_json_delta', partial_json: tcDelta.function.arguments },
                  });
                }
              }

              if (tcDelta.function?.name && tc) {
                tc.name = tcDelta.function.name;
              }
            }
          }

          // Finish reason
          if (choice.finish_reason && choice.finish_reason !== 'null') {
            // [DONE] will handle the actual close — just note the reason here
            if (choice.finish_reason === 'tool_calls') hasToolUse = true;
          }
        }
      });

      proxyRes.on('end', () => {
        // Stream ended without [DONE] (some backends do this)
        if (!res.writableEnded) {
          if (started) {
            if (!hasToolUse) {
              writeSSEEvent(res, 'content_block_stop', { type: 'content_block_stop', index: textBlockIdx });
            } else {
              for (const blockIdx of toolBlockMap.values()) {
                writeSSEEvent(res, 'content_block_stop', { type: 'content_block_stop', index: blockIdx });
              }
            }
            writeSSEEvent(res, 'message_delta', {
              type: 'message_delta',
              delta: { stop_reason: hasToolUse ? 'tool_use' : 'end_turn', stop_sequence: null },
              usage: { output_tokens: outputToks, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            });
            writeSSEEvent(res, 'message_stop', { type: 'message_stop' });
          }
          try { res.end(); } catch {}
        }
        recordUsage(inputToks, outputToks);
        resolve(200);
      });

      proxyRes.on('error', (e) => {
        diagnostics.lastError = e.message;
        if (!res.writableEnded) {
          writeSSEEvent(res, 'error', { type: 'error', error: { type: 'api_error', message: e.message } });
          try { res.end(); } catch {}
        }
        resolve(500);
      });
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      if (!res.headersSent) {
        sendJson(res, errorEnvelope('api_error', 'Backend streaming timeout'), 504);
      }
      resolve(504);
    });

    proxyReq.on('error', (e) => {
      diagnostics.lastError = e.message;
      if (!res.headersSent) {
        sendJson(res, errorEnvelope('api_error', `Backend connection error: ${e.message}`), 502);
      }
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
// WEBHOOK MANAGEMENT STORE
// ────────────────────────────────────────────────────────────────
const webhooks = new Map();
const webhookDeliveries = new Map(); // webhook_id → [delivery, ...]

function makeWebhook(params = {}) {
  const wh = {
    uuid:          uuidv4(),
    name:          params.name || 'My Webhook',
    url:           params.url  || '',
    events:        params.events || ['message.created', 'conversation.created'],
    active:        params.active !== false,
    secret:        crypto.randomBytes(32).toString('hex'),
    created_at:    new Date().toISOString(),
    updated_at:    new Date().toISOString(),
    last_delivery: null,
    delivery_count: 0,
    failure_count:  0,
  };
  webhooks.set(wh.uuid, wh);
  webhookDeliveries.set(wh.uuid, []);
  return wh;
}

function recordWebhookDelivery(webhookId, event, payload, statusCode) {
  const deliveries = webhookDeliveries.get(webhookId) || [];
  const del = {
    uuid:        uuidv4(),
    webhook_id:  webhookId,
    event,
    payload,
    status_code: statusCode,
    success:     statusCode >= 200 && statusCode < 300,
    delivered_at: new Date().toISOString(),
    duration_ms:  Math.floor(Math.random() * 200) + 50,
  };
  deliveries.push(del);
  if (deliveries.length > 100) deliveries.shift();
  webhookDeliveries.set(webhookId, deliveries);
  const wh = webhooks.get(webhookId);
  if (wh) {
    wh.last_delivery = del.delivered_at;
    wh.delivery_count++;
    if (!del.success) wh.failure_count++;
  }
  return del;
}

// Fire webhooks (non-blocking, best effort, localhost only)
function dispatchWebhookEvent(event, payload) {
  for (const wh of webhooks.values()) {
    if (!wh.active || !wh.events.includes(event)) continue;
    if (!wh.url || isBlockedUrl(wh.url)) continue;
    const body = JSON.stringify({ id: uuidv4(), type: event, created_at: new Date().toISOString(), data: payload });
    const sig  = crypto.createHmac('sha256', wh.secret).update(body).digest('hex');
    const parsed = new URL(wh.url);
    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port || 80,
      path:     parsed.pathname,
      method:   'POST',
      headers: {
        'Content-Type':    'application/json',
        'Content-Length':  Buffer.byteLength(body),
        'X-Signature-256': `sha256=${sig}`,
        'X-Event-Type':    event,
      },
      timeout: 5000,
    };
    const transport = parsed.protocol === 'https:' ? https : http;
    const r = transport.request(opts, (res2) => {
      recordWebhookDelivery(wh.uuid, event, payload, res2.statusCode);
      res2.resume();
    });
    r.on('error', () => recordWebhookDelivery(wh.uuid, event, payload, 0));
    r.on('timeout', () => { r.destroy(); recordWebhookDelivery(wh.uuid, event, payload, 0); });
    r.write(body);
    r.end();
  }
}

// ────────────────────────────────────────────────────────────────
// API KEY MANAGEMENT — for the org (not the auth modes)
// These are operator-side org API keys, not auth credentials
// ────────────────────────────────────────────────────────────────
const apiKeys = new Map();

function makeApiKey(params = {}) {
  const prefix = 'sk-ant-api03-';
  const random = crypto.randomBytes(40).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 40);
  const keyVal = `${prefix}${random}-AAAA`;
  const key = {
    uuid:          uuidv4(),
    name:          params.name || 'My API Key',
    key_hint:      keyVal.slice(0, 20) + '...',
    scopes:        params.scopes || ['api'],
    created_at:    new Date().toISOString(),
    last_used_at:  null,
    expires_at:    params.expires_at || null,
    is_active:     true,
    usage_count:   0,
    // Only shown on creation
    key_value:     keyVal,
  };
  apiKeys.set(key.uuid, key);
  return key;
}

// ────────────────────────────────────────────────────────────────
// AUDIT LOG
// ────────────────────────────────────────────────────────────────
const auditLog = [];
const MAX_AUDIT_ENTRIES = 1000;

function audit(action, resourceType, resourceId, metadata = {}) {
  auditLog.push({
    uuid:           uuidv4(),
    action,
    resource_type:  resourceType,
    resource_id:    resourceId,
    actor_uuid:     ACCOUNT_UUID,
    actor_email:    config.operator_email,
    org_uuid:       ORG_UUID,
    ip_address:     '127.0.0.1',
    user_agent:     `worker-a/${SERVER_VERSION}`,
    metadata,
    created_at:     new Date().toISOString(),
  });
  if (auditLog.length > MAX_AUDIT_ENTRIES) auditLog.shift();
}

// ────────────────────────────────────────────────────────────────
// SSO / SAML MOCKS
// ────────────────────────────────────────────────────────────────
const ssoConfig = {
  enabled:          false,
  provider:         'none',  // none | okta | google | azure | generic_saml
  sso_url:          '',
  entity_id:        `urn:sister-poc:${ORG_UUID}`,
  acs_url:          `http://localhost:${DEFAULT_CONFIG.port}/auth/saml/acs`,
  metadata_url:     '',
  domains:          [],
  auto_provision:   true,
  default_role:     'member',
  attribute_mapping: {
    email:      'email',
    first_name: 'firstName',
    last_name:  'lastName',
    groups:     'groups',
  },
};

// ────────────────────────────────────────────────────────────────
// VOICE / AUDIO ENDPOINTS (stub responses)
// ────────────────────────────────────────────────────────────────

function buildVoiceCapabilities() {
  return {
    supported:         false,
    languages:         ['en-US'],
    models:            ['claude-sonnet-4-6'],
    max_duration_secs: 300,
    formats:           ['webm', 'mp4', 'wav'],
  };
}

// ────────────────────────────────────────────────────────────────
// SCIM PROVISIONING MOCKS (enterprise)
// ────────────────────────────────────────────────────────────────
const scimUsers = new Map([[ACCOUNT_UUID, {
  id:          ACCOUNT_UUID,
  externalId:  null,
  userName:    config.operator_email,
  displayName: 'Operator',
  active:      true,
  emails: [{ value: config.operator_email, primary: true }],
  name: { givenName: 'Operator', familyName: '' },
  roles: [{ value: 'admin', display: 'Admin' }],
  meta: {
    resourceType: 'User',
    created:      '2024-01-01T00:00:00Z',
    lastModified: new Date().toISOString(),
    version:      'W/"1"',
    location:     `/scim/v2/Users/${ACCOUNT_UUID}`,
  },
}]]);

// ────────────────────────────────────────────────────────────────
// COMPUTER USE BETA MOCKS
// ────────────────────────────────────────────────────────────────
const computerUseSessions = new Map();

function makeComputerUseSession(params = {}) {
  const sess = {
    uuid:        uuidv4(),
    status:      'ready',
    model:       resolveModelAlias(params.model || config.default_model),
    resolution:  { width: 1280, height: 800 },
    os:          'linux',
    created_at:  new Date().toISOString(),
    updated_at:  new Date().toISOString(),
    timeout_at:  new Date(Date.now() + 3600000).toISOString(),
  };
  computerUseSessions.set(sess.uuid, sess);
  return sess;
}

// ────────────────────────────────────────────────────────────────
// CONVERSATION CONTINUATION / REGENERATE
// ────────────────────────────────────────────────────────────────

// Build a /v1/messages body from an existing conversation for continuation
function buildContinuationBody(convUuid, additionalUserText, model) {
  const chain = buildMessageChain(convUuid, conversations.get(convUuid)?.current_leaf_message_uuid);
  const msgs  = chain.map(m => ({
    role:    m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n') || '[no text]',
  }));
  if (additionalUserText) msgs.push({ role: 'user', content: additionalUserText });
  return {
    model:      resolveModelAlias(model || config.default_model),
    messages:   msgs,
    max_tokens: 4096,
    stream:     true,
  };
}

// ────────────────────────────────────────────────────────────────
// OAI TOOL-USE RESPONSE TRANSLATION
// handles streaming OpenAI tool_calls deltas → Anthropic tool_use blocks
// Called AFTER proxyAndTranslateOAItoAnthropic when tool stop is detected
// ────────────────────────────────────────────────────────────────
function translateOAIToolCallsToAnthropic(oaiFinishReason, accumulatedCalls) {
  // accumulatedCalls: [{ index, id, type, function: { name, arguments } }]
  return accumulatedCalls
    .filter(tc => tc.function?.name)
    .map(tc => ({
      type:  'tool_use',
      id:    tc.id || `toolu_${crypto.randomBytes(10).toString('hex')}`,
      name:  tc.function.name,
      input: (() => { try { return JSON.parse(tc.function.arguments || '{}'); } catch { return {}; } })(),
    }));
}

// ────────────────────────────────────────────────────────────────
// PROMPT LIBRARY / TEMPLATES
// ────────────────────────────────────────────────────────────────
const promptTemplates = new Map();

function makePromptTemplate(params = {}) {
  const pt = {
    uuid:        uuidv4(),
    name:        params.name        || 'Untitled Template',
    description: params.description || '',
    content:     params.content     || '',
    variables:   params.variables   || [],
    is_public:   params.is_public   || false,
    created_at:  new Date().toISOString(),
    updated_at:  new Date().toISOString(),
    creator_uuid: ACCOUNT_UUID,
    use_count:   0,
  };
  promptTemplates.set(pt.uuid, pt);
  return pt;
}

// ────────────────────────────────────────────────────────────────
// INTEGRATION STORE (Google Drive, GitHub, etc.)
// ────────────────────────────────────────────────────────────────
const integrations = new Map();

function makeIntegration(type, params = {}) {
  const integ = {
    uuid:         uuidv4(),
    type,
    name:         params.name || type,
    status:       'connected',
    connected_at: new Date().toISOString(),
    scopes:       params.scopes || [],
    account_info: params.account_info || {},
    settings:     params.settings    || {},
  };
  integrations.set(integ.uuid, integ);
  return integ;
}

// ────────────────────────────────────────────────────────────────
// CONVERSATION SEARCH INDEX
// ────────────────────────────────────────────────────────────────
function searchConversations(query, limit = 20) {
  if (!query) return [];
  const q = query.toLowerCase();
  const results = [];
  for (const conv of conversations.values()) {
    const msgs = convMessages.get(conv.uuid) || [];
    const matchName = (conv.name || '').toLowerCase().includes(q);
    const matchMsg  = msgs.some(m =>
      m.content.some(b => b.type === 'text' && b.text.toLowerCase().includes(q))
    );
    if (matchName || matchMsg) {
      const snippet = msgs.find(m =>
        m.content.some(b => b.type === 'text' && b.text.toLowerCase().includes(q))
      );
      results.push({
        ...conv,
        snippet: snippet?.content?.find(b => b.type === 'text')?.text?.slice(0, 200) || '',
        score:   matchName ? 2 : 1,
      });
    }
    if (results.length >= limit) break;
  }
  return results.sort((a, b) => b.score - a.score).map(({ score, ...r }) => r);
}

// ────────────────────────────────────────────────────────────────
// COMPREHENSIVE SETUP PAGE
// ────────────────────────────────────────────────────────────────
function serveSetupPage(res) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Worker A — Sister PoC</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0d1117;--surface:#161b22;--border:#21262d;--text:#c9d1d9;--muted:#8b949e;
  --accent:#f0b429;--accent2:#79c0ff;--green:#3fb950;--red:#f85149;--blue:#58a6ff;
  --purple:#d2a8ff;--orange:#ffa657;
}
body{font-family:'Courier New',monospace;background:var(--bg);color:var(--text);font-size:14px}
.topbar{background:var(--surface);border-bottom:1px solid var(--border);padding:0 1.5rem;height:48px;display:flex;align-items:center;gap:2rem;position:sticky;top:0;z-index:100}
.topbar h1{color:var(--accent);font-size:1rem;white-space:nowrap}
.topbar .version{color:var(--muted);font-size:.75rem}
.nav{display:flex;gap:0.5rem;flex:1}
.nav-btn{background:none;border:none;color:var(--muted);cursor:pointer;padding:.3rem .7rem;border-radius:4px;font-family:inherit;font-size:.8rem;transition:all .15s}
.nav-btn:hover,.nav-btn.active{background:rgba(240,180,41,.12);color:var(--accent)}
.status-pill{margin-left:auto;display:flex;align-items:center;gap:.5rem;font-size:.75rem}
.pill{padding:.2rem .6rem;border-radius:10px;font-size:.72rem;font-weight:700}
.pill-ok{background:#0d4429;color:var(--green)}
.pill-err{background:#3d1c1c;color:var(--red)}
.pill-warn{background:#3d2e0a;color:var(--orange)}
.main{display:flex;height:calc(100vh - 48px)}
.sidebar{width:240px;background:var(--surface);border-right:1px solid var(--border);overflow-y:auto;flex-shrink:0}
.sidebar-section{padding:.5rem}
.sidebar-label{font-size:.7rem;color:var(--muted);padding:.5rem .5rem .25rem;letter-spacing:.06em;text-transform:uppercase}
.sidebar-item{padding:.4rem .6rem;border-radius:4px;cursor:pointer;font-size:.8rem;transition:background .1s;display:flex;align-items:center;gap:.5rem}
.sidebar-item:hover,.sidebar-item.active{background:rgba(240,180,41,.1);color:var(--accent)}
.sidebar-item .icon{opacity:.6;font-size:.9rem}
.content{flex:1;overflow-y:auto;padding:1.5rem;max-width:900px}
.panel{display:none}
.panel.active{display:block}
h2{color:var(--accent2);font-size:.95rem;margin:0 0 1rem;padding-bottom:.4rem;border-bottom:1px solid var(--border)}
h3{color:var(--text);font-size:.85rem;margin:1.2rem 0 .6rem}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:1.2rem}
@media(max-width:700px){.grid2{grid-template-columns:1fr}.sidebar{display:none}}
.field{margin-bottom:.8rem}
label{display:block;font-size:.75rem;color:var(--muted);margin-bottom:.2rem;letter-spacing:.03em}
input,select,textarea{width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:.45rem .6rem;border-radius:4px;font-family:inherit;font-size:.82rem;transition:border-color .15s}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent)}
textarea{resize:vertical;min-height:70px}
select option{background:var(--bg)}
.btn{background:var(--accent);color:#0d1117;border:none;padding:.5rem 1.4rem;border-radius:4px;cursor:pointer;font-weight:700;font-family:inherit;font-size:.82rem;transition:background .15s;display:inline-block}
.btn:hover{background:#e9a020}
.btn-sm{padding:.3rem .8rem;font-size:.75rem}
.btn-ghost{background:none;border:1px solid var(--border);color:var(--text)}
.btn-ghost:hover{border-color:var(--accent);color:var(--accent);background:none}
.btn-danger{background:var(--red);color:#fff}
.btn-danger:hover{background:#e03140}
.status-bar{margin-top:.6rem;padding:.4rem .7rem;background:var(--bg);border-left:3px solid var(--accent);font-size:.78rem;display:none;border-radius:0 4px 4px 0}
.card{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:1rem;margin-bottom:.75rem}
.card-title{font-size:.82rem;color:var(--accent2);margin-bottom:.5rem;font-weight:700}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:.75rem;margin-bottom:1rem}
.stat{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:.75rem;text-align:center}
.stat-val{font-size:1.4rem;font-weight:700;color:var(--accent);display:block}
.stat-label{font-size:.7rem;color:var(--muted);margin-top:.2rem}
.log-table{width:100%;border-collapse:collapse;font-size:.75rem}
.log-table th{text-align:left;padding:.4rem .6rem;border-bottom:1px solid var(--border);color:var(--muted);font-weight:700;font-size:.7rem;text-transform:uppercase;letter-spacing:.04em}
.log-table td{padding:.35rem .6rem;border-bottom:1px solid rgba(33,38,45,.7);font-family:'Courier New',monospace;vertical-align:middle}
.log-table tr:hover td{background:rgba(33,38,45,.5)}
.status-ok{color:var(--green)}
.status-err{color:var(--red)}
.status-warn{color:var(--orange)}
.method-get{color:var(--green)}
.method-post{color:var(--blue)}
.method-del{color:var(--red)}
.method-patch{color:var(--orange)}
.method-put{color:var(--purple)}
.conv-item{background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:.6rem .8rem;margin-bottom:.4rem;cursor:pointer;transition:border-color .15s}
.conv-item:hover{border-color:var(--accent2)}
.conv-item .conv-name{font-size:.82rem;color:var(--text);font-weight:700}
.conv-item .conv-meta{font-size:.7rem;color:var(--muted);margin-top:.15rem}
.msg-bubble{padding:.6rem .8rem;border-radius:6px;margin-bottom:.5rem;font-size:.8rem;line-height:1.5}
.msg-human{background:rgba(88,166,255,.08);border-left:3px solid var(--blue)}
.msg-assistant{background:rgba(63,185,80,.08);border-left:3px solid var(--green)}
.msg-role{font-size:.7rem;font-weight:700;margin-bottom:.2rem;text-transform:uppercase;letter-spacing:.05em;opacity:.7}
pre{background:var(--bg);border:1px solid var(--border);padding:.7rem;border-radius:4px;overflow-x:auto;font-size:.75rem;line-height:1.5}
.tag{display:inline-block;padding:.1rem .4rem;border-radius:3px;font-size:.7rem;margin-right:.2rem;font-weight:700}
.tag-model{background:rgba(210,168,255,.15);color:var(--purple)}
.tag-tokens{background:rgba(88,166,255,.15);color:var(--blue)}
.json-viewer{font-size:.72rem;line-height:1.6;max-height:300px;overflow:auto}
.form-row{display:flex;gap:.6rem;align-items:flex-end}
.form-row .field{flex:1;margin:0}
#testArea{border:1px solid var(--border);border-radius:6px;padding:1rem;margin-top:1rem;display:none;background:var(--surface)}
#testOutput{font-size:.75rem;line-height:1.6;color:var(--green);white-space:pre-wrap;max-height:300px;overflow:auto;background:var(--bg);padding:.7rem;border-radius:4px;margin-top:.7rem;display:none}
.toggle{display:flex;align-items:center;gap:.5rem;cursor:pointer;margin-bottom:.5rem}
.toggle input[type=checkbox]{width:auto;cursor:pointer;accent-color:var(--accent)}
.toggle label{margin:0;cursor:pointer;color:var(--text);font-size:.82rem}
.divider{border:none;border-top:1px solid var(--border);margin:1rem 0}
.info-box{background:rgba(88,166,255,.06);border:1px solid rgba(88,166,255,.2);border-radius:4px;padding:.6rem .8rem;font-size:.75rem;color:var(--text);margin-bottom:.8rem}
.warn-box{background:rgba(255,166,87,.06);border:1px solid rgba(255,166,87,.2);border-radius:4px;padding:.6rem .8rem;font-size:.75rem;color:var(--text);margin-bottom:.8rem}
</style>
</head>
<body>
<div class="topbar">
  <h1>⚡ Worker A</h1>
  <span class="version">v${SERVER_VERSION}</span>
  <div class="nav">
    <button class="nav-btn active" onclick="show('overview')">Overview</button>
    <button class="nav-btn" onclick="show('config')">Config</button>
    <button class="nav-btn" onclick="show('conversations')">Conversations</button>
    <button class="nav-btn" onclick="show('test')">Test</button>
    <button class="nav-btn" onclick="show('logs')">Logs</button>
    <button class="nav-btn" onclick="show('debug')">Debug</button>
  </div>
  <div class="status-pill">
    <span id="wc_pill" class="pill pill-err">Worker C ✗</span>
    <span id="backend_pill" class="pill pill-warn">loading</span>
  </div>
</div>
<div class="main">
<div class="sidebar">
  <div class="sidebar-section">
    <div class="sidebar-label">Quick Links</div>
    <div class="sidebar-item" onclick="show('overview')"><span class="icon">📊</span>Overview</div>
    <div class="sidebar-item" onclick="show('config')"><span class="icon">⚙️</span>Configuration</div>
    <div class="sidebar-item" onclick="show('conversations')"><span class="icon">💬</span>Conversations</div>
    <div class="sidebar-item" onclick="show('test')"><span class="icon">🧪</span>Test Completion</div>
    <div class="sidebar-item" onclick="show('logs')"><span class="icon">📋</span>Request Log</div>
    <div class="sidebar-item" onclick="show('debug')"><span class="icon">🔧</span>Debug Tools</div>
  </div>
  <div class="sidebar-section">
    <div class="sidebar-label">Endpoints</div>
    <div class="sidebar-item" onclick="openUrl('/health')"><span class="icon">🟢</span>Health</div>
    <div class="sidebar-item" onclick="openUrl('/diag')"><span class="icon">📈</span>Diagnostics</div>
    <div class="sidebar-item" onclick="openUrl('/v1/models')"><span class="icon">🤖</span>Models</div>
    <div class="sidebar-item" onclick="openUrl('/debug/logs')"><span class="icon">📝</span>Log JSON</div>
  </div>
  <div class="sidebar-section">
    <div class="sidebar-label">Research</div>
    <div class="sidebar-item" onclick="show('arch')"><span class="icon">🏗️</span>Architecture</div>
  </div>
</div>
<div class="content">

<!-- OVERVIEW -->
<div class="panel active" id="panel-overview">
  <h2>System Overview</h2>
  <div class="stat-grid" id="stats">
    <div class="stat"><span class="stat-val" id="s-reqs">—</span><div class="stat-label">Requests</div></div>
    <div class="stat"><span class="stat-val" id="s-convs">—</span><div class="stat-label">Conversations</div></div>
    <div class="stat"><span class="stat-val" id="s-sse">—</span><div class="stat-label">SSE Streams</div></div>
    <div class="stat"><span class="stat-val" id="s-pending">—</span><div class="stat-label">Bridge Pending</div></div>
    <div class="stat"><span class="stat-val" id="s-uptime">—</span><div class="stat-label">Uptime (s)</div></div>
    <div class="stat"><span class="stat-val" id="s-tokens">—</span><div class="stat-label">RL Remaining</div></div>
  </div>
  <div class="card">
    <div class="card-title">Active Configuration</div>
    <table class="log-table">
      <tbody id="config-summary"></tbody>
    </table>
  </div>
  <div class="card">
    <div class="card-title">Blocked Hosts (enforced on all outbound)</div>
    <div id="blocked-hosts" style="font-size:.78rem;color:var(--red);line-height:2"></div>
  </div>
</div>

<!-- CONFIG -->
<div class="panel" id="panel-config">
  <h2>Configuration</h2>
  <div class="info-box">Changes are applied immediately. Worker C receives a config push via WebSocket.</div>
  <div class="grid2">
  <div>
    <h3>Backend</h3>
    <div class="field"><label>Backend type</label>
    <select id="backend" onchange="onBackendChange()">
      <option value="lm_studio">LM Studio (local, no key)</option>
      <option value="openrouter">OpenRouter (API key)</option>
      <option value="anthropic">Anthropic API (key / OAuth)</option>
      <option value="cookie_bridge">claude.ai bridge (Worker C)</option>
      <option value="custom">Custom URL</option>
    </select></div>
    <div class="field"><label>LM Studio URL</label><input id="lm_studio_url"></div>
    <div class="field"><label>OpenRouter URL</label><input id="openrouter_url"></div>
    <div class="field" id="f_custom" style="display:none"><label>Custom URL</label><input id="custom_url"></div>
    <div class="field"><label>HTTP-Referer (OpenRouter)</label><input id="http_referer" placeholder="https://your-site.com"></div>
    <div class="field"><label>X-Title (OpenRouter)</label><input id="x_title" placeholder="Sister PoC"></div>
  </div>
  <div>
    <h3>Auth Mode</h3>
    <div class="warn-box" style="font-size:.72rem">Four completely separate code paths. <b>Auth mode ≠ backend.</b> LM Studio uses no_key. Anthropic API uses api_key or oauth. cookie_bridge uses Worker C.</div>
    <div class="field"><label>Auth mode</label>
    <select id="auth_mode">
      <option value="no_key">no_key — no auth header</option>
      <option value="api_key">api_key — x-api-key</option>
      <option value="oauth">oauth — Bearer token</option>
      <option value="cookie_bridge">cookie_bridge — Worker C WS</option>
    </select></div>
    <div class="field"><label>API key</label><input id="api_key" type="password" placeholder="sk-ant-api03-..."></div>
    <div class="field"><label>OAuth token</label><input id="oauth_token" type="password" placeholder="sk-ant-oat01-..."></div>
  </div>
  </div>
  <h3>Model &amp; Mutation</h3>
  <div class="grid2">
  <div class="field"><label>Default model</label>
  <select id="default_model">
    <option value="claude-opus-4-6">Claude Opus 4.6</option>
    <option value="claude-sonnet-4-6" selected>Claude Sonnet 4.6</option>
    <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5</option>
  </select></div>
  <div class="field"><label>System prompt mutation</label>
  <select id="mutation_mode">
    <option value="strip_replace">strip_replace — replace entirely</option>
    <option value="prepend">prepend — insert before</option>
    <option value="append">append — add after</option>
  </select></div>
  </div>
  <div class="field"><label>System prompt override (blank = disabled — applies to ALL auth modes, pre-dispatch)</label>
  <textarea id="system_prompt_override" placeholder="Enter system prompt override..."></textarea></div>
  <div class="field">
  <div class="toggle"><input type="checkbox" id="log_requests"><label for="log_requests">Log requests to ${LOG_PATH}</label></div>
  </div>
  <button class="btn" onclick="saveConfig()">Save &amp; Apply</button>
  <button class="btn btn-ghost" style="margin-left:.5rem" onclick="loadConfigUI()">Reset from server</button>
  <div class="status-bar" id="cfg-status"></div>
</div>

<!-- CONVERSATIONS -->
<div class="panel" id="panel-conversations">
  <h2>Conversations <span id="conv-count" style="color:var(--muted);font-size:.8rem"></span></h2>
  <div class="form-row" style="margin-bottom:1rem">
    <div class="field"><input id="conv-search" placeholder="Search conversations..." oninput="searchConvs()"></div>
    <button class="btn btn-sm btn-ghost" onclick="loadConvs()">↻ Refresh</button>
  </div>
  <div id="conv-list">Loading...</div>
  <div id="conv-detail" style="display:none;margin-top:1rem">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.75rem">
      <h3 id="conv-detail-title" style="margin:0"></h3>
      <div style="display:flex;gap:.5rem">
        <button class="btn btn-sm btn-ghost" onclick="exportConv('json')">Export JSON</button>
        <button class="btn btn-sm btn-ghost" onclick="exportConv('markdown')">Export MD</button>
        <button class="btn btn-sm btn-danger" onclick="deleteConv()">Delete</button>
        <button class="btn btn-sm btn-ghost" onclick="closeConvDetail()">✕ Close</button>
      </div>
    </div>
    <div id="conv-messages"></div>
  </div>
</div>

<!-- TEST -->
<div class="panel" id="panel-test">
  <h2>Test Completion</h2>
  <div class="info-box">Sends requests through Worker A's full pipeline. Use this to verify backend connectivity and mutation modes.</div>
  <div class="grid2">
  <div class="field"><label>Model</label>
  <select id="test-model">
    <option value="claude-opus-4-6">Claude Opus 4.6</option>
    <option value="claude-sonnet-4-6" selected>Claude Sonnet 4.6</option>
    <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5</option>
  </select></div>
  <div class="field"><label>Endpoint</label>
  <select id="test-endpoint">
    <option value="/v1/messages">/v1/messages (Anthropic)</option>
    <option value="/v1/chat/completions">/v1/chat/completions (OpenAI)</option>
    <option value="/v1/messages/thinking">/v1/messages/thinking (Extended thinking)</option>
  </select></div>
  </div>
  <div class="field"><label>Prompt</label>
  <textarea id="test-prompt" style="min-height:100px">Hello! Can you say "Worker A test successful" and nothing else?</textarea></div>
  <div class="toggle" style="margin-bottom:.75rem"><input type="checkbox" id="test-stream" checked><label for="test-stream">Stream response</label></div>
  <button class="btn" onclick="runTest()">▶ Run Test</button>
  <button class="btn btn-ghost" style="margin-left:.5rem" onclick="clearTest()">Clear</button>
  <div id="testArea">
    <div style="font-size:.75rem;color:var(--muted);margin-bottom:.4rem" id="test-status"></div>
    <div id="testOutput"></div>
  </div>
</div>

<!-- LOGS -->
<div class="panel" id="panel-logs">
  <h2>Request Log</h2>
  <div class="form-row" style="margin-bottom:.75rem">
    <div class="field"><input id="log-filter" placeholder="Filter path, method, status..." oninput="filterLogs()"></div>
    <button class="btn btn-sm btn-ghost" onclick="loadLogs()">↻ Refresh</button>
    <button class="btn btn-sm btn-danger" onclick="clearLogs()">Clear</button>
  </div>
  <div id="log-stats" style="font-size:.75rem;color:var(--muted);margin-bottom:.75rem"></div>
  <div style="overflow-x:auto">
  <table class="log-table">
    <thead><tr>
      <th>Time</th><th>Method</th><th>Path</th><th>Status</th><th>ms</th>
    </tr></thead>
    <tbody id="log-tbody"></tbody>
  </table>
  </div>
  <div id="no-logs" style="color:var(--muted);font-size:.8rem;padding:.75rem 0;display:none">No log entries yet.</div>
</div>

<!-- DEBUG -->
<div class="panel" id="panel-debug">
  <h2>Debug Tools</h2>
  <div class="card">
    <div class="card-title">Rate Limit State</div>
    <div id="rl-state" class="json-viewer"></div>
    <button class="btn btn-sm btn-ghost" onclick="loadRLState()" style="margin-top:.5rem">Refresh</button>
  </div>
  <div class="card">
    <div class="card-title">Full Diagnostics</div>
    <div id="diag-out" class="json-viewer"></div>
    <button class="btn btn-sm btn-ghost" onclick="loadDiag()" style="margin-top:.5rem">Refresh</button>
  </div>
  <div class="card">
    <div class="card-title">Danger Zone</div>
    <p style="font-size:.78rem;color:var(--muted);margin-bottom:.6rem">Reset clears all in-memory state: conversations, files, projects, logs. Config is preserved.</p>
    <button class="btn btn-danger" onclick="resetState()">⚠ Reset All State</button>
  </div>
</div>

<!-- ARCH -->
<div class="panel" id="panel-arch">
  <h2>Architecture Reference</h2>
  <pre style="font-size:.73rem;line-height:1.7">
  Worker B (React UI)          Worker C (Tampermonkey)
       │                              │
       │ HTTP/SSE                     │ WebSocket /ws
       ▼                              ▼
  ┌─────────────────────────────────────────────┐
  │              WORKER A (this)                │
  │                                             │
  │  ┌─ HTTP Router ─────────────────────────┐  │
  │  │  /api/bootstrap/*  → mock JSON        │  │
  │  │  /v1/messages      → backend/bridge   │  │
  │  │  /v1/chat/completions → OAI compat   │  │
  │  │  /api/organizations/* → mock CRUD    │  │
  │  │  /setup            → this page       │  │
  │  │  + ~50 more routes                   │  │
  │  └───────────────────────────────────────┘  │
  │                                             │
  │  Auth modes (completely separate):          │
  │  no_key      → {} headers                  │
  │  api_key     → x-api-key: ...              │
  │  oauth       → Authorization: Bearer ...   │
  │  cookie_bridge → WS → Worker C             │
  │                                             │
  │  System prompt mutation (pre-auth):         │
  │  strip_replace | prepend | append           │
  │                                             │
  │  BLOCKED_HOSTS (enforced on all outbound):  │
  │  api.anthropic.com, console.anthropic.com,  │
  │  platform.claude.com, 111724.xyz, etc.      │
  └─────────────────────────────────────────────┘
       │
       ▼
  Backend (operator-configured)
  ● LM Studio   http://127.0.0.1:1234/v1
  ● OpenRouter  https://openrouter.ai/api/v1
  ● Anthropic   https://api.anthropic.com  [blocked unless api_key/oauth set]
  ● Custom      configurable URL
  ● bridge      claude.ai via Worker C WS
  </pre>
</div>

</div><!-- .content -->
</div><!-- .main -->

<script>
let allLogs=[], allConvs=[], currentConvId=null;

function show(id){
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
  const p=document.getElementById('panel-'+id);
  if(p){p.classList.add('active');}
  const sideitems=document.querySelectorAll('.sidebar-item');
  sideitems.forEach(s=>{if(s.textContent.toLowerCase().includes(id))s.classList.add('active');else s.classList.remove('active');});
  if(id==='overview')loadOverview();
  if(id==='conversations')loadConvs();
  if(id==='logs')loadLogs();
  if(id==='debug'){loadDiag();loadRLState();}
  if(id==='config')loadConfigUI();
}

function openUrl(u){window.open(u,'_blank');}

async function loadOverview(){
  try{
    const [h,d]=await Promise.all([fetch('/health').then(r=>r.json()),fetch('/diag').then(r=>r.json())]);
    document.getElementById('s-reqs').textContent=d.requestCount||0;
    document.getElementById('s-convs').textContent=d.conversations||0;
    document.getElementById('s-sse').textContent=d.sseStreams||0;
    document.getElementById('s-pending').textContent=d.pending_bridge||0;
    document.getElementById('s-uptime').textContent=d.uptime_s||0;
    const rl=await fetch('/v1/rate_limits').then(r=>r.json());
    document.getElementById('s-tokens').textContent=rl.tokens_remaining||0;
    const wc=h.worker_c_connected;
    document.getElementById('wc_pill').className='pill '+(wc?'pill-ok':'pill-err');
    document.getElementById('wc_pill').textContent='Worker C '+(wc?'✓':'✗');
    document.getElementById('backend_pill').className='pill pill-ok';
    document.getElementById('backend_pill').textContent=h.backend||'?';
    const tbody=document.getElementById('config-summary');
    const cfg=d.config||{};
    tbody.innerHTML=Object.entries(cfg).map(([k,v])=>
      '<tr><td style="color:var(--muted);padding-right:.8rem">'+k+'</td><td style="color:var(--text)">'+String(v)+'</td></tr>'
    ).join('');
    // blocked hosts
    const bh=await fetch('/diag').then(r=>r.json());
    document.getElementById('blocked-hosts').innerHTML=
      (bh.blocked_hosts||['api.anthropic.com','console.anthropic.com','111724.xyz','aroic.workers.dev']).map(h=>'🚫 '+h).join('<br>');
  }catch(e){console.warn(e);}
}

async function loadConfigUI(){
  try{
    const d=await fetch('/diag').then(r=>r.json());
    const c=d.config||{};
    ['backend','auth_mode','default_model','mutation_mode'].forEach(k=>{
      const el=document.getElementById(k);
      if(el&&c[k!='default_model'?k:k])el.value=c[k]||'';
    });
    document.getElementById('f_custom').style.display=c.backend==='custom'?'':'none';
    document.getElementById('log_requests').checked=!!c.log_requests;
    // fetch full config
    const fc=await fetch('/bridge/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})}).then(r=>r.json()).catch(()=>({}));
  }catch(e){}
}

function onBackendChange(){
  document.getElementById('f_custom').style.display=document.getElementById('backend').value==='custom'?'':'none';
}

async function saveConfig(){
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
    log_requests:document.getElementById('log_requests').checked,
    backend_urls:{
      lm_studio:document.getElementById('lm_studio_url').value,
      openrouter:document.getElementById('openrouter_url').value,
      custom:document.getElementById('custom_url').value,
    },
  };
  const r=await fetch('/bridge/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(cfg)});
  const st=document.getElementById('cfg-status');
  st.style.display='block';
  if(r.ok){st.style.borderColor='var(--green)';st.textContent='✓ Saved and applied';}
  else{st.style.borderColor='var(--red)';st.textContent='✗ Error: '+r.status;}
  setTimeout(()=>{st.style.display='none';},4000);
  loadOverview();
}

async function loadConvs(){
  try{
    const r=await fetch('/api/organizations/'+encodeURIComponent('${ORG_UUID}')+'/chat_conversations_v2?limit=100');
    if(!r.ok)throw new Error(r.status);
    allConvs=await r.json();
    renderConvs(allConvs);
    document.getElementById('conv-count').textContent='('+allConvs.length+')';
  }catch{
    document.getElementById('conv-list').innerHTML='<span style="color:var(--red);font-size:.8rem">Failed to load</span>';
  }
}

function renderConvs(list){
  const el=document.getElementById('conv-list');
  if(!list.length){el.innerHTML='<p style="color:var(--muted);font-size:.8rem">No conversations yet.</p>';return;}
  el.innerHTML=list.map(c=>\`<div class="conv-item" onclick="openConv('\${c.uuid}')">
    <div class="conv-name">\${c.name||'Untitled'}</div>
    <div class="conv-meta">
      <span class="tag tag-model">\${c.model||'—'}</span>
      \${new Date(c.updated_at).toLocaleString()}
      \${c.is_starred?'⭐':''}
    </div>
  </div>\`).join('');
}

function searchConvs(){
  const q=document.getElementById('conv-search').value.toLowerCase();
  renderConvs(q?allConvs.filter(c=>(c.name||'').toLowerCase().includes(q)):allConvs);
}

async function openConv(id){
  currentConvId=id;
  const r=await fetch('/api/organizations/${ORG_UUID}/chat_conversations/'+id);
  if(!r.ok)return;
  const data=await r.json();
  document.getElementById('conv-detail').style.display='block';
  document.getElementById('conv-detail-title').textContent=data.name||'Untitled';
  const msgs=data.messages||[];
  document.getElementById('conv-messages').innerHTML=msgs.map(m=>\`
    <div class="msg-bubble msg-\${m.sender}">
      <div class="msg-role">\${m.sender}</div>
      \${(m.content||[]).filter(b=>b.type==='text').map(b=>b.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\\n/g,'<br>')).join('')}
    </div>\`).join('');
}

function closeConvDetail(){
  document.getElementById('conv-detail').style.display='none';
  currentConvId=null;
}

async function exportConv(fmt){
  if(!currentConvId)return;
  window.open('/api/organizations/${ORG_UUID}/chat_conversations/'+currentConvId+'/export?format='+fmt,'_blank');
}

async function deleteConv(){
  if(!currentConvId)return;
  if(!confirm('Delete this conversation?'))return;
  await fetch('/api/organizations/${ORG_UUID}/chat_conversations/'+currentConvId,{method:'DELETE'});
  closeConvDetail();
  loadConvs();
}

async function runTest(){
  const prompt=document.getElementById('test-prompt').value;
  const model=document.getElementById('test-model').value;
  const endpoint=document.getElementById('test-endpoint').value;
  const stream=document.getElementById('test-stream').checked;
  const area=document.getElementById('testArea');
  const out=document.getElementById('testOutput');
  const stat=document.getElementById('test-status');
  area.style.display='block';
  out.style.display='block';
  out.textContent='';
  stat.textContent='Sending...';

  const body={model,stream};
  if(endpoint==='/v1/messages'||endpoint==='/v1/messages/thinking'){
    body.messages=[{role:'user',content:prompt}];
    body.max_tokens=1024;
  } else {
    body.messages=[{role:'user',content:prompt}];
    body.max_tokens=1024;
  }

  const t0=Date.now();
  try{
    const resp=await fetch(endpoint,{
      method:'POST',
      headers:{'Content-Type':'application/json','Accept':stream?'text/event-stream':'application/json'},
      body:JSON.stringify(body),
    });
    stat.textContent=resp.status+' '+resp.statusText+' ('+(Date.now()-t0)+'ms)';
    stat.style.color=resp.ok?'var(--green)':'var(--red)';
    if(stream&&resp.body){
      const reader=resp.body.getReader();const dec=new TextDecoder();
      while(true){
        const{done,value}=await reader.read();
        if(done)break;
        const chunk=dec.decode(value);
        const lines=chunk.split('\\n');
        for(const l of lines){
          if(l.startsWith('data: ')){
            const d=l.slice(6);
            if(d==='[DONE]'){out.textContent+='\\n[DONE]';break;}
            try{
              const ev=JSON.parse(d);
              if(ev.type==='content_block_delta'&&ev.delta?.text)out.textContent+=ev.delta.text;
              else if(ev.type==='content_block_delta'&&ev.delta?.thinking)out.textContent+='[thinking] '+ev.delta.thinking;
              else if(ev.choices?.[0]?.delta?.content)out.textContent+=ev.choices[0].delta.content;
            }catch{}
          }
        }
      }
    } else {
      out.textContent=JSON.stringify(await resp.json(),null,2);
    }
  }catch(e){
    stat.textContent='Error: '+e.message;stat.style.color='var(--red)';
    out.textContent=e.stack||e.message;
  }
}

function clearTest(){
  document.getElementById('testArea').style.display='none';
  document.getElementById('testOutput').textContent='';
}

async function loadLogs(){
  try{
    const r=await fetch('/debug/logs?limit=200');
    const d=await r.json();
    allLogs=d.logs||[];
    renderLogs(allLogs);
  }catch{document.getElementById('log-tbody').innerHTML='<tr><td colspan="5" style="color:var(--red)">Failed</td></tr>';}
}

function filterLogs(){
  const q=document.getElementById('log-filter').value.toLowerCase();
  renderLogs(q?allLogs.filter(l=>
    l.path.toLowerCase().includes(q)||
    l.method.toLowerCase().includes(q)||
    String(l.status).includes(q)
  ):allLogs);
}

function renderLogs(logs){
  const tbody=document.getElementById('log-tbody');
  const none=document.getElementById('no-logs');
  if(!logs.length){tbody.innerHTML='';none.style.display='block';return;}
  none.style.display='none';
  const mc={'GET':'method-get','POST':'method-post','DELETE':'method-del','PATCH':'method-patch','PUT':'method-put'};
  tbody.innerHTML=logs.slice(0,200).map(l=>\`<tr>
    <td style="color:var(--muted)">\${l.ts?.slice(11,23)||''}</td>
    <td class="\${mc[l.method]||''}">\${l.method||''}</td>
    <td>\${l.path||''}</td>
    <td class="\${l.status<300?'status-ok':l.status<500?'status-warn':'status-err'}">\${l.status||''}</td>
    <td style="color:var(--muted)">\${l.duration_ms||0}</td>
  </tr>\`).join('');
  const ok=logs.filter(l=>l.status<300).length;
  const err=logs.filter(l=>l.status>=400).length;
  document.getElementById('log-stats').textContent=
    logs.length+' entries · '+ok+' ok · '+err+' errors · avg '+
    (logs.reduce((s,l)=>s+(l.duration_ms||0),0)/Math.max(1,logs.length)).toFixed(0)+'ms';
}

async function clearLogs(){
  await fetch('/debug/logs',{method:'DELETE'});
  allLogs=[];renderLogs([]);
}

async function loadDiag(){
  const d=await fetch('/diag').then(r=>r.json());
  document.getElementById('diag-out').textContent=JSON.stringify(d,null,2);
}

async function loadRLState(){
  const d=await fetch('/v1/rate_limits').then(r=>r.json());
  document.getElementById('rl-state').textContent=JSON.stringify(d,null,2);
}

async function resetState(){
  if(!confirm('Reset ALL in-memory state? This cannot be undone.'))return;
  await fetch('/debug/reset',{method:'POST'});
  loadOverview();
  loadConvs();
  loadLogs();
}

// Init
loadOverview();
setInterval(loadOverview,15000);
</script>
</body>
</html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}
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

