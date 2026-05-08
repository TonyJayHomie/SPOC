// ==UserScript==
// @name         Worker C - Claude.ai Browser Bridge
// @namespace    local.claude.bridge
// @version      1.0.0
// @description  Local-only claude.ai bridge using browser-managed cookies via fetch(credentials:'include'). No cookie reads.
// @match        https://claude.ai/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const WS_URL = 'ws://127.0.0.1:8787/ws';
  const BLOCKED_HOSTS = new Set(['api.anthropic.com', 'console.anthropic.com', 'platform.claude.com']);
  let ws = null;

  function log(...args) {
    console.log('[worker_c]', ...args);
  }

  function currentConversationUuid() {
    const m = location.pathname.match(/\/chat\/([0-9a-f-]{36})/i);
    return m ? m[1] : '';
  }

  function likelyOrgUuid() {
    const cached = sessionStorage.getItem('worker_c.org_uuid') || localStorage.getItem('worker_c.org_uuid');
    if (cached) return cached;
    return '150fb5c6-500f-4fec-b0d9-f4bcd2ab9ec5';
  }

  function parseSseFrames(buffer, onFrame) {
    const parts = buffer.split(/\n\n/);
    const rest = parts.pop() || '';
    for (const part of parts) {
      if (!part.trim()) continue;
      let event = 'message';
      let data = '';
      for (const line of part.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      onFrame(event, data);
    }
    return rest;
  }

  function safeJson(text) {
    try { return JSON.parse(text); } catch { return null; }
  }

  function pickText(json) {
    if (!json || typeof json !== 'object') return '';
    const candidates = [
      json?.delta?.text,
      json?.text,
      json?.completion,
      json?.message?.text,
      json?.content?.text,
      typeof json?.delta === 'string' ? json.delta : ''
    ];
    for (const c of candidates) if (typeof c === 'string' && c) return c;
    return '';
  }

  async function createConversation(orgUuid, model, body) {
    const url = `/api/organizations/${orgUuid}/chat_conversations`;
    const payload = body?.create_conversation_params || {
      name: '',
      model: model || 'claude-sonnet-4-6',
      include_conversation_preferences: true,
      paprika_mode: 'extended',
      compass_mode: null,
      is_temporary: false,
      enabled_imagine: true
    };
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload)
    });
    const json = await response.json();
    const conversationUuid = json?.uuid || json?.chat_conversation_uuid || json?.conversation_uuid || '';
    if (!conversationUuid) throw new Error('Unable to create claude.ai conversation UUID');
    return conversationUuid;
  }

  async function handleCompletionRequest(msg) {
    const orgUuid = msg.org_uuid || likelyOrgUuid();
    sessionStorage.setItem('worker_c.org_uuid', orgUuid);

    let conversationUuid = msg.conversation_uuid || currentConversationUuid();
    if (!conversationUuid) {
      conversationUuid = await createConversation(orgUuid, msg?.body?.model, msg.body);
      ws.send(JSON.stringify({ type: 'meta', id: msg.id, org_uuid: orgUuid, conversation_uuid: conversationUuid }));
    }

    const targetUrl = `${location.origin}/api/organizations/${orgUuid}/chat_conversations/${conversationUuid}/completion`;
    const host = new URL(targetUrl).hostname;
    if (BLOCKED_HOSTS.has(host) && host !== location.hostname) {
      throw new Error(`Blocked outbound host: ${host}`);
    }

    const response = await fetch(targetUrl, {
      method: 'POST',
      credentials: 'include',
      headers: {
        accept: 'text/event-stream',
        'content-type': 'application/json'
      },
      body: JSON.stringify(msg.body)
    });

    if (!response.ok) {
      throw new Error(`claude.ai completion failed: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = parseSseFrames(buffer, (event, dataText) => {
        const json = safeJson(dataText);
        ws.send(JSON.stringify({
          type: 'claude_event',
          id: msg.id,
          event,
          text: pickText(json),
          data: json || dataText
        }));
      });
    }

    ws.send(JSON.stringify({ type: 'done', id: msg.id }));
  }

  function hello() {
    return {
      type: 'hello',
      page_url: location.href,
      pathname: location.pathname,
      host: location.host,
      org_uuid: likelyOrgUuid(),
      conversation_uuid: currentConversationUuid(),
      bridge: 'claude_browser_tab'
    };
  }

  function connect() {
    ws = new WebSocket(WS_URL);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify(hello()));
      log('connected to local Worker A');
    });
    ws.addEventListener('message', async (ev) => {
      const msg = safeJson(ev.data);
      if (!msg) return;
      try {
        if (msg.type === 'completion_request') {
          await handleCompletionRequest(msg);
        } else if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', id: msg.id, error: err.message || String(err) }));
      }
    });
    ws.addEventListener('close', () => {
      setTimeout(connect, 2000);
    });
    ws.addEventListener('error', () => {});
  }

  connect();
})();
