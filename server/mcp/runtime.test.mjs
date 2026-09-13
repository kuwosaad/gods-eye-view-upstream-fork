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
