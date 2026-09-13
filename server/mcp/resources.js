import {
  projectAnnotationsResource,
  projectEntitiesResource,
  projectLayersResource,
  projectStateResource,
} from '../../src/agent/resourceViews.js';

const URI_RE = /^gev:\/\/sessions\/([^/]+)\/(state|layers|entities|annotations)$/;
const ARTIFACT_RE = /^gev:\/\/sessions\/([^/]+)\/artifacts\/([^/]+)$/;

function session(uri, expression) {
  const match = expression.exec(String(uri));
  if (!match) return null;
  try { return { id: decodeURIComponent(match[1]), kind: match[2] }; } catch { return null; }
}

function principalId(value) {
  if (value && typeof value === 'object') return value.principalId ?? 'anonymous';
  return value ?? 'anonymous';
}

function safeJson(value) {
  try { return JSON.stringify(value); } catch { return JSON.stringify({ error: 'RESOURCE_PROJECTION_FAILED' }); }
}

/**
 * Server side adapter for the four live observation resources.  It accepts a
 * session id and principal instead of a Session object, keeping ACL decisions
 * in the injected state/artifact callbacks.
 */
export function createMcpResourceAdapter({
  getState,
  getArtifact = null,
  onMutation = null,
  maxCacheEntries = 128,
} = {}) {
  if (typeof getState !== 'function') throw new TypeError('getState must be a function');
  if (!Number.isInteger(maxCacheEntries) || maxCacheEntries < 1) throw new RangeError('maxCacheEntries must be positive');
  const cache = new Map();

  const cachedState = async (sessionId, principal) => {
    const value = await getState(sessionId, { principalId: principal });
    const version = Number.isFinite(value?.stateVersion) ? value.stateVersion : null;
    const key = `${sessionId}\u0000${String(principal ?? '')}`;
    const prior = cache.get(key);
    // Without a version the reader cannot prove that a cached value is fresh.
    if (version !== null && prior && prior.version === version) {
      cache.delete(key); cache.set(key, prior);
      return prior.value;
    }
    if (version === null) return value;
    cache.delete(key); cache.set(key, { version, value });
    while (cache.size > maxCacheEntries) cache.delete(cache.keys().next().value);
    return value;
  };

  const project = async (kind, sessionId, principal) => {
    const state = await cachedState(sessionId, principal);
    try {
      return ({ state: projectStateResource, layers: projectLayersResource,
        entities: projectEntitiesResource, annotations: projectAnnotationsResource })[kind](state);
    } catch {
      return { error: 'RESOURCE_PROJECTION_FAILED' };
    }
  };

  const readResource = async (uri, principal = 'anonymous') => {
    principal = principalId(principal);
    const target = session(uri, URI_RE);
    if (target) return { uri: String(uri), mimeType: 'application/json', text: safeJson(await project(target.kind, target.id, principal)) };
    const artifactMatch = ARTIFACT_RE.exec(String(uri));
    let artifact = null;
    if (artifactMatch) {
      try { artifact = { sessionId: decodeURIComponent(artifactMatch[1]), artifactId: decodeURIComponent(artifactMatch[2]) }; } catch { artifact = null; }
    }
    if (!artifact || typeof getArtifact !== 'function') return null;
    const result = await getArtifact(artifact.sessionId, artifact.artifactId, principal);
    if (result == null) return null;
    if (result && typeof result === 'object' && typeof result.text === 'string') return { uri: String(uri), ...result };
    return { uri: String(uri), mimeType: result?.mimeType || 'application/octet-stream', blob: result?.data?.toString?.('base64') || Buffer.from(result).toString('base64') };
  };

  const notifyMutation = async (sessionId, principal = 'anonymous', event = {}) => {
    principal = principalId(principal);
    const keyPrefix = `${sessionId}\u0000`;
    for (const key of cache.keys()) if (key.startsWith(keyPrefix)) cache.delete(key);
    const state = await cachedState(sessionId, principal);
    return onMutation?.({ sessionId, principal, stateVersion: state?.stateVersion ?? null, event });
  };

  const listResourceUris = (sessionId) => ['state', 'layers', 'entities', 'annotations'].map((kind) => `gev://sessions/${encodeURIComponent(sessionId)}/${kind}`);
  const callback = (kind) => (sessionId, options) => project(kind, sessionId, principalId(options));
  const artifact = async (sessionId, artifactId, options) => {
    if (artifactId && typeof artifactId === 'object') {
      options = artifactId;
      artifactId = options.artifactId;
    }
    const principal = principalId(options);
    if (typeof getArtifact !== 'function') return null;
    return getArtifact(sessionId, artifactId, principal);
  };
  return Object.freeze({
    state: callback('state'), layers: callback('layers'), entities: callback('entities'),
    annotations: callback('annotations'), artifacts: artifact,
    readResource, notifyMutation, listResourceUris,
    clearCache: () => cache.clear(), get cacheSize() { return cache.size; },
  });
}
