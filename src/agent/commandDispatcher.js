import { captureCesiumViewport } from './captureView.js';
import { isAgentToolReadOnly } from './toolCatalog.js';

/**
 * Transport agnostic command bridge for agent clients.
 *
 * The browser transport can feed request envelopes to this object and send
 * the returned envelope back over WebSocket, postMessage, or any other link.
 * Only mutations are serialized; observation calls are allowed to overlap.
 */

const DEFAULT_READ_TOOLS = new Set([
  'get_state',
  'get_health',
  'get_current_view',
  'get_current_view_state',
  'gev_capture_view',
  'get_entity_context',
  'list_layers',
  'list_sessions',
]);
const DEFAULT_MAX_QUEUED_MUTATIONS = 256;

function error(code, message, details = undefined) {
  return {
    code,
    message,
    ...(details === undefined ? {} : { details }),
  };
}

function validId(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normaliseRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw error('INVALID_REQUEST', 'Request must be an object');
  }
  if (!validId(request.id))
    throw error('INVALID_REQUEST', 'Request id is required');
  if (!validId(request.sessionId))
    throw error('INVALID_REQUEST', 'Session id is required');
  if (!validId(request.tool))
    throw error('INVALID_REQUEST', 'Tool name is required');
  const args = request.arguments ?? {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw error('INVALID_REQUEST', 'Request arguments must be an object');
  }
  return {
    id: request.id,
    sessionId: request.sessionId,
    tool: request.tool,
    arguments: args,
    ...(typeof request.mutation === 'boolean'
      ? { mutation: request.mutation }
      : {}),
  };
}

function captureMetadata(state, health, image) {
  const layers = Array.isArray(state?.layers)
    ? state.layers
        .filter((layer) => layer?.enabled)
        .slice(0, 256)
        .map((layer) => String(layer.id || '').slice(0, 120))
        .filter(Boolean)
    : [];
  return {
    camera: state?.camera || null,
    active: {
      mapStack: state?.active?.mapStack || null,
      style: state?.active?.style || null,
      context: state?.active?.context || null,
    },
    enabledLayerIds: layers,
    timestamp: image.timestamp,
    health: health || null,
    dimensions: { width: image.width, height: image.height },
    freshFrame: Boolean(image.freshFrame),
    tileSettled: image.tileSettled === null ? null : Boolean(image.tileSettled),
  };
}

/**
 * @param {object} options
 * @param {(tool:string,args:object,options?:object)=>Promise<any>} options.actionRunner
 * @param {(sessionId:string)=>any|Promise<any>} [options.getState]
 * @param {(sessionId:string)=>any|Promise<any>} [options.getHealth]
 * @param {object} [options.capture] Browser capture options.
 * @param {Iterable<string>} [options.readTools]
 * @param {Iterable<string>} [options.mutationTools] Explicit mutation names.
 * @param {Iterable<string>|Map<string, any>|object} [options.tools] Optional tool registry for early unknown-tool errors.
 * @param {(tool:string)=>boolean} [options.isReadTool]
 * @param {number} [options.maxQueuedMutations=256] Maximum active or waiting
 * mutations per session. This bounds work submitted by a connected agent.
 * @param {(event:object)=>void} [options.onEvent]
 */
export function createAgentCommandDispatcher({
  actionRunner,
  getState = () => null,
  getHealth = () => null,
  capture = null,
  readTools = DEFAULT_READ_TOOLS,
  mutationTools = null,
  tools = null,
  isReadTool = null,
  maxQueuedMutations = DEFAULT_MAX_QUEUED_MUTATIONS,
  onEvent = null,
} = {}) {
  if (typeof actionRunner !== 'function')
    throw new TypeError('actionRunner must be a function');
  if (!Number.isInteger(maxQueuedMutations) || maxQueuedMutations < 1)
    throw new TypeError('maxQueuedMutations must be a positive integer');
  const reads = new Set(readTools);
  const mutations = mutationTools && new Set(mutationTools);
  const registeredTools = tools
    ? new Set(
        tools instanceof Map
          ? tools.keys()
          : typeof tools[Symbol.iterator] === 'function'
            ? tools
            : Object.keys(tools),
      )
    : null;
  const queues = new Map();
  let destroyed = false;

  const read = (tool, request) => {
    // The server bridge may classify a command explicitly. This avoids an
    // unknown/new tool accidentally becoming concurrent merely because its
    // name was added to a read set.
    if (typeof request?.mutation === 'boolean') return !request.mutation;
    if (typeof isReadTool === 'function') return Boolean(isReadTool(tool));
    if (isAgentToolReadOnly(tool)) return true;
    if (mutations) return !mutations.has(tool);
    return reads.has(tool);
  };

  const call = async (request, signal) => {
    if (request.tool === 'get_state') return getState(request.sessionId);
    if (request.tool === 'get_health') return getHealth(request.sessionId);
    if (request.tool === 'gev_capture_view') {
      if (!capture)
        throw error('UNAVAILABLE', 'Viewport capture is not configured');
      const image = await captureCesiumViewport({
        ...capture,
        ...(request.arguments.format
          ? { format: request.arguments.format }
          : {}),
        signal,
      });
      if (!image) return null;
      // Keep provenance separate from MCP image data. The snapshot is bounded
      // and intentionally excludes the base64 payload/data URL.
      return {
        ...image,
        metadata: captureMetadata(
          await Promise.resolve(getState(request.sessionId)),
          await Promise.resolve(getHealth(request.sessionId)),
          image,
        ),
      };
    }
    return actionRunner(request.tool, request.arguments, {
      signal,
      sessionId: request.sessionId,
    });
  };

  const dispatch = (rawRequest, { signal } = {}) => {
    let request;
    try {
      request = normaliseRequest(rawRequest);
    } catch (cause) {
      const e = cause?.code
        ? cause
        : error('INVALID_REQUEST', cause?.message || String(cause));
      return Promise.resolve({
        id: rawRequest?.id ?? null,
        sessionId: rawRequest?.sessionId ?? null,
        ok: false,
        error: e,
      });
    }
    if (destroyed)
      return Promise.resolve({
        id: request.id,
        sessionId: request.sessionId,
        ok: false,
        error: error('DESTROYED', 'Command dispatcher has been destroyed'),
      });
    if (signal?.aborted)
      return Promise.resolve({
        id: request.id,
        sessionId: request.sessionId,
        ok: false,
        error: error('ABORTED', 'Command was aborted'),
      });

    const execute = async () => {
      if (destroyed)
        return {
          id: request.id,
          sessionId: request.sessionId,
          ok: false,
          error: error('DESTROYED', 'Command dispatcher has been destroyed'),
        };
      if (signal?.aborted) throw error('ABORTED', 'Command was aborted');
      if (registeredTools && !registeredTools.has(request.tool)) {
        return {
          id: request.id,
          sessionId: request.sessionId,
          ok: false,
          error: error('UNKNOWN_TOOL', `Unknown tool: ${request.tool}`),
        };
      }
      try {
        const result = await call(request, signal);
        const response = {
          id: request.id,
          sessionId: request.sessionId,
          ok: true,
          result,
        };
        onEvent?.({ type: 'completed', request, response });
        return response;
      } catch (cause) {
        const response = {
          id: request.id,
          sessionId: request.sessionId,
          ok: false,
          error: cause?.code
            ? cause
            : error(
                signal?.aborted ? 'ABORTED' : 'EXECUTION_FAILED',
                cause?.message || String(cause),
              ),
        };
        onEvent?.({ type: 'failed', request, response });
        return response;
      }
    };

    if (read(request.tool, request)) return execute();
    const queue = queues.get(request.sessionId) || {
      tail: Promise.resolve(),
      count: 0,
    };
    if (queue.count >= maxQueuedMutations)
      return Promise.resolve({
        id: request.id,
        sessionId: request.sessionId,
        ok: false,
        error: error(
          'QUEUE_FULL',
          'Too many mutations queued for this session',
        ),
      });
    queue.count += 1;
    queues.set(request.sessionId, queue);
    const prior = queue.tail;
    const current = prior.catch(() => {}).then(execute);
    const queued = current.finally(() => {
      queue.count -= 1;
      if (queues.get(request.sessionId) === queue && queue.count === 0)
        queues.delete(request.sessionId);
    });
    queue.tail = queued;
    return current;
  };

  const destroy = () => {
    destroyed = true;
    queues.clear();
  };
  return Object.freeze({
    dispatch,
    destroy,
    isDestroyed: () => destroyed,
    get pendingSessions() {
      return queues.size;
    },
  });
}

export { normaliseRequest };
