import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpResourceAdapter } from './resources.js';

test('projects resources and caches the same state version per principal', async () => {
  let reads = 0; let state = { stateVersion: 2, layers: [{ id: 'x', enabled: true }] };
  const adapter = createMcpResourceAdapter({ getState: async () => { reads++; return state; }, maxCacheEntries: 2 });
  const uri = 'gev://sessions/main/layers';
  const first = await adapter.readResource(uri, 'a');
  const second = await adapter.readResource(uri, 'a');
  // The injected reader remains authoritative; the cache reuses the bounded
  // projection once its stateVersion is known, while still checking for a new
  // version on each read.
  assert.equal(reads, 2); assert.deepEqual(JSON.parse(first.text), JSON.parse(second.text));
  state = { ...state, stateVersion: 3, layers: [] };
  assert.deepEqual(JSON.parse((await adapter.readResource(uri, 'a')).text).layers, []);
  assert.equal(reads, 3);
});

test('mutation hook receives fresh state and artifacts are injected', async () => {
  const events = [];
  const adapter = createMcpResourceAdapter({
    getState: async (id, principal) => ({ stateVersion: 9, id, principal }),
    onMutation: (event) => events.push(event),
    getArtifact: async (id, artifactId, principal) => ({ text: JSON.stringify({ id, artifactId, principal }), mimeType: 'application/json' }),
  });
  await adapter.notifyMutation('s', 'agent', { name: 'move' });
  assert.equal(events[0].stateVersion, 9); assert.equal(events[0].event.name, 'move');
  const artifact = await adapter.readResource('gev://sessions/s/artifacts/a1', 'agent');
  assert.equal(JSON.parse(artifact.text).artifactId, 'a1');
});

test('exposes provider callbacks and normalizes principal options', async () => {
  const calls = [];
  const adapter = createMcpResourceAdapter({
    getState: async (sessionId, options) => {
      calls.push([sessionId, options]);
      return { stateVersion: 1, layers: [{ id: 'layer' }] };
    },
    getArtifact: async (sessionId, artifactId, principal) => ({
      text: JSON.stringify({ sessionId, artifactId, principal }),
      mimeType: 'application/json',
    }),
  });

  const layers = await adapter.layers('main', { principalId: 'agent' });
  assert.equal(layers.layers[0].id, 'layer');
  assert.deepEqual(calls[0], ['main', { principalId: 'agent' }]);
  const artifact = await adapter.readResource(
    'gev://sessions/main/artifacts/capture-1',
    { principalId: 'agent' },
  );
  assert.deepEqual(JSON.parse(artifact.text), {
    sessionId: 'main', artifactId: 'capture-1', principal: 'agent',
  });
  const callbackArtifact = await adapter.artifacts('main', 'capture-1', { principalId: 'agent' });
  assert.equal(JSON.parse(callbackArtifact.text).artifactId, 'capture-1');
});

test('does not cache unversioned state and hides projection failures', async () => {
  let reads = 0;
  const adapter = createMcpResourceAdapter({
    getState: async () => { reads += 1; return { stateVersion: undefined }; },
  });
  await adapter.readResource('gev://sessions/main/state', 'agent');
  await adapter.readResource('gev://sessions/main/state', 'agent');
  assert.equal(reads, 2);

  const broken = createMcpResourceAdapter({
    getState: async () => ({ get camera() { throw new Error('private detail'); } }),
  });
  const result = await broken.readResource('gev://sessions/main/state');
  assert.deepEqual(JSON.parse(result.text), { error: 'RESOURCE_PROJECTION_FAILED' });
});
