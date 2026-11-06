import test from 'node:test';
import assert from 'node:assert/strict';
import { createOnlineReader } from './index.mjs';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const client = { async getChapter(id) { return { id, images: ['a.gif'] }; }, async getScrambleId() { return 2; } };
const code = expected => e => { assert.equal(e.code, expected); return true; };

test('dispose aborts network and queue, prevents new work, is idempotent', async () => {
  const begun = deferred(); let networkSignal;
  const reader = createOnlineReader({ client, fetch: (_url, { signal }) => { networkSignal = signal; begun.resolve(); return new Promise(() => {}); } });
  const active = reader.readPage({ chapterId: 1, page: 1 });
  await begun.promise;
  const queued = reader.readPage({ chapterId: 1, page: 1 });
  reader.dispose(); reader.dispose();
  assert.equal(networkSignal.aborted, true);
  await assert.rejects(active, code('DISPOSED')); await assert.rejects(queued, code('DISPOSED'));
  await assert.rejects(reader.readPage({ chapterId: 1, page: 1 }), code('DISPOSED'));
});

test('dispose waits for in-flight codec settlement', async () => {
  const started = deferred(), unblock = deferred(); let settled = false;
  const codec = { async decode() { started.resolve(); await unblock.promise; settled = true; return {}; }, async encode() {} };
  const reader = createOnlineReader({ client, codec, fetch: async () => new Response('data') });
  const result = reader.readPage({ chapterId: 1, page: 1 });
  await started.promise; reader.dispose();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  unblock.resolve(); await assert.rejects(result, code('DISPOSED')); assert.equal(settled, true);
});

test('aborts a stalled stream and enforces redirect rejection', async () => {
  let streamCancelled = false;
  const reader = createOnlineReader({ client, limits: { timeoutMs: 20 }, fetch: async () => ({ status: 200, body: { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}), return() { streamCancelled = true; return Promise.resolve({ done: true }); } }; } } }) });
  await assert.rejects(reader.readPage({ chapterId: 1, page: 1 }), code('TIMEOUT'));
  assert.equal(streamCancelled, true);
  const redir = createOnlineReader({ client, fetch: async () => ({ status: 200, redirected: true }) });
  await assert.rejects(redir.readPage({ chapterId: 1, page: 1 }), code('HTTP_ERROR'));
});
