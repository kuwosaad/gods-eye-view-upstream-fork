import { redact, safeArgumentSummary } from './security.js';

/** Bounded process-local audit trail. Records contain no raw arguments. */
export class AuditLog {
  constructor({ maxRecords = 1000, maxBytes = 512 * 1024, now = Date.now } = {}) {
    if (!Number.isInteger(maxRecords) || maxRecords < 1) throw new RangeError('maxRecords must be positive');
    if (!Number.isFinite(maxBytes) || maxBytes < 1) throw new RangeError('maxBytes must be positive');
    this.maxRecords = maxRecords;
    this.maxBytes = maxBytes;
    this.now = now;
    this.records = [];
    this.bytes = 0;
  }

  append({ principal = 'anonymous', sessionId, tool, args, outcome = 'ok', durationMs, errorCode, costClass } = {}) {
    let argumentSummary;
    if (args !== undefined) argumentSummary = safeArgumentSummary(args);
    const record = {
      at: new Date(this.now()).toISOString(),
      principal: redact(String(principal).slice(0, 128)),
      ...(sessionId === undefined ? {} : { sessionId: redact(String(sessionId).slice(0, 128)) }),
      ...(tool === undefined ? {} : { tool: redact(String(tool).slice(0, 128)) }),
      ...(costClass === undefined
        ? {}
        : { costClass: String(costClass).slice(0, 32) }),
      ...(argumentSummary === undefined ? {} : { args: argumentSummary }),
      outcome: String(outcome).slice(0, 32),
      ...(Number.isFinite(durationMs) ? { durationMs: Math.max(0, durationMs) } : {}),
      ...(errorCode ? { errorCode: String(errorCode).slice(0, 64) } : {}),
    };
    const size = Buffer.byteLength(JSON.stringify(record));
    if (size > this.maxBytes) return null;
    this.records.push(record); this.bytes += size;
    while (this.records.length > this.maxRecords || this.bytes > this.maxBytes) {
      const removed = this.records.shift();
      this.bytes -= Buffer.byteLength(JSON.stringify(removed));
    }
    return record;
  }

  list({ limit = this.maxRecords } = {}) {
    return structuredClone(this.records.slice(-Math.max(0, Math.min(this.maxRecords, Number.isFinite(limit) ? limit : this.maxRecords))));
  }

  clear() { this.records.length = 0; this.bytes = 0; }
}

export const createAuditLog = (options) => new AuditLog(options);
