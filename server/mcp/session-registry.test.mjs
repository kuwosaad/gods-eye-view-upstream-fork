import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionRegistry } from './session-registry.js';

const connection = (id) => ({ id, close() {} });

test('unclaimed sessions are discoverable but claim is first-owner-wins', () => {
  const registry = new SessionRegistry();
  registry.register(connection('browser'), 'browser');
  assert.equal(registry.list('agent-a').length, 1);
  assert.throws(() => registry.resolve('browser', 'agent-a'), { code: 'ACCESS_DENIED' });
  assert.equal(registry.claim('browser', 'agent-a').principalId, 'agent-a');
  assert.throws(() => registry.claim('browser', 'agent-b'), { code: 'ACCESS_DENIED' });
  assert.equal(registry.resolve('browser', 'agent-a').id, 'browser');
});

test('only the owner may share, close, or replace a session', () => {
  const registry = new SessionRegistry();
  registry.register(connection('browser'), 'browser', { principalId: 'owner' });
  assert.throws(() => registry.share('browser', 'stranger', 'other'), { code: 'ACCESS_DENIED' });
  assert.throws(() => registry.register(connection('replacement'), 'browser', { principalId: 'other', replace: true }), { code: 'ACCESS_DENIED' });
  registry.share('browser', 'owner', 'other');
  assert.equal(registry.resolve('browser', 'other').id, 'browser');
  registry.register(connection('replacement'), 'browser', { principalId: 'other', actorPrincipalId: 'owner', replace: true });
  assert.equal(registry.get('browser').principalId, 'other');
  assert.throws(() => registry.close('browser', 'owner'), { code: 'ACCESS_DENIED' });
  assert.equal(registry.close('browser', 'other'), true);
});

test('public sessions can be joined but have no implicit owner powers', () => {
  const registry = new SessionRegistry();
  registry.register(connection('public'), 'public', { publicSession: true });
  assert.equal(registry.join('public', 'any-agent').id, 'public');
  assert.throws(() => registry.close('public', 'any-agent'), { code: 'ACCESS_DENIED' });
});
