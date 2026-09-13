import assert from 'node:assert/strict';
import test from 'node:test';
import { createStdioMcpServer } from './stdio.js';

function fakeFetch(log) {
  return async (url, init = {}) => {
    log.push({ url: String(url), init });
    const body = JSON.parse(init.body);
    let result;
    if (body.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-gev', version: '1' } };
    else if (body.method === 'tools/list') result = { tools: [{ name: 'ping', description: 'Ping', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }] };
    else if (body.method === 'tools/call') result = { content: [{ type: 'text', text: `pong:${body.params.arguments.value}` }], structuredContent: { value: body.params.arguments.value } };
    else result = {};
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'fake-session' } });
  };
}

test('stdio proxy initializes, lists, and calls through local HTTP MCP', async () => {
  const requests = [];
  const proxy = createStdioMcpServer({ token: 'secret', url: 'http://127.0.0.1:4173/mcp', fetch: fakeFetch(requests) });
  const listed = await proxy.connect();
  assert.equal(proxy.registered, true);
  assert.deepEqual(listed.tools.map((tool) => tool.name), ['ping']);
  const call = await proxy.upstream.callTool({ name: 'ping', arguments: { value: 'ok' } });
  assert.equal(call.structuredContent.value, 'ok');
  assert.ok(requests.length >= 3);
  assert.ok(requests.every(({ url }) => url === 'http://127.0.0.1:4173/mcp'));
  assert.ok(requests.every(({ init }) => (init.headers.get ? init.headers.get('authorization') : init.headers.authorization) === 'Bearer secret'));
  await proxy.close();
});

test('stdio proxy requires a token and permits only local /mcp URLs', () => {
  assert.throws(() => createStdioMcpServer({ url: 'http://localhost:5173/mcp', token: '' }), /GEV_AGENT_TOKEN/);
  assert.throws(() => createStdioMcpServer({ url: 'http://evil.example/mcp', token: 'x' }), /localhost/);
  assert.throws(() => createStdioMcpServer({ url: 'http://localhost:5173/other', token: 'x' }), /\/mcp/);
  assert.throws(() => createStdioMcpServer({ url: 'ws://localhost:5173/mcp', token: 'x' }), /localhost/);
});
