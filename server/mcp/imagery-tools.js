import { readdir, mkdir, readFile, unlink } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const OUTPUT_DIR = 'output/agent';
const ARTIFACT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

const number = (value, min, max, name) => {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw new TypeError(`${name} must be between ${min} and ${max}`);
  return value;
};
const integer = (value, min, max, name) => {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new TypeError(`${name} must be an integer between ${min} and ${max}`);
  return value;
};
const artifact = (value) => {
  if (
    typeof value !== 'string' ||
    !ARTIFACT_RE.test(value) ||
    value.includes('..')
  )
    throw new TypeError('artifactId must be a safe artifact name');
  return value;
};
const arg = (flag, value) => [flag, String(value)];

const common = {
  latitude: { type: 'number', minimum: -90, maximum: 90 },
  longitude: { type: 'number', minimum: -180, maximum: 180 },
};

/** Fixed, non-shell operation definitions for the derived imagery tools. */
export const IMAGERY_OPERATIONS = Object.freeze({
  satellite_ortho: Object.freeze({
    description: 'Create a bounded satellite orthophoto around a coordinate.',
    script: 'tools/sat-ortho.mjs',
    timeoutMs: 90_000,
    maxConcurrency: 1,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        lat: common.latitude,
        lon: common.longitude,
        zoom: { type: 'integer', minimum: 1, maximum: 22 },
        size: { type: 'integer', minimum: 256, maximum: 2048 },
      },
      required: ['lat', 'lon'],
    },
  }),
  streetview_panorama: Object.freeze({
    description: 'Fetch a bounded Street View panorama around a coordinate.',
    script: 'tools/streetview-panorama.mjs',
    timeoutMs: 120_000,
    maxConcurrency: 1,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        lat: common.latitude,
        lon: common.longitude,
        zoom: { type: 'integer', minimum: 0, maximum: 5 },
        radius: { type: 'integer', minimum: 1, maximum: 200 },
      },
      required: ['lat', 'lon'],
    },
  }),
  streetview_headings: Object.freeze({
    description:
      'Fetch bounded Street View heading images around a coordinate.',
    script: 'tools/streetview-headings.mjs',
    timeoutMs: 120_000,
    maxConcurrency: 1,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        lat: common.latitude,
        lon: common.longitude,
        fov: { type: 'integer', minimum: 30, maximum: 120 },
        pitch: { type: 'integer', minimum: -90, maximum: 90 },
        step: { type: 'integer', minimum: 1, maximum: 180 },
        neighbors: { type: 'boolean' },
      },
      required: ['lat', 'lon'],
    },
  }),
  pano_pinhole: Object.freeze({
    description: 'Project a previously generated panorama into a bounded view.',
    script: 'tools/pano-pinhole.mjs',
    timeoutMs: 60_000,
    maxConcurrency: 1,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        artifactId: { type: 'string', pattern: ARTIFACT_RE.source },
        heading: { type: 'number', minimum: -360, maximum: 360 },
        pitch: { type: 'number', minimum: -90, maximum: 90 },
        roll: { type: 'number', minimum: -180, maximum: 180 },
        hfov: { type: 'number', minimum: 20, maximum: 150 },
        width: { type: 'integer', minimum: 256, maximum: 2048 },
        height: { type: 'integer', minimum: 144, maximum: 2048 },
      },
      required: ['artifactId'],
    },
  }),
  cesium_render: Object.freeze({
    description: 'Render a bounded Cesium view around a coordinate.',
    script: 'tools/cesium-render.mjs',
    timeoutMs: 120_000,
    maxConcurrency: 1,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        lat: common.latitude,
        lon: common.longitude,
        heading: { type: 'number', minimum: -360, maximum: 360 },
        pitch: { type: 'number', minimum: -90, maximum: 30 },
        height: { type: 'number', minimum: 1, maximum: 10000 },
        fov: { type: 'number', minimum: 20, maximum: 120 },
        width: { type: 'integer', minimum: 256, maximum: 2048 },
        heightPx: { type: 'integer', minimum: 144, maximum: 2048 },
        sse: { type: 'number', minimum: 0.5, maximum: 32 },
        timeout: { type: 'integer', minimum: 5, maximum: 90 },
      },
      required: ['lat', 'lon'],
    },
  }),
});

function addCoordinate(args, input) {
  args.push(
    ...arg('--lat', number(input.lat, -90, 90, 'lat')),
    ...arg('--lon', number(input.lon, -180, 180, 'lon')),
  );
}

/** Build an argv array. No user supplied path, URL, key, or shell fragment is accepted. */
export function buildImageryCommand(
  name,
  input = {},
  { projectRoot = ROOT, inputPath } = {},
) {
  const operation = IMAGERY_OPERATIONS[name];
  if (!operation) throw new RangeError(`Unknown imagery operation: ${name}`);
  const value =
    input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const args = [resolve(projectRoot, operation.script)];
  if (name === 'pano_pinhole') {
    // inputPath is an internal, trusted resolver result. Public callers can
    // only provide an opaque artifact ID, which remains strictly validated.
    const resolvedInput =
      inputPath === undefined
        ? resolve(projectRoot, OUTPUT_DIR, artifact(value.artifactId))
        : inputPath;
    if (typeof resolvedInput !== 'string' || !resolvedInput)
      throw new TypeError('resolved artifact input is invalid');
    args.push(...arg('--input', resolvedInput));
    if (value.heading !== undefined)
      args.push(
        ...arg('--heading', number(value.heading, -360, 360, 'heading')),
      );
    if (value.pitch !== undefined)
      args.push(...arg('--pitch', number(value.pitch, -90, 90, 'pitch')));
    if (value.roll !== undefined)
      args.push(...arg('--roll', number(value.roll, -180, 180, 'roll')));
    if (value.hfov !== undefined)
      args.push(...arg('--hfov', number(value.hfov, 20, 150, 'hfov')));
    if (value.width !== undefined)
      args.push(...arg('--width', integer(value.width, 256, 2048, 'width')));
    if (value.height !== undefined)
      args.push(...arg('--height', integer(value.height, 144, 2048, 'height')));
  } else {
    addCoordinate(args, value);
    const bounded = {
      satellite_ortho: [
        ['zoom', 1, 22],
        ['size', 256, 2048],
      ],
      streetview_panorama: [
        ['zoom', 0, 5],
        ['radius', 1, 200],
      ],
      streetview_headings: [
        ['fov', 30, 120],
        ['pitch', -90, 90],
        ['step', 1, 180],
      ],
      cesium_render: [
        ['heading', -360, 360],
        ['pitch', -90, 30],
        ['height', 1, 10000],
        ['fov', 20, 120],
        ['width', 256, 2048],
        ['heightPx', 144, 2048],
        ['sse', 0.5, 32],
        ['timeout', 5, 90],
      ],
    }[name];
    for (const [key, min, max] of bounded || [])
      if (value[key] !== undefined)
        args.push(
          ...arg(
            `--${key === 'heightPx' ? 'height-px' : key}`,
            Number.isInteger(min)
              ? integer(value[key], min, max, key)
              : number(value[key], min, max, key),
          ),
        );
    if (name === 'streetview_headings' && value.neighbors === true)
      args.push('--neighbors');
  }
  args.push('--outdir', resolve(projectRoot, OUTPUT_DIR));
  return Object.freeze({
    command: process.execPath,
    args: Object.freeze(args),
    timeoutMs: operation.timeoutMs,
    maxConcurrency: operation.maxConcurrency,
  });
}

const CREDENTIALLED_OPERATIONS = new Set([
  'satellite_ortho',
  'streetview_panorama',
  'streetview_headings',
  'cesium_render',
]);
const running = new Map();

/** Execute a fixed operation and register only files created in its private output directory. */
export async function runImageryOperation(
  name,
  input = {},
  {
    projectRoot = ROOT,
    spawn = nodeSpawn,
    registerOutput = () => {},
    resolveArtifactInput,
    signal,
    credentials = {},
  } = {},
) {
  const hasInjectedCredential = Object.prototype.hasOwnProperty.call(
    credentials,
    'googleMapsApiKey',
  );
  const googleMapsApiKey = hasInjectedCredential
    ? credentials.googleMapsApiKey
    : process.env.GOOGLE_MAPS_API_KEY;
  if (
    CREDENTIALLED_OPERATIONS.has(name) &&
    (typeof googleMapsApiKey !== 'string' || !googleMapsApiKey.trim())
  ) {
    const cause = new Error(
      `${name} requires a configured provider credential`,
    );
    cause.code = 'CAPABILITY_UNAVAILABLE';
    throw cause;
  }
  const operation = IMAGERY_OPERATIONS[name];
  if (!operation) throw new RangeError(`Unknown imagery operation: ${name}`);
  if (signal?.aborted) {
    const cause = new Error('Imagery operation was aborted');
    cause.code = 'ABORTED';
    throw cause;
  }
  const outputDir = resolve(projectRoot, OUTPUT_DIR);
  await mkdir(outputDir, { recursive: true });
  const before = new Set(await readdir(outputDir));
  let inputPath;
  if (name === 'pano_pinhole' && typeof resolveArtifactInput === 'function') {
    const resolved = await resolveArtifactInput(artifact(input?.artifactId));
    inputPath = typeof resolved === 'string' ? resolved : resolved?.path;
    if (typeof inputPath !== 'string' || !inputPath) {
      throw new TypeError('resolved artifact input is invalid');
    }
  }
  const command = buildImageryCommand(name, input, { projectRoot, inputPath });
  const queueKey = 'global';
  const previous = running.get(queueKey) || Promise.resolve();
  let release;
  const turn = new Promise((resolveTurn) => {
    release = resolveTurn;
  });
  const chain = previous.then(() => turn);
  running.set(queueKey, chain);
  await previous;
  try {
    const result = await new Promise((resolveResult, reject) => {
      const child = spawn(command.command, command.args, {
        cwd: projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(CREDENTIALLED_OPERATIONS.has(name)
          ? {
              env: {
                PATH: process.env.PATH || '',
                GOOGLE_MAPS_API_KEY: googleMapsApiKey,
              },
            }
          : {}),
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (fn, value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          fn(value);
        }
      };
      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk).slice(0, 32768 - stdout.length);
      });
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk).slice(0, 32768 - stderr.length);
      });
      const timer = setTimeout(() => {
        child.kill?.('SIGTERM');
        const cause = new Error(`Imagery operation '${name}' timed out`);
        cause.code = 'TIMEOUT';
        finish(reject, cause);
      }, operation.timeoutMs);
      const abort = () => {
        child.kill?.('SIGTERM');
        const cause = new Error('Imagery operation was aborted');
        cause.code = 'ABORTED';
        finish(reject, cause);
      };
      signal?.addEventListener?.('abort', abort, { once: true });
      child.once('error', (cause) => finish(reject, cause));
      child.once('close', (code) => {
        signal?.removeEventListener?.('abort', abort);
        if (code !== 0) {
          const cause = new Error(
            stderr.trim().slice(0, 512) || `Imagery operation failed (${code})`,
          );
          cause.code = 'EXECUTION_FAILED';
          finish(reject, cause);
          return;
        }
        finish(resolveResult, { stdout, stderr });
      });
    });
    const files = (await readdir(outputDir)).filter(
      (file) => !before.has(file),
    );
    const outputs = files
      .map((file) => resolve(outputDir, file))
      .filter((file) => {
        const rel = relative(outputDir, file);
        return (
          rel &&
          !rel.startsWith('..') &&
          !rel.includes('/') &&
          /\.(?:jpg|jpeg|png|webp)$/i.test(rel)
        );
      });
    const registered = [];
    try {
      for (const file of outputs) {
        const data = await readFile(file);
        const descriptor = await registerOutput({
          operation: name,
          path: file,
          bytes: data.byteLength,
          data,
        });
        // Registration is the public boundary. Keep only the descriptor it
        // returns and prevent accidental leakage of local paths or process IO.
        if (descriptor && typeof descriptor === 'object') {
          const {
            path: _path,
            filesystemPath: _filesystemPath,
            stdout: _stdout,
            stderr: _stderr,
            data: _data,
            ...publicDescriptor
          } = descriptor;
          registered.push(Object.freeze(publicDescriptor));
        } else if (descriptor !== undefined) {
          registered.push(descriptor);
        }
      }
    } finally {
      await Promise.all(
        outputs.map((file) => unlink(file).catch(() => undefined)),
      );
    }
    return Object.freeze({
      operation: name,
      outputs: Object.freeze(registered),
    });
  } finally {
    release();
    if (running.get(queueKey) === chain) running.delete(queueKey);
  }
}
