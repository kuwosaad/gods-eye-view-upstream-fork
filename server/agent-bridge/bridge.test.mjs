import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createAgentBridge } from './bridge.js';

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent = [];
  send(value) {
    this.sent.push(JSON.parse(value));
  }
  close(code, reason) {
    this.readyState = 3;
    this.emit('close', code, reason);
  }
}

class FakeWss extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    FakeWss.last = this;
  }
  handleUpgrade(request, socket, head, callback) {
    callback(new FakeSocket(), request);
  }
  close() {}
}

function server() {
  const result = new EventEmitter();
  result.off = result.removeListener.bind(result);
  return result;
}

test('registers an authenticated session and routes request responses', async () => {
  const bridge = createAgentBridge({
    WebSocketServer: FakeWss,
    token: 'secret',
  });
  const http = server();
  bridge.attach(http);
  const request = {
    url: '/__gev_agent?sessionId=main&token=secret',
    headers: { origin: 'http://localhost:5173', host: 'localhost:5173' },
    socket: { remoteAddress: '127.0.0.1' },
  };
  const raw = new EventEmitter();
  raw.write = () => {};
  raw.destroy = () => {};
  http.emit('upgrade', request, raw, Buffer.alloc(0));
  const socket = [...bridge.sessions.values()][0].socket;
  assert.deepEqual(socket.sent[0], { type: 'registered', sessionId: 'main' });
  const result = bridge.request('main', 'fly_to', { lat: 1 });
  assert.equal(socket.sent[1].type, 'gev:command');
  socket.emit(
    'message',
    JSON.stringify({
      type: 'gev:response',
      id: socket.sent[1].id,
      result: { ok: true },
    }),
  );
  assert.deepEqual(await result, { ok: true });
  bridge.close();
});

test('rejects bad credentials and disallowed origins before upgrade', () => {
  const bridge = createAgentBridge({
    WebSocketServer: FakeWss,
    token: 'secret',
    allowedOrigins: ['http://localhost'],
  });
  const http = server();
  bridge.attach(http);
  for (const url of [
    '/__gev_agent?sessionId=main&token=wrong',
    '/__gev_agent?sessionId=main&token=secret',
  ]) {
    const raw = new EventEmitter();
    raw.write = () => {};
    raw.destroy = () => {};
    http.emit(
      'upgrade',
      {
        url,
        headers: { origin: 'https://evil.example', host: 'localhost' },
        socket: { remoteAddress: '127.0.0.1' },
      },
      raw,
      Buffer.alloc(0),
    );
    assert.equal(bridge.sessions.size, 0);
  }
  bridge.close();
});

test('closes a socket when a message exceeds the configured bound', () => {
  const bridge = createAgentBridge({
    WebSocketServer: FakeWss,
    token: 'secret',
    maxMessageBytes: 20,
  });
  const http = server();
  bridge.attach(http);
  const raw = new EventEmitter();
  raw.write = () => {};
  raw.destroy = () => {};
  http.emit(
    'upgrade',
    {
      url: '/__gev_agent?sessionId=main&token=secret',
      headers: { origin: 'http://localhost', host: 'localhost' },
      socket: { remoteAddress: '127.0.0.1' },
    },
    raw,
    Buffer.alloc(0),
  );
  const socket = [...bridge.sessions.values()][0].socket;
  socket.emit(
    'message',
    JSON.stringify({ type: 'event', event: 'x', payload: 'too large' }),
  );
  assert.equal(socket.readyState, 3);
  bridge.close();
});

test('fails closed without a bridge token and without an Origin header', () => {
  assert.throws(
    () => createAgentBridge({ WebSocketServer: FakeWss }),
    /non-empty token/,
  );
  const bridge = createAgentBridge({
    WebSocketServer: FakeWss,
    token: 'secret',
  });
  const http = server();
  bridge.attach(http);
  const raw = new EventEmitter();
  raw.write = () => {};
  raw.destroy = () => {};
  http.emit(
    'upgrade',
    {
      url: '/__gev_agent?sessionId=main&token=secret',
      headers: { host: 'localhost' },
      socket: { remoteAddress: '127.0.0.1' },
    },
    raw,
    Buffer.alloc(0),
  );
  assert.equal(bridge.sessions.size, 0);
  bridge.close();
});

test('forwards mutation classification and sends cancellation on abort', async () => {
  const bridge = createAgentBridge({ WebSocketServer: FakeWss, token: 'secret' });
  const http = server();
  bridge.attach(http);
  const raw = new EventEmitter();
  raw.write = () => {};
  raw.destroy = () => {};
  http.emit('upgrade', {
    url: '/__gev_agent?sessionId=main&token=secret',
    headers: { origin: 'http://localhost', host: 'localhost' },
    socket: { remoteAddress: '127.0.0.1' },
  }, raw, Buffer.alloc(0));
  const socket = [...bridge.sessions.values()][0].socket;
  const controller = new AbortController();
  const result = bridge.request('main', 'get_state', {}, { signal: controller.signal, mutation: false });
  assert.equal(socket.sent[1].mutation, false);
  controller.abort();
  await assert.rejects(result, { code: 'ABORTED' });
  assert.deepEqual(socket.sent[2], { type: 'gev:cancel', id: socket.sent[1].id });
  bridge.close();
});

test('bounds pending requests per session and rejects sends on a replaced session', async () => {
  const bridge = createAgentBridge({
    WebSocketServer: FakeWss,
    token: 'secret',
    maxPendingPerSession: 1,
    requestTimeoutMs: 1000,
  });
  const http = server();
  bridge.attach(http);
  const upgrade = () => {
    const raw = new EventEmitter();
    raw.write = () => {};
    raw.destroy = () => {};
    http.emit('upgrade', {
      url: '/__gev_agent?sessionId=main&token=secret',
      headers: { origin: 'http://localhost', host: 'localhost' },
      socket: { remoteAddress: '127.0.0.1' },
    }, raw, Buffer.alloc(0));
  };
  upgrade();
  const first = bridge.request('main', 'slow');
  await assert.rejects(bridge.request('main', 'second'), { code: 'PENDING_LIMIT' });
  upgrade();
  await assert.rejects(first, { code: 'SESSION_CLOSED' });
  bridge.close();
});

test('does not treat a lookalike origin as localhost', () => {
  const bridge = createAgentBridge({ WebSocketServer: FakeWss, token: 'secret' });
  const http = server();
  bridge.attach(http);
  const raw = new EventEmitter();
  raw.write = () => {};
  raw.destroy = () => {};
  http.emit('upgrade', {
    url: '/__gev_agent?sessionId=main&token=secret',
    headers: { origin: 'http://localhost.evil:5173', host: 'localhost' },
    socket: { remoteAddress: '127.0.0.1' },
  }, raw, Buffer.alloc(0));
  assert.equal(bridge.sessions.size, 0);
  bridge.close();
});

test('publishes browser session connect, replacement, and disconnect events', () => {
  const bridge = createAgentBridge({ WebSocketServer: FakeWss, token: 'secret' });
  const http = server();
  bridge.attach(http);
  const events = [];
  bridge.subscribeSessions((event) => events.push(event));
  const upgrade = () => {
    const raw = new EventEmitter();
    raw.write = () => {};
    raw.destroy = () => {};
    http.emit(
      'upgrade',
      {
        url: '/__gev_agent?sessionId=main&token=secret',
        headers: { origin: 'http://localhost', host: 'localhost' },
        socket: { remoteAddress: '127.0.0.1' },
      },
      raw,
      Buffer.alloc(0),
    );
  };
  upgrade();
  upgrade();
  bridge.sessions.get('main').socket.close();
  assert.deepEqual(events, [
    { type: 'connected', sessionId: 'main' },
    { type: 'replaced', sessionId: 'main' },
    { type: 'disconnected', sessionId: 'main' },
  ]);
  bridge.close();
});
