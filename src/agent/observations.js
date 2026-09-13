import { getRenderGovernorDiagnostics } from '../renderGovernor.js';

// Observations are deliberately a small, boring data contract.  Keep this
// module independent of Cesium and the UI so it can also be used by tests and
// by the browser bridge during application startup.
export const MAX_OBSERVATION_ANNOTATIONS = 120;
export const MAX_OBSERVATION_LAYERS = 256;

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value, max = 240) {
  return typeof value === 'string' ? value.slice(0, max) : null;
}

function safeCall(fn, fallback = null) {
  try { return typeof fn === 'function' ? fn() : fallback; } catch { return fallback; }
}

function cameraState(viewer) {
  const camera = viewer?.camera;
  if (!camera) return null;
  const carto = camera.positionCartographic || safeCall(camera.getPositionCartographic);
  let lat = finite(carto?.latitude);
  let lon = finite(carto?.longitude);
  if (lat !== null && lon !== null) {
    lat = finite((lat * 180) / Math.PI);
    lon = finite((lon * 180) / Math.PI);
  }
  return {
    latitude: lat,
    longitude: lon,
    heightM: finite(carto?.height),
    heading: finite(camera.heading),
    pitch: finite(camera.pitch),
    roll: finite(camera.roll),
  };
}

function selectedState(viewer, styleManager) {
  const entity = viewer?.selectedEntity;
  const tracked = viewer?.trackedEntity;
  const cockpit = safeCall(styleManager?.getCockpitState?.bind(styleManager));
  const subject = cockpit?.subject;
  const item = (value) => value ? {
    id: text(value.id ?? value.entityId),
    name: text(value.name),
    layerId: text(value.layerId),
  } : null;
  return { selected: item(entity), tracked: item(tracked), cockpitSubject: item(subject) };
}

function layerStates(dataManager) {
  let layers = safeCall(dataManager?.getAll?.bind(dataManager), []);
  if (!Array.isArray(layers) && dataManager?.layers instanceof Map) {
    layers = [...dataManager.layers].map(([id, entry]) => ({
      id, name: entry?.module?.name, enabled: entry?.enabled,
      lifecycleState: entry?.lifecycleState, lifecycleUncertain: entry?.lifecycleUncertain,
      stats: safeCall(entry?.module?.getStats?.bind(entry?.module), null),
    }));
  }
  return (Array.isArray(layers) ? layers : []).slice(0, MAX_OBSERVATION_LAYERS).map((layer) => {
    const stats = layer?.stats && typeof layer.stats === 'object' ? layer.stats : {};
    return {
      id: text(layer?.id, 120), name: text(layer?.name, 160),
      enabled: Boolean(layer?.enabled),
      lifecycleState: text(layer?.lifecycleState, 40) || 'unknown',
      uncertain: Boolean(layer?.lifecycleUncertain ?? layer?.uncertain),
      stats: {
        count: finite(stats.count) ?? 0,
        lastUpdate: finite(stats.lastUpdate) ?? text(stats.lastUpdate, 80),
        loading: Boolean(stats.loading), refreshing: Boolean(stats.refreshing),
        error: text(stats.error?.message ?? stats.error ?? stats.lastError),
      },
    };
  });
}

function annotationStates(annotations) {
  const list = safeCall(annotations?.list?.bind(annotations), []);
  return (Array.isArray(list) ? list : []).slice(0, MAX_OBSERVATION_ANNOTATIONS).map((annotation) => ({
    id: text(annotation?.id, 120), label: text(annotation?.label, 200),
    target: text(annotation?.target, 200), kind: text(annotation?.kind, 60),
    color: text(annotation?.color, 40), status: text(annotation?.status, 40),
  }));
}

function health(viewer) {
  const scene = viewer?.scene;
  const tileLoadState = scene?.globe?.tileLoadProgressEvent ? 'available' : 'unknown';
  return {
    renderGovernor: safeCall(getRenderGovernorDiagnostics, null),
    tiles: { available: tileLoadState !== 'unknown', loadState: tileLoadState },
    scene: { available: Boolean(scene), rendering: Boolean(scene?.render), requestRenderMode: scene?.requestRenderMode ?? null },
  };
}

export function createAgentObservationReader({ viewer, styleManager, dataManager, sceneDirector = null, annotations = null } = {}) {
  let stateVersion = 0;
  const getState = () => {
    const controls = safeCall(styleManager?.getControlState?.bind(styleManager));
    const context = safeCall(styleManager?.getContextModeState?.bind(styleManager));
    const scenePlayback = safeCall(sceneDirector?.getPlaybackStatus?.bind(sceneDirector));
    const selected = selectedState(viewer, styleManager);
    const mapStack = controls?.mapStack
      ?? safeCall(styleManager?.mapStackController?.getActiveId?.bind(styleManager?.mapStackController));
    return {
      stateVersion: ++stateVersion,
      observedAt: new Date().toISOString(),
      camera: cameraState(viewer),
      active: { mapStack: text(mapStack, 80), style: text(controls?.style ?? styleManager?.activeStyle, 80), context: context || null },
      controls: controls || null,
      layers: layerStates(dataManager),
      selected,
      tracking: selected.tracked || selected.cockpitSubject || null,
      scene: scenePlayback || null,
      annotations: { count: safeCall(annotations?.count?.bind(annotations), 0) || 0, items: annotationStates(annotations) },
      health: health(viewer),
    };
  };
  return Object.freeze({ getState, getHealth: () => health(viewer) });
}
