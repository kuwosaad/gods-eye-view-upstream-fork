import { randomUUID, timingSafeEqual } from 'node:crypto';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { GEV_AGENT_TOOL_CATALOG } from '../../src/agent/toolCatalog.js';
import { GEV_ERROR_CODES } from '../agent-bridge/protocol.js';

export const MCP_PATH = '/mcp';
export const MCP_MAX_BODY_BYTES = 1024 * 1024;
export const MCP_MAX_SESSIONS = 64;
export const MCP_MAX_CAPTURE_BYTES = 256 * 1024;
const MCP_METHODS = new Set(['GET', 'POST', 'DELETE']);
const MCP_JSON_CONTENT_TYPE = /^application\/json(?:\s*;|$)/i;

function zodValue(spec = {}) {
  let value;
  if (spec.const !== undefined) value = z.literal(spec.const);
  else if (spec.enum?.length)
    value =
      spec.enum.length === 1
        ? z.literal(spec.enum[0])
        : z.union(spec.enum.map((item) => z.literal(item)));
  else if (spec.type === 'string') value = z.string();
  else if (spec.type === 'number') value = z.number();
  else if (spec.type === 'integer') value = z.number().int();
  else if (spec.type === 'boolean') value = z.boolean();
  else if (spec.type === 'array') value = z.array(zodValue(spec.items || {}));
  else if (spec.type === 'object' || spec.properties) {
    const nested = zodShape(spec);
    value =
      spec.additionalProperties === false
        ? z.strictObject(nested)
        : z.object(nested);
  } else value = z.unknown();
  if (spec.minLength !== undefined)
    value = value.min?.(spec.minLength) ?? value;
  if (spec.maxLength !== undefined)
    value = value.max?.(spec.maxLength) ?? value;
  if (spec.minimum !== undefined) value = value.min?.(spec.minimum) ?? value;
  if (spec.maximum !== undefined) value = value.max?.(spec.maximum) ?? value;
  if (spec.minItems !== undefined) value = value.min?.(spec.minItems) ?? value;
  if (spec.maxItems !== undefined) value = value.max?.(spec.maxItems) ?? value;
  return value;
}

function zodShape(schema = {}) {
  const required = new Set(schema.required || []);
  const shape = {};
  for (const [name, spec] of Object.entries(schema.properties || {})) {
    const value = zodValue(spec);
    shape[name] = required.has(name) ? value : value.optional();
  }
  return shape;
}

function result(value) {
  const structuredContent =
    value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : { value };
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent,
  };
}

function failed(error) {
  return {
    ...result({
      error: error?.message || String(error),
      code: error?.code || 'MCP_ERROR',
    }),
    isError: true,
  };
}

function publicError(error, fallback = 'MCP request failed') {
  const requestedCode = typeof error?.code === 'string' ? error.code : 'MCP_ERROR';
  // Codes are part of the public protocol; exception messages are not.  In
  // particular, provider errors can contain URLs, credentials, or stack
  // details, so never forward their message through the MCP boundary.
  const safeCodes = new Set([
    ...GEV_ERROR_CODES,
    'QUEUE_FULL',
    'PROVIDER_FAILURE',
    'PERMISSION_DENIED',
  ]);
  const output = new Error(fallback);
  output.code = safeCodes.has(requestedCode) ? requestedCode : 'MCP_ERROR';
  return output;
}

function localHost(host) {
  try {
    const hostname = new URL(`http://${String(host || '')}`).hostname;
    return (
      hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
    );
  } catch {
    return false;
  }
}

function authorized(req, { token = process.env.GEV_AGENT_TOKEN || '' } = {}) {
  if (!token) return false;
  if (!localHost(req.headers?.host)) return false;
  const forwarded = [
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-proto',
  ];
  if (forwarded.some((name) => req.headers?.[name])) return false;
  const peer = String(req.socket?.remoteAddress || '').replace(/^::ffff:/i, '');
  if (
    !peer ||
    (peer !== '127.0.0.1' && peer !== '::1' && peer !== '0:0:0:0:0:0:0:1')
  )
    return false;
  const origin = req.headers?.origin;
  if (origin) {
    try {
      if (!localHost(new URL(origin).host)) return false;
    } catch {
      return false;
    }
  }
  const match = /^Bearer\s+(.+)$/i.exec(
    String(req.headers?.authorization || ''),
  );
  if (!match) return false;
  const expected = Buffer.from(String(token));
  const actual = Buffer.from(match[1]);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function readBody(req, maxBytes) {
  if (req.body !== undefined) return req.body;
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > maxBytes) {
      const error = new Error('Request body is too large');
      error.code = 'BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Request body must be valid JSON');
    error.code = 'INVALID_JSON';
    throw error;
  }
}

function captureResult(value) {
  // Dispatchers return the stable envelope, while older adapters may return
  // the image payload directly.
  const payload = value?.data && typeof value.data === 'object' ? value.data : value;
  const image = payload?.image || payload;
  const data = image?.data || image?.base64;
  let decodedBytes;
  try {
    decodedBytes = typeof data === 'string' ? Buffer.from(data, 'base64').byteLength : 0;
  } catch {
    decodedBytes = 0;
  }
  if (typeof data !== 'string' || decodedBytes === 0 || decodedBytes > MCP_MAX_CAPTURE_BYTES) throw new Error('Capture returned no image or exceeded the image limit');
  const mimeType = image.mimeType || image.contentType || 'image/png';
  if (!/^image\/(png|jpeg|webp)$/.test(mimeType)) throw new Error('Capture returned an unsupported image type');
  const metadata = payload?.metadata || image.metadata;
  const artifacts = payload?.artifacts || image.artifacts;
  const envelopeFields = value && typeof value === 'object' ? { ...value } : {};
  const payloadFields = payload && typeof payload === 'object' ? { ...payload } : {};
  for (const fields of [envelopeFields, payloadFields]) {
    delete fields.data;
    delete fields.image;
    delete fields.base64;
  }
  const structuredContent = { ...envelopeFields, ...payloadFields, mimeType, ...(metadata === undefined ? {} : { metadata }), ...(artifacts === undefined ? {} : { artifacts }) };
  return { content: [{ type: 'image', data, mimeType }, ...(metadata ? [{ type: 'text', text: JSON.stringify(metadata) }] : [])], structuredContent };
}

function resourceContents(uri, value) {
  return { contents: [{ uri, mimeType: 'application/json', text: typeof value === 'string' ? value : JSON.stringify(value) }] };
}

function artifactContents(uri, value) {
  if (value && typeof value === 'object' && value.data != null) {
    const data = Buffer.isBuffer(value.data)
      ? value.data
      : value.data instanceof Uint8Array
        ? Buffer.from(value.data)
        : Buffer.from(String(value.data));
    return {
      contents: [
        {
          uri,
          mimeType: value.mimeType || 'application/octet-stream',
          blob: data.toString('base64'),
        },
      ],
    };
  }
  return resourceContents(uri, value);
}

function makeServer({ catalog, dispatch, listSessions, getState, resources = {}, principalId, sessionManagement = {}, serverTools = [] }) {
  const server = new McpServer({ name: 'gods-eye-view', version: '0.1.1' });
  const invoke = async (name, args, extra) => {
    const sessionId = args?.sessionId ?? args?.session_id;
    const call = await dispatch(
      { id: randomUUID(), sessionId, tool: name, arguments: args || {} },
      { signal: extra?.signal, callerId: principalId, principalId },
    );
    if (call?.ok === false || call?.error) {
      return failed(publicError(call.error, 'Tool execution failed'));
    }
    return result(call?.result === undefined ? call : call.result);
  };
  const names = new Set(['gev_list_sessions', 'gev_get_state']);
  for (const tool of catalog) {
    const name = tool.name;
    if (!name || names.has(name))
      throw new TypeError(
        `Duplicate or invalid MCP tool name: ${name || '(empty)'}`,
      );
    names.add(name);
    const inputSchema = zodShape(tool.parameters);
    // Session selection belongs to the MCP adapter, so every catalog action
    // can target a browser session without changing the canonical catalog.
    inputSchema.sessionId = z.string().optional();
    server.registerTool(
      name,
      { description: tool.description, inputSchema },
      (args, extra) => invoke(name, args, extra),
    );
  }
  server.registerTool(
    'gev_list_sessions',
    {
      description: 'List connected God’s Eye View browser sessions.',
      inputSchema: {},
    },
    async () => {
      try { return result(await listSessions({ principalId })); }
      catch (error) { throw publicError(error, 'Session listing failed'); }
    },
  );
  server.registerTool('gev_whoami', { description: 'Return the identity of this MCP client.', inputSchema: {} }, async () => result({ principalId }));
  server.registerTool(
    'gev_get_state',
    {
      description:
        'Read the current state of a God’s Eye View browser session.',
      inputSchema: { sessionId: z.string().optional() },
    },
    async (args) => {
      try { return result(await getState(args?.sessionId, { principalId })); }
      catch (error) { return failed(publicError(error, 'State observation failed')); }
    },
  );
  server.registerTool('gev_capture_view', {
    description: 'Capture the current God’s Eye View viewport as an image.',
    inputSchema: { sessionId: z.string().optional(), format: z.enum(['png', 'jpeg', 'webp']).optional() },
  }, async (args, extra) => {
    try {
      const sessionId = args?.sessionId;
      const call = await dispatch({ id: randomUUID(), sessionId, tool: 'gev_capture_view', arguments: args || {} }, { signal: extra?.signal, callerId: principalId, principalId });
      if (call?.ok === false || call?.error) return failed(publicError(call.error, 'Capture failed'));
      return captureResult(call?.result === undefined ? call : call.result);
    } catch (error) {
      return failed(publicError(error, 'Capture failed'));
    }
  });
  for (const kind of ['state', 'layers', 'entities', 'annotations']) {
    const callback = resources[kind];
    if (typeof callback !== 'function') continue;
    const template = new ResourceTemplate(`gev://sessions/{sessionId}/${kind}`, { list: undefined });
    server.registerResource(`gev_${kind}`, template, { description: `Current God’s Eye View ${kind}.`, mimeType: 'application/json', ...(resources.subscribe ? { subscribe: true } : {}) }, async (uri, variables) => {
      try { return resourceContents(uri.href, await callback(String(variables.sessionId), { principalId })); }
      catch (error) { throw publicError(error, 'Resource read failed'); }
    });
  }
  const artifactCallback = resources.artifacts;
  if (typeof artifactCallback === 'function') {
    const template = new ResourceTemplate('gev://sessions/{sessionId}/artifacts/{artifactId}', { list: undefined });
    server.registerResource('gev_artifacts', template, { description: 'A God’s Eye View session artifact.' }, async (uri, variables) => {
      try { return artifactContents(uri.href, await artifactCallback(String(variables.sessionId), String(variables.artifactId), { principalId })); }
      catch (error) { throw publicError(error, 'Artifact read failed'); }
    });
  }
  const management = [['create_session', 'createSession'], ['join_session', 'joinSession'], ['share_session', 'shareSession'], ['close_session', 'closeSession'], ['acquire_lease', 'acquireLease'], ['release_lease', 'releaseLease']];
  const managementSchemas = {
    create_session: { sessionId: z.string().optional() },
    join_session: { sessionId: z.string() },
    share_session: { sessionId: z.string(), invitedPrincipalId: z.string() },
    close_session: { sessionId: z.string() },
    acquire_lease: { sessionId: z.string(), ttlMs: z.number().int().min(100).max(86_400_000).optional() },
    release_lease: { sessionId: z.string() },
  };
  for (const [name, key] of management) if (typeof sessionManagement[key] === 'function') {
    server.registerTool(`gev_${name}`, { description: `Manage a God’s Eye View session (${name}).`, inputSchema: managementSchemas[name] }, async (args) => {
      try { return result(await sessionManagement[key](args, { principalId })); }
      catch (error) { return failed(publicError(error, 'Session operation failed')); }
    });
  }
  const reserved = new Set([...names, 'gev_capture_view', 'gev_whoami', ...management.map(([name]) => `gev_${name}`)]);
  const entries = Array.isArray(serverTools) ? serverTools : Object.entries(serverTools).map(([name, value]) => ({ name, ...value }));
  for (const tool of entries) {
    if (!tool?.name || reserved.has(tool.name) || typeof tool.handler !== 'function') throw new TypeError(`Invalid or duplicate server MCP tool: ${tool?.name || '(empty)'}`);
    reserved.add(tool.name);
    const inputSchema = tool.inputSchema?.properties ? zodShape(tool.inputSchema) : (tool.inputSchema || {});
    server.registerTool(tool.name, { description: tool.description || '', inputSchema, ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}) }, async (args, extra) => {
      let value;
      try {
        value = await tool.handler(args || {}, { signal: extra?.signal, principalId });
      } catch (error) {
        return failed(publicError(error, 'Server tool execution failed'));
      }
      if (value?.content) return value;
      if (value?.image || value?.base64) return captureResult(value);
      if (Array.isArray(value?.resourceLinks)) {
        const { resourceLinks, ...structuredContent } = value;
        return {
          content: resourceLinks.map((link) => ({
            type: 'resource_link',
            ...link,
          })),
          structuredContent: { ...structuredContent, links: resourceLinks },
        };
      }
      return result(value);
    });
  }
  return server;
}

/** Create the single MCP middleware used by both Vite dev and preview servers. */
export function createMcpMiddleware({
  catalog = GEV_AGENT_TOOL_CATALOG,
  dispatch,
  dispatcher,
  listSessions = () => [],
  getState = () => null,
  resources = {},
  sessionManagement = {},
  serverTools = [],
  joinSession,
  shareSession,
  closeSession,
  acquireLease,
  releaseLease,
  token,
  maxBodyBytes = MCP_MAX_BODY_BYTES,
} = {}) {
  const callDispatch = dispatch || dispatcher?.dispatch;
  if (typeof callDispatch !== 'function')
    throw new TypeError('MCP dispatch function is required');
  const transports = new Map();
  let closed = false;
  const pendingInitializations = new Set();
  const options = { token };
  const handler = async (req, res) => {
    if (closed) {
      res.statusCode = 503;
      res.end('MCP server is shutting down');
      return;
    }
    if (!authorized(req, options)) {
      res.statusCode = 401;
      res.setHeader('WWW-Authenticate', 'Bearer');
      res.end('Unauthorized');
      return;
    }
    if (!MCP_METHODS.has(req.method)) {
      res.statusCode = 405;
      res.setHeader('Allow', [...MCP_METHODS].join(', '));
      res.end('Method not allowed');
      return;
    }
    if (req.method === 'POST') {
      const declaredLength = Number(req.headers?.['content-length']);
      if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
        res.statusCode = 413;
        res.end('Request body is too large');
        return;
      }
      const contentType = String(req.headers?.['content-type'] || '');
      if (!MCP_JSON_CONTENT_TYPE.test(contentType)) {
        res.statusCode = 415;
        res.end('Content-Type must be application/json');
        return;
      }
    }
    let body;
    if (req.method === 'POST') {
      try {
        body = await readBody(req, maxBodyBytes);
      } catch (error) {
        res.statusCode = error.code === 'BODY_TOO_LARGE' ? 413 : 400;
        res.end(
          error.code === 'BODY_TOO_LARGE' ? error.message : 'Invalid JSON body',
        );
        return;
      }
    }
    const sessionHeader = req.headers?.['mcp-session-id'];
    let pair = sessionHeader && transports.get(String(sessionHeader));
    if (sessionHeader && !pair) {
      res.statusCode = 404;
      res.end('Unknown MCP session');
      return;
    }
    // Stateful transports must only be created for a genuine initialize
    // request. This prevents malformed/no-session traffic from accumulating
    // orphaned MCP servers.
    if (
      !pair &&
      req.method === 'POST' &&
      body?.jsonrpc === '2.0' &&
      body.method === 'initialize'
    ) {
      if (transports.size + pendingInitializations.size >= MCP_MAX_SESSIONS) {
        res.statusCode = 503;
        res.end('MCP session capacity reached');
        return;
      }
      let server;
      const principalId = randomUUID();
      try {
        const legacyManagement = Object.fromEntries(
          Object.entries({
            joinSession,
            shareSession,
            closeSession,
            acquireLease,
            releaseLease,
          }).filter(([, value]) => typeof value === 'function'),
        );
        server = makeServer({
          catalog,
          dispatch: callDispatch,
          listSessions,
          getState,
          resources,
          sessionManagement: { ...sessionManagement, ...legacyManagement },
          serverTools,
          principalId,
        });
      } catch {
        res.statusCode = 500;
        res.end('MCP server configuration is invalid');
        return;
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      pair = { server, transport, principalId };
      pendingInitializations.add(pair);
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
        pendingInitializations.delete(pair);
      };
      try {
        await server.connect(transport);
      } catch (error) {
        pendingInitializations.delete(pair);
        await transport.close().catch(() => {});
        await server.close().catch(() => {});
        const safe = publicError(error);
        res.statusCode = 500;
        res.end(safe.message);
        return;
      }
    }
    if (!pair) {
      res.statusCode = 400;
      res.end('MCP session is not initialized');
      return;
    }
    try {
      await pair.transport.handleRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('MCP request failed');
      }
    }
    if (pair.transport.sessionId)
      transports.set(pair.transport.sessionId, pair);
  };
  handler.close = async () => {
    closed = true;
    const pairs = [
      ...new Set([...transports.values(), ...pendingInitializations]),
    ];
    await Promise.all(
      pairs.map(async ({ server, transport }) => {
        await transport.close().catch(() => {});
        await server.close().catch(() => {});
      }),
    );
    transports.clear();
    pendingInitializations.clear();
  };
  handler.notifyResourceUpdated = async (uri) => Promise.all(
    [...transports.values()].map(({ server }) => server.server.sendResourceUpdated({ uri })),
  );
  return handler;
}

export function createMcpPlugin(options = {}) {
  const middleware = createMcpMiddleware(options);
  const install = (server) => server.middlewares.use(MCP_PATH, middleware);
  return {
    name: 'gev-mcp',
    configureServer: install,
    configurePreviewServer: install,
    closeBundle: () => middleware.close(),
  };
}

export { zodShape, authorized, captureResult };
