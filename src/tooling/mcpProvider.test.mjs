import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  authorized,
  createMcpMiddleware,
  MCP_MAX_BODY_BYTES,
  MCP_MAX_CAPTURE_BYTES,
  captureResult,
  publicError,
  zodShape,
} from '../../server/providers/mcp.js';

function start(handler) {
  const server = http.createServer((req, res) => handler(req, res));
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/mcp` }),
    ),
  );
}
async function jsonResponse(response) {
  const text = await response.text();
  const match = text.match(/data:\s*(\{[\s\S]*\})/);
  return JSON.parse(match ? match[1] : text);
}

const catalog = [
  {
    name: 'ping',
    description: 'Ping the browser.',
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
    },
  },
];

test('capture unwraps the stable dispatch envelope and preserves metadata and artifacts', () => {
  const encoded = Buffer.from('image').toString('base64');
  const response = captureResult({
    tool: 'gev_capture_view',
    sessionId: 'browser-1',
    data: { image: { data: encoded, mimeType: 'image/png' }, metadata: { width: 1 }, artifacts: [{ id: 'a1' }] },
  });
  assert.equal(response.content[0].type, 'image');
  assert.deepEqual(response.structuredContent.metadata, { width: 1 });
  assert.deepEqual(response.structuredContent.artifacts, [{ id: 'a1' }]);
});

test('MCP middleware exposes resource topology notifications', () => {
  const middleware = createMcpMiddleware({
    token: 'secret',
    dispatch: async () => ({ ok: true }),
  });
  assert.equal(typeof middleware.notifyResourceListChanged, 'function');
  return middleware.close();
});

test('capture enforces the decoded image byte limit', () => {
  const encoded = Buffer.alloc(MCP_MAX_CAPTURE_BYTES + 1).toString('base64');
  assert.throws(() => captureResult({ image: { data: encoded, mimeType: 'image/png' } }), /image limit/);
});

test('public errors preserve documented timeout and artifact codes', () => {
  for (const code of [
    'REQUEST_TIMEOUT',
    'ARTIFACT_NOT_FOUND',
    'INVALID_ARTIFACT',
    'INVALID_ARTIFACT_ID',
  ]) {
    assert.equal(publicError({ code }).code, code);
  }
});

test('catalog schema conversion preserves requiredness and nested constraints', () => {
  const shape = zodShape({
    type: 'object',
    required: ['count'],
    properties: {
      count: { type: 'integer', minimum: 1, maximum: 3 },
      mode: { enum: ['a', 'b'] },
      tags: {
        type: 'array',
        minItems: 1,
        maxItems: 2,
        items: { type: 'string' },
      },
      options: {
        type: 'object',
        required: ['enabled'],
        additionalProperties: false,
        properties: { enabled: { type: 'boolean' } },
      },
    },
  });
  assert.equal(shape.count.safeParse(2).success, true);
  assert.equal(shape.count.safeParse(4).success, false);
  assert.equal(shape.mode.safeParse(undefined).success, true);
  assert.equal(shape.tags.safeParse(['x']).success, true);
  assert.equal(shape.tags.safeParse([]).success, false);
  assert.equal(
    shape.options.safeParse({ enabled: true, extra: 1 }).success,
    false,
  );
});

test('MCP exposes the catalog and routes calls through the injected session dispatcher', async (t) => {
  const calls = [];
  const middleware = createMcpMiddleware({
    catalog,
    token: 'secret',
    resources: { state: (id) => ({ id }), subscribe: true },
    dispatch: async (request) => {
      calls.push(request);
      if (request.tool === 'gev_capture_view') return { ok: true, result: { image: { data: 'aW1hZ2U=', mimeType: 'image/png' }, metadata: { width: 1 } } };
      return {
        ok: true,
        result: {
          echoed: request.arguments.value,
          sessionId: request.sessionId,
        },
      };
    },
    listSessions: () => [{ id: 'browser-1' }],
    getState: (id) => ({ id }),
  });
  const { server, url } = await start(middleware);
  t.after(async () => {
    await middleware.close();
    server.close();
  });
  const init = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: 'Bearer secret',
      host: '127.0.0.1',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
    }),
  });
  assert.equal(init.status, 200);
  const mcpSession = init.headers.get('mcp-session-id');
  assert.ok(mcpSession);
  const initialized = await jsonResponse(init);
  assert.equal(initialized.result.capabilities.resources.subscribe, true);
  const listed = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: 'Bearer secret',
      'mcp-session-id': mcpSession,
      host: '127.0.0.1',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    }),
  });
  const tools = await jsonResponse(listed);
  assert.ok(tools.result.tools.some((tool) => tool.name === 'ping'));
  assert.ok(tools.result.tools.some((tool) => tool.name === 'gev_capture_view'));
  const listedResources = await jsonResponse(await fetch(url, {
    method: 'POST',
    headers: {
      authorization: 'Bearer secret',
      'mcp-session-id': mcpSession,
      host: '127.0.0.1',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 21,
      method: 'resources/list',
      params: {},
    }),
  }));
  assert.ok(
    listedResources.result.resources.some(
      ({ uri }) => uri === 'gev://sessions/browser-1/state',
    ),
  );
  const called = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: 'Bearer secret',
      'mcp-session-id': mcpSession,
      host: '127.0.0.1',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'ping',
        arguments: { value: 'ok', sessionId: 'browser-1' },
      },
    }),
  });
  const payload = await jsonResponse(called);
  assert.equal(payload.result.structuredContent.echoed, 'ok');
  assert.equal(calls[0].sessionId, 'browser-1');
});

test('MCP enforces loopback and bearer auth and bounds request bodies', async (t) => {
  const middleware = createMcpMiddleware({
    catalog: [],
    token: 'secret',
    dispatch: async () => ({ ok: true }),
  });
  const { server, url } = await start(middleware);
  t.after(async () => {
    await middleware.close();
    server.close();
  });
  const unauthorized = await fetch(url, {
    method: 'POST',
    headers: {
      host: '127.0.0.1',
      'content-type': 'application/json',
      authorization: 'Bearer wrong',
      accept: 'application/json, text/event-stream',
    },
    body: '{}',
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(
    authorized(
      {
        socket: { remoteAddress: '127.0.0.1' },
        headers: { host: 'example.com', authorization: 'Bearer secret' },
      },
      { token: 'secret' },
    ),
    false,
  );
  const oversized = await fetch(url, {
    method: 'POST',
    headers: {
      host: '127.0.0.1',
      authorization: 'Bearer secret',
      accept: 'application/json, text/event-stream',
    },
    body: 'x'.repeat(MCP_MAX_BODY_BYTES + 1),
  });
  assert.equal(oversized.status, 413);
});

test('MCP gives clients distinct principals and forwards management/server-tool arguments', async (t) => {
  const seen = [];
  const middleware = createMcpMiddleware({ token: 'secret', catalog: [], dispatch: async (request, ctx) => {
    if (request.tool === 'server_ping') {
      seen.push({ request, ...ctx });
      return { ok: true, result: { data: { pong: request.arguments.value } } };
    }
    return { ok: true };
  }, joinSession: (args, ctx) => { seen.push({ args, ...ctx }); return { joined: true }; }, serverTools: [{ name: 'server_ping', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }, handler: () => { throw new Error('server tool bypassed dispatch'); } }] });
  const { server, url } = await start(middleware); t.after(async () => { await middleware.close(); server.close(); });
  const headers = (extra = {}) => ({ authorization: 'Bearer secret', host: '127.0.0.1', 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extra });
  const init = async (id) => { const response = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) }); return { body: await jsonResponse(response), session: response.headers.get('mcp-session-id') }; };
  const a = await init(10); const b = await init(11);
  assert.ok(a.session); assert.ok(b.session); assert.notEqual(a.session, b.session);
  const who = await jsonResponse(await fetch(url, { method: 'POST', headers: headers({ 'mcp-session-id': a.session }), body: JSON.stringify({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'gev_whoami', arguments: {} } }) }));
  assert.ok(who.result.structuredContent.principalId);
  const join = await jsonResponse(await fetch(url, { method: 'POST', headers: headers({ 'mcp-session-id': a.session }), body: JSON.stringify({ jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'gev_join_session', arguments: { sessionId: 's1' } } }) }));
  assert.equal(join.result.structuredContent.joined, true); assert.equal(seen[0].args.sessionId, 's1'); assert.equal(seen[0].principalId, who.result.structuredContent.principalId);
  const ping = await jsonResponse(await fetch(url, { method: 'POST', headers: headers({ 'mcp-session-id': a.session }), body: JSON.stringify({ jsonrpc: '2.0', id: 15, method: 'tools/call', params: { name: 'server_ping', arguments: { value: 'x' } } }) }));
  assert.equal(ping.result.structuredContent.pong, 'x'); assert.equal(seen[1].request.arguments.value, 'x');
});

test('initialized HTTP sessions count once against the advertised capacity', async (t) => {
  const middleware = createMcpMiddleware({
    token: 'secret',
    catalog: [],
    dispatch: async () => ({ ok: true }),
  });
  const { server, url } = await start(middleware);
  t.after(async () => {
    await middleware.close();
    server.close();
  });
  const sessions = [];
  for (let index = 0; index < 33; index += 1) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        host: '127.0.0.1',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: index + 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: `capacity-${index}`, version: '1' },
        },
      }),
    });
    assert.equal(response.status, 200, `session ${index + 1} should initialize`);
    sessions.push(response.headers.get('mcp-session-id'));
    await response.arrayBuffer();
  }
  assert.equal(new Set(sessions).size, 33);
});

test('malformed initialize requests do not consume HTTP session capacity', async (t) => {
  const middleware = createMcpMiddleware({
    token: 'secret',
    catalog: [],
    dispatch: async () => ({ ok: true }),
  });
  const { server, url } = await start(middleware);
  t.after(async () => {
    await middleware.close();
    server.close();
  });
  const headers = {
    authorization: 'Bearer secret',
    host: '127.0.0.1',
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  for (let index = 0; index < 64; index += 1) {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: index + 1,
        method: 'initialize',
        params: {},
      }),
    });
    assert.equal(response.status, 400, `malformed request ${index + 1}`);
    await response.arrayBuffer();
  }
  const valid = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 100,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'valid-after-malformed', version: '1' },
      },
    }),
  });
  assert.equal(valid.status, 200);
  assert.ok(valid.headers.get('mcp-session-id'));
  await valid.arrayBuffer();
});

test('DELETE removes a transport from HTTP session capacity', async (t) => {
  const middleware = createMcpMiddleware({
    token: 'secret',
    catalog: [],
    dispatch: async () => ({ ok: true }),
  });
  const { server, url } = await start(middleware);
  t.after(async () => {
    await middleware.close();
    server.close();
  });
  const headers = {
    authorization: 'Bearer secret',
    host: '127.0.0.1',
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  const init = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'delete-capacity', version: '1' },
      },
    }),
  });
  assert.equal(init.status, 200);
  const deletedSession = init.headers.get('mcp-session-id');
  assert.ok(deletedSession);
  await init.arrayBuffer();
  const deleted = await fetch(url, {
    method: 'DELETE',
    headers: { ...headers, 'mcp-session-id': deletedSession },
  });
  assert.equal(deleted.status, 200);
  await deleted.arrayBuffer();

  const sessions = [];
  for (let index = 0; index < 64; index += 1) {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: index + 2,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: `after-delete-${index}`, version: '1' },
        },
      }),
    });
    assert.equal(response.status, 200, `session ${index + 1} should initialize`);
    sessions.push(response.headers.get('mcp-session-id'));
    await response.arrayBuffer();
  }
  assert.equal(new Set(sessions).size, 64);
});

test('shutdown during request body streaming does not allocate an MCP session', async (t) => {
  const middleware = createMcpMiddleware({
    token: 'secret',
    catalog: [],
    dispatch: async () => ({ ok: true }),
  });
  const { server, url } = await start(middleware);
  t.after(async () => {
    await middleware.close();
    server.close();
  });
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'shutdown-race', version: '1' },
    },
  });
  const response = await new Promise((resolve, reject) => {
    const request = http.request(new URL(url), {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        host: '127.0.0.1',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      res.resume();
      res.once('end', () => resolve(res));
    });
    request.once('error', reject);
    const split = Math.max(1, Math.floor(body.length / 2));
    request.write(body.slice(0, split));
    setImmediate(async () => {
      try {
        await middleware.close();
        request.end(body.slice(split));
      } catch (error) {
        request.destroy(error);
      }
    });
  });
  assert.equal(response.statusCode, 503);
});

test('resource subscriptions require an authorized session resource', async (t) => {
  const middleware = createMcpMiddleware({
    token: 'secret',
    catalog: [],
    dispatch: async () => ({ ok: true }),
    listSessions: () => [
      { id: 'public-session', access: 'owner' },
      { id: 'waiting-session', access: 'unclaimed' },
    ],
    resources: { state: (id) => ({ id }), subscribe: true },
  });
  const { server, url } = await start(middleware);
  t.after(async () => {
    await middleware.close();
    server.close();
  });
  const headers = (extra = {}) => ({
    authorization: 'Bearer secret',
    host: '127.0.0.1',
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...extra,
  });
  const initialized = await fetch(url, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'subscription-test', version: '1' },
      },
    }),
  });
  assert.equal(initialized.status, 200);
  const sessionId = initialized.headers.get('mcp-session-id');
  const subscribe = (id, uri) => fetch(url, {
    method: 'POST',
    headers: headers({ 'mcp-session-id': sessionId }),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'resources/subscribe',
      params: { uri },
    }),
  }).then(jsonResponse);
  const denied = await subscribe(2, 'gev://sessions/private-session/state');
  assert.equal(denied.error.code, -32602);
  const unclaimed = await subscribe(4, 'gev://sessions/waiting-session/state');
  assert.equal(unclaimed.error.code, -32602);
  const allowed = await subscribe(3, 'gev://sessions/public-session/state');
  assert.deepEqual(allowed.result, {});
});
