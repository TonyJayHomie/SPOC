'use strict';

const state = {
  baseUrl: localStorage.getItem('bridge.baseUrl') || 'http://127.0.0.1:8787',
  model: localStorage.getItem('bridge.model') || 'claude-sonnet-4-6',
  orgUuid: localStorage.getItem('bridge.orgUuid') || '150fb5c6-500f-4fec-b0d9-f4bcd2ab9ec5',
  conversationUuid: localStorage.getItem('bridge.conversationUuid') || '',
  systemPrompt: localStorage.getItem('bridge.systemPrompt') || '',
  stream: (localStorage.getItem('bridge.stream') || 'true') === 'true'
};

const $ = (s) => document.querySelector(s);

function persist() {
  localStorage.setItem('bridge.baseUrl', state.baseUrl);
  localStorage.setItem('bridge.model', state.model);
  localStorage.setItem('bridge.orgUuid', state.orgUuid);
  localStorage.setItem('bridge.conversationUuid', state.conversationUuid);
  localStorage.setItem('bridge.systemPrompt', state.systemPrompt);
  localStorage.setItem('bridge.stream', String(state.stream));
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function appendMessage(role, text, id = '') {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  if (id) wrap.dataset.msgId = id;
  wrap.innerHTML = `<div class="meta">${escapeHtml(role)}</div><pre>${escapeHtml(text)}</pre>`;
  $('#messages').appendChild(wrap);
  wrap.scrollIntoView({ block: 'end' });
  return wrap;
}

function setStatus(text, ok = true) {
  const el = $('#status');
  el.textContent = text;
  el.className = ok ? 'ok' : 'bad';
}

async function saveConfig() {
  state.baseUrl = $('#baseUrl').value.trim();
  state.model = $('#model').value.trim();
  state.orgUuid = $('#orgUuid').value.trim();
  state.conversationUuid = $('#conversationUuid').value.trim();
  state.systemPrompt = $('#systemPrompt').value;
  state.stream = $('#stream').checked;
  persist();
  const r = await fetch(`${state.baseUrl}/bridge/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      org_uuid: state.orgUuid,
      conversation_uuid: state.conversationUuid,
      model: state.model,
      system_prompt: state.systemPrompt
    })
  });
  const j = await r.json();
  setStatus(j.ok ? 'Config saved' : 'Config failed', !!j.ok);
}

async function health() {
  state.baseUrl = $('#baseUrl').value.trim();
  persist();
  const r = await fetch(`${state.baseUrl}/health`);
  const j = await r.json();
  $('#healthOut').textContent = JSON.stringify(j, null, 2);
  setStatus(j.browser_connected ? 'Browser bridge connected' : 'Waiting for claude.ai tab + userscript', !!j.browser_connected);
}

function parseAnthropicSSEChunk(chunk, onEvent) {
  const frames = chunk.split(/\n\n+/).filter(Boolean);
  for (const frame of frames) {
    const lines = frame.split('\n');
    let event = 'message';
    let data = '';
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (data) onEvent(event, data);
  }
}

async function sendPrompt() {
  await saveConfig();
  const prompt = $('#prompt').value.trim();
  if (!prompt) return;
  appendMessage('user', prompt);
  $('#prompt').value = '';
  const assistant = appendMessage('assistant', '', `assistant_${Date.now()}`);
  const pre = assistant.querySelector('pre');

  const body = {
    model: state.model,
    stream: state.stream,
    system: state.systemPrompt,
    max_tokens: 8192,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
  };

  const r = await fetch(`${state.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body)
  });

  if (!state.stream) {
    const j = await r.json();
    const text = (j.content || []).map((x) => x.text || '').join('');
    pre.textContent = text || JSON.stringify(j, null, 2);
    return;
  }

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split(/\n\n/);
    buf = parts.pop() || '';
    for (const part of parts) {
      parseAnthropicSSEChunk(part + '\n\n', (event, data) => {
        if (event === 'content_block_delta') {
          try {
            const j = JSON.parse(data);
            const text = j?.delta?.text || '';
            pre.textContent += text;
          } catch {}
        }
        if (event === 'error') {
          try {
            const j = JSON.parse(data);
            pre.textContent += `\n[error] ${j?.error?.message || data}`;
          } catch {
            pre.textContent += `\n[error] ${data}`;
          }
        }
      });
    }
  }
}

function init() {
  $('#baseUrl').value = state.baseUrl;
  $('#model').value = state.model;
  $('#orgUuid').value = state.orgUuid;
  $('#conversationUuid').value = state.conversationUuid;
  $('#systemPrompt').value = state.systemPrompt;
  $('#stream').checked = state.stream;
  $('#saveBtn').addEventListener('click', (e) => { e.preventDefault(); saveConfig().catch((err) => setStatus(err.message, false)); });
  $('#healthBtn').addEventListener('click', (e) => { e.preventDefault(); health().catch((err) => setStatus(err.message, false)); });
  $('#sendBtn').addEventListener('click', (e) => { e.preventDefault(); sendPrompt().catch((err) => setStatus(err.message, false)); });
}

document.addEventListener('DOMContentLoaded', init);
