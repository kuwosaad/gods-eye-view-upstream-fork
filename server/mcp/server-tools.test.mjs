import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createImageryServerTools } from './server-tools.js';

test('imagery tools require session access and return only artifact resources', async () => {
  const accesses = [];
  const stored = [];
  const tools = createImageryServerTools({
    registry: {
      get(sessionId, principalId) {
        accesses.push({ sessionId, principalId });
        return { id: sessionId };
      },
    },
    artifactStore: {
      async put(sessionId, data, metadata) {
        stored.push({ sessionId, data, metadata });
        return {
          id: 'opaque-artifact-id-1234',
          resourceUri:
            'gev://sessions/globe/artifacts/opaque-artifact-id-1234',
          mimeType: metadata.mimeType,
          size: data.length,
        };
      },
      async resourceLink(sessionId, artifactId, { name }) {
        return {
          type: 'resource_link',
          name,
          uri: `gev://sessions/${sessionId}/artifacts/${artifactId}`,
          mimeType: 'image/png',
        };
      },
    },
    run: async (operation, input, options) => ({
      operation,
      outputs: [
        await options.registerOutput({
          path: '/private/output.png',
          data: Buffer.from('image'),
          bytes: 5,
        }),
      ],
    }),
  });
  const satellite = tools.find((tool) => tool.name === 'gev_satellite_ortho');
  const result = await satellite.handler(
    { sessionId: 'globe', lat: 1, lon: 2 },
    { principalId: 'agent-a' },
  );

  assert.deepEqual(accesses, [
    { sessionId: 'globe', principalId: 'agent-a' },
  ]);
  assert.equal(stored[0].metadata.mimeType, 'image/png');
  assert.equal(result.artifacts[0].path, undefined);
  assert.equal(result.resourceLinks[0].uri.includes('/private/'), false);
  assert.equal(satellite.inputSchema.required.includes('sessionId'), true);
});

test('browser disconnect aborts an in-flight artifact operation', async () => {
  const connection = new EventEmitter();
  const [satellite] = createImageryServerTools({
    registry: { get: () => ({ id: 'globe', connection }) },
    artifactStore: {
      put() {},
      resourceLink() {},
    },
    run: (_operation, _input, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () =>
            reject(
              Object.assign(new Error('aborted'), { code: 'ABORTED' }),
            ),
          { once: true },
        );
      }),
  });
  const pending = satellite.handler(
    { sessionId: 'globe', lat: 1, lon: 2 },
    { principalId: 'agent-a' },
  );
  connection.emit('close');
  await assert.rejects(pending, { code: 'ABORTED' });
  assert.equal(connection.listenerCount('close'), 0);
});
