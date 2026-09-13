import { createHash, randomBytes } from 'node:crypto';
import { promises as fs, constants as fsConstants } from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_COUNT = 100;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ARTIFACT_BYTES = DEFAULT_MAX_BYTES;
const MAX_METADATA_BYTES = 16 * 1024;
const ARTIFACT_FILE_SUFFIX = '.artifact';
const METADATA_FILE_SUFFIX = '.meta.json';
const ARTIFACT_ID_RE = /^[A-Za-z0-9_-]{22,64}$/;

const NOFOLLOW = fsConstants.O_NOFOLLOW || 0;
const READ_ONLY_NOFOLLOW = fsConstants.O_RDONLY | NOFOLLOW;
const WRITE_NEW_NOFOLLOW =
  fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW;

export class ArtifactStoreError extends Error {
  constructor(message, code = 'ARTIFACT_STORE_ERROR', details) {
    super(message);
    this.name = 'ArtifactStoreError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function invalid(message, code = 'INVALID_ARTIFACT') {
  return new ArtifactStoreError(message, code);
}

function assertQuota(value, name) {
  if (
    value !== Infinity &&
    (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
  )
    throw new RangeError(`${name} must be a non-negative number or Infinity`);
  return value;
}

function assertCountQuota(value, name) {
  if (value !== Infinity && (!Number.isInteger(value) || value < 0))
    throw new RangeError(`${name} must be a non-negative integer or Infinity`);
  return value;
}

function clockValue(now) {
  const value = typeof now === 'function' ? now() : Date.now();
  const time = value instanceof Date ? value.getTime() : Number(value);
  return Number.isFinite(time) ? time : Date.now();
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function sessionDirectoryName(sessionId) {
  return createHash('sha256').update(sessionId).digest('hex');
}

function normalizeSessionId(sessionId) {
  if (
    typeof sessionId !== 'string' ||
    sessionId.length === 0 ||
    sessionId.length > 256
  )
    throw invalid(
      'sessionId must be a non-empty string of at most 256 characters',
      'INVALID_SESSION',
    );
  return sessionId;
}

function normalizeArtifactId(artifactId) {
  if (typeof artifactId !== 'string' || !ARTIFACT_ID_RE.test(artifactId))
    throw invalid('artifactId is invalid', 'INVALID_ARTIFACT_ID');
  return artifactId;
}

function normalizeData(data) {
  if (Buffer.isBuffer(data)) return Buffer.from(data);
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  throw invalid(
    'artifact data must be a Buffer, Uint8Array, or string',
    'INVALID_DATA',
  );
}

function normalizeMetadata(metadata) {
  if (metadata === undefined) return {};
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    throw invalid('artifact metadata must be an object', 'INVALID_METADATA');
  let encoded;
  try {
    encoded = JSON.stringify(metadata);
  } catch {
    throw invalid(
      'artifact metadata must be JSON serializable',
      'INVALID_METADATA',
    );
  }
  if (
    typeof encoded !== 'string' ||
    Buffer.byteLength(encoded) > MAX_METADATA_BYTES
  )
    throw invalid('artifact metadata is too large', 'METADATA_TOO_LARGE');
  return JSON.parse(encoded);
}

function normalizeMimeType(metadata) {
  const value = metadata.mimeType ?? metadata.contentType;
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > 255)
    throw invalid('artifact MIME type must be a non-empty short string', 'INVALID_METADATA');
  return value;
}

function isRegularFile(stat) {
  return stat.isFile() && !stat.isSymbolicLink();
}

/**
 * Small disk-backed artifact registry. Each session receives a hashed,
 * owner-only directory. IDs contain random bytes only; user input is never
 * used as a path component. Quotas are applied independently per session.
 */
export class ArtifactStore {
  constructor({
    root,
    maxBytes = DEFAULT_MAX_BYTES,
    maxCount = DEFAULT_MAX_COUNT,
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    maxArtifactBytes = DEFAULT_MAX_ARTIFACT_BYTES,
    now = Date.now,
  } = {}) {
    if (typeof root !== 'string' || root.length === 0)
      throw new TypeError('root is required');
    this.root = path.resolve(root);
    this.maxBytes = assertQuota(maxBytes, 'maxBytes');
    this.maxCount = assertCountQuota(maxCount, 'maxCount');
    this.maxAgeMs = assertQuota(maxAgeMs, 'maxAgeMs');
    this.maxArtifactBytes = assertQuota(maxArtifactBytes, 'maxArtifactBytes');
    this.now = now;
    this._realRoot = null;
    this._rootReady = null;
    this._locks = new Map();
  }

  async _ensureRoot() {
    if (!this._rootReady) {
      this._rootReady = (async () => {
        await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
        const rootStat = await fs.lstat(this.root);
        if (!rootStat.isDirectory())
          throw invalid('artifact root is not a directory', 'INVALID_ROOT');
        // The root itself is sensitive: metadata and generated images belong
        // to the local process owner and should never be group/world-readable.
        await fs.chmod(this.root, 0o700);
        this._realRoot = await fs.realpath(this.root);
      })().catch((error) => {
        this._rootReady = null;
        throw error;
      });
    }
    await this._rootReady;
    return this._realRoot;
  }

  _queue(key, task) {
    const previous = this._locks.get(key) || Promise.resolve();
    const running = previous.catch(() => undefined).then(task);
    let queued;
    const settled = running.finally(() => {
      if (this._locks.get(key) === queued) this._locks.delete(key);
    });
    // Keep a rejected operation from poisoning the next operation, and make
    // sure the bookkeeping promise itself cannot become an unhandled reject.
    queued = settled.catch(() => undefined);
    this._locks.set(key, queued);
    return running;
  }

  async _waitForOperations() {
    // Take snapshots until no operation remains. A cleanup call that races a
    // caller already in flight must observe a settled store before scanning.
    while (this._locks.size) {
      await Promise.all([...this._locks.values()]);
    }
  }

  async _sessionDirectory(sessionId, { create = true } = {}) {
    const normalized = normalizeSessionId(sessionId);
    const realRoot = await this._ensureRoot();
    const directory = path.join(this.root, sessionDirectoryName(normalized));
    if (!isWithin(this.root, directory))
      throw invalid('artifact path escapes root', 'PATH_ESCAPE');
    if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    let stat;
    try {
      stat = await fs.lstat(directory);
    } catch (error) {
      if (!create && error?.code === 'ENOENT') return null;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw invalid('artifact session directory is not safe', 'PATH_ESCAPE');
    await fs.chmod(directory, 0o700);
    const realDirectory = await fs.realpath(directory);
    if (!isWithin(realRoot, realDirectory) || realDirectory === realRoot)
      throw invalid('artifact session directory escapes root', 'PATH_ESCAPE');
    return {
      id: normalized,
      path: directory,
      realPath: realDirectory,
      key: sessionDirectoryName(normalized),
    };
  }

  _artifactPath(directory, artifactId, suffix = ARTIFACT_FILE_SUFFIX) {
    const id = normalizeArtifactId(artifactId);
    const candidate = path.resolve(directory.path, `${id}${suffix}`);
    if (!isWithin(directory.path, candidate))
      throw invalid('artifact path escapes session directory', 'PATH_ESCAPE');
    return candidate;
  }

  _resourceUri(sessionId, artifactId) {
    return `gev://sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(normalizeArtifactId(artifactId))}`;
  }

  async _safeRead(filePath) {
    let handle;
    try {
      handle = await fs.open(filePath, READ_ONLY_NOFOLLOW);
      return await handle.readFile();
    } catch (error) {
      if (error?.code === 'ELOOP')
        throw invalid('artifact path contains a symlink', 'PATH_ESCAPE');
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async _safeLstat(filePath) {
    try {
      const stat = await fs.lstat(filePath);
      if (!isRegularFile(stat))
        throw invalid('artifact path is not a regular file', 'PATH_ESCAPE');
      return stat;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async _writeNew(filePath, bytes) {
    const temporary = `${filePath}.${randomBytes(12).toString('hex')}.tmp`;
    let handle;
    try {
      handle = await fs.open(temporary, WRITE_NEW_NOFOLLOW, 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.chmod(temporary, 0o600);
      // link+unlink gives create-only semantics. rename() would replace a
      // pre-existing symlink if an attacker guessed a caller-supplied ID.
      await fs.link(temporary, filePath);
      await fs.unlink(temporary);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async _removeFiles(directory, artifactId) {
    const artifact = this._artifactPath(directory, artifactId);
    const metadata = this._artifactPath(
      directory,
      artifactId,
      METADATA_FILE_SUFFIX,
    );
    await fs.unlink(artifact).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
    await fs.unlink(metadata).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }

  _expiresAt(createdAt) {
    return this.maxAgeMs === Infinity ? null : createdAt + this.maxAgeMs;
  }

  async _readRecord(directory, artifactId, { removeExpired = true } = {}) {
    const artifactPath = this._artifactPath(directory, artifactId);
    const stat = await this._safeLstat(artifactPath);
    if (!stat) return null;
    const metadataPath = this._artifactPath(
      directory,
      artifactId,
      METADATA_FILE_SUFFIX,
    );
    let metadata;
    try {
      metadata = JSON.parse(
        (await this._safeRead(metadataPath)).toString('utf8'),
      );
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) {
        if (removeExpired) await this._removeFiles(directory, artifactId);
        return null;
      }
      throw error;
    }
    if (
      !metadata ||
      metadata.id !== artifactId ||
      (directory.id !== null &&
        directory.id !== undefined &&
        metadata.sessionId !== directory.id)
    ) {
      if (removeExpired) await this._removeFiles(directory, artifactId);
      return null;
    }
    const record = {
      ...metadata,
      size: stat.size,
      path: undefined,
    };
    delete record.path;
    if (directory.id !== null && directory.id !== undefined)
      record.resourceUri = this._resourceUri(directory.id, artifactId);
    if (
      record.expiresAt !== null &&
      Number.isFinite(record.expiresAt) &&
      clockValue(this.now) >= record.expiresAt
    ) {
      if (removeExpired) await this._removeFiles(directory, artifactId);
      return null;
    }
    return record;
  }

  async _listDirectory(directory, { removeExpired = true } = {}) {
    let entries;
    try {
      entries = await fs.readdir(directory.path, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const records = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(ARTIFACT_FILE_SUFFIX))
        continue;
      const artifactId = entry.name.slice(0, -ARTIFACT_FILE_SUFFIX.length);
      if (!ARTIFACT_ID_RE.test(artifactId)) continue;
      const record = await this._readRecord(directory, artifactId, {
        removeExpired,
      });
      if (record) records.push(record);
    }
    return records.sort((left, right) => left.createdAtMs - right.createdAtMs);
  }

  async put(sessionId, data, metadata = {}) {
    const bytes = normalizeData(data);
    if (bytes.byteLength > this.maxArtifactBytes)
      throw invalid(
        'artifact exceeds the per-artifact byte quota',
        'ARTIFACT_TOO_LARGE',
      );
    const normalizedSessionId = normalizeSessionId(sessionId);
    const userMetadata = normalizeMetadata(metadata);
    const mimeType = normalizeMimeType(userMetadata);
    const key = sessionDirectoryName(normalizedSessionId);
    return this._queue(key, async () => {
      const directory = await this._sessionDirectory(normalizedSessionId);
      const existing = await this._listDirectory(directory);
      const usedBytes = existing.reduce((sum, item) => sum + item.size, 0);
      if (
        existing.length >= this.maxCount ||
        usedBytes + bytes.byteLength > this.maxBytes
      )
        throw invalid('artifact session quota exceeded', 'QUOTA_EXCEEDED');
      const createdAtMs = clockValue(this.now);
      const id = await this._newId(directory);
      const record = {
        id,
        sessionId: normalizedSessionId,
        size: bytes.byteLength,
        createdAt: new Date(createdAtMs).toISOString(),
        createdAtMs,
        expiresAt: this._expiresAt(createdAtMs),
        ...userMetadata,
      };
      record.mimeType = mimeType || 'application/octet-stream';
      record.resourceUri = this._resourceUri(normalizedSessionId, id);
      // These fields describe the stored object and cannot be spoofed by
      // callers through metadata.
      record.id = id;
      record.sessionId = normalizedSessionId;
      record.size = bytes.byteLength;
      record.createdAt = new Date(createdAtMs).toISOString();
      record.createdAtMs = createdAtMs;
      record.expiresAt = this._expiresAt(createdAtMs);
      record.resourceUri = this._resourceUri(normalizedSessionId, id);
      const encodedMetadata = Buffer.from(JSON.stringify(record), 'utf8');
      if (encodedMetadata.byteLength > MAX_METADATA_BYTES)
        throw invalid('artifact metadata is too large', 'METADATA_TOO_LARGE');
      const artifactPath = this._artifactPath(directory, id);
      const metadataPath = this._artifactPath(
        directory,
        id,
        METADATA_FILE_SUFFIX,
      );
      try {
        await this._writeNew(artifactPath, bytes);
        await this._writeNew(metadataPath, encodedMetadata);
      } catch (error) {
        await fs.unlink(artifactPath).catch(() => undefined);
        await fs.unlink(metadataPath).catch(() => undefined);
        throw error;
      }
      return { ...record };
    });
  }

  async _newId(directory) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = randomBytes(18).toString('base64url');
      const existing = await this._safeLstat(this._artifactPath(directory, id));
      if (!existing) return id;
    }
    throw invalid('could not allocate a unique artifact ID', 'ID_COLLISION');
  }

  async lookup(sessionId, artifactId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const id = normalizeArtifactId(artifactId);
    const key = sessionDirectoryName(normalizedSessionId);
    return this._queue(key, async () => {
      const directory = await this._sessionDirectory(normalizedSessionId, {
        create: false,
      });
      if (!directory)
        throw invalid('artifact was not found', 'ARTIFACT_NOT_FOUND');
      const record = await this._readRecord(directory, id);
      if (!record)
        throw invalid('artifact was not found', 'ARTIFACT_NOT_FOUND');
      return { ...record };
    });
  }

  /** Return metadata and bytes together for callers that need one lookup. */
  async get(sessionId, artifactId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const id = normalizeArtifactId(artifactId);
    const key = sessionDirectoryName(normalizedSessionId);
    return this._queue(key, async () => {
      const directory = await this._sessionDirectory(normalizedSessionId, {
        create: false,
      });
      if (!directory)
        throw invalid('artifact was not found', 'ARTIFACT_NOT_FOUND');
      const record = await this._readRecord(directory, id);
      if (!record)
        throw invalid('artifact was not found', 'ARTIFACT_NOT_FOUND');
      const data = await this._safeRead(
        this._artifactPath(directory, record.id),
      );
      return { ...record, data };
    });
  }

  async read(sessionId, artifactId) {
    return (await this.get(sessionId, artifactId)).data;
  }

  /** Return the MCP resource URI for an artifact without touching its bytes. */
  resourceUri(sessionId, artifactId) {
    return this._resourceUri(normalizeSessionId(sessionId), artifactId);
  }

  /** Return a protocol-neutral ResourceLink after confirming the artifact exists. */
  async resourceLink(sessionId, artifactId, { name, description } = {}) {
    const record = await this.lookup(sessionId, artifactId);
    return {
      type: 'resource_link',
      uri: record.resourceUri || this._resourceUri(sessionId, record.id),
      mimeType: record.mimeType || record.contentType || 'application/octet-stream',
      ...(name !== undefined ? { name: String(name) } : {}),
      ...(description !== undefined ? { description: String(description) } : {}),
    };
  }

  async list(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const key = sessionDirectoryName(normalizedSessionId);
    return this._queue(key, async () => {
      const directory = await this._sessionDirectory(normalizedSessionId, {
        create: false,
      });
      return directory ? this._listDirectory(directory) : [];
    });
  }

  async usage(sessionId) {
    const records = await this.list(sessionId);
    return {
      count: records.length,
      bytes: records.reduce((sum, record) => sum + record.size, 0),
      maxCount: this.maxCount,
      maxBytes: this.maxBytes,
    };
  }

  async remove(sessionId, artifactId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const id = normalizeArtifactId(artifactId);
    const key = sessionDirectoryName(normalizedSessionId);
    return this._queue(key, async () => {
      const directory = await this._sessionDirectory(normalizedSessionId, {
        create: false,
      });
      if (!directory) return false;
      const record = await this._readRecord(directory, id, {
        removeExpired: false,
      });
      if (!record) return false;
      await this._removeFiles(directory, id);
      return true;
    });
  }

  async cleanup(sessionId) {
    if (sessionId !== undefined) {
      const normalizedSessionId = normalizeSessionId(sessionId);
      const key = sessionDirectoryName(normalizedSessionId);
      return this._queue(key, async () => {
        const directory = await this._sessionDirectory(normalizedSessionId, {
          create: false,
        });
        if (!directory) return { removed: 0, bytes: 0 };
        return this._cleanupDirectory(directory);
      });
    }
    await this._waitForOperations();
    await this._ensureRoot();
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    let removed = 0;
    let bytes = 0;
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        !/^[a-f0-9]{64}$/.test(entry.name)
      )
        continue;
      // A hashed directory does not reveal a session ID, so cleanup can work
      // without accepting arbitrary path input from the caller.
      const directory = await this._sessionDirectoryFromEntry(entry.name);
      if (!directory) continue;
      const result = await this._queue(entry.name, () =>
        this._cleanupDirectory(directory),
      );
      removed += result.removed;
      bytes += result.bytes;
    }
    return { removed, bytes };
  }

  async cleanupExpired(sessionId) {
    return this.cleanup(sessionId);
  }

  async close({ cleanup = false } = {}) {
    await this._waitForOperations();
    if (cleanup) return this.cleanup();
    return { removed: 0, bytes: 0 };
  }

  async _sessionDirectoryFromEntry(name) {
    const realRoot = await this._ensureRoot();
    const directoryPath = path.join(this.root, name);
    if (!isWithin(this.root, directoryPath)) return null;
    const stat = await fs
      .lstat(directoryPath)
      .catch((error) =>
        error?.code === 'ENOENT' ? null : Promise.reject(error),
      );
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return null;
    await fs.chmod(directoryPath, 0o700);
    const realPath = await fs.realpath(directoryPath);
    if (!isWithin(realRoot, realPath) || realPath === realRoot) return null;
    return { id: null, path: directoryPath, realPath, key: name };
  }

  async _cleanupDirectory(directory) {
    let entries;
    try {
      entries = await fs.readdir(directory.path, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return { removed: 0, bytes: 0 };
      throw error;
    }
    let removed = 0;
    let bytes = 0;
    for (const entry of entries) {
      if (entry.name.endsWith('.tmp')) {
        const temporary = path.join(directory.path, entry.name);
        const temporaryStat = await fs.lstat(temporary).catch(() => null);
        bytes += temporaryStat?.isFile() ? temporaryStat.size : 0;
        await fs.unlink(temporary).catch((error) => {
          if (error?.code !== 'ENOENT') throw error;
        });
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(ARTIFACT_FILE_SUFFIX))
        continue;
      const id = entry.name.slice(0, -ARTIFACT_FILE_SUFFIX.length);
      if (!ARTIFACT_ID_RE.test(id)) continue;
      const record = await this._readRecord(directory, id, {
        removeExpired: false,
      });
      if (record) continue;
      const artifactPath = this._artifactPath(directory, id);
      const stat = await fs.lstat(artifactPath).catch(() => null);
      bytes += stat?.isFile() ? stat.size : 0;
      await this._removeFiles(directory, id);
      removed += 1;
    }
    // A crash between the payload and metadata writes can leave an orphaned
    // metadata file. It is safe to remove because metadata is never an
    // independently addressable artifact.
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(METADATA_FILE_SUFFIX))
        continue;
      const id = entry.name.slice(0, -METADATA_FILE_SUFFIX.length);
      if (!ARTIFACT_ID_RE.test(id)) continue;
      const artifact = await this._safeLstat(this._artifactPath(directory, id));
      if (artifact) continue;
      await fs
        .unlink(this._artifactPath(directory, id, METADATA_FILE_SUFFIX))
        .catch((error) => {
          if (error?.code !== 'ENOENT') throw error;
        });
    }
    return { removed, bytes };
  }
}

export function createArtifactStore(options) {
  return new ArtifactStore(options);
}
