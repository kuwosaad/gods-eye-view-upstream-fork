import { EventEmitter } from 'node:events';
import { McpError } from './errors.js';
import { SessionRegistry } from './session-registry.js';
import { ToolDispatcher } from './dispatcher.js';

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
    this.unsubscribe = bridge.subscribe?.(id, (event) => this.emit('message', event));
  }
  send(message) {
    if (this.closed) throw new McpError('Browser connection is closed', 'DISCONNECTED');
    if (message.type === 'gev:cancel') return;
    return this.command(message.name, message.args);
  }
  command(name, args = {}, { signal, mutation = false, callerId } = {}) {
    return this.bridge.request(this.id, name, args, { signal, mutation, callerId });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
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

  const registerBridgeSession = (sessionId, { principalId = null, replace = true } = {}) => {
    if (!bridge?.sessions?.has(sessionId))
      throw new McpError(`Bridge session '${sessionId}' is not connected`, 'SESSION_NOT_FOUND');
    const previous = registry.sessions.get(sessionId);
    const previousConnection = connections.get(sessionId);
    const connection = new BridgeConnection(bridge, sessionId);
    connections.set(sessionId, connection);
    const session = registry.register(connection, sessionId, {
      principalId: previous?.principalId ?? principalId,
      replace,
      unclaimed: previous?.unclaimed ?? principalId === null,
      publicSession: previous?.publicSession,
      actorPrincipalId: previous?.principalId ?? principalId,
    });
    if (previous) {
      session.sharedWith = new Set(previous.sharedWith);
      session.stateVersion = previous.stateVersion;
      session.leaseOwner = previous.leaseOwner;
    }
    previousConnection?.close();
    connection.once('close', () => {
      if (connections.get(sessionId) === connection) connections.delete(sessionId);
      if (registry.sessions.get(sessionId) === session) registry.remove(sessionId);
    });
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
    const response = await dispatcher.callTool(name, args, { ...options, callerId });
    const sessionId = args.sessionId ?? args.session_id;
    let state;
    if (!response.isError && resolvedTools[name]?.mutation) {
      try {
        const session = registry.resolve(sessionId, callerId);
        state = await getState(session);
        if (state && typeof state === 'object')
          state = { ...state, stateVersion: session.stateVersion };
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
      const raw = await dispatcher.executeRaw(name, args, { ...options, callerId });
      let state;
      if (raw.tool.mutation && raw.session) {
        state = await getState(raw.session);
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

  const claim = (sessionId, callerId) => registry.claim(sessionId, callerId);
  const join = (sessionId, callerId) => registry.join(sessionId, callerId);
  const share = (sessionId, callerId, invitedPrincipalId) =>
    registry.share(sessionId, callerId, invitedPrincipalId);
  const closeSession = (sessionId, callerId) => registry.close(sessionId, callerId);
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
