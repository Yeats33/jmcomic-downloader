import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import * as jmcomic from '../index.js';

const requireFromDsh = createRequire(process.env.DSH_PACKAGE_JSON ?? '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/package.json');
const host = name => import(pathToFileURL(requireFromDsh.resolve(`@deepseek-ai/${name}`)).href);
const [{ Context }, { default: Registry }, { default: Gateway }, { default: RemoteAccess }, { default: SystemPrompt }, { default: Tools }] = await Promise.all([
  host('cordis'), host('dsh-typert-registry'), host('dsh-api-gateway'),
  host('dsh-api-remote-access'), host('dsh-system-prompt'), host('dsh-tools'),
]);

// Independently produce the inverse stripe layout: 220980 uses ten blocks.
function scramble(plain, width, height) {
  const result = Buffer.alloc(plain.length), row = width * 3, base = Math.floor(height / 10), rem = height % 10;
  for (let i = 0; i < 10; i++) {
    const count = base + (i === 0 ? rem : 0);
    const source = base * i + (i === 0 ? 0 : rem);
    const destination = height - base * (i + 1) - rem;
    plain.copy(result, destination * row, source * row, (source + count) * row);
  }
  return result;
}

test('real Gateway reads one mocked CDN image, validates inputs and propagates cancellation', { timeout: 15000 }, async () => {
  const width = 4, height = 13, plain = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 3;
    plain[i] = y * 17; plain[i + 1] = x * 51; plain[i + 2] = (y * 19 + x * 7) % 256;
  }
  const scrambled = scramble(plain, width, height);
  assert.notDeepEqual(scrambled, plain);
  const webp = await sharp(scrambled, { raw: { width, height, channels: 3 } }).webp({ lossless: true }).toBuffer();
  const originalFetch = globalThis.fetch, calls = [], root = new Context();
  let blockImage = false, imageStarted, blockedSignal;
  const started = new Promise(resolve => { imageStarted = resolve; });
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    assert.equal(init.redirect, 'error');
    if (url.origin === 'https://example.invalid' && url.pathname === '/chapter') {
      assert.equal(url.searchParams.get('id'), '220980');
      const fixture = { id: '220980', name: 'fixture', series: [], images: ['00001.webp', '00002.webp'] };
      const timestamp = init.headers.tokenparam.split(',')[0];
      const key = createHash('md5').update(`${timestamp}185Hcomic3PAPP7R`).digest('hex');
      const cipher = createCipheriv('aes-256-ecb', Buffer.from(key, 'ascii'), null);
      const data = Buffer.concat([cipher.update(JSON.stringify(fixture)), cipher.final()]).toString('base64');
      return new Response(JSON.stringify({ code: 200, data }));
    }
    if (url.origin === 'https://example.invalid' && url.pathname === '/chapter_view_template') {
      assert.equal(url.searchParams.get('id'), '220980');
      return new Response('var scramble_id = 220980;');
    }
    if (url.href === 'https://cdn-msp2.jmapiproxy2.cc/media/photos/220980/00001.webp') {
      if (blockImage) {
        blockedSignal = init.signal;
        imageStarted();
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('mock image wait expired')), 2000);
          const abort = () => { clearTimeout(timer); reject(init.signal.reason); };
          if (init.signal.aborted) abort(); else init.signal.addEventListener('abort', abort, { once: true });
        });
      }
      return new Response(webp);
    }
    assert.fail(`Unexpected outbound request blocked: ${url.href}`);
  };
  try {
    await root.plugin(Registry); await root.plugin(RemoteAccess); await root.plugin(SystemPrompt, {});
    await root.plugin(Tools); await root.plugin(Gateway, {});
    const fiber = root.plugin(jmcomic, { apiDomain: 'https://example.invalid', timeoutMs: 3000, downloadRoot: '' });
    await fiber;
    assert.ok(root.typert.local.get('jmcomic/readPage'));
    const invoke = (args, signal = new AbortController().signal) => root.typertGateway.invoke({
      namespace: 'jmcomic', method: 'readPage', args, signal,
      peer: { principal: { kind: 'owner' }, signal, ctx: root, interactions: 'answer' },
    });
    for (const args of [{}, { id: '220980' }, { page: '1' }, { id: 220980, page: '1' },
      { id: '220980', page: 1 }, { id: null, page: '1' }, { id: '220980', page: null },
      { id: '220980', page: '1', extra: true }]) {
      await assert.rejects(invoke(args), error => ['gateway/arguments-invalid', 'gateway/input-invalid'].includes(error.code), JSON.stringify(args));
    }
    for (const args of [{ id: '../bad', page: '1' }, ...['0', '-1', '01', '1.5', '', '1000000'].map(page => ({ id: '220980', page }))]) {
      await assert.rejects(invoke(args), undefined, JSON.stringify(args));
    }
    assert.equal(calls.length, 0, 'invalid inputs do not reach network');
    await assert.rejects(invoke({ id: '220980', page: '3' }));
    assert.deepEqual(calls.map(c => c.url.pathname), ['/chapter'], 'out of range rejected before template or image fetch');
    calls.length = 0;
    const raw = await invoke({ id: '220980', page: '1' });
    assert.equal(typeof raw, 'string');
    const result = JSON.parse(raw);
    assert.deepEqual(Object.keys(result).sort(), ['chapterId', 'data', 'mime', 'page', 'total']);
    assert.equal(result.chapterId, '220980'); assert.equal(result.page, 1); assert.equal(result.total, 2);
    assert.equal(result.mime, 'image/png'); assert.equal(typeof result.data, 'string');
    const bytes = Buffer.from(result.data, 'base64');
    assert.equal(bytes.toString('base64'), result.data);
    const decoded = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
    assert.equal(decoded.info.format, 'raw'); assert.equal(decoded.info.width, width); assert.equal(decoded.info.height, height);
    assert.equal(decoded.info.channels, 3); assert.deepEqual(decoded.data, plain, 'actual sharp pipeline restores stripes');
    assert.deepEqual(calls.map(c => c.url.pathname).sort(), ['/chapter', '/chapter_view_template', '/media/photos/220980/00001.webp'].sort());
    blockImage = true;
    const controller = new AbortController();
    const pending = invoke({ id: '220980', page: '1' }, controller.signal);
    await started;
    controller.abort(new Error('cancel fixture'));
    await assert.rejects(pending);
    assert.equal(blockedSignal.aborted, true, 'peer cancellation reaches the CDN fetch');
    blockImage = false;
    assert.equal(JSON.parse(await invoke({ id: '220980', page: '1' })).page, 1, 'slot released after cancellation');
    await fiber.dispose();
    assert.equal(root.typert.local.get('jmcomic/readPage'), undefined);
  } finally {
    try { await root.fiber.dispose(); } finally { globalThis.fetch = originalFetch; }
  }
});
