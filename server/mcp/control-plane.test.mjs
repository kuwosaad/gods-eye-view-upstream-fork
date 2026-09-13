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
