import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createControlPlane } from './control-plane.js';
import { SessionRegistry } from './session-registry.js';
import { createMcpMiddleware } from '../providers/mcp.js';
import { createQuotaGuard } from './security.js';

function fakeBridge(entries = ['alpha', 'bravo']) {
  const sessions = new Map(entries.map((id) => [id, {}]));
  const calls = [];
  const listeners = new Map();
  return {
    sessions,
    calls,
    subscribe(id, listener) {
      const set = listeners.get(id) || new Set();
      set.add(listener);
      listeners.set(id, set);
      return () => set.delete(listener);
    },
    request(id, name, args, options) {
      calls.push({ id, name, args, options });
      return Promise.resolve({ id, name, args });
    },
    disconnect(id) {
      sessions.delete(id);
      for (const listener of listeners.get(id) || []) listener({ type: 'disconnect' });
    },
  };
}

function serverFor(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ server, url: `http://127.0.0.1:${server.address().port}/mcp` });
  }));
}

async function rpc(url, body, sessionId, token = 'release-token') {
  const headers = {
    authorization: `Bearer ${token}`,
    host: '127.0.0.1',
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
  };
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await response.text();
  const match = text.match(/data:\s*(\{[\s\S]*\})/);
  return { response, body: JSON.parse(match ? match[1] : text) };
}

async function initialize(url) {
  const result = await rpc(url, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'release-test', version: '1' } },
  });
  assert.equal(result.response.status, 200);
  return result.response.headers.get('mcp-session-id');
}

test('control plane claims sessions, enforces ACL, and projects each session resource', async () => {
  const bridge = fakeBridge();
  const state = new Map([
    ['alpha', { stateVersion: 0, layers: [{ id: 'roads' }], entities: [{ id: 'a' }], annotations: [] }],
    ['bravo', { stateVersion: 0, layers: [{ id: 'air' }], entities: [{ id: 'b' }], annotations: [] }],
  ]);
  const plane = createControlPlane({
    bridge,
    getState: async (session) => state.get(session.id),
    tools: { inspect: { sessionRequired: true, handler: ({ session }) => ({ sessionId: session.id }) } },
  });
  plane.syncBridgeSessions();
  plane.claim('alpha', 'owner');
  assert.throws(() => plane.registry.get('alpha', 'intruder'), { code: 'ACCESS_DENIED' });
  assert.deepEqual(plane.listResources('owner').map(({ uri }) => uri), ['gev://sessions/alpha/state']);
  plane.share('alpha', 'owner', 'guest');
  assert.equal(plane.listResources('guest').length, 1);
  const resource = await plane.readResource('gev://sessions/alpha/state', 'guest');
  assert.deepEqual(JSON.parse(resource.text), state.get('alpha'));
  assert.equal((await plane.call('inspect', { sessionId: 'bravo' }, { callerId: 'owner' })).structuredContent.code, 'ACCESS_DENIED');
  plane.close();
});

test('mutations are ordered per browser session and return increasing stateVersion', async () => {
  const bridge = fakeBridge(['alpha']);
  const order = [];
  const plane = createControlPlane({ bridge, tools: {
    move: { mutation: true, handler: async ({ args }) => { order.push(args.step); await new Promise((r) => setTimeout(r, args.delay)); return { step: args.step }; } },
  } });
  plane.syncBridgeSessions();
  plane.claim('alpha', 'owner');
  const first = plane.call('move', { sessionId: 'alpha', step: 1, delay: 20 }, { callerId: 'owner' });
  const second = plane.call('move', { sessionId: 'alpha', step: 2, delay: 0 }, { callerId: 'owner' });
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(order, [1, 2]);
  assert.equal(a.structuredContent.stateVersion, 1);
  assert.equal(b.structuredContent.stateVersion, 2);
  plane.close();
});

test('HTTP MCP exposes capture envelope, projected resources, and isolated principals', async (t) => {
  const bridge = fakeBridge(['alpha']);
  const plane = createControlPlane({ bridge, tools: {} });
  plane.syncBridgeSessions();
  plane.claim('alpha', 'http-principal');
  const middleware = createMcpMiddleware({
    token: 'release-token', catalog: [],
    dispatch: async ({ tool }) => tool === 'gev_capture_view'
      ? { ok: true, result: { image: { data: 'aW1hZ2U=', mimeType: 'image/png' }, metadata: { width: 2, height: 1, stateVersion: 3 } } }
      : { ok: true, result: {} },
    listSessions: () => [{ id: 'alpha' }],
    getState: async () => ({ stateVersion: 3, layers: [{ id: 'roads' }], entities: [], annotations: [] }),
    resources: { state: async () => ({ stateVersion: 3, layers: [{ id: 'roads' }], entities: [], annotations: [] }) },
  });
  const { server, url } = await serverFor(middleware);
  t.after(async () => { await middleware.close(); server.close(); plane.close(); });
  const session = await initialize(url);
  const secondSession = await initialize(url);
  const whoA = await rpc(url, { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'gev_whoami', arguments: {} } }, session);
  const whoB = await rpc(url, { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'gev_whoami', arguments: {} } }, secondSession);
  assert.notEqual(whoA.body.result.structuredContent.principalId, whoB.body.result.structuredContent.principalId);
  const listed = await rpc(url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, session);
  assert.ok(listed.body.result.tools.some((tool) => tool.name === 'gev_capture_view'));
  const capture = await rpc(url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'gev_capture_view', arguments: { sessionId: 'alpha' } } }, session);
  assert.equal(capture.body.result.content[0].type, 'image');
  assert.equal(capture.body.result.content[0].mimeType, 'image/png');
  assert.match(capture.body.result.content[1].text, /"width":2/);
  const resources = await rpc(url, { jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'gev://sessions/alpha/state' } }, session);
  assert.equal(resources.body.result.contents[0].mimeType, 'application/json');
  assert.match(resources.body.result.contents[0].text, /"stateVersion":3/);
});

test('quotas reject excess calls and session capacity, and disconnect removes browser state', async () => {
  let now = 0;
  const quota = createQuotaGuard({ maxCalls: 1, windowMs: 1000, now: () => now });
  assert.equal(quota.check('agent').allowed, true);
  assert.equal(quota.check('agent').allowed, false);
  now = 1001;
  assert.equal(quota.check('agent').allowed, true);
  const registry = new SessionRegistry({ maxSessionsPerPrincipal: 1 });
  registry.register({ id: 'one', close() {} }, 'one', { principalId: 'agent' });
  assert.throws(() => registry.register({ id: 'two', close() {} }, 'two', { principalId: 'agent' }), { code: 'SESSION_QUOTA' });
  const bridge = fakeBridge(['drop']);
  const plane = createControlPlane({ bridge });
  plane.syncBridgeSessions();
  assert.equal(plane.registry.list().length, 1);
  plane.registry.get('drop').connection.close();
  assert.equal(plane.registry.list().length, 0);
  plane.close();

  const queueRegistry = new SessionRegistry({ maxPendingMutations: 1 });
  const queued = queueRegistry.register({ id: 'queued', close() {} }, 'queued');
  let release;
  const pending = queued.runMutation(() => new Promise((resolve) => { release = resolve; }));
  await assert.rejects(() => queued.runMutation(() => undefined), { code: 'QUEUE_FULL' });
  release();
  await pending;
});
