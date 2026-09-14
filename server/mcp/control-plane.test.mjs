import test from 'node:test';
import assert from 'node:assert/strict';
import { createControlPlane } from './control-plane.js';
import { SessionRegistry } from './session-registry.js';

function bridgeFor(id = 'browser') {
  const listeners = new Set();
  const calls = [];
  return {
    sessions: new Map([[id, {}]]),
    subscribe(sessionId, listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    request(sessionId, name, args, options) {
      assert.equal(sessionId, id);
      calls.push(options);
      return Promise.resolve({ name, args, sessionId });
    },
    listeners,
    calls,
  };
}

test('syncs external bridge sessions and routes browser tools', async () => {
  const bridge = bridgeFor();
  const states = [];
  const plane = createControlPlane({
    bridge,
    getState: async (session) => ({ id: session.id, version: session.stateVersion }),
    tools: { move: { mutation: true, description: 'Move' } },
  });
  plane.syncBridgeSessions();
  plane.claim('browser', 'agent-a');
  const result = await plane.call('move', { value: 3 }, { callerId: 'agent-a' });
  assert.equal(result.structuredContent.stateVersion, 1);
  assert.deepEqual(result.state, {
    id: 'browser',
    version: 1,
    stateVersion: 1,
  });
  assert.equal(bridge.calls[0].mutation, true);
  assert.equal(bridge.calls[0].callerId, 'agent-a');
  assert.deepEqual(plane.listResources('agent-a').map(({ uri }) => uri), ['gev://sessions/browser/state']);
  const resource = await plane.readResource('gev://sessions/browser/state', 'agent-a');
  assert.deepEqual(JSON.parse(resource.text), { id: 'browser', version: 1 });
  states.push(...plane.registry.list('agent-a'));
  assert.equal(states.length, 1);
  plane.close();
});

test('external sessions remain unclaimed until explicitly claimed', async () => {
  const bridge = bridgeFor('unclaimed');
  const plane = createControlPlane({ bridge, tools: { inspect: { mutation: true } } });
  plane.syncBridgeSessions();
  assert.deepEqual(plane.listResources('agent-a'), []);
  const denied = await plane.call('inspect', { sessionId: 'unclaimed' }, { callerId: 'agent-a' });
  assert.equal(denied.structuredContent.code, 'ACCESS_DENIED');
  plane.claim('unclaimed', 'agent-a');
  assert.equal(plane.listResources('agent-a').length, 1);
  const lease = plane.acquireLease('unclaimed', 'agent-a', { ttlMs: 100 });
  plane.releaseLease('unclaimed', 'agent-a');
  assert.equal(plane.registry.get('unclaimed').leaseOwner, null);
  lease.done();
});

test('session topology changes notify resource-list observers', () => {
  const bridge = bridgeFor('observed');
  let changes = 0;
  const plane = createControlPlane({
    bridge,
    onSessionsChanged: () => {
      changes += 1;
    },
  });
  plane.syncBridgeSessions();
  const afterConnect = changes;
  plane.claim('observed', 'owner');
  plane.share('observed', 'owner', 'guest');
  plane.closeSession('observed', 'owner');
  assert.ok(afterConnect >= 1);
  assert.equal(changes, afterConnect + 3);
  plane.close();
});

test('reconnect replaces a stale bridge generation while preserving session state', async () => {
  const bridge = bridgeFor('reconnect');
  const plane = createControlPlane({ bridge, tools: { move: { mutation: true } } });
  plane.syncBridgeSessions();
  plane.claim('reconnect', 'agent-a');
  const before = plane.registry.get('reconnect', 'agent-a');
  before.stateVersion = 7;
  before.sharedWith.add('agent-b');
  const oldEntry = bridge.sessions.get('reconnect');
  bridge.sessions.set('reconnect', {});
  plane.syncBridgeSessions();
  const after = plane.registry.get('reconnect', 'agent-b');
  assert.notEqual(after.connection, before.connection);
  assert.equal(after.stateVersion, 7);
  assert.equal(after.principalId, 'agent-a');
  assert.equal(after.sharedWith.has('agent-b'), true);
  assert.notEqual(plane.registry.get('reconnect').connection, oldEntry);
});

test('reconnect keeps mutations ordered and versions unique while one is in flight', async () => {
  const bridge = bridgeFor('reconnect');
  const order = [];
  let firstEnteredResolve;
  let releaseFirstResolve;
  const firstEntered = new Promise((resolve) => { firstEnteredResolve = resolve; });
  let first = true;
  const plane = createControlPlane({
    bridge,
    tools: {
      move: {
        mutation: true,
        handler: async ({ args }) => {
          order.push(args.step);
          if (first) {
            first = false;
            firstEnteredResolve();
            await new Promise((resolve) => { releaseFirstResolve = resolve; });
          }
          return { step: args.step };
        },
      },
    },
  });
  // Keep the test deterministic without exposing implementation details from
  // the bridge: wait until the first handler has entered, then replace it.
  plane.syncBridgeSessions();
  plane.claim('reconnect', 'agent-a');
  const firstCall = plane.dispatch({ tool: 'move', arguments: { sessionId: 'reconnect', step: 1 } }, { callerId: 'agent-a' });
  await firstEntered;
  bridge.sessions.set('reconnect', {});
  plane.syncBridgeSessions();
  const secondCall = plane.dispatch({ tool: 'move', arguments: { sessionId: 'reconnect', step: 2 } }, { callerId: 'agent-a' });
  releaseFirstResolve();
  const [firstResult, secondResult] = await Promise.all([firstCall, secondCall]);
  assert.deepEqual(order, [1, 2]);
  assert.equal(firstResult.result.stateVersion, 1);
  assert.equal(secondResult.result.stateVersion, 2);
  plane.close();
});

test('dispatch observes each mutation before the next mutation advances state', async () => {
  const bridge = bridgeFor('snapshot');
  const plane = createControlPlane({
    bridge,
    getState: async (session) => ({ version: session.stateVersion }),
    tools: {
      move: {
        mutation: true,
        handler: async ({ args }) => {
          await new Promise((resolve) => setTimeout(resolve, args.delay));
          return { step: args.step };
        },
      },
    },
  });
  plane.syncBridgeSessions();
  plane.claim('snapshot', 'agent-a');
  const first = plane.dispatch(
    { tool: 'move', arguments: { sessionId: 'snapshot', step: 1, delay: 10 } },
    { callerId: 'agent-a' },
  );
  const second = plane.dispatch(
    { tool: 'move', arguments: { sessionId: 'snapshot', step: 2, delay: 0 } },
    { callerId: 'agent-a' },
  );
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a.result.state, { version: 1, stateVersion: 1 });
  assert.deepEqual(b.result.state, { version: 2, stateVersion: 2 });
  plane.close();
});

test('reconnect preserves the active mutation lease and its expiry', () => {
  const bridge = bridgeFor('reconnect');
  const plane = createControlPlane({ bridge });
  plane.syncBridgeSessions();
  plane.claim('reconnect', 'agent-a');
  plane.share('reconnect', 'agent-a', 'agent-b');
  plane.acquireLease('reconnect', 'agent-a', { ttlMs: 1_000 });
  bridge.sessions.set('reconnect', {});
  plane.syncBridgeSessions();

  const session = plane.registry.get('reconnect', 'agent-a');
  assert.equal(session.leaseOwner, 'agent-a');
  assert.ok(session.leaseExpiresAt > Date.now());
  assert.throws(
    () => plane.acquireLease('reconnect', 'agent-b'),
    { code: 'LEASED' },
  );
  plane.close();
});

test('failed bridge registration does not strand a stale connection generation', () => {
  const bridge = bridgeFor('reconnect');
  const registry = new SessionRegistry({ maxSessionsPerPrincipal: 0 });
  const plane = createControlPlane({ bridge, registry });
  assert.throws(
    () => plane.registerBridgeSession('reconnect', { principalId: 'agent-a' }),
    { code: 'SESSION_QUOTA' },
  );
  registry.maxSessionsPerPrincipal = 1;
  plane.syncBridgeSessions({ principalId: 'agent-a' });
  assert.equal(plane.registry.get('reconnect', 'agent-a').id, 'reconnect');
  plane.close();
});

test('closing the control plane aborts active browser commands', async () => {
  const bridge = bridgeFor('closing');
  let seenSignal;
  bridge.request = (sessionId, name, args, { signal }) => new Promise((resolve, reject) => {
    seenSignal = signal;
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ABORTED' })), { once: true });
  });
  const plane = createControlPlane({ bridge, tools: { move: { mutation: true } } });
  plane.syncBridgeSessions();
  plane.claim('closing', 'agent-a');
  const pending = plane.call('move', {}, { callerId: 'agent-a' });
  await new Promise((resolve) => setImmediate(resolve));
  plane.close();
  const result = await pending;
  assert.equal(seenSignal.aborted, true);
  assert.equal(result.structuredContent.code, 'ABORTED');
});

test('control plane preserves ACL isolation and records failures', async () => {
  const registry = new SessionRegistry();
  const connection = { id: 'private', command: async () => 'ok', close() {} };
  registry.register(connection, 'private', { principalId: 'owner' });
  const audit = [];
  const plane = createControlPlane({
    registry,
    audit: (event) => audit.push(event),
    tools: { inspect: { mutation: true, handler: ({ session }) => session.id } },
  });
  const denied = await plane.call('inspect', { sessionId: 'private' }, { callerId: 'stranger' });
  assert.equal(denied.structuredContent.code, 'ACCESS_DENIED');
  assert.equal(audit.at(-1).type, 'failed');
  registry.share('private', 'owner', 'stranger');
  const allowed = await plane.call('inspect', { sessionId: 'private' }, { callerId: 'stranger' });
  assert.equal(allowed.structuredContent.value, 'private');
});

test('dispatch returns a stable raw envelope and structured errors', async () => {
  const registry = new SessionRegistry();
  registry.register({ id: 's', command: async () => ({ ok: true }), close() {} }, 's');
  const plane = createControlPlane({
    registry,
    getState: async (session) => ({ sessionId: session.id }),
    tools: { move: { mutation: true, handler: () => ({ value: 4, warnings: ['slow'], artifacts: ['image'] }) } },
  });
  plane.claim('s', 'agent');
  const good = await plane.dispatch({ id: '1', sessionId: 's', tool: 'move', arguments: {} }, { callerId: 'agent' });
  assert.deepEqual(good, {
    ok: true,
    result: {
      tool: 'move', sessionId: 's', stateVersion: 1,
      data: { value: 4, warnings: ['slow'], artifacts: ['image'] },
      warnings: ['slow'], artifacts: ['image'], state: { sessionId: 's', stateVersion: 1 },
    },
  });
  const bad = await plane.dispatch({ id: '2', sessionId: 's', tool: 'missing', arguments: {} }, { callerId: 'agent' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'TOOL_NOT_FOUND');
});
