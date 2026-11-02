/**
 * Unit tests for RagStore. Extraction, tier classification, chunking, semantic
 * search, removal, and agent-switch reconciliation are exercised with a
 * deterministic fake embedder so no network / GEMINI_API_KEY is needed.
 */
import { jest } from '@jest/globals';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import * as XLSX from 'xlsx';
import { RagStore, isValidFileId, FILE_ID_RE, embedWithRetry, isTransientEmbedError } from '../../agent/utilities/RagStore.js';
import { SessionManager } from '../../agent/utilities/SessionManager.js';
import config from '../../config.js';

// Deterministic fake embedder: bag-of-words over a tiny vocabulary, L2
// normalized so dot product == cosine. A query embeds near chunks that share
// its keywords.
const VOCAB = ['apple', 'banana', 'carrot', 'dolphin', 'elephant', 'forest'];
function featurize(text) {
  const lower = text.toLowerCase();
  const counts = VOCAB.map(w => (lower.match(new RegExp(w, 'g')) || []).length);
  counts.push(0.001); // avoid a zero vector
  let norm = Math.sqrt(counts.reduce((s, v) => s + v * v, 0));
  return counts.map(v => v / norm);
}

function makeFakeEmbedder() {
  return {
    calls: 0,
    async embed(texts) {
      this.calls += texts.length;
      return texts.map(featurize);
    }
  };
}

describe('RagStore', () => {
  let sessionManager;
  let sessionId;
  let tempDir;
  let embedder;
  let store;

  beforeEach(() => {
    const base = join(tmpdir(), `ragstore-test-${Date.now()}-${randomBytes(4).toString('hex')}`);
    sessionManager = new SessionManager({ tempBasePath: base, disableCleanup: true });
    sessionId = sessionManager.createSession(null);
    tempDir = sessionManager.getSessionTempDir(sessionId);
    embedder = makeFakeEmbedder();
    store = new RagStore(embedder);
  });

  afterEach(() => {
    sessionManager.shutdown();
  });

  function writeOriginal(fileId, buffer) {
    const dir = join(tempDir, 'rag', fileId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'original.bin'), buffer);
    return dir;
  }

  // Build text guaranteed to exceed the manifest threshold, with distinct
  // keyword-bearing paragraphs so semantic search can discriminate.
  function buildLargeText() {
    const applePara = 'The apple orchard discussion. ' + 'apple '.repeat(40);
    const dolphinPara = 'The dolphin migration discussion. ' + 'dolphin '.repeat(40);
    const blocks = [];
    for (let i = 0; i < 60; i++) {
      blocks.push(applePara);
      blocks.push(dolphinPara);
    }
    return blocks.join('\n\n');
  }

  describe('processFile — extraction & tiering', () => {
    it('classifies a small text file as the manifest tier and writes extracted.txt', async () => {
      const dir = writeOriginal('file_0000000000000001', Buffer.from('A short reference note about systems.', 'utf8'));
      const meta = await store.processFile(sessionManager, sessionId, { fileId: 'file_0000000000000001', name: 'note.txt', mimeType: 'text/plain', addedAt: 'now' });

      expect(meta.tier).toBe('manifest');
      expect(meta.status).toBe('ready');
      expect(meta.chunkCount).toBe(0);
      expect(existsSync(join(dir, 'extracted.txt'))).toBe(true);
      expect(existsSync(join(dir, 'embeddings.json'))).toBe(false);
      expect(embedder.calls).toBe(0); // never embeds a manifest-tier file
      expect(sessionManager.getAttachedFiles(sessionId)).toHaveLength(1);
    });

    it('extracts text from a PDF', async () => {
      const pdf = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 52>>stream
BT /F1 18 Tf 20 100 Td (Hello RAG world) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF`;
      const dir = writeOriginal('file_0000000000000002', Buffer.from(pdf, 'latin1'));
      await store.processFile(sessionManager, sessionId, { fileId: 'file_0000000000000002', name: 'doc.pdf', mimeType: 'application/pdf', addedAt: 'now' });
      const text = readFileSync(join(dir, 'extracted.txt'), 'utf8');
      expect(text).toContain('Hello RAG world');
    }, 20000);

    it('extracts text from an XLSX workbook', async () => {
      const ws = XLSX.utils.aoa_to_sheet([['City', 'Population'], ['Springfield', 30720]]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Towns');
      const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      const dir = writeOriginal('file_0000000000000003', buffer);
      await store.processFile(sessionManager, sessionId, { fileId: 'file_0000000000000003', name: 'data.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', addedAt: 'now' });
      const text = readFileSync(join(dir, 'extracted.txt'), 'utf8');
      expect(text).toContain('Springfield');
      expect(text).toContain('Population');
    });

    it('throws if the embedder returns fewer vectors than chunks (alignment guard)', async () => {
      // Mimics an embedding API that aggregates a batch into a single vector —
      // the exact failure that stranded every chunk but the opening one.
      const collapsing = { async embed(texts) { return texts.length ? [featurize('only one')] : []; } };
      const badStore = new RagStore(collapsing);
      writeOriginal('file_0000000000000004', Buffer.from(buildLargeText(), 'utf8'));
      await expect(
        badStore.processFile(sessionManager, sessionId, { fileId: 'file_0000000000000004', name: 'bad.txt', mimeType: 'text/plain', addedAt: 'now' })
      ).rejects.toThrow(/does not match chunk count/);
    });

    it('classifies a large file as the vector tier and writes chunks + embeddings', async () => {
      const dir = writeOriginal('file_0000000000000005', Buffer.from(buildLargeText(), 'utf8'));
      const meta = await store.processFile(sessionManager, sessionId, { fileId: 'file_0000000000000005', name: 'big.txt', mimeType: 'text/plain', addedAt: 'now' });

      expect(meta.tier).toBe('vector');
      expect(meta.tokenCount).toBeGreaterThan(config.ragManifestMaxTokens);
      expect(meta.chunkCount).toBeGreaterThan(0);
      expect(existsSync(join(dir, 'chunks.json'))).toBe(true);
      expect(existsSync(join(dir, 'embeddings.json'))).toBe(true);

      const chunks = JSON.parse(readFileSync(join(dir, 'chunks.json'), 'utf8'));
      const vectors = JSON.parse(readFileSync(join(dir, 'embeddings.json'), 'utf8'));
      expect(chunks.length).toBe(vectors.length);
      expect(chunks[0]).toHaveProperty('startChar');
      expect(chunks[0]).toHaveProperty('endChar');
    });
  });

  describe('processFile — removal races', () => {
    // A remove_file landing while extraction/embedding is in flight deletes the
    // shared rag/<id> dir out from under processFile, so its artifact writes hit
    // ENOENT. The embedder hook stands in for that mid-flight deletion.
    it('reclassifies a remove that races embedding as a benign typed error (rag root intact)', async () => {
      const fileId = 'file_0000000000000006';
      const dir = writeOriginal(fileId, Buffer.from(buildLargeText(), 'utf8'));
      const racingEmbedder = {
        async embed(texts) {
          // What removeFile / #handleRemoveFile do: delete just this file's dir.
          rmSync(dir, { recursive: true, force: true });
          return texts.map(featurize);
        }
      };
      const racingStore = new RagStore(racingEmbedder);
      await expect(
        racingStore.processFile(sessionManager, sessionId, { fileId, name: 'big.txt', mimeType: 'text/plain', addedAt: 'now' })
      ).rejects.toMatchObject({ code: 'FILE_REMOVED_DURING_PROCESSING' });
    });

    it('lets a vanished rag root (session teardown) surface as a raw ENOENT, not the benign code', async () => {
      const fileId = 'file_0000000000000007';
      writeOriginal(fileId, Buffer.from(buildLargeText(), 'utf8'));
      const teardownEmbedder = {
        async embed(texts) {
          // The whole session rag tree torn down under a live worker — a genuine
          // bug that must stay loud rather than be masked as a benign removal.
          rmSync(join(tempDir, 'rag'), { recursive: true, force: true });
          return texts.map(featurize);
        }
      };
      const racingStore = new RagStore(teardownEmbedder);
      await expect(
        racingStore.processFile(sessionManager, sessionId, { fileId, name: 'big.txt', mimeType: 'text/plain', addedAt: 'now' })
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  describe('search', () => {
    it('returns the most relevant chunk for a query', async () => {
      writeOriginal('file_0000000000000005', Buffer.from(buildLargeText(), 'utf8'));
      await store.processFile(sessionManager, sessionId, { fileId: 'file_0000000000000005', name: 'big.txt', mimeType: 'text/plain', addedAt: 'now' });

      const results = await store.search(sessionManager, sessionId, 'apple', { topK: 3 });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].text.toLowerCase()).toContain('apple');
      expect(results[0]).toHaveProperty('fileId', 'file_0000000000000005');
      expect(results[0]).toHaveProperty('location');
    });

    it('respects topK', async () => {
      writeOriginal('file_0000000000000005', Buffer.from(buildLargeText(), 'utf8'));
      await store.processFile(sessionManager, sessionId, { fileId: 'file_0000000000000005', name: 'big.txt', mimeType: 'text/plain', addedAt: 'now' });
      const results = await store.search(sessionManager, sessionId, 'dolphin', { topK: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('filters by fileId', async () => {
      writeOriginal('file_0000000000000005', Buffer.from(buildLargeText(), 'utf8'));
      await store.processFile(sessionManager, sessionId, { fileId: 'file_0000000000000005', name: 'big.txt', mimeType: 'text/plain', addedAt: 'now' });
      const results = await store.search(sessionManager, sessionId, 'apple', { fileId: 'file_00000000000000ff' });
      expect(results).toEqual([]);
    });

    it('returns empty when there are no vector-tier files', async () => {
      writeOriginal('file_0000000000000001', Buffer.from('tiny note', 'utf8'));
      await store.processFile(sessionManager, sessionId, { fileId: 'file_0000000000000001', name: 'note.txt', mimeType: 'text/plain', addedAt: 'now' });
      const results = await store.search(sessionManager, sessionId, 'apple', {});
      expect(results).toEqual([]);
    });
  });

  describe('removeFile', () => {
    it('deletes artifacts, manifest entry, and session metadata', async () => {
      const dir = writeOriginal('file_0000000000000001', Buffer.from('note', 'utf8'));
      await store.processFile(sessionManager, sessionId, { fileId: 'file_0000000000000001', name: 'note.txt', mimeType: 'text/plain', addedAt: 'now' });
      expect(existsSync(dir)).toBe(true);

      store.removeFile(sessionManager, sessionId, 'file_0000000000000001');
      expect(existsSync(dir)).toBe(false);
      expect(sessionManager.getAttachedFiles(sessionId)).toHaveLength(0);
      expect(store.readManifest(tempDir).find(m => m.fileId === 'file_0000000000000001')).toBeUndefined();
    });
  });

  describe('reconcile', () => {
    it('re-registers an already-processed file without re-embedding (agent switch)', async () => {
      writeOriginal('file_0000000000000005', Buffer.from(buildLargeText(), 'utf8'));
      await store.processFile(sessionManager, sessionId, { fileId: 'file_0000000000000005', name: 'big.txt', mimeType: 'text/plain', addedAt: 'now' });
      const embedCallsAfterProcess = embedder.calls;

      // Simulate a new worker: fresh store + fresh session, same temp dir on disk.
      const newSm = new SessionManager({ tempBasePath: join(tempDir, '..'), disableCleanup: true });
      // Point the new session at the SAME temp dir by reusing the same sessionId dir.
      const newSessionId = sessionId;
      // Re-register the session object so getSessionTempDir resolves.
      newSm.createSessionWithId(newSessionId, null, tempDir);
      const newStore = new RagStore(embedder);

      const fresh = await newStore.reconcile(newSm, newSessionId, [{ fileId: 'file_0000000000000005', name: 'big.txt', mimeType: 'text/plain', addedAt: 'now' }]);
      expect(fresh).toHaveLength(0); // nothing freshly processed
      expect(embedder.calls).toBe(embedCallsAfterProcess); // no re-embedding
      expect(newSm.getAttachedFiles(newSessionId).find(f => f.fileId === 'file_0000000000000005')?.tier).toBe('vector');

      newSm.shutdown();
    });

    it('processes a file whose bytes exist but was never extracted (uploaded before a worker)', async () => {
      writeOriginal('file_0000000000000008', Buffer.from('A note added before any worker existed.', 'utf8'));
      const fresh = await store.reconcile(sessionManager, sessionId, [{ fileId: 'file_0000000000000008', name: 'pre.txt', mimeType: 'text/plain', addedAt: 'now' }]);
      expect(fresh).toHaveLength(1);
      expect(fresh[0].status).toBe('ready');
      expect(existsSync(join(tempDir, 'rag', 'file_0000000000000008', 'extracted.txt'))).toBe(true);
    });
  });

  /**
   * Regression guard: fileId is a path segment, so it must never traverse.
   *
   * fileIds arrive from the client over the WebSocket and are concatenated into
   * <sessionTempDir>/rag/<fileId>. `remove_file` rmSync's that path with
   * recursive:true and `add_file` mkdirSync's it and writes into it — both in
   * the MAIN process, outside the bwrap sandbox. A `..` in the id was arbitrary
   * recursive deletion and arbitrary-directory write as the service user.
   *
   * The wire schema rejects a malformed id (see MessageProtocol.test.js); this
   * is the second line, guarding the store itself so a future caller reaching
   * RagStore by another route cannot escape either.
   */
  describe('fileId path-traversal guard', () => {
    // Only what could escape <tempDir>/rag/ is rejected. The guard is about path
    // safety, not about the id's shape — `fileId` is a client-chosen value.
    const REJECTED = [
      ['a traversal', '../../../../etc'],
      ['a nested traversal', 'file_0123456789abcdef/../../../etc'],
      ['a forward-slash separator', 'rag/escape'],
      ['a backslash separator', 'rag\\escape'],
      ['an absolute path', '/etc/passwd'],
      ['a bare dot-dot', '..'],
      ['a bare dot', '.'],
      ['an empty string', ''],
      ['a null byte', 'file name'],
      ['an over-long id', 'a'.repeat(129)],
    ];

    it.each(REJECTED)('isValidFileId rejects %s', (_label, fileId) => {
      expect(isValidFileId(fileId)).toBe(false);
    });

    it.each([[null], [undefined], [42], [{}]])(
      'isValidFileId rejects the non-string %p', (fileId) => {
        expect(isValidFileId(fileId)).toBe(false);
      });

    // The compatibility half. fileId is documented as an arbitrary client id
    // (agent/README.md), so a real client's id must not be refused just because
    // it does not look like the one the server mints — that was a live upload
    // failure, not a hypothetical.
    it.each([
      ['the id the server mints', `file_${randomBytes(8).toString('hex')}`],
      ['a UUID with dashes', '3f2504e0-4f89-11d3-9a0c-0305e82c3301'],
      ['a short client id', 'file_abc'],
      ['a mixed-case id', 'File_0123456789abcdeZ'],
      ['an unprefixed hex id', '0123456789abcdef'],
      ['a dotted name', 'report.2026.pdf'],
      ['a name with dots that is not a traversal', 'v1..2'],
      ['a single character', 'a'],
      ['a name with spaces', 'My Reference Document.pdf'],
      ['a name with unicode', 'rapport-financiér-2026.pdf'],
      ['a name with punctuation', 'Q3 (final) [v2].xlsx'],
      ['a 128-character id', 'a'.repeat(128)],
    ])('isValidFileId accepts %s', (_label, fileId) => {
      expect(isValidFileId(fileId)).toBe(true);
      expect(FILE_ID_RE.test(fileId)).toBe(true);
    });

    it.each(REJECTED)('processFile refuses %s rather than building the path', async (_label, fileId) => {
      await expect(
        store.processFile(sessionManager, sessionId, {
          fileId, name: 'note.txt', mimeType: 'text/plain', addedAt: 'now'
        })
      ).rejects.toThrow(/Not a file id/);
    });

    it('removeFile refuses a traversing id rather than rmSync-ing it', () => {
      // A sibling directory that a traversing id would otherwise delete.
      const victim = join(tempDir, 'victim');
      mkdirSync(victim, { recursive: true });
      writeFileSync(join(victim, 'keep.txt'), 'important');

      store.removeFile(sessionManager, sessionId, '../victim');

      expect(existsSync(join(victim, 'keep.txt'))).toBe(true);
    });

    it('search ignores a traversing fileId filter', async () => {
      writeOriginal('file_0000000000000005', Buffer.from(buildLargeText(), 'utf8'));
      await store.processFile(sessionManager, sessionId, {
        fileId: 'file_0000000000000005', name: 'big.txt', mimeType: 'text/plain', addedAt: 'now'
      });

      const results = await store.search(sessionManager, sessionId, 'apple', { fileId: '../../../etc' });

      expect(results).toEqual([]);
    });
  });

});

describe('embedWithRetry', () => {
  const socketDrop = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } });

  test('retries a dropped socket and returns the eventual result', async () => {
    let calls = 0;
    const result = await embedWithRetry(async () => {
      calls++;
      if (calls < 3) throw socketDrop();
      return 'ok';
    }, [0, 0, 0]);
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  test('gives up after the last delay and rethrows the transient error', async () => {
    let calls = 0;
    await expect(embedWithRetry(async () => { calls++; throw socketDrop(); }, [0, 0])).rejects.toThrow('fetch failed');
    expect(calls).toBe(3);
  });

  test('does not retry a non-transient error', async () => {
    let calls = 0;
    const badRequest = Object.assign(new Error('bad request'), { status: 400 });
    await expect(embedWithRetry(async () => { calls++; throw badRequest; }, [0, 0, 0])).rejects.toThrow('bad request');
    expect(calls).toBe(1);
  });

  test('classifies rate limits and 5xx as transient, 4xx as not', () => {
    expect(isTransientEmbedError({ status: 429 })).toBe(true);
    expect(isTransientEmbedError({ status: 503 })).toBe(true);
    expect(isTransientEmbedError({ status: 403 })).toBe(false);
    expect(isTransientEmbedError({ code: 'ECONNRESET' })).toBe(true);
  });
});
