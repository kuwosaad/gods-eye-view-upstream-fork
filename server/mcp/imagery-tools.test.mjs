import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { buildImageryCommand, IMAGERY_OPERATIONS } from './imagery-tools.js';
import { runImageryOperation } from './imagery-tools.js';

test('publishes fixed imagery operations with bounded concurrency and timeouts', () => {
  assert.deepEqual(Object.keys(IMAGERY_OPERATIONS), [
    'satellite_ortho',
    'streetview_panorama',
    'streetview_headings',
    'pano_pinhole',
    'cesium_render',
  ]);
  for (const operation of Object.values(IMAGERY_OPERATIONS)) {
    assert.match(operation.script, /^tools\/[a-z-]+\.mjs$/);
    assert.ok(operation.timeoutMs > 0);
    assert.ok(operation.maxConcurrency >= 1);
  }
});

test('builds argument arrays without accepting credentials or arbitrary paths', () => {
  const command = buildImageryCommand(
    'satellite_ortho',
    {
      lat: 30.2,
      lon: -97.7,
      zoom: 18,
      size: 1024,
    },
    { projectRoot: '/project' },
  );
  assert.equal(command.command, process.execPath);
  assert.deepEqual(command.args.slice(1), [
    '--lat',
    '30.2',
    '--lon',
    '-97.7',
    '--zoom',
    '18',
    '--size',
    '1024',
    '--outdir',
    '/project/output/agent',
  ]);
  assert.equal(
    command.args.some((value) => value === '--key'),
    false,
  );
  assert.equal(
    command.args.some((value) => value.includes('https:')),
    false,
  );

  const pinhole = buildImageryCommand('pano_pinhole', {
    artifactId: 'pano_001',
  });
  assert.equal(pinhole.args.includes('--input'), true);
  assert.equal(
    pinhole.args.some((value) => value.includes('..')),
    false,
  );
  assert.throws(
    () => buildImageryCommand('pano_pinhole', { artifactId: '../secret' }),
    /safe artifact/,
  );
});

test('rejects coordinates and dimensions outside the safe bounds', () => {
  assert.throws(
    () => buildImageryCommand('cesium_render', { lat: 91, lon: 0 }),
    /lat must be/,
  );
  assert.throws(
    () =>
      buildImageryCommand('satellite_ortho', { lat: 0, lon: 0, size: 99999 }),
    /size must be/,
  );
  assert.throws(
    () =>
      buildImageryCommand('streetview_panorama', { lat: 0, lon: 0, zoom: 6 }),
    /zoom must be/,
  );
  assert.throws(
    () => buildImageryCommand('cesium_render', { lat: 0, lon: 0, timeout: 1 }),
    /timeout must be/,
  );
});

test('resolves opaque pano IDs, returns registered descriptors, and cleans generated files', async () => {
  const root = resolve(new URL('../..', import.meta.url).pathname);
  const dir = resolve(root, 'output/agent');
  await mkdir(dir, { recursive: true });
  const input = resolve(dir, 'fixture-agent-pano.jpg');
  await sharp({
    create: {
      width: 8,
      height: 4,
      channels: 3,
      background: { r: 20, g: 80, b: 140 },
    },
  })
    .jpeg()
    .toFile(input);
  const registered = [];
  try {
    const result = await runImageryOperation(
      'pano_pinhole',
      {
        artifactId: 'opaque-pano-id',
        width: 256,
        height: 144,
      },
      {
        projectRoot: root,
        resolveArtifactInput: async (id) => {
          assert.equal(id, 'opaque-pano-id');
          return { path: input };
        },
        registerOutput: async (value) => {
          registered.push(value);
          return {
            id: 'registered-output-id',
            mimeType: 'image/jpeg',
            size: value.bytes,
            path: value.path,
          };
        },
      },
    );
    assert.equal(result.outputs.length, 1);
    assert.equal(registered.length, 1);
    assert.match(registered[0].path, /pinhole_fixture-agent-pano/);
    assert.ok(registered[0].bytes > 0);
    assert.deepEqual(result.outputs[0], {
      id: 'registered-output-id',
      mimeType: 'image/jpeg',
      size: registered[0].bytes,
    });
    assert.equal('stdout' in result, false);
    assert.equal('path' in result.outputs[0], false);
    await assert.rejects(
      import('node:fs/promises').then(({ stat }) => stat(registered[0].path)),
      /ENOENT/,
    );
  } finally {
    await rm(input, { force: true });
  }
});

test('keeps the fixed argv and shell boundary when resolving a pano artifact', async () => {
  const projectRoot = resolve(new URL('../..', import.meta.url).pathname);
  const seen = [];
  const child = {
    stdout: { on() {} },
    stderr: { on() {} },
    once(event, listener) {
      if (event === 'close') setImmediate(() => listener(1));
    },
    kill() {},
  };
  await assert.rejects(
    runImageryOperation(
      'pano_pinhole',
      { artifactId: 'opaque-id' },
      {
        projectRoot,
        resolveArtifactInput: () => '/artifact-store/opaque-id.artifact',
        spawn(command, args, options) {
          seen.push({ command, args, options });
          return child;
        },
      },
    ),
    (error) => error.code === 'EXECUTION_FAILED',
  );
  assert.equal(seen[0].options.shell, undefined);
  assert.equal(
    seen[0].args.includes('/artifact-store/opaque-id.artifact'),
    true,
  );
  assert.equal(seen[0].args.includes('opaque-id'), false);
});

test('returns explicit capability errors for credentialed providers', async () => {
  await assert.rejects(
    runImageryOperation(
      'satellite_ortho',
      { lat: 0, lon: 0 },
      { credentials: {} },
    ),
    (error) => error.code === 'CAPABILITY_UNAVAILABLE',
  );
});

test('passes configured credentials through the child environment only', async () => {
  let spawnOptions;
  const child = {
    stdout: { on() {} },
    stderr: { on() {} },
    once(event, listener) {
      if (event === 'close') setImmediate(() => listener(1));
    },
    kill() {},
  };
  await assert.rejects(
    runImageryOperation(
      'satellite_ortho',
      { lat: 0, lon: 0 },
      {
        credentials: { googleMapsApiKey: 'test-key' },
        spawn(command, args, options) {
          spawnOptions = { command, args, options };
          return child;
        },
      },
    ),
    (error) => error.code === 'EXECUTION_FAILED',
  );
  assert.equal(spawnOptions.options.env.GOOGLE_MAPS_API_KEY, 'test-key');
  assert.equal(spawnOptions.args.includes('test-key'), false);
  assert.deepEqual(Object.keys(spawnOptions.options.env).sort(), [
    'GOOGLE_MAPS_API_KEY',
    'PATH',
  ]);
});
