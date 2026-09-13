import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IMAGERY_OPERATIONS, runImageryOperation } from './imagery-tools.js';

const MIME_BY_EXTENSION = Object.freeze({
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
});

function imageMime(path) {
  const extension = String(path).split('.').pop()?.toLowerCase();
  return MIME_BY_EXTENSION[extension] || 'application/octet-stream';
}

/** Build the fixed, artifact-backed imagery tools exposed by the one MCP server. */
export function createImageryServerTools({
  registry,
  artifactStore,
  projectRoot,
  credentials = {},
  run = runImageryOperation,
} = {}) {
  if (!registry || typeof registry.get !== 'function')
    throw new TypeError('registry is required');
  if (!artifactStore || typeof artifactStore.put !== 'function')
    throw new TypeError('artifactStore is required');

  return Object.entries(IMAGERY_OPERATIONS).map(([operation, definition]) => ({
    name: `gev_${operation}`,
    description: definition.description,
    inputSchema: {
      ...definition.inputSchema,
      properties: {
        sessionId: { type: 'string', minLength: 1, maxLength: 96 },
        ...definition.inputSchema.properties,
      },
      required: ['sessionId', ...(definition.inputSchema.required || [])],
    },
    costClass: 'artifact',
    handler: async (args, { signal, principalId }) => {
      const { sessionId, ...input } = args;
      const session = registry.get(sessionId, principalId);
      const disconnect = new AbortController();
      const onDisconnect = () => disconnect.abort();
      session.connection?.once?.('close', onDisconnect);
      const operationSignal = signal
        ? AbortSignal.any([signal, disconnect.signal])
        : disconnect.signal;
      let temporaryDirectory;
      try {
        const result = await run(operation, input, {
          projectRoot,
          signal: operationSignal,
          credentials,
          resolveArtifactInput:
            operation === 'pano_pinhole'
              ? async (artifactId) => {
                  const source = await artifactStore.get(sessionId, artifactId);
                  if (!source.mimeType?.startsWith('image/')) {
                    const error = new Error('Artifact is not an image');
                    error.code = 'INVALID_ARTIFACT';
                    throw error;
                  }
                  temporaryDirectory = await mkdtemp(
                    join(tmpdir(), 'gev-pinhole-'),
                  );
                  const inputPath = join(temporaryDirectory, 'input.image');
                  await writeFile(inputPath, source.data, { mode: 0o600 });
                  return inputPath;
                }
              : undefined,
          registerOutput: async ({ path, data, bytes }) => {
            const record = await artifactStore.put(sessionId, data, {
              operation,
              mimeType: imageMime(path),
              bytes,
            });
            return {
              id: record.id,
              uri: record.resourceUri,
              mimeType: record.mimeType,
              size: record.size,
            };
          },
        });
        const resourceLinks = await Promise.all(
          result.outputs.map((artifact) =>
            artifactStore.resourceLink(sessionId, artifact.id, {
              name: `${operation}-${artifact.id}`,
              description: definition.description,
            }),
          ),
        );
        return {
          operation,
          artifacts: result.outputs,
          resourceLinks,
        };
      } finally {
        session.connection?.off?.('close', onDisconnect);
        if (temporaryDirectory)
          await rm(temporaryDirectory, { recursive: true, force: true });
      }
    },
  }));
}
