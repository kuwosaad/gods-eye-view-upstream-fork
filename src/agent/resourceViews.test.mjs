import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createObservationResourceProvider,
  projectAnnotationsResource,
  projectEntitiesResource,
  projectLayersResource,
  projectStateResource,
} from './resourceViews.js';

const state = {
  stateVersion: 7, observedAt: '2026-09-13T00:00:00.000Z', partial: true,
  camera: { latitude: 1, longitude: 2 }, active: { style: 'normal' },
  health: { stale: true, apiKey: 'must-not-escape' },
  selected: { selected: { id: 'a', name: 'A' }, tracked: { id: 'a', name: 'A' } },
  layers: [{ id: 'x', name: 'X', enabled: true, stats: { count: 3 } }],
  annotations: { count: 1, items: [{ id: 'n', label: 'Note', target: 'Delhi' }] },
};

test('projections preserve freshness and remain bounded JSON', () => {
  for (const value of [projectStateResource(state), projectLayersResource(state), projectEntitiesResource(state), projectAnnotationsResource(state)]) {
    assert.equal(value.stateVersion, 7);
    assert.equal(value.partial, true);
    assert.doesNotThrow(() => JSON.stringify(value));
  }
  assert.equal(projectStateResource(state).health.apiKey, undefined);
  assert.equal(projectEntitiesResource(state).count, 1);
});

test('resource provider resolves only supported session resources', () => {
  const provider = createObservationResourceProvider({ getState: (id) => ({ ...state, sessionId: id }) });
  const resource = provider.read('gev://sessions/main/layers');
  assert.equal(resource.mimeType, 'application/json');
  assert.equal(JSON.parse(resource.text).layers[0].id, 'x');
  assert.equal(provider.read('gev://sessions/main/unknown'), null);
});
