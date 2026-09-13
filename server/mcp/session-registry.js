import { randomUUID } from 'node:crypto';
import { McpError } from './errors.js';

export class MutationLease {
  constructor(session, owner, release, timer = null) {
    this.session = session;
    this.owner = owner;
    this.release = release;
    this.released = false;
    this.timer = timer;
  }
  done() {
    if (!this.released) {
      this.released = true;
      if (this.timer) clearTimeout(this.timer);
      this.release();
    }
  }
}

export class GevSession {
  constructor(id, connection, { maxPendingMutations = 100, principalId = null, publicSession = false, unclaimed = false } = {}) {
    this.id = id;
    this.connection = connection;
    this.mutationTail = Promise.resolve();
    this.leaseOwner = null;
    this.leaseTimer = null;
    this.maxPendingMutations = maxPendingMutations;
    this.pendingMutations = 0;
    this.stateVersion = 0;
    this.closed = false;
    this.principalId = principalId;
    this.sharedWith = new Set();
    this.publicSession = publicSession;
    this.unclaimed = unclaimed;
    this.createdAt = new Date().toISOString();
  }
  runMutation(task, { signal } = {}) {
    if (this.closed)
      return Promise.reject(new McpError('Session is closed', 'SESSION_CLOSED'));
    if (this.pendingMutations >= this.maxPendingMutations)
      return Promise.reject(
        new McpError('Session mutation queue is full', 'QUEUE_FULL'),
      );
    this.pendingMutations += 1;
    const execute = () => this.closed
      ? Promise.reject(new McpError('Session is closed', 'SESSION_CLOSED'))
      : signal?.aborted ? Promise.reject(new McpError('Command cancelled', 'ABORTED')) : task();
    const run = this.mutationTail.then(
      execute,
      execute,
    );
    const tracked = run
      .then((value) => {
        this.stateVersion += 1;
        return value;
      })
      .finally(() => {
        this.pendingMutations -= 1;
        if (this.pendingMutations === 0) this.mutationTail = Promise.resolve();
      });
    this.mutationTail = tracked.catch(() => undefined);
    return tracked;
  }
  acquireLease(owner, { ttlMs = 0 } = {}) {
    if (!owner) throw new TypeError('lease owner is required');
    if (this.leaseOwner && this.leaseOwner !== owner)
      throw new McpError(
        `Session is controlled by '${this.leaseOwner}'`,
        'LEASED',
      );
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseOwner = owner;
    const release = () => {
      if (this.leaseOwner === owner) this.leaseOwner = null;
      this.leaseTimer = null;
    };
    const timer = ttlMs > 0
      ? setTimeout(() => release(), ttlMs)
      : null;
    this.leaseTimer = timer;
    return new MutationLease(this, owner, release, timer);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseTimer = null;
    this.leaseOwner = null;
    this.connection.close?.();
  }
  canAccess(principalId = 'anonymous') {
    return this.publicSession || (!this.unclaimed && !this.principalId) || principalId === this.principalId || this.sharedWith.has(principalId);
  }
  assertAccess(principalId = 'anonymous') {
    if (!this.canAccess(principalId))
      throw new McpError('Session is not shared with this caller', 'ACCESS_DENIED');
  }
}

export class SessionRegistry {
  constructor({ maxPendingMutations = 100, maxSessionsPerPrincipal = Infinity } = {}) {
    this.sessions = new Map();
    this.maxPendingMutations = maxPendingMutations;
    this.maxSessionsPerPrincipal = maxSessionsPerPrincipal;
  }
  register(connection, id = connection.id || randomUUID(), options = {}) {
    if (this.sessions.has(id) && !options.replace)
      throw new McpError(`Session '${id}' already exists`, 'SESSION_EXISTS');
    const principalId = options.principalId ?? null;
    const replacing = this.sessions.get(id);
    if (replacing && options.actorPrincipalId !== replacing.principalId)
      throw new McpError('Only the session owner can replace this session', 'ACCESS_DENIED');
    const currentCount = this.sessionsFor(principalId).filter((item) => item !== replacing).length;
    if (principalId && currentCount >= this.maxSessionsPerPrincipal)
      throw new McpError('Principal session quota exceeded', 'SESSION_QUOTA');
    replacing?.close();
    const session = new GevSession(id, connection, {
      maxPendingMutations:
        options.maxPendingMutations ?? this.maxPendingMutations,
      principalId,
      publicSession: options.publicSession === true,
      unclaimed:
        options.unclaimed ?? (principalId === null && options.publicSession !== true),
    });
    this.sessions.set(id, session);
    connection.once?.('close', () => {
      if (this.sessions.get(id) === session) this.sessions.delete(id);
    });
    return session;
  }
  get(id, principalId = null) {
    const session = this.sessions.get(id);
    if (!session)
      throw new McpError(`Unknown session '${id}'`, 'SESSION_NOT_FOUND');
    if (principalId !== null) session.assertAccess(principalId);
    return session;
  }
  remove(id) {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    session.close();
    return true;
  }
  resolve(id, principalId = 'anonymous') {
    if (id !== undefined && id !== null && id !== '')
      return this.get(id, principalId);
    const visible = [...this.sessions.values()].filter((session) => session.canAccess(principalId));
    if (visible.length === 1) return visible[0];
    if (visible.length === 0)
      throw new McpError('No browser sessions are connected', 'SESSION_NOT_FOUND');
    throw new McpError('sessionId is required when multiple sessions exist', 'SESSION_REQUIRED');
  }
  sessionsFor(principalId) {
    return [...this.sessions.values()].filter((session) => session.principalId === principalId);
  }
  create(connection, { id = connection.id || randomUUID(), principalId, ...options } = {}) {
    return this.register(connection, id, { ...options, principalId });
  }
  join(id, principalId) {
    const session = this.get(id);
    session.assertAccess(principalId);
    return session;
  }
  claim(id, principalId) {
    if (typeof principalId !== 'string' || !principalId.trim()) throw new TypeError('principal is required to claim a session');
    const session = this.get(id);
    if (session.principalId === null) {
      session.principalId = principalId;
      session.unclaimed = false;
      return session;
    }
    session.assertAccess(principalId);
    return session;
  }
  share(id, principalId, invitedPrincipalId) {
    const session = this.get(id, principalId);
    if (session.principalId !== principalId) throw new McpError('Only the session owner may share it', 'ACCESS_DENIED');
    if (!invitedPrincipalId) throw new TypeError('invited principal is required');
    session.sharedWith.add(invitedPrincipalId);
    return session;
  }
  close(id, principalId = null) {
    const session = this.get(id);
    if (session.principalId !== principalId) throw new McpError('Only the session owner may close it', 'ACCESS_DENIED');
    return this.remove(id);
  }
  list(principalId = null) {
    return [...this.sessions.values()].filter(
      (session) =>
        principalId === null || session.unclaimed || session.canAccess(principalId),
    ).map(
      ({ id, createdAt, connection, leaseOwner }) => ({
        id,
        createdAt,
        connectionId: connection.id,
        leased: Boolean(leaseOwner),
      }),
    );
  }
}
