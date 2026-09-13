import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  authorized,
  createMcpMiddleware,
  MCP_MAX_BODY_BYTES,
  MCP_MAX_CAPTURE_BYTES,
  captureResult,
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

test('capture enforces the decoded image byte limit', () => {
  const encoded = Buffer.alloc(MCP_MAX_CAPTURE_BYTES + 1).toString('base64');
  assert.throws(() => captureResult({ image: { data: encoded, mimeType: 'image/png' } }), /image limit/);
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
    resources: { state: (id) => ({ id }) },
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
  const middleware = createMcpMiddleware({ token: 'secret', catalog: [], dispatch: async () => ({ ok: true }), joinSession: (args, ctx) => { seen.push({ args, ...ctx }); return { joined: true }; }, serverTools: [{ name: 'server_ping', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }, handler: (args, ctx) => { seen.push({ args, ...ctx }); return { pong: args.value }; } }] });
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
  assert.equal(ping.result.structuredContent.pong, 'x'); assert.equal(seen[1].args.value, 'x');
});
