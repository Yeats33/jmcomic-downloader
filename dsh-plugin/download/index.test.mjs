import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, mkdir, symlink, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { calculateBlockNum, restoreRows, createChapterDownloader, createSharpCodec } from './index.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'jm-dl-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function response(data, status = 200) { return new Response(data, { status }); }
const codec = {
  async decode(input) {
    const format = input.toString() === 'GIF' ? 'gif' : 'webp';
    return { data: Buffer.from([0, 1, 2, 3, 4, 5, 6]), width: 1, height: 7, channels: 1, format, pages: 1 };
  },
  async encode(image) { return image.data; },
};
const chapter = { id: '100', images: ['a.webp', 'b.gif'] };
const make = (root, options = {}) => createChapterDownloader({ root, codec, fetch: async url => response(url.includes('b.gif') ? 'GIF' : 'WEBP'), ...options });

test('block count thresholds and ASCII hash nibble', () => {
  assert.equal(calculateBlockNum(220980, 220979, '00001'), 0);
  assert.equal(calculateBlockNum(220980, 220980, '00001'), 10);
  assert.equal(calculateBlockNum(220980, 268849, '00001'), 10);
  assert.equal(calculateBlockNum(220980, 268850, '00001'), 6);
  assert.equal(calculateBlockNum(220980, 421926, '00001'), 14);
  assert.throws(() => calculateBlockNum(1, '../1', 'x'));
});

test('stitch matches Rust including remainder, zero and invalid height', () => {
  assert.deepEqual(restoreRows(Buffer.from([0, 1, 2, 3, 4, 5, 6]), 1, 7, 1, 3), Buffer.from([4, 5, 6, 2, 3, 0, 1]));
  assert.deepEqual(restoreRows(Buffer.from([0, 1, 2, 3]), 1, 4, 1, 2), Buffer.from([2, 3, 0, 1]));
  assert.deepEqual(restoreRows(Buffer.from([1]), 1, 1, 1, 0), Buffer.from([1]));
  assert.throws(() => restoreRows(Buffer.from([0, 1]), 1, 2, 1, 3));
});

test('download in order, preserve GIF, write completion only after success, refuse overwrite', async t => {
  const root = await fixture(t);
  const downloader = make(root);
  const result = await downloader.downloadChapter({ chapterId: '100', scrambleId: 200, chapter, format: 'png' });
  assert.equal(result.imageCount, 2);
  assert.deepEqual((await readdir(result.directory)).sort(), ['.complete.json', '0001.png', '0002.gif']);
  assert.deepEqual(await readFile(path.join(result.directory, '0001.png')), Buffer.from([0, 1, 2, 3, 4, 5, 6]));
  assert.equal(await readFile(path.join(result.directory, '0002.gif'), 'utf8'), 'GIF');
  assert.equal(JSON.parse(await readFile(path.join(result.directory, '.complete.json'))).imageCount, 2);
  await assert.rejects(downloader.downloadChapter({ chapterId: '100', scrambleId: 200, chapter }), { code: 'EEXIST' });
  assert.equal(await readFile(path.join(result.directory, '0002.gif'), 'utf8'), 'GIF');
});

test('decoded webp rows are restored before encoding', async t => {
  const root = await fixture(t);
  // 10 blocks for this ID, use a 13-row source.
  const c = { ...codec, async decode() { return { data: Buffer.from(Array.from({ length: 13 }, (_, i) => i)), width: 1, height: 13, channels: 1, pages: 1, format: 'webp' }; } };
  await make(root, { codec: c }).downloadChapter({ chapterId: 220980, scrambleId: 220980, chapter: { images: ['a.webp'] } });
  assert.deepEqual(await readFile(path.join(root, 'chapter-220980', '0001.jpg')), Buffer.from([9, 10, 11, 12, 8, 7, 6, 5, 4, 3, 2, 1, 0]));
});

test('invalid names and IDs never create paths or invoke fetch', async t => {
  const root = await fixture(t);
  let calls = 0;
  const dl = make(root, { fetch: async () => { calls++; return response('WEBP'); } });
  for (const name of ['../evil.webp', 'x/evil.webp', 'x\\evil.webp', '%2e%2e.webp', '.webp', 'x.jpg', 'foo..bar.webp', 'x.webp?foo']) {
    await assert.rejects(dl.downloadChapter({ chapterId: 100, scrambleId: 1, chapter: { images: [name] } }));
  }
  await assert.rejects(dl.downloadChapter({ chapterId: '../evil', scrambleId: 1, chapter }));
  await assert.rejects(dl.downloadChapter({ chapterId: 100, scrambleId: 1, chapter: { id: 101, images: ['x.webp'] } }));
  assert.equal(calls, 0); assert.deepEqual(await readdir(root), []);
});

test('failure at any image rolls back owned files without completion', async t => {
  const root = await fixture(t);
  let count = 0;
  const dl = make(root, { fetch: async () => ++count === 1 ? response('WEBP') : response('oops', 500) });
  await assert.rejects(dl.downloadChapter({ chapterId: 100, scrambleId: 200, chapter }), /HTTP status 500/);
  assert.deepEqual(await readdir(root), []);
});

test('rejects oversized data, oversized dimensions, malformed content and too-short images', async t => {
  const root = await fixture(t);
  await assert.rejects(make(root, { limits: { maxBytes: 3 } }).downloadChapter({ chapterId: 100, scrambleId: 200, chapter }), /byte limit/);
  await assert.rejects(make(root, { limits: { maxPixels: 6 } }).downloadChapter({ chapterId: 100, scrambleId: 200, chapter }), /pixels/);
  await assert.rejects(make(root, { codec: { ...codec, async decode() { throw Error('corrupt'); } } }).downloadChapter({ chapterId: 100, scrambleId: 200, chapter }), /corrupt/);
  await assert.rejects(make(root).downloadChapter({ chapterId: 220980, scrambleId: 220980, chapter: { images: ['x.webp'] } }), /smaller than block/);
  assert.deepEqual(await readdir(root), []);
});

test('empty response retries with timestamp; reject redirects and non-streaming body', async t => {
  const root = await fixture(t); const urls = [];
  const dl = make(root, { fetch: async url => { urls.push(url); return response(urls.length === 1 ? '' : 'WEBP'); } });
  await dl.downloadChapter({ chapterId: 101, scrambleId: 200, chapter: { images: ['x.webp'] } });
  assert.match(urls[1], /\?ts=\d+$/);
  await assert.rejects(make(root, { fetch: async () => response(null, 302) }).downloadChapter({ chapterId: 102, scrambleId: 200, chapter: { images: ['x.webp'] } }), /HTTP status 302/);
  await assert.rejects(make(root, { fetch: async () => ({ status: 200, body: null }) }).downloadChapter({ chapterId: 103, scrambleId: 200, chapter: { images: ['x.webp'] } }), /streaming/);
});

test('cancellation cleans owned files even when fetch ignores signal', async t => {
  const root = await fixture(t); const controller = new AbortController(); let count = 0;
  const dl = make(root, { fetch: async () => { if (++count === 1) return response('WEBP'); controller.abort(); return new Promise(() => {}); } });
  await assert.rejects(dl.downloadChapter({ chapterId: 100, scrambleId: 200, chapter, signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(await readdir(root), []);
});

test('refuse symlink root, root ancestor, existing chapter and existing data', async t => {
  const root = await fixture(t); const dest = path.join(root, 'actual');
  await mkdir(dest); await symlink(dest, path.join(root, 'link'));
  await assert.rejects(make(path.join(root, 'link')).downloadChapter({ chapterId: 100, scrambleId: 200, chapter }), /symlink/);
  assert.throws(() => make(`${root}/link/../actual`), /normalized/);
  const existing = path.join(dest, 'chapter-100'); await mkdir(existing); await writeFile(path.join(existing, '0001.jpg'), 'keep');
  await assert.rejects(make(dest).downloadChapter({ chapterId: 100, scrambleId: 200, chapter }), { code: 'EEXIST' });
  assert.equal(await readFile(path.join(existing, '0001.jpg'), 'utf8'), 'keep');
});

test('optional sharp codec is importable without installed sharp', () => {
  assert.equal(typeof createSharpCodec().decode, 'function');
});
