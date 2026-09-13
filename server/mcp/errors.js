export class McpError extends Error {
  constructor(message, code = 'MCP_ERROR', details) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export class TimeoutError extends McpError {
  constructor(message = 'Command timed out') {
    super(message, 'TIMEOUT');
    this.name = 'TimeoutError';
  }
}

export class AbortError extends McpError {
  constructor(message = 'Command cancelled') {
    super(message, 'ABORTED');
    this.name = 'AbortError';
  }
}
