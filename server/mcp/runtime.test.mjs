import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpRuntime } from './runtime.js';

function bridgeFor(id = 'browser') {
  const sessions = new Map([[id, {}]]);
  return {
    sessions,
    subscribe: () => () => {},
    request: async (sessionId, name, args) => ({ sessionId, name, args, stateVersion: 4 }),
    close() {},
  };
}

test('composes catalog, private session discovery, join claim, dispatch, and resources', async () => {
  const runtime = createMcpRuntime({
    bridge: bridgeFor(),
    catalog: [{ name: 'move', description: 'Move', parameters: { type: 'object', properties: {} } }],
    metadata: { move: { access: 'mutation' } },
    getState: async (session) => ({ stateVersion: session.stateVersion, sessionId: session.id }),
    tools: { move: { mutation: true } },
  });

  assert.equal(runtime.listSessions({ principalId: 'agent-a' }).length, 1);
  await assert.rejects(() => runtime.getState('browser', { principalId: 'agent-a' }), { code: 'ACCESS_DENIED' });
  const joined = runtime.joinSession({ sessionId: 'browser' }, { principalId: 'agent-a' });
  assert.equal(joined.id, 'browser');
  const result = await runtime.dispatch({ id: '1', tool: 'move', sessionId: 'browser', arguments: { x: 1 } }, { principalId: 'agent-a' });
  assert.equal(result.ok, true);
  assert.equal(result.result.stateVersion, 1);
  assert.equal((await runtime.resourceCallbacks.state('browser', { principalId: 'agent-a' })).stateVersion, 1);
  await runtime.close();
});

test('runtime quota rejection is per principal and audit is bounded', async () => {
  const runtime = createMcpRuntime({ bridge: bridgeFor('s'), quota: { maxCalls: 1 }, tools: { inspect: { handler: () => 'ok' } } });
  const first = await runtime.dispatch({ tool: 'inspect', arguments: {} }, { principalId: 'a' });
  const second = await runtime.dispatch({ tool: 'inspect', arguments: {} }, { principalId: 'a' });
  assert.equal(first.ok, true);
  assert.equal(second.error.code, 'QUOTA_EXCEEDED');
  const audit = runtime.auditLog.list();
  assert.equal(audit.length, 2);
  assert.equal(audit[0].outcome, 'ok');
  assert.equal(audit[1].errorCode, 'QUOTA_EXCEEDED');
  await runtime.close();
});

test('a create request cannot reserve or steal another principal live session', async () => {
  const bridge = bridgeFor('default');
  const runtime = createMcpRuntime({ bridge });
  runtime.listSessions({ principalId: 'owner' });
  runtime.joinSession({ sessionId: 'default' }, { principalId: 'owner' });

  assert.throws(
    () => runtime.createSession({ sessionId: 'default' }, { principalId: 'intruder' }),
    { code: 'ACCESS_DENIED' },
  );
  bridge.sessions.set('default', {});
  runtime.syncBridgeSessions();
  assert.equal(runtime.registry.get('default').principalId, 'owner');
  await runtime.close();
});

test('closing a session disconnects it and prevents synchronization resurrection', async () => {
  const bridge = bridgeFor('default');
  bridge.disconnect = (sessionId) => bridge.sessions.delete(sessionId);
  const runtime = createMcpRuntime({ bridge });
  runtime.listSessions({ principalId: 'owner' });
  runtime.joinSession({ sessionId: 'default' }, { principalId: 'owner' });
  runtime.closeSession({ sessionId: 'default' }, { principalId: 'owner' });

  assert.equal(bridge.sessions.has('default'), false);
  assert.equal(runtime.listSessions({ principalId: 'owner' }).length, 0);
  assert.equal(runtime.reservations.has('default'), false);
  await runtime.close();
});

test('read-only catalog tools auto-select the sole accessible browser session', async () => {
  const runtime = createMcpRuntime({
    bridge: bridgeFor('only'),
    catalog: [
      {
        name: 'inspect',
        description: 'Inspect',
        parameters: { type: 'object', properties: {} },
      },
    ],
    metadata: { inspect: { access: 'read', readOnly: true } },
  });
  runtime.listSessions({ principalId: 'owner' });
  runtime.joinSession({ sessionId: 'only' }, { principalId: 'owner' });
  const response = await runtime.dispatch(
    { tool: 'inspect', arguments: {} },
    { principalId: 'owner' },
  );
  assert.equal(response.ok, true);
  assert.equal(response.result.sessionId, 'only');
  await runtime.close();
});

test('registered server tools share dispatcher leases and cost-class quotas', async () => {
  let calls = 0;
  const runtime = createMcpRuntime({
    bridge: bridgeFor('only'),
    quota: {
      limits: { artifact: { maxCalls: 1, maxBytes: 1_000, maxRuntimeMs: 1_000 } },
    },
  });
  runtime.registerServerTools([
    {
      name: 'gev_artifact_test',
      inputSchema: { type: 'object', properties: {} },
      costClass: 'artifact',
      handler: async () => ({ calls: ++calls }),
    },
  ]);
  runtime.listSessions({ principalId: 'owner' });
  runtime.joinSession({ sessionId: 'only' }, { principalId: 'owner' });
  runtime.shareSession(
    { sessionId: 'only', invitedPrincipalId: 'guest' },
    { principalId: 'owner' },
  );
  runtime.acquireLease(
    { sessionId: 'only', ttlMs: 1_000 },
    { principalId: 'owner' },
  );
  const blocked = await runtime.dispatch(
    { tool: 'gev_artifact_test', sessionId: 'only', arguments: {} },
    { principalId: 'guest' },
  );
  assert.equal(blocked.error.code, 'LEASED');
  const first = await runtime.dispatch(
    { tool: 'gev_artifact_test', sessionId: 'only', arguments: {} },
    { principalId: 'owner' },
  );
  const second = await runtime.dispatch(
    { tool: 'gev_artifact_test', sessionId: 'only', arguments: {} },
    { principalId: 'owner' },
  );
  assert.equal(first.ok, true);
  assert.equal(second.error.code, 'QUOTA_EXCEEDED');
  assert.equal(calls, 1);
  await runtime.close();
});

test('unused session reservations are bounded and expire', async () => {
  let timestamp = 0;
  const runtime = createMcpRuntime({
    reservationTtlMs: 10,
    maxReservations: 1,
    now: () => timestamp,
  });
  runtime.createSession({ sessionId: 'first' }, { principalId: 'owner' });
  assert.throws(
    () => runtime.createSession({ sessionId: 'second' }, { principalId: 'owner' }),
    { code: 'SESSION_QUOTA' },
  );
  timestamp = 11;
  assert.equal(
    runtime.createSession({ sessionId: 'second' }, { principalId: 'owner' }).status,
    'waiting',
  );
  assert.equal(runtime.reservations.has('first'), false);
  await runtime.close();
});

test('a failed join does not claim an unclaimed browser session', async () => {
  const bridge = bridgeFor('browser');
  const runtime = createMcpRuntime({ bridge, maxReservations: 1 });
  runtime.createSession({ sessionId: 'reserved' }, { principalId: 'owner' });
  runtime.listSessions({ principalId: 'owner' });

  assert.throws(
    () =>
      runtime.joinSession(
        { sessionId: 'browser' },
        { principalId: 'owner' },
      ),
    { code: 'SESSION_QUOTA' },
  );
  const session = runtime.registry.get('browser');
  assert.equal(session.principalId, null);
  assert.equal(session.unclaimed, true);
  await runtime.close();
});
