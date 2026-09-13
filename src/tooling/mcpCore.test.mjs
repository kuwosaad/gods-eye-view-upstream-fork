import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AbortError,
  BrowserConnection,
  SessionRegistry,
  TimeoutError,
  ToolDispatcher,
} from '../../server/mcp/index.js';

function fakeTransport() {
  const sent = [];
  return {
    sent,
    send(message) {
      sent.push(message);
    },
    close() {},
  };
}

test('browser commands correlate replies and preserve structured values', async () => {
  const transport = fakeTransport();
  const connection = new BrowserConnection(transport, { id: 'browser-a' });
  const pending = connection.command('get_state', { scope: 'globe' });
  assert.deepEqual(transport.sent[0], {
    type: 'gev:command',
    id: 'browser-a:1',
    name: 'get_state',
    args: { scope: 'globe' },
    mutation: false,
  });
  connection.receive({
    type: 'gev:response',
    id: 'browser-a:1',
    result: { camera: { lat: 1 } },
  });
  assert.deepEqual(await pending, { camera: { lat: 1 } });
});

test('browser commands time out and can be cancelled', async () => {
  const transport = fakeTransport();
  const connection = new BrowserConnection(transport, { commandTimeoutMs: 10 });
  await assert.rejects(connection.command('slow'), TimeoutError);
  const controller = new AbortController();
  const pending = connection.command(
    'cancelled',
    {},
    { signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(pending, AbortError);
  assert.equal(transport.sent.at(-1).type, 'gev:cancel');
});

test('settled commands remove abort listeners and ignore late aborts', async () => {
  const transport = fakeTransport();
  const listeners = new Set();
  const signal = {
    aborted: false,
    addEventListener(type, listener) {
      if (type === 'abort') listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === 'abort') listeners.delete(listener);
    },
  };
  const connection = new BrowserConnection(transport, { id: 'browser-b' });
  const pending = connection.command('quick', {}, { signal });
  const abortListener = [...listeners][0];
  connection.receive({ type: 'gev:response', id: 'browser-b:1', result: 'ok' });
  assert.equal(await pending, 'ok');
  assert.equal(listeners.size, 0);
  abortListener();
  assert.equal(
    transport.sent.filter((message) => message.type === 'gev:cancel').length,
    0,
  );
});

test('registry isolates named sessions and removes disconnected browsers', () => {
  const registry = new SessionRegistry();
  const a = new BrowserConnection(fakeTransport(), { id: 'a' });
  const session = registry.register(a, 'main');
  assert.equal(registry.get('main'), session);
  assert.throws(
    () =>
      registry.register(
        new BrowserConnection(fakeTransport(), { id: 'b' }),
        'main',
      ),
    /already exists/,
  );
  a.close();
  assert.deepEqual(registry.list(), []);
});

test('mutating tools are serialized and leases prevent competing owners', async () => {
  const registry = new SessionRegistry();
  const session = registry.register(
    new BrowserConnection(fakeTransport(), { id: 'b' }),
    'main',
    { principalId: 'agent-a' },
  );
  const events = [];
  const dispatcher = new ToolDispatcher({
    registry,
    tools: {
      move: {
        mutation: true,
        handler: async ({ args }) => {
          events.push(`start:${args.value}`);
          await new Promise((r) => setTimeout(r, 5));
          events.push(`end:${args.value}`);
          return args.value;
        },
      },
    },
  });
  const lease = session.acquireLease('agent-a');
  assert.throws(() => session.acquireLease('agent-b'), /controlled by/);
  const [one, two] = await Promise.all([
    dispatcher.callTool(
      'move',
      { sessionId: 'main', value: 1 },
      { callerId: 'agent-a' },
    ),
    dispatcher.callTool(
      'move',
      { sessionId: 'main', value: 2 },
      { callerId: 'agent-a' },
    ),
  ]);
  lease.done();
  assert.deepEqual(events, ['start:1', 'end:1', 'start:2', 'end:2']);
  assert.equal(one.structuredContent.value, 1);
  assert.equal(two.structuredContent.value, 2);
});

test('dispatcher exposes tool metadata and converts failures to structured results', async () => {
  const registry = new SessionRegistry();
  const dispatcher = new ToolDispatcher({
    registry,
    tools: {
      ping: {
        description: 'Ping',
        inputSchema: { type: 'object' },
        handler: () => ({ ok: true }),
      },
    },
  });
  assert.deepEqual(dispatcher.listTools(), [
    { name: 'ping', description: 'Ping', inputSchema: { type: 'object' } },
  ]);
  assert.equal(
    (await dispatcher.callTool('missing')).structuredContent.code,
    'TOOL_NOT_FOUND',
  );
  assert.deepEqual((await dispatcher.callTool('ping')).structuredContent, {
    ok: true,
  });
});

test('resolves an omitted session only when there is exactly one browser', async () => {
  const registry = new SessionRegistry();
  const browser = new BrowserConnection(fakeTransport(), { id: 'single' });
  registry.register(browser, 'only', { principalId: 'agent' });
  const dispatcher = new ToolDispatcher({
    registry,
    tools: {
      inspect: { mutation: true, handler: ({ session }) => session.id },
    },
  });
  assert.equal(
    (await dispatcher.callTool('inspect', {}, { callerId: 'agent' })).structuredContent.value,
    'only',
  );
  registry.register(
    new BrowserConnection(fakeTransport(), { id: 'two' }),
    'second',
    { principalId: 'agent' },
  );
  const result = await dispatcher.callTool('inspect', {}, { callerId: 'agent' });
  assert.equal(result.structuredContent.code, 'SESSION_REQUIRED');
});

test('bounds mutation queues and reports state versions', async () => {
  const registry = new SessionRegistry({ maxPendingMutations: 1 });
  const session = registry.register(
    new BrowserConnection(fakeTransport()),
    'main',
    { principalId: 'anonymous' },
  );
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const dispatcher = new ToolDispatcher({
    registry,
    tools: {
      wait: { mutation: true, handler: async () => { await gate; return { ok: true }; } },
    },
  });
  const first = dispatcher.callTool('wait', { sessionId: 'main' });
  const queued = await dispatcher.callTool('wait', { sessionId: 'main' });
  assert.equal(queued.structuredContent.code, 'QUEUE_FULL');
  release();
  const result = await first;
  assert.equal(result.structuredContent.stateVersion, 1);
  assert.equal(session.stateVersion, 1);
});

test('leases expire and disconnect closes the session safely', async () => {
  const registry = new SessionRegistry();
  const browser = new BrowserConnection(fakeTransport());
  const session = registry.register(browser, 'main');
  session.acquireLease('agent-a', { ttlMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.doesNotThrow(() => session.acquireLease('agent-b'));
  browser.close();
  assert.equal(registry.list().length, 0);
});

test('principals are isolated until a session is shared', () => {
  const registry = new SessionRegistry({ maxSessionsPerPrincipal: 1 });
  const session = registry.create(new BrowserConnection(fakeTransport()), {
    id: 'private',
    principalId: 'owner',
  });
  assert.throws(() => registry.get('private', 'other'), /not shared/);
  assert.deepEqual(registry.list('other'), []);
  registry.share('private', 'owner', 'other');
  assert.equal(registry.join('private', 'other'), session);
  assert.deepEqual(registry.list('other').map(({ id }) => id), ['private']);
  assert.throws(
    () => registry.create(new BrowserConnection(fakeTransport()), { principalId: 'owner' }),
    /quota exceeded/,
  );
});
