import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentBrowserClient } from './browserClient.js';

class FakeWebSocket {
  static instances = [];
  static OPEN = 1;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  emit(type, value = {}) {
    for (const listener of this.listeners.get(type) || []) listener(value);
  }
  send(value) {
    this.sent.push(JSON.parse(value));
  }
  open() {
    this.readyState = 1;
    this.emit('open');
  }
  close(code) {
    this.readyState = 3;
    this.emit('close', { code });
  }
}

function client(options = {}) {
  FakeWebSocket.instances.length = 0;
  return createAgentBrowserClient({
    sessionId: 'main',
    token: 'secret',
    WebSocket: FakeWebSocket,
    reconnect: false,
    actionRunner: async (tool, args) => ({ tool, args }),
    ...options,
  });
}

test('connects to the authenticated same-origin endpoint and dispatches commands', async () => {
  const gev = client({
    location: { protocol: 'https:', host: 'localhost:5173' },
  });
  const socket = FakeWebSocket.instances[0];
  assert.match(socket.url, /^wss:\/\/localhost:5173\/__gev_agent\?/);
  assert.match(socket.url, /sessionId=main/);
  assert.match(socket.url, /token=secret/);
  socket.open();
  assert.deepEqual(socket.sent[0], {
    version: 1,
    type: 'gev:hello',
    sessionId: 'main',
    capabilities: ['commands', 'cancel', 'events', 'capture_view'],
  });
  socket.emit('message', {
    data: JSON.stringify({
      type: 'gev:command',
      id: 'one',
      name: 'look',
      args: { at: 1 },
    }),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(socket.sent.at(-1), {
    version: 1,
    type: 'gev:response',
    id: 'one',
    sessionId: 'main',
    result: { tool: 'look', args: { at: 1 } },
  });
  gev.destroy();
});

test('answers versioned ping with pong and rejects unsupported versions', () => {
  const gev = client();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.emit('message', {
    data: JSON.stringify({ type: 'gev:ping', version: 1, id: 'p:1' }),
  });
  assert.deepEqual(socket.sent.at(-1), {
    version: 1,
    type: 'gev:pong',
    id: 'p:1',
  });
  socket.emit('message', {
    data: JSON.stringify({ type: 'gev:ping', version: 2, id: 'p:2' }),
  });
  assert.equal(socket.sent.at(-1).code, 'PROTOCOL_VERSION_UNSUPPORTED');
  gev.destroy();
});

test('cancels an active command with an AbortController', async () => {
  let signal;
  const gev = client({
    actionRunner: async (tool, args, options) => {
      signal = options.signal;
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (options.signal.aborted)
        throw Object.assign(new Error('cancelled'), { code: 'ABORTED' });
      return args;
    },
  });
  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.emit('message', {
    data: JSON.stringify({ type: 'gev:command', id: 'slow', name: 'wait' }),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  socket.emit('message', {
    data: JSON.stringify({ type: 'gev:cancel', id: 'slow' }),
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(signal.aborted, true);
  assert.equal(socket.sent.at(-1).error.code, 'ABORTED');
  gev.destroy();
});

test('closes oversized messages and cleans up on destroy', () => {
  const gev = client({ maxMessageBytes: 10 });
  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.emit('message', { data: JSON.stringify({ type: 'gev:command' }) });
  assert.equal(socket.readyState, 3);
  gev.destroy();
  assert.equal(gev.isDestroyed, true);
});

test('owner-closed sessions do not reconnect until the page is explicitly reopened', async () => {
  const gev = client({ reconnect: true, reconnectBaseMs: 1, reconnectMaxMs: 1 });
  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.close(4002);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(gev.socket, null);
  gev.destroy();
});
