import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAgentCommandDispatcher,
  normaliseRequest,
} from './commandDispatcher.js';

test('validates request envelopes and returns structured errors', async () => {
  assert.throws(
    () => normaliseRequest({}),
    (cause) => cause.message === 'Request id is required',
  );
  const bridge = createAgentCommandDispatcher({
    actionRunner: async () => null,
  });
  const response = await bridge.dispatch({
    id: '1',
    sessionId: 's',
    tool: 'x',
    arguments: [],
  });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'INVALID_REQUEST');
});

test('serializes mutations within a session while reads run concurrently', async () => {
  const started = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const bridge = createAgentCommandDispatcher({
    actionRunner: async (tool) => {
      started.push(tool);
      if (tool === 'first') await gate;
      return tool;
    },
    readTools: ['observe'],
  });
  const first = bridge.dispatch({ id: '1', sessionId: 's', tool: 'first' });
  const second = bridge.dispatch({ id: '2', sessionId: 's', tool: 'second' });
  const read = bridge.dispatch({ id: '3', sessionId: 's', tool: 'observe' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(started.includes('first'), true);
  assert.equal(started.includes('observe'), true);
  assert.equal(started.includes('second'), false);
  release();
  await Promise.all([first, second, read]);
  assert.equal(started.at(-1), 'second');
  assert.equal(bridge.pendingSessions, 0);
});

test('supports state and health hooks, abort, and destroy', async () => {
  const bridge = createAgentCommandDispatcher({
    actionRunner: async () => 'ran',
    getState: (sessionId) => ({ sessionId }),
    getHealth: () => ({ healthy: true }),
  });
  assert.deepEqual(
    (await bridge.dispatch({ id: 's', sessionId: 'one', tool: 'get_state' }))
      .result,
    { sessionId: 'one' },
  );
  assert.deepEqual(
    (await bridge.dispatch({ id: 'h', sessionId: 'one', tool: 'get_health' }))
      .result,
    { healthy: true },
  );
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    (
      await bridge.dispatch(
        { id: 'a', sessionId: 'one', tool: 'anything' },
        { signal: controller.signal },
      )
    ).error.code,
    'ABORTED',
  );
  bridge.destroy();
  assert.equal(bridge.isDestroyed(), true);
  assert.equal(
    (await bridge.dispatch({ id: 'd', sessionId: 'one', tool: 'anything' }))
      .error.code,
    'DESTROYED',
  );
});

test('handles viewport capture as a read-only browser command', async () => {
  const source = { width: 10, height: 10 };
  const target = {
    getContext: () => ({ drawImage() {} }),
    toDataURL: () => 'data:image/png;base64,AAAA',
  };
  const bridge = createAgentCommandDispatcher({
    actionRunner: async () => {
      throw new Error('should not run');
    },
    getState: () => ({
      camera: { latitude: 1 },
      active: {
        mapStack: 'satellite',
        style: 'noir',
        context: { mode: 'flights' },
      },
      layers: [
        { id: 'aircraft', enabled: true },
        { id: 'fires', enabled: false },
      ],
    }),
    getHealth: () => ({ providers: { aircraft: 'available' } }),
    capture: {
      source,
      documentRef: { createElement: () => target },
      format: 'png',
      requireFresh: false,
    },
  });
  const result = await bridge.dispatch({
    id: 'v',
    sessionId: 's',
    tool: 'gev_capture_view',
  });
  assert.equal(result.ok, true);
  assert.equal(result.result.type, 'image');
  assert.deepEqual(result.result.metadata, {
    camera: { latitude: 1 },
    active: {
      mapStack: 'satellite',
      style: 'noir',
      context: { mode: 'flights' },
    },
    enabledLayerIds: ['aircraft'],
    timestamp: result.result.timestamp,
    health: { providers: { aircraft: 'available' } },
    dimensions: { width: 10, height: 10 },
    freshFrame: false,
    tileSettled: null,
  });
  assert.equal('data' in result.result.metadata, false);
});

test('capture forwards the requested output format', async () => {
  let mimeType;
  const target = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage() {} }),
    toDataURL(type) {
      mimeType = type;
      return `data:${type};base64,aW1hZ2U=`;
    },
  };
  const dispatcher = createAgentCommandDispatcher({
    actionRunner: async () => null,
    capture: {
      source: { width: 2, height: 1 },
      documentRef: { hidden: false, createElement: () => target },
      requireFresh: false,
    },
  });
  const result = await dispatcher.dispatch({
    id: 'capture-format',
    sessionId: 'main',
    tool: 'gev_capture_view',
    arguments: { format: 'webp' },
  });
  assert.equal(result.ok, true);
  assert.equal(mimeType, 'image/webp');
});

test('canonical read-only tools do not enter the mutation queue by default', async () => {
  let active = 0;
  let maxActive = 0;
  const dispatcher = createAgentCommandDispatcher({
    actionRunner: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return null;
    },
  });
  await Promise.all([
    dispatcher.dispatch({ id: 'a', sessionId: 'main', tool: 'analyst_query', arguments: {} }),
    dispatcher.dispatch({ id: 'b', sessionId: 'main', tool: 'next_iss_pass', arguments: {} }),
  ]);
  assert.equal(maxActive, 2);
});

test('honours explicit mutation classification and bounds queued work', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const started = [];
  const bridge = createAgentCommandDispatcher({
    actionRunner: async (tool) => {
      started.push(tool);
      if (tool === 'first') await gate;
      return tool;
    },
    maxQueuedMutations: 2,
  });
  const first = bridge.dispatch({
    id: '1',
    sessionId: 's',
    tool: 'first',
    mutation: true,
  });
  const second = bridge.dispatch({
    id: '2',
    sessionId: 's',
    tool: 'second',
    mutation: true,
  });
  const full = await bridge.dispatch({
    id: '3',
    sessionId: 's',
    tool: 'third',
    mutation: true,
  });
  assert.equal(full.error.code, 'QUEUE_FULL');
  const read = bridge.dispatch({
    id: '4',
    sessionId: 's',
    tool: 'observe',
    mutation: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(started.includes('observe'), true);
  release();
  await Promise.all([first, second, read]);
  assert.equal(bridge.pendingSessions, 0);
});
