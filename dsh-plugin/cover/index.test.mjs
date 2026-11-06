import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createCoverService } from './index.mjs';

const code = expected => e => { assert.equal(e.code, expected); return true; };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const input = Buffer.from('fixture');
const codec = { async convert() { return Buffer.from('jpeg'); } };

test('real sharp converts static source formats and resizes', async () => {
  for (const format of ['jpeg', 'png', 'webp']) {
    const bytes = await sharp({ create: { width: 480, height: 400, channels: 4, background: { r: 128, g: 40, b: 80, alpha: 0.5 } } }).toFormat(format).toBuffer();
    let seen;
    const service = createCoverService({ fetch: async (url, options) => { seen = { url, options }; return new Response(bytes); } });
    const result = await service.readCover({ id: 123 });
    assert.equal(seen.url, 'https://cdn-msp3.18comic.vip/media/albums/123_3x4.jpg');
    assert.equal(seen.options.redirect, 'error'); assert.equal(seen.options.method, 'GET');
    assert.equal(result.id, '123'); assert.equal(result.mime, 'image/jpeg');
    const metadata = await sharp(Buffer.from(result.data, 'base64')).metadata();
    assert.equal(metadata.format, 'jpeg'); assert.equal(metadata.width, 240); assert.equal(metadata.height, 200);
  }
});

test('small images are not enlarged and EXIF orientation is applied', async () => {
  const data = await sharp({ create: { width: 10, height: 20, channels: 3, background: '#cc8899' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const service = createCoverService({ fetch: async () => new Response(data) });
  const result = await service.readCover({ id: '5' });
  const info = await sharp(Buffer.from(result.data, 'base64')).metadata();
  assert.equal(info.width, 20); assert.equal(info.height, 10); assert.equal(info.orientation, undefined);
});

test('rejects ID and URL injection without any network activity', async () => {
  let count = 0;
  const service = createCoverService({ fetch: async () => { count++; throw Error('unexpected'); } });
  for (const id of ['../1', '1/2', '1?x', 'https://example.com/', '01', '0', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '9223372036854775808', '9'.repeat(10000)]) await assert.rejects(service.readCover({ id }), TypeError);
  await assert.rejects(service.readCover({ id: 1, url: 'https://evil' }), TypeError);
  assert.equal(count, 0);
});

test('network, redirects, byte limits, image format, pixels and output limits', async () => {
  const run = (fetch, limits, injectedCodec) => createCoverService({ fetch, limits, ...(injectedCodec ? { codec: injectedCodec } : {}) }).readCover({ id: 1 });
  await assert.rejects(run(async () => new Response('x', { status: 404 })), e => e.code === 'HTTP_ERROR' && e.status === 404);
  await assert.rejects(run(async () => ({ status: 200, redirected: true })), code('HTTP_ERROR'));
  await assert.rejects(run(async () => { throw new Error('offline'); }), code('NETWORK_ERROR'));
  await assert.rejects(run(async () => new Response(Buffer.alloc(8), { headers: { 'content-length': '8' } }), { maxBytes: 4 }), code('RESPONSE_TOO_LARGE'));
  await assert.rejects(run(async () => new Response(Buffer.alloc(8)), { maxBytes: 4 }), code('RESPONSE_TOO_LARGE'));
  await assert.rejects(run(async () => new Response('bad')), code('IMAGE_ERROR'));
  await assert.rejects(run(async () => new Response('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"></svg>')), code('IMAGE_ERROR'));
  const gif = await sharp(Buffer.alloc(12), { raw: { width: 2, height: 2, channels: 3 } }).gif().toBuffer();
  await assert.rejects(run(async () => new Response(gif)), code('IMAGE_ERROR'));
  const png = await sharp(Buffer.alloc(27), { raw: { width: 3, height: 3, channels: 3 } }).png().toBuffer();
  await assert.rejects(run(async () => new Response(png), { maxPixels: 8 }), code('IMAGE_ERROR'));
  const animatedPng = Buffer.concat([png.subarray(0, 33), Buffer.from([0, 0, 0, 0, 0x61, 0x63, 0x54, 0x4c, 0, 0, 0, 0]), png.subarray(33)]);
  await assert.rejects(run(async () => new Response(animatedPng)), code('IMAGE_ERROR'));
  const animatedWebp = await sharp(Buffer.from([255,0,0, 0,255,0, 0,0,255, 255,255,0]), { raw: { width: 2, height: 2, channels: 3, pageHeight: 1 } }).webp({ delay: [100, 100] }).toBuffer();
  assert.equal((await sharp(animatedWebp, { animated: true }).metadata()).pages, 2);
  await assert.rejects(run(async () => new Response(animatedWebp)), code('IMAGE_ERROR'));
  await assert.rejects(run(async () => new Response(input), { maxOutputBytes: 2 }, codec), code('OUTPUT_TOO_LARGE'));
  assert.throws(() => createCoverService({ limits: { maxOutputBytes: 1_048_577 } }), TypeError);
});

test('timeout aborts hung fetch and hung response stream', async () => {
  let requestSignal;
  const service = createCoverService({ limits: { timeoutMs: 20 }, fetch: (_url, opts) => { requestSignal = opts.signal; return new Promise(() => {}); } });
  await assert.rejects(service.readCover({ id: 1 }), code('TIMEOUT')); assert.equal(requestSignal.aborted, true);
  let cancelled = false;
  const streamService = createCoverService({ limits: { timeoutMs: 20 }, fetch: async () => ({ status: 200, body: { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}), return() { cancelled = true; return Promise.resolve({ done: true }); } }; } } }) });
  await assert.rejects(streamService.readCover({ id: 1 }), code('TIMEOUT')); assert.equal(cancelled, true);
});

test('concurrency is capped; queued cancellation, queue-full and codec settle', async () => {
  const gate = deferred(), started = deferred(); let active = 0, peak = 0, startedCount = 0;
  const delayedCodec = { async convert() { active++; peak = Math.max(peak, active); if (++startedCount === 4) started.resolve(); await gate.promise; active--; return Buffer.from('jpeg'); } };
  const service = createCoverService({ fetch: async () => new Response(input), codec: delayedCodec, limits: { maxQueue: 2 } });
  const firstCancel = new AbortController();
  const pending = [service.readCover({ id: 1, signal: firstCancel.signal }), ...[2, 3, 4].map(id => service.readCover({ id }))];
  await started.promise; firstCancel.abort();
  const queuedCancel = new AbortController();
  const cancelled = service.readCover({ id: 5, signal: queuedCancel.signal });
  const queued = service.readCover({ id: 6 });
  await assert.rejects(service.readCover({ id: 7 }), code('BUSY'));
  queuedCancel.abort(); await assert.rejects(cancelled, code('ABORTED'));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(startedCount, 4);
  gate.resolve(); await assert.rejects(pending[0], code('ABORTED'));
  await Promise.all([...pending.slice(1), queued]); assert.equal(peak, 4); assert.equal(startedCount, 5);
});

test('dispose cancels active and queued requests and forbids future calls', async () => {
  const started = deferred(); let n = 0; const signals = [];
  const service = createCoverService({ fetch: (_url, { signal }) => { signals.push(signal); if (++n === 4) started.resolve(); return new Promise(() => {}); }, codec });
  const active = [1, 2, 3, 4].map(id => service.readCover({ id }));
  await started.promise;
  const queued = service.readCover({ id: 5 });
  service.dispose(); service.dispose();
  for (const p of [...active, queued]) await assert.rejects(p, code('DISPOSED'));
  assert.ok(signals.every(signal => signal.aborted));
  await assert.rejects(service.readCover({ id: 1 }), code('DISPOSED'));
});
