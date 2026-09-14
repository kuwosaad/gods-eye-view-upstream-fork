/** Versioned, bounded wire contract shared by the GEV agent transports. */
export const GEV_PROTOCOL_VERSION = 1;
export const GEV_MAX_MESSAGE_BYTES = 256 * 1024;
export const GEV_MAX_CAPABILITIES = 256;
export const GEV_MAX_STRING_BYTES = 4096;

export const GEV_ERROR_CODES = Object.freeze([
  'INVALID_MESSAGE', 'INVALID_REQUEST', 'UNAUTHORIZED', 'SESSION_NOT_FOUND',
  'SESSION_CLOSED', 'UNKNOWN_TOOL', 'EXECUTION_FAILED', 'REQUEST_TIMEOUT',
  'CANCELLED', 'ABORTED', 'DISCONNECTED', 'DESTROYED', 'LEASED', 'TOOL_NOT_FOUND',
  'MESSAGE_TOO_LARGE', 'PROTOCOL_VERSION_UNSUPPORTED', 'BRIDGE_CLOSED',
  'PENDING_LIMIT', 'RESULT_TOO_LARGE', 'DUPLICATE_ID', 'UNAVAILABLE',
  'QUEUE_FULL', 'INVALID_ARGUMENTS', 'QUOTA_EXCEEDED', 'SESSION_REQUIRED',
  'ACCESS_DENIED', 'SESSION_EXISTS', 'SESSION_QUOTA', 'RESOURCE_NOT_FOUND',
  'LEASE_OWNER_REQUIRED', 'CAPABILITY_UNAVAILABLE', 'REMOTE_ERROR',
  'ARTIFACT_NOT_FOUND', 'INVALID_ARTIFACT', 'INVALID_ARTIFACT_ID',
]);

const TYPES = new Set(['gev:hello', 'gev:command', 'gev:cancel', 'gev:response', 'gev:error', 'gev:event', 'gev:ping', 'gev:pong', 'registered']);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;

function fail(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function string(value, name, max = GEV_MAX_STRING_BYTES) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > max) {
    throw fail('INVALID_MESSAGE', `${name} must be a non-empty bounded string`);
  }
  return value;
}

function id(value, name = 'id') {
  const result = string(value, name, 128);
  if (!ID_RE.test(result)) throw fail('INVALID_MESSAGE', `${name} has an invalid format`);
  return result;
}

function session(value) {
  const result = string(value, 'sessionId', 96);
  if (!SESSION_RE.test(result)) throw fail('INVALID_MESSAGE', 'sessionId has an invalid format');
  return result;
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('INVALID_MESSAGE', `${name} must be an object`);
  return value;
}

function boundedJson(value, name) {
  try {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > GEV_MAX_MESSAGE_BYTES) throw fail('MESSAGE_TOO_LARGE', `${name} exceeds message limit`);
  } catch (error) {
    if (error?.code) throw error;
    throw fail('INVALID_MESSAGE', `${name} is not JSON serializable`);
  }
  return value;
}

export function validateMessage(raw) {
  const value = object(raw, 'message');
  const type = string(value.type, 'type', 32);
  if (!TYPES.has(type)) throw fail('INVALID_MESSAGE', `unsupported message type '${type}'`);
  if (value.version !== undefined && value.version !== GEV_PROTOCOL_VERSION) {
    throw fail('PROTOCOL_VERSION_UNSUPPORTED', `unsupported protocol version '${value.version}'`);
  }
  if (type === 'registered') {
    session(value.sessionId);
  } else if (type === 'gev:hello') {
    if (value.version !== GEV_PROTOCOL_VERSION) throw fail('PROTOCOL_VERSION_UNSUPPORTED', 'hello must declare protocol version');
    session(value.sessionId);
    if (!Array.isArray(value.capabilities) || value.capabilities.length > GEV_MAX_CAPABILITIES) throw fail('INVALID_MESSAGE', 'capabilities must be a bounded array');
    value.capabilities.forEach((capability) => string(capability, 'capability', 128));
  } else if (type === 'gev:command') {
    id(value.id); if (value.sessionId !== undefined) session(value.sessionId); string(value.name, 'name', 128);
    if (value.args !== undefined) boundedJson(object(value.args, 'args'), 'args');
    if (value.mutation !== undefined && typeof value.mutation !== 'boolean') throw fail('INVALID_MESSAGE', 'mutation must be boolean');
  } else if (type === 'gev:cancel') {
    id(value.id); if (value.sessionId !== undefined) session(value.sessionId);
  } else if (type === 'gev:response') {
    id(value.id); if (value.sessionId !== undefined) session(value.sessionId);
    if (!Object.hasOwn(value, 'result') && !Object.hasOwn(value, 'error')) throw fail('INVALID_MESSAGE', 'response requires result or error');
    if (Object.hasOwn(value, 'error')) validateError(value.error);
    if (Object.hasOwn(value, 'result')) boundedJson(value.result, 'result');
  } else if (type === 'gev:error') {
    if (value.id !== undefined) id(value.id);
    if (value.sessionId !== undefined) session(value.sessionId);
    validateError(value);
  } else if (type === 'gev:event') {
    session(value.sessionId); string(value.event, 'event', 128);
    if (value.payload !== undefined) boundedJson(value.payload, 'payload');
  } else {
    if (value.id !== undefined) id(value.id);
    if (value.sessionId !== undefined) session(value.sessionId);
  }
  return boundedJson(value, 'message');
}

function validateError(value) {
  const error = object(value, 'error');
  const code = string(error.code, 'error.code', 64);
  if (!GEV_ERROR_CODES.includes(code)) throw fail('INVALID_MESSAGE', `unknown error code '${code}'`);
  string(error.message, 'error.message', 2048);
  if (error.details !== undefined) boundedJson(error.details, 'error.details');
  return error;
}

export function parseMessage(data, maxBytes = GEV_MAX_MESSAGE_BYTES) {
  const bytes = Buffer.byteLength(typeof data === 'string' ? data : data instanceof Buffer ? data : String(data));
  if (bytes > maxBytes) throw fail('MESSAGE_TOO_LARGE', 'message exceeds message limit');
  let value;
  try { value = JSON.parse(typeof data === 'string' ? data : data.toString()); }
  catch { throw fail('INVALID_MESSAGE', 'message is not valid JSON'); }
  return validateMessage(value);
}

export function encodeMessage(message) {
  validateMessage(message);
  const encoded = JSON.stringify(message);
  if (Buffer.byteLength(encoded) > GEV_MAX_MESSAGE_BYTES) throw fail('MESSAGE_TOO_LARGE', 'message exceeds message limit');
  return encoded;
}

export function protocolError(code, message, details) {
  if (!GEV_ERROR_CODES.includes(code)) throw new TypeError(`unknown GEV error code '${code}'`);
  const result = {
    type: 'gev:error', version: GEV_PROTOCOL_VERSION, code,
    message: String(message).slice(0, 2048),
    ...(details === undefined ? {} : { details }),
  };
  // Keep every locally generated error inside the same wire bounds.
  return validateMessage(result);
}
