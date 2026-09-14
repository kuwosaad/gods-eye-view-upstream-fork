import { EventEmitter } from 'node:events';
import { McpError } from './errors.js';
import { SessionRegistry } from './session-registry.js';
import { errorResult, textResult, ToolDispatcher } from './dispatcher.js';

/**
 * A deliberately small adapter for the bridge used by the server. The control
 * plane only depends on request/subscribe; the concrete WebSocket transport
 * stays outside this module.
 */
class BridgeConnection extends EventEmitter {
  constructor(bridge, id) {
    super();
    this.bridge = bridge;
    this.id = id;
    this.generation = bridge.sessions.get(id);
    this.closed = false;
    this.abortController = new AbortController();
    this.unsubscribe = bridge.subscribe?.(id, (event) => this.emit('message', event));
  }
  send(message) {
    if (this.closed) throw new McpError('Browser connection is closed', 'DISCONNECTED');
    if (message.type === 'gev:cancel') return;
    return this.command(message.name, message.args);
  }
  command(name, args = {}, { signal, mutation = false, callerId } = {}) {
    const requestSignal = signal
      ? AbortSignal.any([this.abortController.signal, signal])
      : this.abortController.signal;
    return this.bridge.request(this.id, name, args, {
      signal: requestSignal,
      mutation,
      callerId,
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.abortController.abort();
    this.unsubscribe?.();
    this.emit('close');
  }
}

function sessionResource(session) {
  return {
    uri: `gev://sessions/${encodeURIComponent(session.id)}/state`,
    name: `God's Eye View session ${session.id}`,
    mimeType: 'application/json',
    description: 'Current state of a connected God’s Eye View session.',
  };
}

export function createControlPlane({
  registry = new SessionRegistry(),
  bridge = null,
  tools = {},
  getState = async (session) => session?.connection?.getState?.(),
  getHealth = () => null,
  audit = null,
  onEvent = null,
  onSessionsChanged = null,
  quotaGuard = null,
} = {}) {
  const resolvedTools = Object.fromEntries(Object.entries(tools).map(([name, tool]) => [
    name,
    tool.handler ? tool : {
      ...tool,
      handler: ({ args, session, signal, callerId }) => {
        if (!session?.connection?.command)
          throw new McpError(`Tool '${name}' requires a browser session`, 'SESSION_REQUIRED');
        return session.connection.command(name, args, { signal, mutation: Boolean(tool.mutation), callerId });
      },
    },
  ]));
  const dispatcher = new ToolDispatcher({
    registry,
    tools: resolvedTools,
    quotaGuard,
  });
  const connections = new Map();
  let unsubscribeBridgeSessions = null;

  const record = (event) => {
    try { audit?.(event); } catch { /* audit hooks must not break commands */ }
    onEvent?.(event);
  };
  const publishSessionsChanged = () => {
    try {
      Promise.resolve(onSessionsChanged?.()).catch(() => {});
    } catch {
      // Topology observers cannot break browser session lifecycle operations.
    }
  };

  const registerBridgeSession = (sessionId, { principalId = null, replace = true } = {}) => {
    if (!bridge?.sessions?.has(sessionId))
      throw new McpError(`Bridge session '${sessionId}' is not connected`, 'SESSION_NOT_FOUND');
    const previous = registry.sessions.get(sessionId);
    const previousState = previous
      ? {
          principalId: previous.principalId,
          unclaimed: previous.unclaimed,
          publicSession: previous.publicSession,
          sharedWith: new Set(previous.sharedWith),
          mutationState: previous.mutationState,
          stateVersion: previous.stateVersion,
          leaseOwner: previous.leaseOwner,
          leaseExpiresAt: previous.leaseExpiresAt,
          createdAt: previous.createdAt,
        }
      : null;
    const previousConnection = connections.get(sessionId);
    const connection = new BridgeConnection(bridge, sessionId);
    let session;
    try {
      session = registry.register(connection, sessionId, {
        principalId: previousState?.principalId ?? principalId,
        replace,
        unclaimed: previousState?.unclaimed ?? principalId === null,
        publicSession: previousState?.publicSession,
        actorPrincipalId: previousState?.principalId ?? principalId,
        mutationState: previousState?.mutationState,
      });
    } catch (error) {
      connection.close();
      throw error;
    }
    connections.set(sessionId, connection);
    if (previousState) {
      session.sharedWith = previousState.sharedWith;
      session.stateVersion = previousState.stateVersion;
      session.createdAt = previousState.createdAt;
      if (previousState.leaseOwner) {
        const remaining = previousState.leaseExpiresAt === null
          ? 0
          : Math.max(0, previousState.leaseExpiresAt - Date.now());
        if (previousState.leaseExpiresAt === null || remaining > 0)
          session.acquireLease(previousState.leaseOwner, { ttlMs: remaining });
      }
    }
    previousConnection?.close();
    connection.once('close', () => {
      if (connections.get(sessionId) === connection) connections.delete(sessionId);
      if (registry.sessions.get(sessionId) === session) {
        registry.remove(sessionId);
        publishSessionsChanged();
      }
    });
    publishSessionsChanged();
    return session;
  };

  const syncBridgeSessions = ({ principalId = null } = {}) => {
    if (!bridge?.sessions) return [];
    const result = [];
    for (const [sessionId, connection] of connections) {
      if (!bridge.sessions.has(sessionId)) connection.close();
    }
    for (const sessionId of bridge.sessions.keys()) {
      const entry = bridge.sessions.get(sessionId);
      const current = connections.get(sessionId);
      if (!current || current.generation !== entry)
        result.push(registerBridgeSession(sessionId, { principalId }));
    }
    return result;
  };

  unsubscribeBridgeSessions = bridge?.subscribeSessions?.((event) => {
    if (event?.type === 'disconnected') {
      connections.get(event.sessionId)?.close();
      return;
    }
    if (event?.type === 'connected' || event?.type === 'replaced') {
      try {
        registerBridgeSession(event.sessionId);
      } catch {
        // A subsequent discovery or command retries synchronization.
      }
    }
  });

  const call = async (name, args = {}, options = {}) => {
    syncBridgeSessions();
    const callerId = options.callerId ?? 'anonymous';
    const startedAt = Date.now();
    let response;
    let observedState;
    try {
      const raw = await dispatcher.executeRaw(name, args, {
        ...options,
        callerId,
        afterMutation: resolvedTools[name]?.mutation
          ? async (session) => getState(session)
          : null,
      });
      observedState = raw.observedState;
      response = textResult(raw.data, { stateVersion: raw.stateVersion });
    } catch (error) {
      response = errorResult(error);
    }
    const sessionId = args.sessionId ?? args.session_id;
    let state;
    if (!response.isError && resolvedTools[name]?.mutation) {
      try {
        state = observedState;
        if (state && typeof state === 'object') {
          const session = registry.resolve(sessionId, callerId);
          state = { ...state, stateVersion: session.stateVersion };
        }
      } catch (error) {
        record({ type: 'state-observation-failed', name, callerId, error });
      }
    }
    const event = {
      type: response.isError ? 'failed' : 'completed',
      name,
      callerId,
      sessionId: sessionId ?? null,
      durationMs: Date.now() - startedAt,
      response,
    };
    record(event);
    if (state === undefined) return response;
    const stateVersion = response.structuredContent?.stateVersion;
    return { ...response, state, ...(stateVersion === undefined ? {} : { stateVersion }) };
  };

  const dispatch = async (request, options = {}) => {
    const callerId = options.callerId ?? 'anonymous';
    const suppliedArgs = request?.arguments ?? request?.args ?? {};
    const requestSessionId = request?.sessionId ?? request?.session_id;
    const args =
      requestSessionId === undefined
        ? suppliedArgs
        : { ...suppliedArgs, sessionId: requestSessionId };
    const name = request?.tool ?? request?.name;
    syncBridgeSessions();
    const startedAt = Date.now();
    try {
      const raw = await dispatcher.executeRaw(name, args, {
        ...options,
        callerId,
        afterMutation: (session) => getState(session),
      });
      let state;
      if (raw.tool.mutation && raw.session) {
        state = raw.observedState;
        if (state && typeof state === 'object')
          state = { ...state, stateVersion: raw.stateVersion };
      }
      const data = raw.data && typeof raw.data === 'object' ? raw.data : {};
      const response = {
        ok: true,
        result: {
          tool: name,
          sessionId: raw.sessionId,
          stateVersion: raw.stateVersion,
          data: raw.data,
          warnings: data.warnings ?? [],
          artifacts: data.artifacts ?? [],
          ...(state === undefined ? {} : { state }),
        },
      };
      record({
        type: 'completed',
        name,
        callerId,
        sessionId: raw.sessionId,
        durationMs: Date.now() - startedAt,
        args,
        stateVersion: raw.stateVersion,
      });
      return response;
    } catch (error) {
      record({
        type: 'failed',
        name,
        callerId,
        sessionId: requestSessionId ?? null,
        durationMs: Date.now() - startedAt,
        args,
        errorCode: error.code ?? 'MCP_ERROR',
      });
      return { ok: false, error: { code: error.code ?? 'MCP_ERROR', message: error.message } };
    }
  };

  const listResources = (callerId = 'anonymous') =>
    [...registry.sessions.values()]
      .filter((session) => session.canAccess(callerId))
      .map(sessionResource);

  const readResource = async (uri, callerId = 'anonymous') => {
    const match = /^gev:\/\/sessions\/([^/]+)\/state$/.exec(uri);
    if (!match) throw new McpError('Unknown resource', 'RESOURCE_NOT_FOUND');
    const session = registry.get(decodeURIComponent(match[1]), callerId);
    const value = await getState(session);
    return { uri, mimeType: 'application/json', text: JSON.stringify(value) };
  };

  const claim = (sessionId, callerId) => {
    const session = registry.claim(sessionId, callerId);
    publishSessionsChanged();
    return session;
  };
  const join = (sessionId, callerId) => registry.join(sessionId, callerId);
  const share = (sessionId, callerId, invitedPrincipalId) => {
    const session = registry.share(sessionId, callerId, invitedPrincipalId);
    publishSessionsChanged();
    return session;
  };
  const closeSession = (sessionId, callerId) => {
    const closed = registry.close(sessionId, callerId);
    publishSessionsChanged();
    return closed;
  };
  const acquireLease = (sessionId, callerId, options) => {
    registry.get(sessionId, callerId);
    return registry.get(sessionId).acquireLease(callerId, options);
  };
  const releaseLease = (sessionId, callerId) => {
    const session = registry.get(sessionId, callerId);
    if (session.leaseOwner !== callerId)
      throw new McpError('Caller does not hold the session lease', 'LEASE_OWNER_REQUIRED');
    session.leaseOwner = null;
    if (session.leaseTimer) clearTimeout(session.leaseTimer);
    session.leaseTimer = null;
    session.leaseExpiresAt = null;
    session.leaseGeneration += 1;
  };

  const close = () => {
    unsubscribeBridgeSessions?.();
    unsubscribeBridgeSessions = null;
    for (const connection of connections.values()) connection.close();
    connections.clear();
  };
  return Object.freeze({
    registry,
    dispatcher,
    call,
    dispatch,
    syncBridgeSessions,
    registerBridgeSession,
    listResources,
    readResource,
    claim,
    join,
    share,
    closeSession,
    acquireLease,
    releaseLease,
    close,
  });
}
