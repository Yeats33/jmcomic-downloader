import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, mkdir, symlink, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createChapterDownloader } from './index.mjs';

const codec = {
  async decode() { return { data: Buffer.from([1]), width: 1, height: 1, channels: 1, format: 'webp', pages: 1 }; },
  async encode({ data }) { return data; },
};
async function rootFixture(t) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'jm-safety-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const request = { chapterId: 1, scrambleId: 2, chapter: { images: ['a.webp'] } };

test('chapter symlink is never followed or replaced', async t => {
  const root = await rootFixture(t), other = path.join(root, 'other');
  await mkdir(other); await writeFile(path.join(other, 'keep'), 'safe');
  await symlink(other, path.join(root, 'chapter-1'));
  const dl = createChapterDownloader({ root, codec, fetch: async () => new Response('data') });
  await assert.rejects(dl.downloadChapter(request), { code: 'EEXIST' });
  assert.deepEqual(await readdir(other), ['keep']);
  assert.equal(await readFile(path.join(other, 'keep'), 'utf8'), 'safe');
});

test('unknown files survive failed chapter rollback', async t => {
  const root = await rootFixture(t); let n = 0;
  const dl = createChapterDownloader({ root, codec, fetch: async () => {
    if (++n === 1) return new Response('data');
    await writeFile(path.join(root, 'chapter-1', 'unrelated'), 'keep');
    return new Response('error', { status: 500 });
  } });
  await assert.rejects(dl.downloadChapter({ ...request, chapter: { images: ['a.webp', 'b.webp'] } }));
  assert.deepEqual(await readdir(path.join(root, 'chapter-1')), ['unrelated']);
  assert.equal(await readFile(path.join(root, 'chapter-1', 'unrelated'), 'utf8'), 'keep');
});

test('stream byte limit is enforced without content length', async t => {
  const root = await rootFixture(t);
  const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(3)); c.enqueue(new Uint8Array(3)); c.close(); } });
  const dl = createChapterDownloader({ root, codec, limits: { maxBytes: 5 }, fetch: async () => new Response(body) });
  await assert.rejects(dl.downloadChapter(request), /byte limit/);
  assert.deepEqual(await readdir(root), []);
});

for (const stage of ['decode', 'encode']) test(`abort waits for ${stage} to settle before cleanup`, async t => {
  const root = await rootFixture(t), controller = new AbortController();
  let started, finish;
  const entered = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { finish = resolve; });
  const fake = { ...codec, async [stage](...args) { started(); await gate; return codec[stage](...args); } };
  const dl = createChapterDownloader({ root, codec: fake, fetch: async () => new Response('data') });
  let settled = false;
  const operation = dl.downloadChapter({ ...request, signal: controller.signal }).finally(() => { settled = true; });
  await entered;
  controller.abort();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'task must hold the host lock while codec is active');
  finish();
  await assert.rejects(operation, { name: 'AbortError' });
  assert.deepEqual(await readdir(root), []);
});

test('aggregate input and output limits roll back earlier images', async t => {
  const root = await rootFixture(t);
  const two = { ...request, chapter: { images: ['a.webp', 'b.webp'] } };
  const fetch = async () => new Response('data');
  const inputLimited = createChapterDownloader({ root, codec, fetch, limits: { maxTotalInputBytes: 7 } });
  await assert.rejects(inputLimited.downloadChapter(two), /total input byte limit/);
  assert.deepEqual(await readdir(root), []);
  const outputLimited = createChapterDownloader({ root, codec, fetch, limits: { maxTotalOutputBytes: 1 } });
  await assert.rejects(outputLimited.downloadChapter(two), /total output byte limit/);
  assert.deepEqual(await readdir(root), []);
  await assert.rejects(outputLimited.downloadChapter(request), /total output byte limit/); // includes completion marker
  assert.deepEqual(await readdir(root), []);
});

test('chapter image count defaults to at most 500', async t => {
  const root = await rootFixture(t);
  let invoked = false;
  const dl = createChapterDownloader({ root, codec, fetch: () => { invoked = true; } });
  await assert.rejects(dl.downloadChapter({ ...request, chapter: { images: Array(501).fill('a.webp') } }), /bounded array/);
  assert.equal(invoked, false);
  assert.deepEqual(await readdir(root), []);
});

for (const phase of ['fetch', 'body']) test(`hard timeout covers ${phase} and cleans previous images`, async t => {
  const root = await rootFixture(t); let calls = 0, observedSignal, returned = false;
  const stalledBody = { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}), return: () => { returned = true; return Promise.resolve({ done: true }); } }; } };
  const dl = createChapterDownloader({ root, codec, limits: { imageDownloadTimeoutMs: 20 }, fetch: async (_url, options) => {
    if (++calls === 1) return new Response('data');
    observedSignal = options.signal;
    return phase === 'fetch' ? new Promise(() => {}) : { status: 200, body: stalledBody };
  } });
  await assert.rejects(dl.downloadChapter({ ...request, chapter: { images: ['a.webp', 'b.webp'] } }), { name: 'TimeoutError' });
  assert.equal(observedSignal.aborted, true);
  if (phase === 'body') assert.equal(returned, true);
  assert.deepEqual(await readdir(root), []);
});

test('empty-response retry shares the same download deadline', async t => {
  const root = await rootFixture(t); const signals = [];
  const dl = createChapterDownloader({ root, codec, limits: { imageDownloadTimeoutMs: 20 }, fetch: async (_url, { signal }) => {
    signals.push(signal);
    return signals.length === 1 ? new Response('') : new Promise(() => {});
  } });
  await assert.rejects(dl.downloadChapter(request), { name: 'TimeoutError' });
  assert.equal(signals.length, 2);
  assert.equal(signals[0], signals[1]);
  assert.equal(signals[0].aborted, true);
  assert.deepEqual(await readdir(root), []);
});

test('hard limits cannot be raised or replaced with unknown keys', async t => {
  const root = await rootFixture(t);
  for (const limits of [{ maxImages: 501 }, { imageDownloadTimeoutMs: 30001 }, { maxTotalInputBytes: 536870913 }, { maxTotalOutputBytes: 536870913 }, { toString: 1 }]) {
    assert.throws(() => createChapterDownloader({ root, codec, limits }), /invalid limit/);
  }
});

for (const reason of ['status', 'length', 'total']) test(`early ${reason} rejection cancels response body`, async t => {
  const root = await rootFixture(t); let cancelled = false;
  const body = { cancel() { cancelled = true; }, [Symbol.asyncIterator]() { throw new Error('must not read'); } };
  const response = { status: reason === 'status' ? 500 : 200, headers: { get: () => '10' }, body };
  const limits = reason === 'length' ? { maxBytes: 5 } : { maxTotalInputBytes: 5 };
  const dl = createChapterDownloader({ root, codec, limits, fetch: async () => response });
  await assert.rejects(dl.downloadChapter(request));
  assert.equal(cancelled, true);
  assert.deepEqual(await readdir(root), []);
});
