import { SceneDirector } from '../scenes/director.js';
import { initAnnotations } from '../annotations/index.js';
import { initGevVoiceCommands } from '../voice/gevRealtime.js';
import { installScopeMask, destroyScopeMask } from '../scopeMask.js';
import {
  installRenderGovernor,
  getRenderGovernorDiagnostics,
  governorRequestRender,
  holdContinuousRender,
  releaseContinuousRender,
} from '../renderGovernor.js';
import { startStandaloneChrome } from './startupChrome.js';
import { createAgentBrowserClient } from '../agent/browserClient.js';
import { createAgentConnectionIndicator } from '../agent/connectionIndicator.js';
import { GEV_AGENT_TOOL_CATALOG } from '../agent/toolCatalog.js';
import { createAgentObservationReader } from '../agent/observations.js';
import {
  DEFAULT_CAPTURE_MAX_ENCODED_BYTES,
  DEFAULT_CAPTURE_MAX_PIXELS,
} from '../agent/captureView.js';

const AGENT_SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;

/** Attach scene tools, rendering listeners and the standalone debug handle. */
export function createStandaloneTools({
  scene,
  controls,
  data,
  loadingScreen,
  placeSearch,
  signal,
  defer,
}) {
  const { viewer, tileset, mapStackController } = scene;
  const { styleManager, weatherEffects, cockpitCloudEffects } = controls;
  const { dataManager } = data;
  const sceneDirector = new SceneDirector(viewer, styleManager, dataManager);
  defer(() => sceneDirector.destroy());
  const annotations = initAnnotations({ viewer, tileset, placeSearch });
  defer(() => {
    if (window.__gevAnnotations === annotations) delete window.__gevAnnotations;
    annotations.destroy();
  });
  defer(
    startStandaloneChrome({ loadingScreen, styleManager, dataManager, signal }),
  );
  // Idle render governor: flips the scene into requestRenderMode whenever
  // nothing animates per frame. Installed AFTER every module above has had
  // its chance to register pre-install holds. (perf wave 2)
  installRenderGovernor(viewer);

  // Install the explicit scope mask used by the DISPLAY controls.
  installScopeMask(viewer);
  defer(() => destroyScopeMask());

  // The follow camera recomputes the tracked target's dead-reckon position
  // every frame — tracking anything is a per-frame animation. (perf wave 2)
  const removeTrackingListener = viewer.trackedEntityChanged.addEventListener(
    () => {
      if (viewer.trackedEntity) holdContinuousRender('tracked-entity');
      else releaseContinuousRender('tracked-entity');
    },
  );

  // Hidden-state suspension (perf wave 2): when the window/tab is hidden,
  // stop the default render loop outright — a hidden canvas repaints for
  // nobody, and browser rAF throttling still lets throttled frames burn
  // GPU. Holder/data state is untouched, so return is seamless: restore
  // the loop, refresh the one DOM surface we gated, render a frame.
  const syncVisibilitySuspension = () => {
    const hidden = document.hidden;
    viewer.useDefaultRenderLoop = !hidden;
    cockpitCloudEffects?.setSuspended?.(hidden);
    if (!hidden) {
      if (dataManager._panelRefreshPendingOnVisible) {
        dataManager._panelRefreshPendingOnVisible = false;
        dataManager._refreshTogglePanel();
      }
      governorRequestRender('visibility-restore');
    }
  };
  document.addEventListener('visibilitychange', syncVisibilitySuspension);
  defer(() =>
    document.removeEventListener('visibilitychange', syncVisibilitySuspension),
  );
  defer(() => {
    removeTrackingListener();
    releaseContinuousRender('tracked-entity');
  });
  // Apply the CURRENT state too — bootstrap can complete while the tab is
  // already hidden, and waiting for the next transition would leave the
  // loop burning behind a hidden tab. (perf wave 2 fix)
  syncVisibilitySuspension();

  window.__godsEyeView = {
    viewer,
    styleManager,
    tileset,
    dataManager,
    sceneDirector,
    mapStackController,
    annotations,
    weatherEffects,
    cockpitCloudEffects,
    getRenderGovernorDiagnostics,
    requestRender: governorRequestRender,
  };
  const debug = window.__godsEyeView;
  defer(() => {
    if (window.__godsEyeView === debug) delete window.__godsEyeView;
  });
  const voiceCommands = initGevVoiceCommands({
    placeSearch,
    viewer,
    styleManager,
    dataManager,
    sceneDirector,
    annotations,
  });
  defer(() => {
    voiceCommands.stop({ removeUi: true });
    if (window.__gevVoiceCommands === voiceCommands)
      delete window.__gevVoiceCommands;
  });
  debug.voiceCommands = voiceCommands;
  if (import.meta.env.GEV_AGENT_ENABLED && import.meta.env.GEV_AGENT_TOKEN) {
    const indicatorElement = document.getElementById(
      'agent-connection-indicator',
    );
    const connectionIndicator = indicatorElement
      ? createAgentConnectionIndicator({
          element: indicatorElement,
          enabled: true,
        })
      : null;
    defer(() => connectionIndicator?.destroy());
    const querySession = new URLSearchParams(window.location.search).get(
      'agentSession',
    );
    const agentSessionId =
      typeof querySession === 'string' && AGENT_SESSION_RE.test(querySession)
        ? querySession
        : 'default';
    const observations = createAgentObservationReader({
      viewer,
      styleManager,
      dataManager,
      sceneDirector,
      annotations,
    });
    const agent = createAgentBrowserClient({
      sessionId: agentSessionId,
      token: import.meta.env.GEV_AGENT_TOKEN,
      actionRunner: voiceCommands.runner,
      getState: observations.getState,
      getHealth: observations.getHealth,
      capture: {
        viewer,
        documentRef: document,
        maxPixels: Math.min(DEFAULT_CAPTURE_MAX_PIXELS, 640 * 480),
        maxEncodedBytes: DEFAULT_CAPTURE_MAX_ENCODED_BYTES,
        format: 'jpeg',
        quality: 0.6,
        requireFresh: false,
      },
      tools: [
        ...GEV_AGENT_TOOL_CATALOG.map((tool) => tool.name),
        'get_state',
        'get_health',
        'gev_capture_view',
      ],
      onStateChange: (state) => connectionIndicator?.update(state),
    });
    debug.agent = agent;
    defer(() => {
      agent.destroy();
      if (debug.agent === agent) delete debug.agent;
    });
  }
  return { sceneDirector, annotations, voiceCommands };
}
