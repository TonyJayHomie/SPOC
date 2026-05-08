#!/usr/bin/env node
'use strict';

/**
 * Worker A — local HTTP + WebSocket bridge server for claude.ai browser-tab passthrough.
 *
 * Design goals:
 * - local-only server, no Wrangler / Cloudflare deployment
 * - LMArenaBridge-style browser bridge via WebSocket
 * - no cookie harvesting; browser tab supplies cookies automatically
 * - Anthropic-compatible /v1/messages streaming + OpenAI-compatible /v1/chat/completions
 * - claude.ai website completion route derived from live HAR captures
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
const DEFAULT_ORG_UUID = process.env.ORG_UUID || '150fb5c6-500f-4fec-b0d9-f4bcd2ab9ec5';
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'claude-sonnet-4-6';

const state = {
  browserSocket: null,
  browserHello: null,
  config: {
    org_uuid: DEFAULT_ORG_UUID,
    conversation_uuid: '',
    model: DEFAULT_MODEL,
    timezone: 'America/Toronto',
    locale: 'en-US',
    browser_origin: 'https://claude.ai',
    system_prompt: '',
    bridge_mode: 'claude_bridge'
  },
  pending: new Map()
};

function nowIso() {
  return new Date().toISOString();
}

function uuid() {
  return crypto.randomUUID();
}

function rid(prefix = 'req') {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function json(res, code, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization,x-api-key,x-bridge-id'
  });
  res.end(text);
}

function noContent(res) {
  res.writeHead(204, {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization,x-api-key,x-bridge-id'
  });
  res.end();
}

function sseHeaders(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'access-control-allow-origin': '*'
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function flattenContentItem(item) {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return '';
  if (item.type === 'text') return item.text || '';
  if (item.type === 'input_text') return item.text || '';
  if (typeof item.text === 'string') return item.text;
  return '';
}

function flattenMessages(messages) {
  return (messages || [])
    .map((m) => {
      const content = Array.isArray(m.content)
        ? m.content.map(flattenContentItem).join('')
        : flattenContentItem(m.content);
      return `${m.role || 'user'}: ${content}`;
    })
    .join('\n\n');
}

function anthropicRequestToClaude(body) {
  const promptText = flattenMessages(body.messages || []);
  const model = body.model || state.config.model || DEFAULT_MODEL;
  const systemText = Array.isArray(body.system)
    ? body.system.map(flattenContentItem).join('\n')
    : (body.system || state.config.system_prompt || '');
  const finalPrompt = systemText ? `${systemText}\n\n${promptText}` : promptText;
  return {
    prompt: finalPrompt,
    timezone: state.config.timezone,
    personalized_styles: [
      {
        type: 'default',
        key: 'Default',
        name: 'Normal',
        nameKey: 'normal_style_name',
        prompt: 'Normal\n',
        summary: 'Default responses from Claude',
        summaryKey: 'normal_style_summary',
        isDefault: true
      }
    ],
    locale: state.config.locale,
    model,
    tools: [],
    turn_message_uuids: {
      human_message_uuid: uuid(),
      assistant_message_uuid: uuid()
    },
    attachments: [],
    files: [],
    sync_sources: [],
    rendering_mode: 'messages',
    create_conversation_params: {
      name: '',
      model,
      include_conversation_preferences: true,
      paprika_mode: 'extended',
      compass_mode: null,
      is_temporary: false,
      enabled_imagine: true
    }
  };
}

function openAIRequestToClaude(body) {
  const normalized = {
    model: body.model || state.config.model || DEFAULT_MODEL,
    messages: body.messages || [],
    system: body.system || ''
  };
  return anthropicRequestToClaude(normalized);
}

function buildAnthropicFinal(id, model, text) {
  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: Math.max(1, Math.ceil(text.length / 4)) }
  };
}

function buildOpenAIFinal(id, model, text) {
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: Math.max(1, Math.ceil(text.length / 4)), total_tokens: Math.max(1, Math.ceil(text.length / 4)) }
  };
}

function anthropicEvent(res, type, payload) {
  res.write(`event: ${type}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function openAIEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function ensureBrowserConnected() {
  if (!state.browserSocket) {
    const error = new Error('Browser bridge not connected. Open claude.ai with Worker C enabled.');
    error.statusCode = 503;
    throw error;
  }
}

function sendWs(socket, obj) {
  if (!socket || socket.destroyed) throw new Error('WebSocket not connected');
  const text = JSON.stringify(obj);
  const payload = Buffer.from(text, 'utf8');
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function setupWebSocket(socket) {
  socket._wsBuffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    socket._wsBuffer = Buffer.concat([socket._wsBuffer, chunk]);
    while (true) {
      const frame = parseWsFrame(socket._wsBuffer);
      if (!frame) break;
      socket._wsBuffer = socket._wsBuffer.slice(frame.bytes);
      if (frame.opcode === 0x8) {
        socket.end();
        return;
      }
      if (frame.opcode === 0x9) {
        socket.write(Buffer.from([0x8a, 0x00]));
        continue;
      }
      if (frame.opcode !== 0x1) continue;
      const message = safeJsonParse(frame.payload.toString('utf8'));
      if (message) onBrowserMessage(socket, message);
    }
  });
  socket.on('close', () => {
    if (state.browserSocket === socket) {
      state.browserSocket = null;
      state.browserHello = null;
    }
  });
  socket.on('error', () => {});
}

function parseWsFrame(buffer) {
  if (buffer.length < 2) return null;
  const b1 = buffer[0];
  const b2 = buffer[1];
  const opcode = b1 & 0x0f;
  const masked = !!(b2 & 0x80);
  let len = b2 & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buffer.length < 4) return null;
    len = buffer.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buffer.length < 10) return null;
    len = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const maskLen = masked ? 4 : 0;
  if (buffer.length < offset + maskLen + len) return null;
  const mask = masked ? buffer.slice(offset, offset + 4) : null;
  const start = offset + maskLen;
  let payload = buffer.slice(start, start + len);
  if (masked && mask) {
    payload = Buffer.from(payload);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  }
  return { opcode, payload, bytes: start + len };
}

function pickTextFromClaudeEvent(msg) {
  if (typeof msg.text === 'string' && msg.text) return msg.text;
  const data = msg.data || msg.json || {};
  const candidates = [
    data?.delta?.text,
    data?.text,
    data?.completion,
    data?.message?.text,
    data?.content?.text,
    data?.delta,
  ];
  for (const item of candidates) {
    if (typeof item === 'string' && item) return item;
  }
  return '';
}

function finishPending(pending, err) {
  if (!pending) return;
  clearTimeout(pending.timeout);
  state.pending.delete(pending.id);
  if (pending.kind === 'anthropic_stream') {
    if (err) {
      anthropicEvent(pending.res, 'error', { type: 'error', error: { type: 'api_error', message: err.message || String(err) } });
    } else {
      if (pending.blockStarted) anthropicEvent(pending.res, 'content_block_stop', { index: 0 });
      anthropicEvent(pending.res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: Math.max(1, Math.ceil(pending.text.length / 4)) } });
      anthropicEvent(pending.res, 'message_stop', { type: 'message_stop' });
    }
    pending.res.end();
    return;
  }
  if (pending.kind === 'openai_stream') {
    if (err) {
      openAIEvent(pending.res, { error: { message: err.message || String(err), type: 'api_error' } });
    }
    pending.res.write('data: [DONE]\n\n');
    pending.res.end();
    return;
  }
  if (pending.kind === 'anthropic_json') {
    if (err) return json(pending.res, err.statusCode || 500, { type: 'error', error: { type: 'api_error', message: err.message || String(err) } });
    return json(pending.res, 200, buildAnthropicFinal(pending.messageId, pending.model, pending.text));
  }
  if (pending.kind === 'openai_json') {
    if (err) return json(pending.res, err.statusCode || 500, { error: { message: err.message || String(err), type: 'api_error' } });
    return json(pending.res, 200, buildOpenAIFinal(pending.messageId, pending.model, pending.text));
  }
}

function onBrowserMessage(socket, message) {
  if (message.type === 'hello') {
    state.browserSocket = socket;
    state.browserHello = { ...message, connected_at: nowIso() };
    return;
  }
  if (message.type === 'pong') return;
  const pending = state.pending.get(message.id);
  if (!pending) return;
  if (message.type === 'error') {
    finishPending(pending, new Error(message.error || 'Browser bridge error'));
    return;
  }
  if (message.type === 'meta' && message.conversation_uuid) {
    state.config.conversation_uuid = message.conversation_uuid;
    pending.conversation_uuid = message.conversation_uuid;
    return;
  }
  if (message.type === 'claude_event') {
    if (!pending.started && pending.kind.startsWith('anthropic')) {
      anthropicEvent(pending.res, 'message_start', {
        type: 'message_start',
        message: {
          id: pending.messageId,
          type: 'message',
          role: 'assistant',
          model: pending.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      });
      pending.started = true;
    }
    const text = pickTextFromClaudeEvent(message);
    if (text) {
      pending.text += text;
      if (pending.kind === 'anthropic_stream') {
        if (!pending.blockStarted) {
          anthropicEvent(pending.res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
          pending.blockStarted = true;
        }
        anthropicEvent(pending.res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
      } else if (pending.kind === 'openai_stream') {
        openAIEvent(pending.res, {
          id: pending.messageId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: pending.model,
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
        });
      }
    }
    if (message.event === 'message_start' && pending.kind === 'openai_stream' && !pending.started) {
      openAIEvent(pending.res, {
        id: pending.messageId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: pending.model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
      });
      pending.started = true;
    }
    if (message.event === 'message_stop') {
      finishPending(pending);
    }
    return;
  }
  if (message.type === 'done') {
    finishPending(pending);
  }
}

function dispatchToBrowser(kind, model, claudeBody, res) {
  ensureBrowserConnected();
  const id = rid('bridge');
  const pending = {
    id,
    kind,
    res,
    text: '',
    model,
    started: false,
    blockStarted: false,
    messageId: rid('msg'),
    timeout: setTimeout(() => {
      finishPending(pending, new Error('Bridge timeout waiting for browser tab response'));
    }, 180000)
  };
  state.pending.set(id, pending);
  sendWs(state.browserSocket, {
    type: 'completion_request',
    id,
    org_uuid: state.config.org_uuid,
    conversation_uuid: state.config.conversation_uuid,
    browser_origin: state.config.browser_origin,
    body: claudeBody
  });
  return pending;
}

async function handleAnthropic(req, res) {
  ensureBrowserConnected();
  const text = await readBody(req);
  const body = safeJsonParse(text, {});
  if (!body || !Array.isArray(body.messages)) {
    return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'messages array is required' } });
  }
  const model = body.model || state.config.model || DEFAULT_MODEL;
  const claudeBody = anthropicRequestToClaude(body);
  if (body.stream) {
    sseHeaders(res);
    dispatchToBrowser('anthropic_stream', model, claudeBody, res);
    return;
  }
  dispatchToBrowser('anthropic_json', model, claudeBody, res);
}

async function handleOpenAI(req, res) {
  ensureBrowserConnected();
  const text = await readBody(req);
  const body = safeJsonParse(text, {});
  if (!body || !Array.isArray(body.messages)) {
    return json(res, 400, { error: { type: 'invalid_request_error', message: 'messages array is required' } });
  }
  const model = body.model || state.config.model || DEFAULT_MODEL;
  const claudeBody = openAIRequestToClaude(body);
  if (body.stream) {
    sseHeaders(res);
    dispatchToBrowser('openai_stream', model, claudeBody, res);
    return;
  }
  dispatchToBrowser('openai_json', model, claudeBody, res);
}

async function handleConfig(req, res) {
  const text = await readBody(req);
  const patch = safeJsonParse(text, {});
  Object.assign(state.config, Object.fromEntries(Object.entries(patch || {}).filter(([, v]) => typeof v === 'string')));
  return json(res, 200, { ok: true, config: state.config });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'OPTIONS') return noContent(res);
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, {
        ok: true,
        host: HOST,
        port: PORT,
        browser_connected: !!state.browserSocket,
        browser_hello: state.browserHello,
        config: state.config,
        pending_requests: state.pending.size
      });
    }
    if (req.method === 'GET' && url.pathname === '/bridge/state') {
      return json(res, 200, {
        browser_connected: !!state.browserSocket,
        browser_hello: state.browserHello,
        config: state.config,
        pending: [...state.pending.keys()]
      });
    }
    if (req.method === 'POST' && url.pathname === '/bridge/config') return handleConfig(req, res);
    if (req.method === 'POST' && url.pathname === '/v1/messages') return handleAnthropic(req, res);
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') return handleOpenAI(req, res);
    if (req.method === 'GET' && url.pathname === '/') {
      return json(res, 200, {
        name: 'claude-ai-browser-bridge',
        description: 'Local bridge server for claude.ai browser-tab passthrough',
        endpoints: ['/health', '/bridge/state', '/bridge/config', '/v1/messages', '/v1/chat/completions'],
        ws_path: '/ws'
      });
    }
    return json(res, 404, { error: { type: 'not_found_error', message: 'Route not found' } });
  } catch (err) {
    return json(res, err.statusCode || 500, { error: { type: 'api_error', message: err.message || String(err) } });
  }
});

server.on('upgrade', (req, socket) => {
  if (req.url !== '/ws') {
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    ''
  ].join('\r\n'));
  state.browserSocket = socket;
  setupWebSocket(socket);
});

server.listen(PORT, HOST, () => {
  console.log(`[worker_a] listening on http://${HOST}:${PORT}`);
  console.log(`[worker_a] websocket on ws://${HOST}:${PORT}/ws`);
});
