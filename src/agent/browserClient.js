import { createAgentCommandDispatcher } from './commandDispatcher.js';

export const AGENT_BROWSER_PATH = '/__gev_agent';
export const DEFAULT_MAX_MESSAGE_BYTES = 256 * 1024;
export const GEV_PROTOCOL_VERSION = 1;
const PROTOCOL_TYPES = new Set([
  'gev:hello',
  'gev:command',
  'gev:cancel',
  'gev:response',
  'gev:error',
  'gev:event',
  'gev:ping',
  'gev:pong',
]);
const ERROR_CODES = new Set([
  'INVALID_MESSAGE', 'INVALID_REQUEST', 'UNAUTHORIZED', 'SESSION_NOT_FOUND',
  'SESSION_CLOSED', 'UNKNOWN_TOOL', 'EXECUTION_FAILED', 'REQUEST_TIMEOUT',
  'CANCELLED', 'ABORTED', 'DISCONNECTED', 'DESTROYED', 'LEASED', 'TOOL_NOT_FOUND',
  'MESSAGE_TOO_LARGE', 'PROTOCOL_VERSION_UNSUPPORTED', 'BRIDGE_CLOSED',
  'PENDING_LIMIT', 'RESULT_TOO_LARGE', 'DUPLICATE_ID', 'UNAVAILABLE',
  'QUEUE_FULL', 'INVALID_ARGUMENTS', 'QUOTA_EXCEEDED', 'SESSION_REQUIRED',
  'ACCESS_DENIED', 'SESSION_EXISTS', 'SESSION_QUOTA', 'RESOURCE_NOT_FOUND',
  'LEASE_OWNER_REQUIRED', 'CAPABILITY_UNAVAILABLE', 'REMOTE_ERROR',
]);

const OPEN = 1;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;

function byteLength(value) {
  if (typeof value === 'string')
    return typeof TextEncoder === 'function'
      ? new TextEncoder().encode(value).byteLength
      : value.length;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  return Infinity;
}

function decode(value) {
  if (typeof value === 'string') return JSON.parse(value);
  if (value instanceof ArrayBuffer)
    return JSON.parse(new TextDecoder().decode(value));
  if (ArrayBuffer.isView(value))
    return JSON.parse(new TextDecoder().decode(value));
  return null;
}

function encodeEnvelope(message, maxBytes) {
  if (!message || typeof message !== 'object' || Array.isArray(message))
    return null;
  const envelope =
    message.type?.startsWith?.('gev:') && message.version === undefined
      ? { version: GEV_PROTOCOL_VERSION, ...message }
      : message;
  if (
    typeof envelope.type !== 'string' ||
    (!PROTOCOL_TYPES.has(envelope.type) &&
      envelope.type !== 'registered' &&
      envelope.type !== 'error')
  )
    return null;
  try {
    if (envelope.type === 'gev:hello') {
      if (envelope.version !== GEV_PROTOCOL_VERSION || typeof envelope.sessionId !== 'string' ||
          !envelope.sessionId || !Array.isArray(envelope.capabilities) || envelope.capabilities.length > 256 ||
          envelope.capabilities.some((item) => typeof item !== 'string' || !item || item.length > 128)) return null;
    }
    if ((envelope.type === 'gev:command' || envelope.type === 'gev:cancel' || envelope.type === 'gev:response') &&
        (typeof envelope.id !== 'string' || !envelope.id || envelope.id.length > 128)) return null;
    if (envelope.type === 'gev:response' && !Object.hasOwn(envelope, 'result') && !Object.hasOwn(envelope, 'error')) return null;
    if (envelope.type === 'gev:error' && (!ERROR_CODES.has(envelope.code) || typeof envelope.message !== 'string' || !envelope.message)) return null;
    if (envelope.error && (typeof envelope.error !== 'object' || !ERROR_CODES.has(envelope.error.code) || typeof envelope.error.message !== 'string')) return null;
    const encoded = JSON.stringify(envelope);
    return encoded !== undefined && byteLength(encoded) <= maxBytes ? { envelope, encoded } : null;
  } catch {
    return null;
  }
}

function errorValue(code, message) {
  return {
    code: ERROR_CODES.has(code) ? code : 'EXECUTION_FAILED',
    message: String(message).slice(0, 2048),
  };
}

function defaultUrl(path, sessionId, token, locationRef = globalThis.location) {
  const protocol = locationRef?.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = locationRef?.host || 'localhost';
  const url = new URL(`${protocol}//${host}${path}`);
  url.searchParams.set('sessionId', sessionId);
  url.searchParams.set('token', token);
  return url.toString();
}

/**
 * Browser half of the GEV agent bridge. It adapts the bridge's command
 * envelopes to the transport-independent command dispatcher.
 */
export function createAgentBrowserClient({
  sessionId,
  token,
  path = AGENT_BROWSER_PATH,
  url,
  location = globalThis.location,
  WebSocket = globalThis.WebSocket,
  dispatcher,
  actionRunner,
  getState,
  getHealth,
  capture,
  readTools,
  mutationTools,
  tools,
  maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
  capabilities = ['commands', 'cancel', 'events', 'capture_view'],
  reconnect = true,
  reconnectBaseMs = 250,
  reconnectMaxMs = 5_000,
  maxReconnectAttempts = Infinity,
  onEvent,
  onStateChange,
} = {}) {
  if (typeof sessionId !== 'string' || !SESSION_RE.test(sessionId))
    throw new TypeError('sessionId is required');
  if (typeof token !== 'string' || !token)
    throw new TypeError('token is required');
  if (typeof WebSocket !== 'function')
    throw new TypeError('WebSocket is required');
  const commandDispatcher =
    dispatcher ||
    createAgentCommandDispatcher({
      actionRunner,
      getState,
      getHealth,
      capture,
      readTools,
      mutationTools,
      tools,
    });
  if (!commandDispatcher || typeof commandDispatcher.dispatch !== 'function')
    throw new TypeError('dispatcher.dispatch is required');

  let socket = null;
  let destroyed = false;
  let reconnectTimer = null;
  let attempts = 0;
  const active = new Map();
  const endpoint = url || defaultUrl(path, sessionId, token, location);

  const state = (value) => {
    onStateChange?.(value);
  };
  const send = (message) => {
    if (socket?.readyState !== OPEN) return false;
    const encodedMessage = encodeEnvelope(message, maxMessageBytes);
    if (!encodedMessage) return false;
    try {
      socket.send(encodedMessage.encoded);
    } catch {
      return false;
    }
    return true;
  };
  const respond = (id, response) => {
    if (response?.ok) {
      const message = {
        type: 'gev:response',
        id,
        sessionId,
        result: response.result,
      };
      if (send(message)) return;
      send({
        type: 'gev:response',
        id,
        error: errorValue('RESULT_TOO_LARGE', 'Command result is too large'),
      });
    } else {
      send({
        type: 'gev:response',
        id,
        error:
          response?.error || errorValue('EXECUTION_FAILED', 'Command failed'),
      });
    }
  };
  const execute = (message) => {
    const id = message.id;
    if (typeof id !== 'string' || !ID_RE.test(id)) {
      send({
        type: 'gev:error',
        code: 'INVALID_MESSAGE',
        message: 'Command id is required',
      });
      return;
    }
    if (active.has(id)) {
      respond(id, {
        ok: false,
        error: errorValue('DUPLICATE_ID', 'Command id is already active'),
      });
      return;
    }
    const controller = new AbortController();
    active.set(id, controller);
    const request = {
      id,
      sessionId,
      tool: message.name || message.tool,
      arguments: message.args ?? message.arguments ?? {},
      ...(typeof message.mutation === 'boolean'
        ? { mutation: message.mutation }
        : {}),
    };
    Promise.resolve(
      commandDispatcher.dispatch(request, { signal: controller.signal }),
    )
      .then((response) => respond(id, response))
      .catch((cause) =>
        respond(id, {
          ok: false,
          error: errorValue(
            cause?.code || 'EXECUTION_FAILED',
            cause?.message || String(cause),
          ),
        }),
      )
      .finally(() => active.delete(id));
  };
  const receive = (raw) => {
    if (byteLength(raw) > maxMessageBytes) {
      socket?.close(1009, 'message too large');
      return;
    }
    let message;
    try {
      message = decode(raw);
    } catch {
      send({
        type: 'gev:error',
        code: 'INVALID_MESSAGE',
        message: 'Message must be an object',
      });
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      send({
        type: 'gev:error',
        code: 'INVALID_MESSAGE',
        message: 'Message must be an object',
      });
      return;
    }
    if (
      message.version !== undefined &&
      message.version !== GEV_PROTOCOL_VERSION
    ) {
      send({
        type: 'gev:error',
        code: 'PROTOCOL_VERSION_UNSUPPORTED',
        message: 'Unsupported protocol version',
      });
      return;
    }
    if (
      message.type?.startsWith?.('gev:') &&
      !PROTOCOL_TYPES.has(message.type)
    ) {
      send({
        type: 'gev:error',
        code: 'INVALID_MESSAGE',
        message: 'Unsupported message type',
      });
      return;
    }
    if (message.type === 'gev:command') {
      execute(message);
      return;
    }
    if (message.type === 'gev:cancel' && typeof message.id === 'string') {
      active.get(message.id)?.abort();
      return;
    }
    if (message.type === 'gev:ping') {
      send({
        type: 'gev:pong',
        ...(typeof message.id === 'string' && ID_RE.test(message.id)
          ? { id: message.id }
          : {}),
      });
      return;
    }
    if (message.type === 'registered') {
      state({ type: 'registered', sessionId: message.sessionId });
      return;
    }
    onEvent?.(message);
  };
  const scheduleReconnect = () => {
    if (
      destroyed ||
      !reconnect ||
      attempts >= maxReconnectAttempts ||
      reconnectTimer
    )
      return;
    const delay = Math.min(reconnectMaxMs, reconnectBaseMs * 2 ** attempts++);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    state({ type: 'reconnecting', delay, attempt: attempts });
  };
  const connect = () => {
    if (destroyed || socket?.readyState === OPEN) return socket;
    state({ type: 'connecting' });
    const current = new WebSocket(endpoint);
    socket = current;
    const opened = () => {
      attempts = 0;
      send({
        type: 'gev:hello',
        version: GEV_PROTOCOL_VERSION,
        sessionId,
        capabilities: Array.isArray(capabilities)
          ? capabilities.slice(0, 256)
          : [],
      });
      state({ type: 'open' });
    };
    const closed = () => {
      if (socket !== current) return;
      socket = null;
      // A response can only be delivered on the socket that issued the
      // command. Abort work when that socket disappears so reconnects do not
      // leave stale actions mutating the new session.
      for (const controller of active.values()) controller.abort();
      active.clear();
      state({ type: 'closed' });
      scheduleReconnect();
    };
    const failed = (event) => {
      onEvent?.({ type: 'error', error: event });
    };
    const message = (event) => receive(event.data);
    if (typeof current.addEventListener === 'function') {
      current.addEventListener('open', opened);
      current.addEventListener('message', message);
      current.addEventListener('error', failed);
      current.addEventListener('close', closed);
    } else {
      current.onopen = opened;
      current.onmessage = (event) => receive(event.data ?? event);
      current.onerror = failed;
      current.onclose = closed;
    }
    return current;
  };
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    for (const controller of active.values()) controller.abort();
    active.clear();
    commandDispatcher.destroy?.();
    socket?.close(1000, 'client destroyed');
    socket = null;
    state({ type: 'destroyed' });
  };
  const client = {
    connect,
    destroy,
    send,
    receive,
    get socket() {
      return socket;
    },
    get endpoint() {
      return endpoint;
    },
    get isDestroyed() {
      return destroyed;
    },
  };
  connect();
  return Object.freeze(client);
}
