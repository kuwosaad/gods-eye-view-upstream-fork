import { McpError } from './errors.js';

const PUBLIC_MESSAGES = Object.freeze({
  MCP_ERROR: 'MCP request failed',
  INVALID_REQUEST: 'Invalid request',
  TOOL_NOT_FOUND: 'Unknown tool',
  INVALID_ARGUMENTS: 'Arguments must be an object',
  QUOTA_EXCEEDED: 'Caller quota exceeded',
  ABORTED: 'Command cancelled',
  SESSION_CLOSED: 'Session is closed',
  SESSION_REQUIRED: 'A browser session is required',
  SESSION_NOT_FOUND: 'Session not found',
  ACCESS_DENIED: 'Access denied',
  SESSION_EXISTS: 'Session already exists',
  SESSION_QUOTA: 'Principal session quota exceeded',
  RESOURCE_NOT_FOUND: 'Resource not found',
  DISCONNECTED: 'Browser disconnected',
  LEASED: 'Session is controlled by another caller',
  QUEUE_FULL: 'Session command queue is full',
  REQUEST_TIMEOUT: 'Command timed out',
  ARTIFACT_NOT_FOUND: 'Artifact not found',
  INVALID_ARTIFACT: 'Artifact is invalid',
  INVALID_ARTIFACT_ID: 'Artifact identifier is invalid',
  PROVIDER_FAILURE: 'Provider request failed',
});

export function textResult(data, { isError = false, stateVersion } = {}) {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  const structured =
    typeof data === 'object' && data !== null ? { ...data } : { value: data };
  if (stateVersion !== undefined) structured.stateVersion = stateVersion;
  return {
    content: [{ type: 'text', text }],
    structuredContent: structured,
    ...(isError ? { isError: true } : {}),
  };
}

export function errorResult(error) {
  const requestedCode = typeof error?.code === 'string' ? error.code : 'MCP_ERROR';
  const code = Object.hasOwn(PUBLIC_MESSAGES, requestedCode) ? requestedCode : 'MCP_ERROR';
  // Error text is a public protocol surface. Never forward provider, path, or
  // credential-bearing exception messages to an untrusted caller.
  const message = PUBLIC_MESSAGES[code];
  let details;
  if (code === 'QUOTA_EXCEEDED' && error?.details && typeof error.details === 'object') {
    const remaining = error.details.remaining ?? error.details;
    if (remaining && typeof remaining === 'object') {
      details = Object.fromEntries(['calls', 'bytes', 'runtimeMs'].map((key) => [key, Number.isFinite(remaining[key]) ? Math.max(0, remaining[key]) : 0]));
    }
  }
  return textResult(
    {
      error: message,
      code,
      ...(details === undefined ? {} : { details }),
    },
    { isError: true },
  );
}

/** Adapts a plain tool catalog to MCP list/call semantics. */
export class ToolDispatcher {
  constructor({ registry, tools = {}, quotaGuard = null }) {
    this.registry = registry;
    this.tools = new Map(Object.entries(tools));
    this.quotaGuard = quotaGuard;
  }
  listTools() {
    return [...this.tools].map(([name, tool]) => ({
      name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema ?? { type: 'object' },
    }));
  }
  async executeRaw(name, args = {}, {
    signal,
    callerId = 'anonymous',
    afterMutation = null,
  } = {}) {
    const tool = this.tools.get(name);
    if (!tool) throw new McpError(`Unknown tool '${name}'`, 'TOOL_NOT_FOUND');
    if (!args || typeof args !== 'object' || Array.isArray(args))
      throw new McpError('Arguments must be an object', 'INVALID_ARGUMENTS');
    const requestedSessionId = args.sessionId ?? args.session_id;
    const needsSession = requestedSessionId || tool.mutation || tool.sessionRequired;
    const session = needsSession ? this.registry.resolve(requestedSessionId, callerId) : null;
    const input = { ...args };
    delete input.sessionId;
    delete input.session_id;
    const costClass = tool.costClass ?? tool.metadata?.costClass ?? tool.quotaClass;
    const startedAt = Date.now();
    let quotaAccepted = false;
    if (this.quotaGuard) {
      let bytes = 0;
      try { bytes = Buffer.byteLength(JSON.stringify(input)); } catch { throw new McpError('Arguments must be valid JSON', 'INVALID_ARGUMENTS'); }
      const quota = this.quotaGuard.check(callerId, { bytes, costClass });
      if (!quota.allowed) throw new McpError('Caller quota exceeded', 'QUOTA_EXCEEDED', quota.remaining);
      quotaAccepted = true;
    }
    if (session?.leaseOwner && session.leaseOwner !== callerId)
      throw new McpError(`Session is controlled by '${session.leaseOwner}'`, 'LEASED');
    const execute = () => signal?.aborted
      ? Promise.reject(new McpError('Command cancelled', 'ABORTED'))
      : session?.closed
        ? Promise.reject(new McpError('Session is closed', 'SESSION_CLOSED'))
        : tool.handler({ args: input, session, signal, callerId });
    try {
      let data;
      let observedState;
      if (session && tool.mutation) {
        // Keep the observation inside the same serialized queue slot as the
        // mutation. Reading state after runMutation resolves allows the next
        // mutation to complete first and produces a mismatched snapshot.
        const result = await session.runMutation(execute, { signal, afterMutation });
        if (afterMutation) {
          data = result.value;
          observedState = result.observed;
        } else {
          data = result;
        }
      } else {
        data = await execute();
      }
      return {
        tool,
        session,
        sessionId: session?.id ?? requestedSessionId ?? null,
        stateVersion: session?.stateVersion,
        data,
        ...(afterMutation ? { observedState } : {}),
      };
    } finally {
      if (quotaAccepted)
        this.quotaGuard.recordRuntime?.(callerId, {
          costClass,
          runtimeMs: Date.now() - startedAt,
        });
    }
  }
  async callTool(name, args = {}, { signal, callerId = 'anonymous' } = {}) {
    try {
      const { data, stateVersion } = await this.executeRaw(name, args, { signal, callerId });
      return textResult(data, { stateVersion });
    } catch (error) {
      return errorResult(error);
    }
  }
}
