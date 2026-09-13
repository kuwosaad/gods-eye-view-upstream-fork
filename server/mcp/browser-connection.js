import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { AbortError, McpError, TimeoutError } from './errors.js';

/** A small protocol adapter. Transport only needs send(message) and optional close(). */
export class BrowserConnection extends EventEmitter {
  constructor(
    transport,
    { id = randomUUID(), commandTimeoutMs = 30_000 } = {},
  ) {
    super();
    if (!transport || typeof transport.send !== 'function')
      throw new TypeError('transport.send is required');
    this.id = id;
    this.transport = transport;
    this.commandTimeoutMs = commandTimeoutMs;
    this.pending = new Map();
    this.sequence = 0;
    this.closed = false;
  }

  receive(message) {
    const value = typeof message === 'string' ? JSON.parse(message) : message;
    if (
      value?.type === 'gev:response' &&
      value.id &&
      this.pending.has(value.id)
    ) {
      const pending = this.pending.get(value.id);
      this.pending.delete(value.id);
      clearTimeout(pending.timer);
      if (value.error)
        pending.reject(
          new McpError(
            value.error.message ?? String(value.error),
            value.error.code,
            value.error.details,
          ),
        );
      else pending.resolve(value.result);
      return true;
    }
    this.emit('message', value);
    return false;
  }

  command(
    name,
    args = {},
    { signal, timeoutMs = this.commandTimeoutMs, mutation = false, callerId } = {},
  ) {
    if (this.closed)
      return Promise.reject(
        new McpError('Browser connection is closed', 'DISCONNECTED'),
      );
    const id = `${this.id}:${++this.sequence}`;
    const message = {
      type: 'gev:command',
      id,
      name,
      args,
      mutation,
      ...(callerId ? { callerId } : {}),
    };
    return new Promise((resolve, reject) => {
      let settled = false;
      let abortHandler;
      const cleanup = () => {
        clearTimeout(timer);
        if (signal && abortHandler)
          signal.removeEventListener('abort', abortHandler);
      };
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        try {
          this.transport.send({ type: 'gev:cancel', id });
        } catch {
          /* connection may already be gone */
        }
        finish(reject, new TimeoutError(`Command '${name}' timed out`));
      }, timeoutMs);
      const cancel = () => {
        if (settled) return;
        this.pending.delete(id);
        try {
          this.transport.send({ type: 'gev:cancel', id });
        } catch {
          /* connection may already be gone */
        }
        finish(reject, new AbortError());
      };
      this.pending.set(id, {
        resolve: (v) => finish(resolve, v),
        reject: (e) => finish(reject, e),
        timer,
      });
      if (signal) {
        if (signal.aborted) return cancel();
        abortHandler = cancel;
        signal.addEventListener('abort', abortHandler, { once: true });
      }
      try {
        this.transport.send(message);
      } catch (error) {
        this.pending.delete(id);
        finish(reject, error);
      }
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values())
      pending.reject(new McpError('Browser disconnected', 'DISCONNECTED'));
    this.pending.clear();
    this.transport.close?.();
    this.emit('close');
  }
}
