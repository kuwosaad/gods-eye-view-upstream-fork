import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync, statSync } from 'node:fs';

const SECRET_KEY = /token|secret|password|passwd|authorization|cookie|api[-_]?key|credential/i;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const QUERY_SECRET_RE = /([?&](?:token|key|api_key|secret|password)=)[^&#\s]*/gi;
const PATH_RE = /(?:file:\/\/|(?:^|[\s"'(])(?:\.{1,2}\/|[A-Za-z]:\\|\/(?:home|tmp|var|etc|opt|srv|mnt|media|run|workspace|app)\/)[^\s"'()]*)/i;
const DATA_RE = /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/i;
const BASE64_RE = /^[A-Za-z0-9+/=_-]{128,}$/;

// Stable policy labels. Tool catalogs may map their tools to these strings without
// importing this module, which keeps the security layer dependency-free.
export const COST_CLASSES = Object.freeze(['free', 'network', 'artifact', 'expensive']);
export const DEFAULT_COST_CLASS = 'free';

export function canonicalCostClass(value) {
  return typeof value === 'string' && COST_CLASSES.includes(value) ? value : DEFAULT_COST_CLASS;
}

export function quotaDecision({ costClass = DEFAULT_COST_CLASS, limits = {}, usage = {} } = {}) {
  const key = canonicalCostClass(costClass);
  const policy = limits[key] || {};
  const finiteCount = (value) => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
  const calls = finiteCount(usage.calls) + 1;
  const bytes = finiteCount(usage.bytes);
  const runtimeMs = finiteCount(usage.runtimeMs);
  return {
    costClass: key,
    allowed: calls <= (policy.maxCalls ?? Infinity) && bytes <= (policy.maxBytes ?? Infinity) && runtimeMs <= (policy.maxRuntimeMs ?? Infinity),
    limits: { maxCalls: policy.maxCalls ?? Infinity, maxBytes: policy.maxBytes ?? Infinity, maxRuntimeMs: policy.maxRuntimeMs ?? Infinity },
  };
}

export function constantTimeEqual(expected, actual) {
  if (typeof expected !== 'string' || typeof actual !== 'string') return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function generateRuntimeToken({ bytes = 32 } = {}) {
  if (!Number.isInteger(bytes) || bytes < 16 || bytes > 128)
    throw new RangeError('token bytes must be between 16 and 128');
  return randomBytes(bytes).toString('base64url');
}

/** Read or atomically create a 0600 token file. Existing files must be owned by this user. */
export function ensureRuntimeToken({ filePath, bytes = 32, fs = null } = {}) {
  if (typeof filePath !== 'string' || !filePath) throw new TypeError('filePath is required');
  const io = fs || { readFileSync, writeFileSync, chmodSync, statSync };
  try {
    const stat = io.statSync(filePath);
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid())
      throw new Error('runtime token file is not owned by the current user');
    const value = String(io.readFileSync(filePath, 'utf8')).trim();
    if (!/^[A-Za-z0-9_-]{22,256}$/.test(value)) throw new Error('runtime token file is invalid');
    io.chmodSync(filePath, 0o600);
    return value;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const value = generateRuntimeToken({ bytes });
    try {
      io.writeFileSync(filePath, `${value}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } catch (writeError) {
      if (writeError?.code !== 'EEXIST') throw writeError;
      return ensureRuntimeToken({ filePath, bytes, fs: io });
    }
    io.chmodSync(filePath, 0o600);
    return value;
  }
}

export function redact(value, { replacement = '[REDACTED]', maxDepth = 8 } = {}, depth = 0) {
  if (depth > maxDepth) return '[TRUNCATED]';
  if (typeof value === 'string') {
    if (DATA_RE.test(value) || BASE64_RE.test(value)) return replacement;
    return value.replace(BEARER_RE, replacement).replace(QUERY_SECRET_RE, `$1${replacement}`).replace(PATH_RE, replacement);
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, { replacement, maxDepth }, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) output[key] = SECRET_KEY.test(key) ? replacement : redact(item, { replacement, maxDepth }, depth + 1);
  return output;
}

export function safeArgumentSummary(args, { maxBytes = 2048 } = {}) {
  let text;
  try { text = JSON.stringify(redact(args)); } catch { text = '[UNSERIALIZABLE]'; }
  if (typeof text !== 'string') text = String(text);
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const suffix = '...[TRUNCATED]';
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix));
  let end = Math.min(text.length, budget);
  while (end > 0 && Buffer.byteLength(text.slice(0, end)) > budget) end -= 1;
  return `${text.slice(0, end)}${suffix}`.slice(0, maxBytes);
}

const DEFAULT_LIMITS = Object.freeze({
  free: Object.freeze({ maxCalls: 120, maxBytes: 1_048_576, maxRuntimeMs: 30_000 }),
  network: Object.freeze({ maxCalls: 60, maxBytes: 4_194_304, maxRuntimeMs: 60_000 }),
  artifact: Object.freeze({ maxCalls: 30, maxBytes: 16_777_216, maxRuntimeMs: 120_000 }),
  expensive: Object.freeze({ maxCalls: 10, maxBytes: 4_194_304, maxRuntimeMs: 120_000 }),
});

export function createQuotaGuard({ maxCalls, maxBytes, maxRuntimeMs, limits, windowMs = 60_000, now = Date.now } = {}) {
  for (const [name, value] of Object.entries({ maxCalls, maxBytes, maxRuntimeMs, windowMs })) {
    if (value !== undefined && value !== Infinity && (!Number.isFinite(value) || value < 0)) throw new RangeError(`${name} must be non-negative`);
  }
  const configuredLimits = Object.fromEntries(COST_CLASSES.map((key) => [key, {
    ...DEFAULT_LIMITS[key], ...(limits?.[key] || {}),
    ...(maxCalls === undefined ? {} : { maxCalls }),
    ...(maxBytes === undefined ? {} : { maxBytes }),
    ...(maxRuntimeMs === undefined ? {} : { maxRuntimeMs }),
  }]));
  for (const policy of Object.values(configuredLimits)) {
    for (const [name, value] of Object.entries(policy)) {
      if (value !== Infinity && (!Number.isFinite(value) || value < 0)) throw new RangeError(`${name} must be non-negative`);
    }
  }
  const entries = new Map();
  const get = (principal = 'anonymous', costClass = DEFAULT_COST_CLASS) => {
    const current = now();
    const key = `${String(principal)}\u0000${canonicalCostClass(costClass)}`;
    let entry = entries.get(key);
    if (!entry || current - entry.started >= windowMs) entry = { started: current, calls: 0, bytes: 0, runtimeMs: 0 };
    entries.set(key, entry);
    return entry;
  };
  const check = (principal, { bytes = 0, runtimeMs = 0, costClass = DEFAULT_COST_CLASS } = {}) => {
    const policy = configuredLimits[canonicalCostClass(costClass)];
    if (!Number.isFinite(bytes) || bytes < 0 || !Number.isFinite(runtimeMs) || runtimeMs < 0) return { allowed: false, remaining: { calls: 0, bytes: 0, runtimeMs: 0 } };
    const entry = get(principal, costClass);
    if (entry.calls + 1 > policy.maxCalls || entry.bytes + bytes > policy.maxBytes || entry.runtimeMs + runtimeMs > policy.maxRuntimeMs) return { allowed: false, costClass: canonicalCostClass(costClass), remaining: { calls: Math.max(0, policy.maxCalls - entry.calls), bytes: Math.max(0, policy.maxBytes - entry.bytes), runtimeMs: Math.max(0, policy.maxRuntimeMs - entry.runtimeMs) } };
    entry.calls += 1; entry.bytes += Math.max(0, bytes); entry.runtimeMs += Math.max(0, runtimeMs);
    return { allowed: true, costClass: canonicalCostClass(costClass), remaining: { calls: policy.maxCalls - entry.calls, bytes: policy.maxBytes - entry.bytes, runtimeMs: policy.maxRuntimeMs - entry.runtimeMs } };
  };
  const recordRuntime = (principal, { runtimeMs = 0, costClass = DEFAULT_COST_CLASS } = {}) => {
    if (!Number.isFinite(runtimeMs) || runtimeMs < 0) return false;
    get(principal, costClass).runtimeMs += runtimeMs;
    return true;
  };
  return { check, recordRuntime, reset(principal, costClass) { return costClass === undefined ? [...entries.keys()].some((key) => key.startsWith(`${String(principal)}\u0000`) && entries.delete(key)) : entries.delete(`${String(principal)}\u0000${canonicalCostClass(costClass)}`); }, clear() { entries.clear(); } };
}

export const createRateLimiter = (options = {}) => createQuotaGuard(options);
