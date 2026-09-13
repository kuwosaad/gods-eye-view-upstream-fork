import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentObservationReader } from './observations.js';

test('observation reader returns bounded serializable state', () => {
  const viewer = { camera: { positionCartographic: { latitude: 1, longitude: 2, height: 30 }, heading: 3 }, scene: { requestRenderMode: true }, selectedEntity: { id: 'sel', name: 'Selected' }, trackedEntity: { id: 'trk' } };
  const dataManager = { getAll: () => [{ id: 'flights', name: 'Flights', enabled: true, lifecycleState: 'enabled', stats: { count: 4, error: new Error('secret?') } }] };
  const annotations = { count: () => 999, list: () => Array.from({ length: 200 }, (_, i) => ({ id: `a${i}`, label: `x${i}` })) };
  const reader = createAgentObservationReader({ viewer, dataManager, annotations, styleManager: { activeStyle: 'noir', getContextModeState: () => ({ mode: 'flights' }) }, sceneDirector: { getPlaybackStatus: () => ({ running: false }) } });
  const state = reader.getState();
  assert.ok(Math.abs(state.camera.latitude - (180 / Math.PI)) < 1e-9);
  assert.equal(state.layers[0].stats.error, 'secret?');
  assert.equal(state.annotations.items.length, 120);
  assert.equal(state.stateVersion, 1);
  assert.doesNotThrow(() => JSON.stringify(state));
  assert.equal(Object.prototype.hasOwnProperty.call(state, 'viewer'), false);
});

test('hostile or missing managers fail closed', () => {
  const reader = createAgentObservationReader({ viewer: null, dataManager: { getAll: () => { throw new Error('no'); } } });
  const state = reader.getState();
  assert.equal(state.camera, null);
  assert.deepEqual(state.layers, []);
  assert.equal(state.selected.selected, null);
});
