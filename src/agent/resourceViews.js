/**
 * Bounded projections used by MCP resource callbacks.
 *
 * The observation reader is the only live state boundary.  These helpers do
 * not inspect Cesium or managers and therefore cannot accidentally turn a
 * resource read into a dump of entities, DOM nodes, or provider credentials.
 */

export const RESOURCE_LIMITS = Object.freeze({
  layers: 256,
  entities: 64,
  annotations: 120,
  valueDepth: 4,
  valueKeys: 48,
  stringLength: 1000,
});

const SECRET_KEY = /(key|token|secret|password|authorization|credential|cookie)/i;

function safeValue(value, depth = 0, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return typeof value === 'string' ? value.slice(0, RESOURCE_LIMITS.stringLength) : value;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (depth >= RESOURCE_LIMITS.valueDepth || typeof value !== 'object' || seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, RESOURCE_LIMITS.valueKeys)
      .map((item) => safeValue(item, depth + 1, seen)).filter((item) => item !== undefined);
  }
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, RESOURCE_LIMITS.valueKeys)) {
    if (SECRET_KEY.test(key)) continue;
    const clean = safeValue(item, depth + 1, seen);
    if (clean !== undefined) result[key.slice(0, 100)] = clean;
  }
  return result;
}

function meta(state, extra = {}) {
  return {
    stateVersion: Number.isFinite(state?.stateVersion) ? state.stateVersion : null,
    observedAt: typeof state?.observedAt === 'string' ? state.observedAt : null,
    stale: state?.stale === true || state?.health?.stale === true,
    partial: state?.partial === true || state?.health?.partial === true,
    ...extra,
  };
}

function entity(value, source) {
  if (!value || typeof value !== 'object') return null;
  return {
    id: typeof value.id === 'string' ? value.id.slice(0, 160) : null,
    name: typeof value.name === 'string' ? value.name.slice(0, 240) : null,
    layerId: typeof value.layerId === 'string' ? value.layerId.slice(0, 120) : null,
    source,
  };
}

export function projectStateResource(state) {
  return {
    ...meta(state),
    camera: safeValue(state?.camera) ?? null,
    active: safeValue(state?.active) ?? null,
    selected: safeValue(state?.selected) ?? null,
    tracking: safeValue(state?.tracking) ?? null,
    scene: safeValue(state?.scene) ?? null,
    health: safeValue(state?.health) ?? null,
  };
}

export function projectLayersResource(state) {
  const layers = Array.isArray(state?.layers) ? state.layers : [];
  return {
    ...meta(state, { truncated: layers.length > RESOURCE_LIMITS.layers }),
    count: layers.length,
    layers: layers.slice(0, RESOURCE_LIMITS.layers).map((layer) => ({
      id: typeof layer?.id === 'string' ? layer.id.slice(0, 120) : null,
      name: typeof layer?.name === 'string' ? layer.name.slice(0, 180) : null,
      enabled: layer?.enabled === true,
      lifecycleState: typeof layer?.lifecycleState === 'string' ? layer.lifecycleState : 'unknown',
      uncertain: layer?.uncertain === true,
      stats: safeValue(layer?.stats) ?? null,
    })),
  };
}

export function projectEntitiesResource(state) {
  const candidates = [
    entity(state?.selected?.selected, 'selected'),
    entity(state?.selected?.tracked, 'tracked'),
    entity(state?.selected?.cockpitSubject, 'cockpit'),
  ].filter(Boolean);
  const entities = candidates.filter((item, index, all) => all.findIndex((other) => other.id && other.id === item.id) === index);
  return {
    ...meta(state, { complete: false }),
    count: entities.length,
    entities: entities.slice(0, RESOURCE_LIMITS.entities),
    unavailableReason: 'The observation contract exposes active context only; it intentionally omits unbounded in-view entity collections.',
  };
}

export function projectAnnotationsResource(state) {
  const annotations = Array.isArray(state?.annotations?.items) ? state.annotations.items : [];
  return {
    ...meta(state, { truncated: annotations.length > RESOURCE_LIMITS.annotations }),
    count: Number.isFinite(state?.annotations?.count) ? state.annotations.count : annotations.length,
    annotations: annotations.slice(0, RESOURCE_LIMITS.annotations).map((item) => ({
      id: typeof item?.id === 'string' ? item.id.slice(0, 120) : null,
      label: typeof item?.label === 'string' ? item.label.slice(0, 240) : null,
      target: typeof item?.target === 'string' ? item.target.slice(0, 240) : null,
      kind: typeof item?.kind === 'string' ? item.kind.slice(0, 60) : null,
      color: typeof item?.color === 'string' ? item.color.slice(0, 40) : null,
      status: typeof item?.status === 'string' ? item.status.slice(0, 40) : null,
    })),
  };
}

export function createObservationResourceProvider({ getState } = {}) {
  if (typeof getState !== 'function') throw new TypeError('getState must be a function');
  const read = (uri) => {
    const match = /^gev:\/\/sessions\/([^/]+)\/(state|layers|entities|annotations)$/.exec(String(uri));
    if (!match) return null;
    const state = getState(match[1]);
    const projection = {
      state: projectStateResource,
      layers: projectLayersResource,
      entities: projectEntitiesResource,
      annotations: projectAnnotationsResource,
    }[match[2]](state);
    return { uri: String(uri), mimeType: 'application/json', text: JSON.stringify(projection) };
  };
  return Object.freeze({ read });
}
