import assert from 'node:assert/strict';
import { promises as fs, constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ArtifactStore } from './artifact-store.js';

async function temporaryDirectory() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'gev-artifacts-'));
}

async function withDirectory(callback) {
  const root = await temporaryDirectory();
  try {
    return await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function sessionPath(root, sessionId) {
  const key = createHash('sha256').update(sessionId).digest('hex');
  return path.join(root, key);
}

test('stores per-session bytes with opaque IDs, metadata, and owner-only permissions', async () => {
  await withDirectory(async (root) => {
    const store = new ArtifactStore({ root, maxBytes: 100, maxCount: 3 });
    const record = await store.put('session one', Buffer.from('image'), {
      contentType: 'image/png',
      width: 2,
      height: 3,
    });

    assert.match(record.id, /^[A-Za-z0-9_-]{24}$/);
    assert.equal(record.sessionId, 'session one');
    assert.equal(record.size, 5);
    assert.equal(record.contentType, 'image/png');
    assert.equal(record.mimeType, 'image/png');
    assert.equal(
      record.resourceUri,
      `gev://sessions/${encodeURIComponent('session one')}/artifacts/${record.id}`,
    );
    assert.equal(store.resourceUri('session one', record.id), record.resourceUri);
    assert.deepEqual(await store.resourceLink('session one', record.id, { name: 'capture' }), {
      type: 'resource_link', uri: record.resourceUri, mimeType: 'image/png', name: 'capture',
    });
    assert.equal(
      await store
        .read('session one', record.id)
        .then((value) => value.toString()),
      'image',
    );
    assert.deepEqual(
      (await store.lookup('session one', record.id)).contentType,
      'image/png',
    );
    assert.deepEqual(
      (await store.get('session one', record.id)).data,
      Buffer.from('image'),
    );
    assert.deepEqual(await store.usage('session one'), {
      count: 1,
      bytes: 5,
      maxCount: 3,
      maxBytes: 100,
    });

    const sessionStat = await fs.stat(sessionPath(root, 'session one'));
    const artifactStat = await fs.stat(
      path.join(sessionPath(root, 'session one'), `${record.id}.artifact`),
    );
    assert.equal(sessionStat.mode & 0o777, 0o700);
    assert.equal(artifactStat.mode & 0o777, 0o600);
    assert.equal((await store.list('other session')).length, 0);
    await assert.rejects(store.lookup('other session', record.id), {
      code: 'ARTIFACT_NOT_FOUND',
    });
  });
});

test('validates MIME metadata and keeps resource links existence-bound', async () => {
  await withDirectory(async (root) => {
    const store = new ArtifactStore({ root });
    await assert.rejects(store.put('s', 'x', { mimeType: '' }), { code: 'INVALID_METADATA' });
    await assert.rejects(store.resourceLink('s', 'AAAAAAAAAAAAAAAAAAAAAA'), { code: 'ARTIFACT_NOT_FOUND' });
    const record = await store.put('s', 'x', { mimeType: 'text/plain; charset=utf-8' });
    assert.equal((await store.resourceLink('s', record.id)).mimeType, 'text/plain; charset=utf-8');
  });
});

test('enforces byte, count, and individual-artifact quotas before writing', async () => {
  await withDirectory(async (root) => {
    const store = new ArtifactStore({
      root,
      maxBytes: 5,
      maxCount: 1,
      maxArtifactBytes: 4,
    });
    await assert.rejects(store.put('s', Buffer.alloc(5), {}), {
      code: 'ARTIFACT_TOO_LARGE',
    });
    const first = await store.put('s', Buffer.from('1234'));
    await assert.rejects(store.put('s', Buffer.from('x')), {
      code: 'QUOTA_EXCEEDED',
    });
    await assert.rejects(store.put('s', Buffer.from('12345')), {
      code: 'ARTIFACT_TOO_LARGE',
    });
    assert.equal((await store.list('s')).length, 1);
    // Quotas are per session, so a second session has its own capacity.
    assert.equal((await store.put('other', 'ok')).size, 2);
    assert.equal(await store.remove('s', first.id), true);
    assert.equal(await store.remove('s', first.id), false);
  });
});

test('expires old artifacts and cleans all session directories', async () => {
  await withDirectory(async (root) => {
    let now = 1_000;
    const store = new ArtifactStore({ root, maxAgeMs: 100, now: () => now });
    const old = await store.put('a', 'old');
    await store.put('b', 'also old');
    now = 1_101;
    assert.deepEqual(await store.list('a'), []);
    const result = await store.cleanup();
    assert.equal(result.removed, 1);
    assert.equal(result.bytes, 8);
    assert.deepEqual(await store.list('b'), []);
  });
});

test('rejects traversal and symlink escapes without touching outside files', async () => {
  await withDirectory(async (root) => {
    const outside = await temporaryDirectory();
    try {
      const secretPath = path.join(outside, 'secret');
      await fs.writeFile(secretPath, 'keep');
      const store = new ArtifactStore({ root });
      await assert.rejects(store.lookup('s', '../secret'), {
        code: 'INVALID_ARTIFACT_ID',
      });

      const escapedSession = sessionPath(root, 'escaped');
      await fs.symlink(outside, escapedSession, 'dir');
      await assert.rejects(store.list('escaped'), { code: 'PATH_ESCAPE' });

      const record = await store.put('safe', 'payload');
      const artifactPath = path.join(
        sessionPath(root, 'safe'),
        `${record.id}.artifact`,
      );
      await fs.unlink(artifactPath);
      await fs.symlink(secretPath, artifactPath);
      await assert.rejects(store.read('safe', record.id), {
        code: 'PATH_ESCAPE',
      });
      assert.equal(await fs.readFile(secretPath, 'utf8'), 'keep');
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

test('rejects non-owner permissions options by restoring private modes', async () => {
  await withDirectory(async (root) => {
    await fs.chmod(root, 0o755);
    const store = new ArtifactStore({ root });
    await store.put('s', new Uint8Array([1, 2, 3]));
    assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
    assert.equal(fsConstants.O_NOFOLLOW > 0, true);
  });
});
