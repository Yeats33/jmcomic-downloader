import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createOnlineReader } from './index.mjs';

const client = (images = ['00001.webp'], overrides = {}) => ({
  async getChapter(id) { return { id, images }; },
  async getScrambleId() { return 220980; },
  ...overrides,
});
const code = expected => e => { assert.equal(e.code, expected); return true; };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const stubCodec = { async decode() { return { width: 1, height: 1, channels: 3, pages: 1, format: 'gif', data: Buffer.alloc(3) }; }, async encode() { throw new Error('unexpected encode'); } };

function scramble(plain, width, height, blocks) {
  const output = Buffer.alloc(plain.length), row = width * 3, base = Math.floor(height / blocks), rem = height % blocks;
  for (let i = 0; i < blocks; i++) {
    const count = base + (i === 0 ? rem : 0), target = height - base * (i + 1) - rem, source = base * i + (i === 0 ? 0 : rem);
    plain.copy(output, target * row, source * row, (source + count) * row);
  }
  return output;
}

test('real sharp restores a lossless scrambled WebP and serves PNG', async () => {
  const width = 4, height = 13, plain = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 3; plain[i] = y * 17; plain[i + 1] = x * 51; plain[i + 2] = (y * 19 + x * 7) % 256;
  }
  const input = await sharp(scramble(plain, width, height, 10), { raw: { width, height, channels: 3 } }).webp({ lossless: true }).toBuffer();
  let requested;
  const reader = createOnlineReader({ client: client(), fetch: async (url, opts) => { requested = [url, opts]; return new Response(input); } });
  const result = await reader.readPage({ chapterId: 220980, page: 1 });
  assert.equal(requested[0], 'https://cdn-msp2.jmapiproxy2.cc/media/photos/220980/00001.webp');
  assert.equal(requested[1].redirect, 'error');
  assert.deepEqual({ ...result, data: undefined }, { chapterId: '220980', page: 1, total: 1, mime: 'image/png', data: undefined });
  assert.deepEqual(await sharp(Buffer.from(result.data, 'base64')).raw().toBuffer(), plain);
});

test('real PNG and JPEG are decoded and restored even if filename extension differs', async () => {
  const width = 4, height = 13, plain = Buffer.alloc(width * height * 3);
  for (let i = 0; i < plain.length; i++) plain[i] = (i * 17) % 256;
  const raw = scramble(plain, width, height, 10);
  for (const [format, name] of [['png', '00001.jpg'], ['jpeg', '00001.png']]) {
    const input = await sharp(raw, { raw: { width, height, channels: 3 } }).toFormat(format).toBuffer();
    // JPEG compression changes pixels: derive the expected rows independently
    // from its decoded pixels, not the original lossless source.
    const decoded = await sharp(input).toColourspace('srgb').raw().toBuffer();
    const expected = Buffer.alloc(decoded.length), stride = width * 3, base = 1, rem = 3;
    for (let i = 0; i < 10; i++) {
      const rows = base + (i === 0 ? rem : 0), src = height - base * (i + 1) - rem, dst = base * i + (i ? rem : 0);
      decoded.copy(expected, dst * stride, src * stride, (src + rows) * stride);
    }
    const reader = createOnlineReader({ client: client([name]), fetch: async () => new Response(input) });
    const result = await reader.readPage({ chapterId: 220980, page: 1 });
    assert.equal(result.mime, 'image/png');
    assert.deepEqual(await sharp(Buffer.from(result.data, 'base64')).raw().toBuffer(), expected);
  }
});

test('empty CDN response retries only once under the same deadline', async () => {
  const gif = await sharp(Buffer.alloc(12), { raw: { width: 2, height: 2, channels: 3 } }).gif().toBuffer();
  const urls = [];
  const reader = createOnlineReader({ client: client(['a.jpg']), fetch: async url => { urls.push(url); return new Response(urls.length === 1 ? null : gif); } });
  const result = await reader.readPage({ chapterId: 1, page: 1 });
  assert.equal(result.mime, 'image/gif'); assert.deepEqual(Buffer.from(result.data, 'base64'), gif);
  assert.equal(urls.length, 2); assert.match(urls[1], /^https:\/\/cdn-msp2\.jmapiproxy2\.cc\/media\/photos\/1\/a\.jpg\?ts=\d+$/);
  const empty = createOnlineReader({ client: client(['a.gif']), fetch: async () => new Response(null) });
  await assert.rejects(empty.readPage({ chapterId: 1, page: 1 }), code('INVALID_RESPONSE'));
});

test('WebP alpha is preserved when restored to PNG', async () => {
  const pixels = Buffer.from([255, 20, 80, 0, 10, 40, 60, 127, 20, 50, 90, 255]);
  const webp = await sharp(pixels, { raw: { width: 3, height: 1, channels: 4 } }).webp({ lossless: true }).toBuffer();
  const expected = await sharp(webp).ensureAlpha().raw().toBuffer();
  const reader = createOnlineReader({ client: client(), fetch: async () => new Response(webp) });
  const result = await reader.readPage({ chapterId: 1, page: 1 });
  const actual = await sharp(Buffer.from(result.data, 'base64')).ensureAlpha().raw().toBuffer();
  assert.deepEqual(actual, expected);
});

test('real animated GIF is validated and returned byte-for-byte', async () => {
  const input = await sharp(Buffer.from([255,0,0, 0,255,0, 0,0,255, 255,255,0]), { raw: { width: 2, height: 2, channels: 3, pageHeight: 1 } }).gif({ delay: [100, 120], loop: 0 }).toBuffer();
  assert.equal((await sharp(input, { animated: true }).metadata()).pages, 2);
  const reader = createOnlineReader({ client: client(['a.gif'], { getScrambleId: async () => { throw new Error('template unavailable'); } }), fetch: async () => new Response(input) });
  const result = await reader.readPage({ chapterId: 1, page: 1 });
  assert.equal(result.mime, 'image/gif'); assert.deepEqual(Buffer.from(result.data, 'base64'), input);
  assert.equal(input.at(-1), 0x3b);
  const truncated = createOnlineReader({ client: client(['a.gif']), fetch: async () => new Response(input.subarray(0, -1)) });
  await assert.rejects(truncated.readPage({ chapterId: 1, page: 1 }), code('IMAGE_ERROR'));
});

test('rejects untrusted IDs, page and filenames before fetching', async () => {
  let calls = 0;
  const fetch = async () => { calls++; throw new Error('unexpected'); };
  const reader = createOnlineReader({ client: client(), fetch });
  for (const chapterId of ['../1', '1/2', '01', '1?x', '9223372036854775808', '9'.repeat(10000)]) await assert.rejects(reader.readPage({ chapterId, page: 1 }), TypeError);
  for (const page of [0, -1, 1.5, '1']) await assert.rejects(reader.readPage({ chapterId: 1, page }), TypeError);
  await assert.rejects(reader.readPage({ chapterId: 1, page: 1, filename: 'override.gif' }), TypeError);
  for (const name of ['../a.webp', 'a/b.gif', 'https://evil/a.gif', '%2f.webp', 'a?x.gif', 'a#x.gif', 'a\\b.gif', 'x..webp', 'a.svg']) {
    const invalid = createOnlineReader({ client: client([name]), fetch });
    await assert.rejects(invalid.readPage({ chapterId: 1, page: 1 }), code('INVALID_METADATA'));
  }
  await assert.rejects(reader.readPage({ chapterId: 1, page: 2 }), code('PAGE_OUT_OF_RANGE'));
  assert.equal(calls, 0);
});

test('validates metadata and preserves upstream errors', async () => {
  const sentinel = Object.assign(new Error('api failed'), { code: 'API_ERROR' });
  let reader = createOnlineReader({ client: client([], { getChapter: async () => { throw sentinel; } }), fetch: async () => { throw Error(); } });
  await assert.rejects(reader.readPage({ chapterId: 1, page: 1 }), e => e === sentinel);
  reader = createOnlineReader({ client: client([], { getChapter: async () => ({ id: 2, images: ['a.gif'] }) }), fetch: async () => { throw Error(); } });
  await assert.rejects(reader.readPage({ chapterId: 1, page: 1 }), code('INVALID_METADATA'));
  const png = await sharp(Buffer.alloc(12), { raw: { width: 2, height: 2, channels: 3 } }).png().toBuffer();
  reader = createOnlineReader({ client: client(['a.png'], { getScrambleId: async () => '1/2' }), fetch: async () => new Response(png) });
  await assert.rejects(reader.readPage({ chapterId: 1, page: 1 }), code('INVALID_METADATA'));
});

test('HTTP, streaming, byte, output, corrupt image and pixel limits are enforced', async () => {
  const run = (fetch, limits = {}, codec) => createOnlineReader({ client: client(['a.gif']), fetch, limits, ...(codec ? { codec } : {}) }).readPage({ chapterId: 1, page: 1 });
  await assert.rejects(run(async () => new Response('no', { status: 404 })), code('HTTP_ERROR'));
  await assert.rejects(run(async () => { throw new Error('offline'); }), code('NETWORK_ERROR'));
  await assert.rejects(run(async () => new Response(Buffer.alloc(20), { headers: { 'content-length': '20' } }), { maxBytes: 10 }), code('RESPONSE_TOO_LARGE'));
  await assert.rejects(run(async () => new Response(Buffer.alloc(20)), { maxBytes: 10 }), code('RESPONSE_TOO_LARGE'));
  await assert.rejects(run(async () => new Response('bad')), code('IMAGE_ERROR'));
  await assert.rejects(run(async () => new Response(Buffer.from('1234567;')), { maxOutputBytes: 4 }, stubCodec), code('OUTPUT_TOO_LARGE'));
  const gif = await sharp(Buffer.alloc(12), { raw: { width: 2, height: 2, channels: 3 } }).gif().toBuffer();
  await assert.rejects(run(async () => new Response(gif), { maxPixels: 3 }), code('IMAGE_ERROR'));
  assert.throws(() => createOnlineReader({ client: client(), limits: { maxPixels: 20_000_001 } }), TypeError);
});

test('timeout and abort interrupt a non-cooperative fetch or metadata request', async () => {
  const never = () => new Promise(() => {});
  let reader = createOnlineReader({ client: client(['a.gif']), fetch: never, limits: { timeoutMs: 20 } });
  await assert.rejects(reader.readPage({ chapterId: 1, page: 1 }), code('TIMEOUT'));
  reader = createOnlineReader({ client: client(['a.gif'], { getChapter: never }), fetch: never });
  const controller = new AbortController(); const result = reader.readPage({ chapterId: 1, page: 1, signal: controller.signal });
  controller.abort(); await assert.rejects(result, code('ABORTED'));
});

test('native settle retains single slot, queued requests cancel, queue is bounded', async () => {
  const started = deferred(), unblock = deferred(); let active = 0, peak = 0, decoded = 0;
  const codec = {
    async decode() { active++; peak = Math.max(peak, active); decoded++; if (decoded === 1) { started.resolve(); await unblock.promise; } active--; return stubCodec.decode(); },
    encode: stubCodec.encode,
  };
  const reader = createOnlineReader({ client: client(['a.gif']), fetch: async () => new Response('gif;'), codec });
  const cancelFirst = new AbortController();
  const first = reader.readPage({ chapterId: 1, page: 1, signal: cancelFirst.signal });
  await started.promise; cancelFirst.abort();
  const second = reader.readPage({ chapterId: 1, page: 1 });
  const cancelQueued = new AbortController();
  const third = reader.readPage({ chapterId: 1, page: 1, signal: cancelQueued.signal });
  const fourth = reader.readPage({ chapterId: 1, page: 1 });
  const fifth = reader.readPage({ chapterId: 1, page: 1 });
  await assert.rejects(reader.readPage({ chapterId: 1, page: 1 }), code('BUSY'));
  cancelQueued.abort(); await assert.rejects(third, code('ABORTED'));
  await tick(); assert.equal(decoded, 1);
  unblock.resolve(); await assert.rejects(first, code('ABORTED'));
  await Promise.all([second, fourth, fifth]); assert.equal(peak, 1); assert.equal(decoded, 4);
});
