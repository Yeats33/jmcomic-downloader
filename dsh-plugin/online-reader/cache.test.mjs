import test from 'node:test';
import assert from 'node:assert/strict';
import { createOnlineReader } from './index.mjs';

const image = (format = 'png') => ({ format, width: 1, height: 1, channels: 3, pages: 1, data: Buffer.alloc(3) });
const codec = { async decode(bytes) { return image(bytes[0] === 103 ? 'gif' : 'png'); }, async encode() { return Buffer.from('png'); } };
const response = async url => new Response(url.endsWith('.gif') ? 'gif;' : 'png');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const code = expected => e => { assert.equal(e.code, expected); return true; };
function fixture({ getChapter, getScrambleId, fetch = response, imageCodec = codec } = {}) {
  const chapters = [], scrambles = [];
  const client = {
    async getChapter(id, options) { chapters.push(id); return getChapter ? getChapter(id, options) : { id, images: ['a.png', 'b.png'] }; },
    async getScrambleId(id, options) { scrambles.push(id); return getScrambleId ? getScrambleId(id, options) : 999; },
  };
  return { chapters, scrambles, reader: createOnlineReader({ client, fetch, codec: imageCodec }) };
}
const page = (reader, id, number = 1, signal) => reader.readPage({ chapterId: id, page: number, signal });

test('same chapter reuses copied bounded metadata and validated scramble', async () => {
  const source = ['a.png', 'b.png']; const seen = [];
  const f = fixture({ getChapter: async id => ({ id, images: source, extra: { huge: 'not cached' } }), fetch: async url => { seen.push(url); return new Response('png'); } });
  await page(f.reader, 1); source[1] = '../changed.png';
  const result = await page(f.reader, 1, 2);
  assert.equal(result.total, 2); assert.match(seen[1], /\/b\.png$/);
  assert.deepEqual(f.chapters, ['1']); assert.deepEqual(f.scrambles, ['1']);
});

test('two-entry LRU and fixed TTL separate chapters and expire', async () => {
  const original = Date.now; let now = 1_000_000;
  Date.now = () => now;
  try {
    const f = fixture();
    await page(f.reader, 1); await page(f.reader, 2); await page(f.reader, 1);
    await page(f.reader, 3); await page(f.reader, 2);
    assert.deepEqual(f.chapters, ['1', '2', '3', '2']);
    assert.deepEqual(f.scrambles, ['1', '2', '3', '2']);
    now += 119_999; await page(f.reader, 2);
    assert.equal(f.chapters.length, 4);
    now++; await page(f.reader, 2);
    assert.deepEqual(f.chapters, ['1', '2', '3', '2', '2']);
    assert.deepEqual(f.scrambles, ['1', '2', '3', '2', '2']);
  } finally { Date.now = original; }
});

test('out-of-range error reports current chapter length after expiration', async () => {
  const original = Date.now; let now = 1_000_000, images = ['a.png', 'b.png'];
  Date.now = () => now;
  try {
    const f = fixture({ getChapter: async id => ({ id, images }) });
    await page(f.reader, 1, 2);
    images = ['a.png']; now += 120_000;
    await assert.rejects(page(f.reader, 1, 2), e => {
      assert.equal(e.code, 'PAGE_OUT_OF_RANGE');
      assert.equal(e.message, '页码超出章节范围；当前共 1 页，请跳转到有效页。');
      return true;
    });
    assert.deepEqual(f.chapters, ['1', '1']);
  } finally { Date.now = original; }
});

test('cached CDN 404 invalidates chapter and next retry fetches fresh filenames', async () => {
  let changed = false; const urls = [];
  const f = fixture({
    getChapter: async id => ({ id, images: [changed ? 'new.png' : 'old.png'] }),
    fetch: async url => {
      urls.push(url);
      if (changed && url.endsWith('/old.png')) return new Response('missing', { status: 404 });
      return new Response('png');
    },
  });
  await page(f.reader, 1);
  changed = true;
  await assert.rejects(page(f.reader, 1), e => e.code === 'HTTP_ERROR' && e.status === 404);
  await page(f.reader, 1);
  assert.deepEqual(f.chapters, ['1', '1']); assert.deepEqual(f.scrambles, ['1', '1']);
  assert.deepEqual(urls, [
    'https://cdn-msp2.jmapiproxy2.cc/media/photos/1/old.png',
    'https://cdn-msp2.jmapiproxy2.cc/media/photos/1/old.png',
    'https://cdn-msp2.jmapiproxy2.cc/media/photos/1/new.png',
  ]);
});

test('other CDN errors do not invalidate existing chapter metadata', async () => {
  let fail = false;
  const f = fixture({ fetch: async () => fail ? new Response('unavailable', { status: 503 }) : new Response('png') });
  await page(f.reader, 1); fail = true;
  await assert.rejects(page(f.reader, 1), e => e.code === 'HTTP_ERROR' && e.status === 503);
  fail = false; await page(f.reader, 1);
  assert.deepEqual(f.chapters, ['1']); assert.deepEqual(f.scrambles, ['1']);
});

test('GIF caches metadata but does not query scramble until a non-GIF page', async () => {
  const f = fixture({ getChapter: async id => ({ id, images: ['a.gif', 'b.png'] }) });
  assert.equal((await page(f.reader, 1)).mime, 'image/gif');
  await page(f.reader, 1); assert.equal(f.scrambles.length, 0);
  await page(f.reader, 1, 2); await page(f.reader, 1, 2);
  assert.deepEqual(f.chapters, ['1']); assert.deepEqual(f.scrambles, ['1']);
});

test('page errors and invalid metadata never seed cache', async () => {
  let calls = 0;
  const f = fixture({ getChapter: async id => {
    calls++;
    if (calls === 1) return { id, images: ['x'.repeat(201)] };
    if (calls === 2) return { id: '2', images: ['a.png'] };
    return { id, images: ['a.png', '../bad.png'] };
  } });
  await assert.rejects(page(f.reader, 1), code('INVALID_METADATA'));
  await assert.rejects(page(f.reader, 1), code('INVALID_METADATA'));
  await assert.rejects(page(f.reader, 1, 2), code('INVALID_METADATA'));
  await page(f.reader, 1); // invalid other page does not prevent this page
  await assert.rejects(page(f.reader, 1, 2), code('INVALID_METADATA'));
  assert.deepEqual(f.chapters, ['1', '1', '1', '1']);
});

test('failed requests do not cache new metadata or scramble results', async () => {
  let fails = true;
  const f = fixture({ imageCodec: { ...codec, async encode() { if (fails) { fails = false; throw Error('encode failed'); } return Buffer.from('png'); } } });
  await assert.rejects(page(f.reader, 1), code('IMAGE_ERROR'));
  await page(f.reader, 1);
  assert.deepEqual(f.chapters, ['1', '1']); assert.deepEqual(f.scrambles, ['1', '1']);
});

test('scramble result from a failed request is not added to an existing GIF entry', async () => {
  let fails = true;
  const f = fixture({ getChapter: async id => ({ id, images: ['a.gif', 'b.png'] }), imageCodec: { ...codec, async encode() { if (fails) { fails = false; throw Error('encode failed'); } return Buffer.from('png'); } } });
  await page(f.reader, 1); await assert.rejects(page(f.reader, 1, 2), code('IMAGE_ERROR'));
  await page(f.reader, 1, 2);
  assert.deepEqual(f.chapters, ['1']); assert.deepEqual(f.scrambles, ['1', '1']);
});

test('upstream metadata errors are never cached', async () => {
  let attempts = 0;
  const sentinel = Object.assign(new Error('template down'), { code: 'API_ERROR' });
  const f = fixture({ getScrambleId: async () => { if (++attempts === 1) throw sentinel; return 999; } });
  await assert.rejects(page(f.reader, 1), e => e === sentinel);
  await page(f.reader, 1);
  assert.deepEqual(f.chapters, ['1', '1']); assert.deepEqual(f.scrambles, ['1', '1']);
});

test('aborted work, including late metadata response, does not populate cache', async () => {
  const started = deferred(), late = deferred(); let count = 0;
  const f = fixture({ getChapter: async id => { if (++count === 1) { started.resolve(); return late.promise; } return { id, images: ['a.png'] }; } });
  const controller = new AbortController(), pending = page(f.reader, 1, 1, controller.signal);
  await started.promise; controller.abort(); await assert.rejects(pending, code('ABORTED'));
  late.resolve({ id: '1', images: ['evil.png'] });
  await page(f.reader, 1); assert.deepEqual(f.chapters, ['1', '1']); assert.deepEqual(f.scrambles, ['1']);
});

test('cancelled native conversion does not populate cache after settling', async () => {
  const started = deferred(), gate = deferred(); let count = 0;
  const f = fixture({ imageCodec: { ...codec, async encode() { if (++count === 1) { started.resolve(); await gate.promise; } return Buffer.from('png'); } } });
  const controller = new AbortController(), pending = page(f.reader, 1, 1, controller.signal);
  await started.promise; controller.abort(); gate.resolve(); await assert.rejects(pending, code('ABORTED'));
  await page(f.reader, 1); assert.deepEqual(f.chapters, ['1', '1']); assert.deepEqual(f.scrambles, ['1', '1']);
});
