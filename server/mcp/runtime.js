import { randomUUID } from 'node:crypto';
import { createAgentBridge } from '../agent-bridge/bridge.js';
import { GEV_AGENT_TOOL_CATALOG, GEV_AGENT_TOOL_METADATA } from '../../src/agent/toolCatalog.js';
import { createControlPlane } from './control-plane.js';
import { createMcpResourceAdapter } from './resources.js';
import { createAuditLog } from './audit.js';
import { createQuotaGuard } from './security.js';
import { ArtifactStore } from './artifact-store.js';

/** Compose the stateful MCP pieces used by the Vite integration. */
export function createMcpRuntime({
  bridge = null,
  bridgeOptions,
  registry,
  catalog = GEV_AGENT_TOOL_CATALOG,
  metadata = GEV_AGENT_TOOL_METADATA,
  tools = {},
  getState: readState,
  getHealth,
  audit = null,
  auditLog = audit === false ? null : createAuditLog(),
  quotaGuard = null,
  quota,
  artifactStore = null,
  artifactRoot,
  artifactOptions,
  onEvent,
  onResourceUpdated,
  browserUrl = null,
} = {}) {
  const agentBridge = bridge || (bridgeOptions ? createAgentBridge(bridgeOptions) : null);
  const resolvedQuota = quotaGuard || (quota ? createQuotaGuard(quota) : null);
  const resolvedArtifactStore = artifactStore || (artifactRoot ? new ArtifactStore({ root: artifactRoot, ...artifactOptions }) : null);
  const catalogTools = Object.fromEntries(catalog.map((entry) => {
    const info = metadata[entry.name] || {};
    return [entry.name, {
      description: entry.description,
      inputSchema: entry.parameters,
      mutation: info.access === 'mutation' || info.readOnly === false,
      costClass: info.costClass,
      ...(tools[entry.name] || {}),
    }];
  }));
  Object.assign(catalogTools, tools);
  if (!catalogTools.gev_capture_view) {
    catalogTools.gev_capture_view = {
      description: 'Capture the current God’s Eye View viewport.',
      inputSchema: { type: 'object', additionalProperties: false },
      mutation: false,
      sessionRequired: true,
      costClass: 'artifact',
    };
  }

  const stateReader = async (session) => {
    if (typeof readState === 'function') return readState(session, session?.principalId);
    if (typeof session?.connection?.getState === 'function') return session.connection.getState();
    if (typeof session?.connection?.command === 'function')
      return session.connection.command('get_state', {}, { mutation: false });
    return null;
  };
  const auditEvent = (event) => {
    auditLog?.append({
      principal: event.callerId, sessionId: event.sessionId, tool: event.name,
      outcome: event.type === 'failed' ? 'error' : 'ok', durationMs: event.durationMs,
      errorCode: event.errorCode ?? event.response?.structuredContent?.code,
      args: event.args,
      costClass: catalogTools[event.name]?.costClass,
    });
    audit?.(event);
    onEvent?.(event);
  };
  const plane = createControlPlane({
    registry, bridge: agentBridge, tools: catalogTools,
    getState: stateReader, getHealth, audit: auditEvent, quotaGuard: resolvedQuota,
  });
  const reservations = new Map();
  const sync = () => {
    const sessions = plane.syncBridgeSessions();
    for (const [sessionId, principalId] of reservations) {
      const session = plane.registry.sessions.get(sessionId);
      if (session?.principalId === null) plane.claim(sessionId, principalId);
    }
    return sessions;
  };
  const getSessionState = async (sessionId, { principalId = 'anonymous' } = {}) => {
    sync();
    const session = plane.registry.resolve(sessionId, principalId);
    const state = await stateReader(session);
    return state && typeof state === 'object'
      ? { ...state, stateVersion: session.stateVersion }
      : { stateVersion: session.stateVersion, data: state };
  };
  const resources = createMcpResourceAdapter({
    getState: getSessionState,
    getArtifact: resolvedArtifactStore ? async (sessionId, artifactId, principalId) => {
      plane.registry.get(sessionId, principalId);
      const result = await resolvedArtifactStore.get(sessionId, artifactId);
      return { data: result.data, mimeType: result.mimeType || 'application/octet-stream' };
    } : null,
  });
  const resourceCallbacks = Object.fromEntries(['state', 'layers', 'entities', 'annotations'].map((kind) => [kind,
    async (sessionId, { principalId = 'anonymous' } = {}) => {
      const value = await resources.readResource(`gev://sessions/${encodeURIComponent(sessionId)}/${kind}`, principalId);
      return JSON.parse(value.text);
    },
  ]));
  if (resolvedArtifactStore)
    resourceCallbacks.artifacts = (sessionId, artifactId, options) =>
      resources.artifacts(sessionId, artifactId, options);
  const dispatch = async (request, options = {}) => {
    const principalId = options.principalId || options.callerId || 'anonymous';
    sync();
    const sessionId = request?.sessionId ?? request?.session_id;
    const args = request?.arguments ?? request?.args ?? {};
    const normalized = sessionId === undefined ? request : { ...request, arguments: { ...args, sessionId } };
    const response = await plane.dispatch(normalized, {
      ...options,
      callerId: principalId,
    });
    const name = request?.tool ?? request?.name;
    if (response.ok && catalogTools[name]?.mutation && response.result?.sessionId) {
      await resources.notifyMutation(response.result.sessionId, principalId, {
        tool: name,
        stateVersion: response.result.stateVersion,
      });
      for (const uri of resources.listResourceUris(response.result.sessionId))
        await onResourceUpdated?.(uri);
    }
    return response;
  };
  const listSessions = ({ principalId = 'anonymous' } = {}) => {
    sync();
    return plane.registry.list(null).flatMap((entry) => {
      const session = plane.registry.sessions.get(entry.id);
      if (!session?.unclaimed && !session?.canAccess(principalId)) return [];
      const access = session.unclaimed
        ? 'unclaimed'
        : session.principalId === principalId
          ? 'owner'
          : 'shared';
      return [{ ...entry, access }];
    });
  };
  const createSession = ({ sessionId, name } = {}, { principalId = 'anonymous' } = {}) => {
    const requested = sessionId ?? name ?? `session-${randomUUID().slice(0, 12)}`;
    if (typeof requested !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(requested))
      throw new TypeError('sessionId must be a valid browser session name');
    const prior = reservations.get(requested);
    if (prior && prior !== principalId) throw Object.assign(new Error('Session is reserved by another principal'), { code: 'ACCESS_DENIED' });
    reservations.set(requested, principalId);
    sync();
    const connected = plane.registry.sessions.get(requested);
    return {
      sessionId: requested, principalId,
      status: connected?.principalId === principalId ? 'connected' : 'waiting',
      ...(typeof browserUrl === 'function' ? { browserUrl: browserUrl(requested) } : typeof browserUrl === 'string' ? { browserUrl: `${browserUrl}${browserUrl.includes('?') ? '&' : '?'}agentSession=${encodeURIComponent(requested)}` } : {}),
    };
  };
  const sessionSummary = (session, principalId) =>
    listSessions({ principalId }).find(({ id }) => id === session.id) || { id: session.id };
  const joinSession = ({ sessionId }, { principalId = 'anonymous' } = {}) => {
    sync();
    const session = plane.registry.get(sessionId);
    // An unclaimed browser is private: the first explicit MCP join claims it.
    if (session.principalId === null && session.unclaimed) return sessionSummary(plane.claim(sessionId, principalId), principalId);
    return sessionSummary(plane.join(sessionId, principalId), principalId);
  };
  const sessionManagement = {
    createSession,
    joinSession,
    shareSession: ({ sessionId, invitedPrincipalId }, ctx) => {
      plane.share(sessionId, ctx.principalId, invitedPrincipalId);
      return { sessionId, sharedWith: invitedPrincipalId };
    },
    closeSession: ({ sessionId }, ctx) => ({
      sessionId,
      closed: plane.closeSession(sessionId, ctx.principalId),
    }),
    acquireLease: ({ sessionId, ttlMs }, ctx) => {
      plane.acquireLease(sessionId, ctx.principalId, { ttlMs });
      return { sessionId, leaseOwner: ctx.principalId, ttlMs: ttlMs ?? 0 };
    },
    releaseLease: ({ sessionId }, ctx) => {
      plane.releaseLease(sessionId, ctx.principalId);
      return { sessionId, released: true };
    },
  };
  const close = async () => {
    resources.clearCache();
    plane.close();
    await resolvedArtifactStore?.close?.();
    await agentBridge?.close?.();
  };
  return Object.freeze({
    bridge: agentBridge, registry: plane.registry, catalog, metadata, tools: catalogTools,
    controlPlane: plane, dispatcher: plane.dispatcher, dispatch, call: plane.call,
    syncBridgeSessions: sync, registerBridgeSession: plane.registerBridgeSession,
    listSessions, createSession, reservations, getState: getSessionState, resources, resourceCallbacks,
    listResources: plane.listResources, readResource: resources.readResource,
    sessionManagement, joinSession, shareSession: sessionManagement.shareSession,
    closeSession: sessionManagement.closeSession, acquireLease: sessionManagement.acquireLease,
    releaseLease: sessionManagement.releaseLease, auditLog, artifactStore: resolvedArtifactStore, close,
  });
}
