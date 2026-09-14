import { createRequire } from 'node:module';
import { timingSafeEqual } from 'node:crypto';
import {
  GEV_PROTOCOL_VERSION,
  parseMessage,
  encodeMessage,
  protocolError,
} from './protocol.js';

const require = createRequire(import.meta.url);

export const AGENT_BRIDGE_PATH = '/__gev_agent';
export const DEFAULT_MAX_MESSAGE_BYTES = 256 * 1024;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_PENDING_REQUESTS = 128;
export const DEFAULT_MAX_PENDING_PER_SESSION = 32;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;

function defaultWebSocketServer(options) {
  const { WebSocketServer } = require('ws');
  return new WebSocketServer(options);
}

function validSessionId(value) {
  return typeof value === 'string' && SESSION_RE.test(value);
}

function originAllowed(origin, allowedOrigins) {
  if (!origin) return false;
  if (allowedOrigins === '*') return true;
  const list = allowedOrigins || ['http://localhost', 'http://127.0.0.1'];
  return list.some((allowed) => {
    if (allowed instanceof RegExp) return allowed.test(origin);
    try {
      const actual = new URL(origin);
      const expected = new URL(allowed);
      return (
        actual.protocol === expected.protocol &&
        actual.hostname === expected.hostname &&
        (!expected.port || actual.port === expected.port)
      );
    } catch {
      return false;
    }
  });
}

function loopbackAddress(address) {
  const value = String(address || '').replace(/^::ffff:/i, '');
  return (
    value === '127.0.0.1' || value === '::1' || value === '0:0:0:0:0:0:0:1'
  );
}

function loopbackHost(header) {
  try {
    const host = new URL(`http://${String(header || '')}`).hostname;
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '[::1]' ||
      host === '::1'
    );
  } catch {
    return false;
  }
}

function tokenMatches(expected, actual) {
  const left = Buffer.from(String(expected));
  const right = Buffer.from(String(actual || ''));
  return left.length === right.length && timingSafeEqual(left, right);
}

function safeRemoteError(value) {
  const code = typeof value?.code === 'string' && /^[A-Z0-9_.:-]{1,64}$/.test(value.code)
    ? value.code : 'REMOTE_ERROR';
  const raw = typeof value?.message === 'string' ? value.message : String(value || 'remote command failed');
  return Object.assign(new Error(raw.slice(0, 512)), { code });
}

/**
 * A small, localhost-first WebSocket bridge between a browser GEV session and
 * a server-side MCP adapter. The bridge owns no application actions: the
 * browser is responsible for dispatching requests and returning results.
 */
export function createAgentBridge({
  path = AGENT_BRIDGE_PATH,
  token = process.env.GEV_AGENT_TOKEN || '',
  allowedOrigins,
  maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxPendingRequests = DEFAULT_MAX_PENDING_REQUESTS,
  maxPendingPerSession = DEFAULT_MAX_PENDING_PER_SESSION,
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  WebSocketServer = defaultWebSocketServer,
} = {}) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new TypeError('GEV agent bridge requires a non-empty token');
  }
  const sessions = new Map();
  const pending = new Map();
  const sessionListeners = new Set();
  let closed = false;
  let nextRequest = 1;
  let wss;
  let heartbeatTimer;

  const publishSession = (event) => {
    for (const listener of sessionListeners) {
      try {
        listener(event);
      } catch {
        // A monitoring listener cannot break the bridge lifecycle.
      }
    }
  };

  const send = (socket, message) => {
    const payload =
      message.type === 'registered'
        ? JSON.stringify(message)
        : encodeMessage(message);
    try {
      if (socket.readyState !== 1) return false;
      // Keep the pre-versioned registration envelope during browser rollout.
      socket.send(payload);
      return true;
    } catch {
      // A socket can close between the readyState check and send(). Cleanup
      // paths must still reject their waiters when that race happens.
      return false;
    }
  };

  const rejectPending = (sessionId, error) => {
    for (const [id, item] of pending) {
      if (item.sessionId !== sessionId) continue;
      clearTimeout(item.timer);
      pending.delete(id);
      send(item.socket, { type: 'gev:cancel', id });
      item.reject(error);
    }
  };

  const onMessage = (socket, sessionId, data) => {
    // A replaced browser may still have queued messages in the event loop.
    // It no longer owns this session and must not answer requests or publish
    // events for the replacement.
    if (sessions.get(sessionId)?.socket !== socket) return;
    if (Buffer.byteLength(String(data)) > maxMessageBytes) {
      socket.close(1009, 'message too large');
      return;
    }
    let message;
    try {
      message = parseMessage(data, maxMessageBytes);
    } catch (error) {
      send(socket, protocolError(error.code === 'MESSAGE_TOO_LARGE' ? 'MESSAGE_TOO_LARGE' : 'INVALID_MESSAGE', 'invalid bridge message'));
      return;
    }
    if (message.type === 'gev:ping') {
      send(socket, { type: 'gev:pong', version: GEV_PROTOCOL_VERSION });
      return;
    }
    if (message.type === 'gev:pong') return;
    if (message.type === 'gev:hello') {
      const current = sessions.get(sessionId);
      if (current) current.capabilities = message.capabilities;
      send(socket, { type: 'gev:hello', version: GEV_PROTOCOL_VERSION, sessionId, capabilities: ['commands', 'cancel', 'events'] });
      return;
    }
    if (
      (message.type === 'gev:response' || message.type === 'response') &&
      typeof message.id === 'string'
    ) {
      const item = pending.get(message.id);
      if (!item || item.sessionId !== sessionId) return;
      clearTimeout(item.timer);
      pending.delete(message.id);
      if (message.error) {
        item.reject(safeRemoteError(message.error));
      } else item.resolve(message.result);
      return;
    }
    if (
      (message.type === 'gev:event' || message.type === 'event') &&
      typeof message.event === 'string'
    ) {
      sessions.get(sessionId)?.events.forEach((listener) => {
        try {
          listener(message);
        } catch {
          /* listener isolation */
        }
      });
      return;
    }
    send(socket, protocolError('INVALID_MESSAGE', 'unsupported bridge message'));
  };

  const handleConnection = (socket, request) => {
    const url = new URL(request.url || '/', 'http://localhost');
    const requested = url.searchParams.get('sessionId');
    if (!validSessionId(requested)) {
      socket.close(1008, 'valid sessionId required');
      return;
    }
    const sessionId = requested;
    const old = sessions.get(sessionId);
    if (old) {
      rejectPending(
        sessionId,
        Object.assign(new Error('session replaced'), { code: 'SESSION_CLOSED' }),
      );
    }
    const session = { socket, events: new Set(), sessionId, lastSeen: Date.now(), capabilities: [] };
    sessions.set(sessionId, session);
    // Install the replacement first. Some socket implementations emit `close`
    // synchronously, and the old handler must see that it no longer owns the id.
    old?.socket.close(4000, 'session replaced');
    publishSession({ type: old ? 'replaced' : 'connected', sessionId });
    send(socket, { type: 'registered', sessionId });
    socket.on('message', (data) => {
      session.lastSeen = Date.now();
      onMessage(socket, sessionId, data);
    });
    socket.on('pong', () => { session.lastSeen = Date.now(); });
    socket.on('close', () => {
      // A replaced socket must not tear down the replacement's pending work.
      if (sessions.get(sessionId)?.socket !== socket) return;
      sessions.delete(sessionId);
      publishSession({ type: 'disconnected', sessionId });
      rejectPending(
        sessionId,
        Object.assign(new Error('session closed'), { code: 'SESSION_CLOSED' }),
      );
      session.events.clear();
    });
    socket.on('error', () => {});
  };

  const attach = (httpServer) => {
    if (wss || closed)
      throw new Error('agent bridge already attached or closed');
    wss = new WebSocketServer({ noServer: true, maxPayload: maxMessageBytes });
    if (heartbeatIntervalMs > 0) {
      heartbeatTimer = setInterval(() => {
        for (const session of sessions.values()) {
          if (Date.now() - session.lastSeen > heartbeatIntervalMs * 2) {
            session.socket.close(4001, 'heartbeat timeout');
          } else if (typeof session.socket.ping === 'function') {
            session.socket.ping();
          } else {
            send(session.socket, { type: 'gev:ping', version: GEV_PROTOCOL_VERSION });
          }
        }
      }, heartbeatIntervalMs);
      heartbeatTimer.unref?.();
    }
    const upgrade = (request, socket, head) => {
      const url = new URL(request.url || '/', 'http://localhost');
      if (url.pathname !== path) return;
      if (!loopbackAddress(request.socket?.remoteAddress)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      if (!loopbackHost(request.headers?.host)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      if (
        request.headers?.['x-forwarded-for'] ||
        request.headers?.['x-forwarded-host'] ||
        request.headers?.['x-forwarded-proto']
      ) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      if (!originAllowed(request.headers.origin, allowedOrigins)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      const presentedToken = request.headers?.['x-gev-agent-token'] || url.searchParams.get('token');
      if (!tokenMatches(token, presentedToken)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, handleConnection);
    };
    httpServer.on('upgrade', upgrade);
    return () => {
      httpServer.off?.('upgrade', upgrade);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    };
  };

  const request = (sessionId, method, params = {}, { signal, mutation = true } = {}) => {
    if (closed) return Promise.reject(Object.assign(new Error('agent bridge closed'), { code: 'BRIDGE_CLOSED' }));
    if (!validSessionId(sessionId))
      return Promise.reject(Object.assign(new Error('invalid sessionId'), { code: 'INVALID_REQUEST' }));
    if (typeof method !== 'string' || !method)
      return Promise.reject(Object.assign(new Error('method required'), { code: 'INVALID_REQUEST' }));
    const session = sessions.get(sessionId);
    if (!session)
      return Promise.reject(
        Object.assign(new Error('session not connected'), {
          code: 'SESSION_NOT_FOUND',
        }),
      );
    const sessionPending = [...pending.values()].filter((item) => item.sessionId === sessionId).length;
    if (pending.size >= maxPendingRequests || sessionPending >= maxPendingPerSession)
      return Promise.reject(Object.assign(new Error('too many pending requests'), { code: 'PENDING_LIMIT' }));
    const id = `gev-${nextRequest++}`;
    return new Promise((resolve, reject) => {
      let settled = false;
      let abortHandler;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abortHandler);
        fn(value);
      };
      const timer = setTimeout(() => {
        pending.delete(id);
        send(session.socket, { type: 'gev:cancel', id });
        finish(reject,
          Object.assign(new Error('request timed out'), {
            code: 'REQUEST_TIMEOUT',
          }),
        );
      }, requestTimeoutMs);
      pending.set(id, { sessionId, socket: session.socket, resolve: (v) => finish(resolve, v), reject: (e) => finish(reject, e), timer });
      abortHandler = () => {
        if (settled) return;
        pending.delete(id);
        send(session.socket, { type: 'gev:cancel', id });
        finish(reject, Object.assign(new Error('request aborted'), { code: 'ABORTED' }));
      };
      if (signal?.aborted) return abortHandler();
      signal?.addEventListener('abort', abortHandler, { once: true });
      try {
        if (!send(session.socket, {
          type: 'gev:command',
          version: GEV_PROTOCOL_VERSION,
          id,
          name: method,
          args: params,
          mutation,
        })) throw Object.assign(new Error('session disconnected'), { code: 'SESSION_CLOSED' });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        finish(reject, error);
      }
    });
  };

  const subscribe = (sessionId, listener) => {
    const session = sessions.get(sessionId);
    if (!session) throw new Error('session not connected');
    session.events.add(listener);
    return () => session.events.delete(listener);
  };

  const subscribeSessions = (listener) => {
    if (typeof listener !== 'function') throw new TypeError('listener is required');
    sessionListeners.add(listener);
    return () => sessionListeners.delete(listener);
  };

  const disconnect = (sessionId, { code = 4002, reason = 'session closed by owner' } = {}) => {
    const session = sessions.get(sessionId);
    if (!session) return false;
    sessions.delete(sessionId);
    rejectPending(
      sessionId,
      Object.assign(new Error('session closed'), { code: 'SESSION_CLOSED' }),
    );
    session.events.clear();
    publishSession({ type: 'disconnected', sessionId });
    session.socket.close(code, reason);
    return true;
  };

  const close = () => {
    closed = true;
    for (const [id, item] of pending) {
      clearTimeout(item.timer);
      send(item.socket, { type: 'gev:cancel', id });
      item.reject(Object.assign(new Error('agent bridge closed'), { code: 'BRIDGE_CLOSED' }));
    }
    pending.clear();
    for (const session of sessions.values())
      session.socket.close(1001, 'bridge closed');
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    sessions.clear();
    sessionListeners.clear();
    wss?.close();
  };

  return {
    attach,
    request,
    subscribe,
    subscribeSessions,
    disconnect,
    close,
    sessions,
    get attached() {
      return Boolean(wss);
    },
  };
}

/** Vite plugin hook; the parent config only needs to include this plugin. */
export function agentBridgePlugin(options = {}) {
  let detach;
  return {
    name: 'gev-agent-bridge',
    configureServer(server) {
      const bridge = createAgentBridge(options);
      detach = bridge.attach(server.httpServer);
      server.agentBridge = bridge;
      server.httpServer.once('close', () => {
        detach?.();
        bridge.close();
      });
    },
  };
}
