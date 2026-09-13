import test from 'node:test';
import assert from 'node:assert/strict';
import {
  captureCesiumViewport,
  computeCaptureSize,
  estimateDataUrlBytes,
} from './captureView.js';

test('capture size preserves aspect ratio under pixel budget', () => {
  const size = computeCaptureSize(3840, 2160, 1200 * 900);
  assert.ok(size.width * size.height <= 1200 * 900);
  assert.ok(size.width < 3840 && size.height < 2160);
});

test('estimates base64 payload bytes', () => {
  assert.equal(estimateDataUrlBytes('data:image/png;base64,AAAA'), 3);
  assert.equal(estimateDataUrlBytes('data:image/png;base64,AAA='), 2);
});

function environment({
  tilesLoaded = true,
  dataUrl = 'data:image/jpeg;base64,ZmFrZQ==',
} = {}) {
  const source = { width: 800, height: 600 };
  const target = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage() {} }),
    toDataURL: () => dataUrl,
  };
  const documentRef = { hidden: false, createElement: () => target };
  const viewer = { scene: { canvas: source, globe: { tilesLoaded } } };
  return { viewer, documentRef, target };
}

test('returns MCP image content and capture provenance', async () => {
  const env = environment();
  const result = await captureCesiumViewport({
    ...env,
    requireFresh: false,
    timestamp: 123,
  });
  assert.equal(result.type, 'image');
  assert.equal(result.mimeType, 'image/jpeg');
  assert.equal(result.data, 'ZmFrZQ==');
  assert.deepEqual(
    { width: result.width, height: result.height, timestamp: result.timestamp },
    { width: 800, height: 600, timestamp: 123 },
  );
  assert.equal(result.tileSettled, true);
  assert.equal(result.freshFrame, false);
  assert.equal('dataUrl' in result, false);
});

test('rejects captures over encoded byte limit', async () => {
  const env = environment({
    dataUrl: `data:image/jpeg;base64,${'A'.repeat(100)}`,
  });
  assert.equal(
    await captureCesiumViewport({
      ...env,
      requireFresh: false,
      maxEncodedBytes: 10,
    }),
    null,
  );
});

test('requires a fresh visible frame when requested', async () => {
  const env = environment();
  env.documentRef.hidden = true;
  assert.equal(await captureCesiumViewport({ ...env }), null);
});

test('cancellation stops a pending fresh-frame capture', async () => {
  const env = environment();
  const listeners = new Set();
  env.viewer.scene.postRender = {
    addEventListener(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const controller = new AbortController();
  const pending = captureCesiumViewport({
    ...env,
    signal: controller.signal,
    timeoutMs: 1000,
  });
  controller.abort();
  assert.equal(await pending, null);
  assert.equal(listeners.size, 0);
});
