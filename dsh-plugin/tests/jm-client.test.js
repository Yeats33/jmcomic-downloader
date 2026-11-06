import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import { JmClient, JmError } from '../core/jm-client.js';

const md5 = value => createHash('md5').update(value).digest('hex');
const encrypt = (timestamp, value) => {
  const cipher = createCipheriv('aes-256-ecb', Buffer.from(md5(`${timestamp}185Hcomic3PAPP7R`)), null);
  return Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]).toString('base64');
};
const envelope = (options, value) => JSON.stringify({ code: 200, data: encrypt(options.headers.tokenparam.split(',')[0], value) });
const response = (body, status = 200) => new Response(body, { status });
const comic = { id: 123, name: '漫画', series: [{ id: '456', name: '第一话', sort: '1' }], author: ['作者'] };
const chapter = { id: 456, name: '第一话', series: [], images: ['001.jpg'], tags: '', series_id: '123' };
const search = { search_query: '漫画 & test', total: '1', content: [{ id: '123', name: '漫画' }] };
const rejectCode = code => error => error instanceof JmError && error.code === code;

test('matches fixed OpenSSL AES-ECB and token protocol vector', async t => {
  t.mock.method(Date, 'now', () => 1700000000000);
  const client = new JmClient({ fetch: async (_url, options) => {
    assert.equal(options.headers.tokenparam, '1700000000,2.0.13');
    assert.equal(options.headers.token, '1c6fa345eea2e10d5a30880ec2a7e0b3');
    return response(JSON.stringify({ code: 200, data: 'CwoWLxUgNxi/GQt6e+nPc34D0+r0y4sMOTVaLe4tNFG2znE652fB295qJ37X8FXo' }));
  } });
  assert.deepEqual(await client.getComic(123), { id: 123, name: 'fixture', series: [] });
});

test('search sends signed anonymous request with encoded parameters and decrypts', async () => {
  let called = 0;
  const client = new JmClient({ domain: 'example.com', fetch: async (url, options) => {
    called++;
    assert.equal(url.origin, 'https://example.com');
    assert.equal(url.pathname, '/search');
    assert.deepEqual(Object.fromEntries(url.searchParams), { main_tag: '0', search_query: '漫画 & test', page: '2', o: 'mv' });
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.tokenparam.split(',')[1], '2.0.13');
    assert.equal(options.headers.token, md5(`${options.headers.tokenparam.split(',')[0]}18comicAPP`));
    assert.equal(options.headers.cookie, undefined);
    return response(envelope(options, search));
  } });
  assert.deepEqual(await client.search('漫画 & test', { page: 2, sort: 'view' }), { type: 'search', data: search });
  assert.equal(called, 1);
});

test('comic and chapter IDs remain exact, including series and image metadata', async () => {
  const client = new JmClient({ domain: 'https://example.com:8443', fetch: async (url, options) => {
    assert.equal(url.origin, 'https://example.com:8443');
    assert.equal(url.searchParams.get('id'), '9007199254740993');
    return response(envelope(options, url.pathname === '/album' ? comic : chapter));
  } });
  assert.deepEqual(await client.getComic('9007199254740993'), comic);
  assert.deepEqual(await client.getChapter('9007199254740993'), chapter);
});

test('scramble ID request uses content token and matching timestamp query', async t => {
  t.mock.method(Date, 'now', () => 1700000000000);
  const client = new JmClient({ domain: 'example.com', fetch: async (url, options) => {
    assert.equal(url.pathname, '/chapter_view_template');
    assert.deepEqual(Object.fromEntries(url.searchParams), { id: '9007199254740993', v: '1700000000', mode: 'vertical', page: '0', app_img_shunt: '1', express: 'off' });
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.tokenparam, '1700000000,2.0.13');
    assert.equal(options.headers.token, md5('170000000018comicAPPContent'));
    return response('<script>var scramble_id = 220980;</script>');
  } });
  assert.equal(await client.getScrambleId('9007199254740993'), 220980);
});

test('scramble ID rejects malformed, ambiguous and out-of-range declarations', async () => {
  for (const body of ['', 'nothing here', 'var scramble_id = 0;', 'var scramble_id = -1;', 'var scramble_id = 01;', 'var scramble_id = 2.0;', 'var scramble_id = 2 + 1;', 'var scramble_id = 9007199254740992;', 'var scramble_id = 123', 'var scramble_id = 123; var scramble_id = 456;', 'var scramble_id = 123; var scramble_id = bad;']) {
    const client = new JmClient({ fetch: async () => response(body) });
    await assert.rejects(client.getScrambleId(1), rejectCode('INVALID_RESPONSE'), body);
  }
  const client = new JmClient({ fetch: async () => response('var scramble_id = 1;') });
  await assert.rejects(client.getScrambleId('0'), TypeError);
  await assert.rejects(client.getScrambleId('1/2'), TypeError);
});

test('scramble ID shares HTTP errors, abort, timeout and streaming limit', async () => {
  await assert.rejects(new JmClient({ fetch: async () => response('error', 503) }).getScrambleId(1), e => rejectCode('HTTP_ERROR')(e) && e.status === 503);
  let cancelled = false;
  const hanging = new JmClient({ timeoutMs: 15, fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
  await assert.rejects(hanging.getScrambleId(1), rejectCode('TIMEOUT'));
  assert.equal(cancelled, true);
  const controller = new AbortController();
  const pending = hanging.getScrambleId(1, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, rejectCode('ABORTED'));
  let tooLargeCancelled = false;
  const tooLarge = new JmClient({ fetch: async () => new Response(new ReadableStream({
    pull(stream) { stream.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); },
    cancel() { tooLargeCancelled = true; },
  })) });
  await assert.rejects(tooLarge.getScrambleId(1), rejectCode('RESPONSE_TOO_LARGE'));
  assert.equal(tooLargeCancelled, true);
});

test('search redirect resolves to comic using the same cancellation signal', async () => {
  const paths = [];
  const abort = new AbortController();
  const client = new JmClient({ fetch: async (url, options) => {
    paths.push(url.pathname);
    assert.equal(options.signal.aborted, false);
    if (url.pathname === '/search') return response(envelope(options, { search_query: '123', total: 1, redirect_aid: 123 }));
    assert.equal(url.searchParams.get('id'), '123');
    return response(envelope(options, comic));
  } });
  assert.deepEqual(await client.search('123', { signal: abort.signal }), { type: 'comic', data: comic });
  assert.deepEqual(paths, ['/search', '/album']);
});

test('validates configuration and parameters before networking', async () => {
  for (const domain of ['', 'https://user:pass@example.com', 'ftp://example.com', 'https://example.com/path', 'https://example.com?x=1']) assert.throws(() => new JmClient({ domain }), TypeError);
  for (const timeoutMs of [0, -1, 1.2, Infinity]) assert.throws(() => new JmClient({ timeoutMs }), TypeError);
  const client = new JmClient({ fetch: () => { throw new Error('unexpected network'); } });
  for (const id of [0, -1, 1.5, 9007199254740992, '01', '1/2', '']) await assert.rejects(client.getComic(id), TypeError);
  await assert.rejects(client.search(''), TypeError);
  await assert.rejects(client.search('x', { sort: 'toString' }), TypeError);
  await assert.rejects(client.search('x', { page: 0 }), TypeError);
});

test('reports HTTP, API, envelope, network, and decryption errors', async () => {
  const make = fetch => new JmClient({ fetch });
  await assert.rejects(make(async () => response('no', 503)).getComic(1), e => rejectCode('HTTP_ERROR')(e) && e.status === 503);
  await assert.rejects(make(async () => response(JSON.stringify({ code: 403, errorMsg: 'denied' }))).getComic(1), e => rejectCode('API_ERROR')(e) && e.apiCode === 403 && e.message.includes('denied'));
  for (const body of ['not json', '{}', '{"code":200,"data":{}}']) await assert.rejects(make(async () => response(body)).getComic(1), rejectCode('INVALID_RESPONSE'));
  for (const data of ['not base64', '', 'YQ==', 'AAAAAAAAAAAAAAAAAAAAAA==']) await assert.rejects(make(async () => response(JSON.stringify({ code: 200, data }))).getComic(1), rejectCode('DECRYPT_ERROR'));
  await assert.rejects(make(async () => { throw new Error('offline'); }).getComic(1), rejectCode('NETWORK_ERROR'));
  await assert.rejects(make(async (_url, options) => response(envelope(options, { invalid: true }))).getComic(1), rejectCode('INVALID_RESPONSE'));
  await assert.rejects(make(async (_url, options) => response(envelope(options, { redirect_aid: 'bad' }))).search('x'), rejectCode('INVALID_RESPONSE'));
});

test('timeout covers hanging fetch and response body, and aborts underlying signal', async () => {
  let fetchSignal;
  const hangingFetch = new JmClient({ timeoutMs: 15, fetch: (_url, options) => { fetchSignal = options.signal; return new Promise(() => {}); } });
  await assert.rejects(hangingFetch.getComic(1), rejectCode('TIMEOUT'));
  assert.equal(fetchSignal.aborted, true);
  let cancelled = false;
  const hangingBody = new JmClient({ timeoutMs: 15, fetch: async (_url, options) => {
    fetchSignal = options.signal;
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  } });
  await assert.rejects(hangingBody.getChapter(1), rejectCode('TIMEOUT'));
  assert.equal(fetchSignal.aborted, true);
  assert.equal(cancelled, true);
});

test('streaming response size cap accepts boundary and cancels excess', async () => {
  const limit = 8 * 1024 * 1024;
  let cancelled = false;
  let pulls = 0;
  const tooLarge = new JmClient({ fetch: async () => new Response(new ReadableStream({
    pull(controller) {
      pulls++;
      controller.enqueue(new Uint8Array(pulls === 1 ? limit : 1));
    },
    cancel() { cancelled = true; },
  })) });
  await assert.rejects(tooLarge.getComic(1), rejectCode('RESPONSE_TOO_LARGE'));
  assert.equal(cancelled, true);
  assert.ok(pulls <= 3);

  // Exactly the limit is accepted: JSON allows whitespace after the envelope.
  const atLimit = new JmClient({ fetch: async (_url, options) => {
    const json = envelope(options, comic);
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(json));
        controller.enqueue(new Uint8Array(limit - Buffer.byteLength(json)).fill(0x20));
        controller.close();
      },
    }));
  } });
  assert.deepEqual(await atLimit.getComic(1), comic);
  await assert.rejects(new JmClient({ fetch: async () => ({ status: 200, text: async () => '{}' }) }).getComic(1), rejectCode('INVALID_RESPONSE'));
});

test('caller abort works before and during requests', async () => {
  let called = false;
  let underlying;
  const client = new JmClient({ fetch: (_url, options) => { called = true; underlying = options.signal; return new Promise(() => {}); } });
  const prior = new AbortController();
  prior.abort();
  await assert.rejects(client.getComic(1, { signal: prior.signal }), rejectCode('ABORTED'));
  assert.equal(called, false);
  const pending = new AbortController();
  const request = client.getComic(1, { signal: pending.signal });
  pending.abort('stop');
  await assert.rejects(request, rejectCode('ABORTED'));
  assert.equal(underlying.aborted, true);
});
