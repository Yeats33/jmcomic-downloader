import { test } from 'node:test';
import assert from 'node:assert/strict';
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

test('real Gateway validates and reads mocked fixed-CDN cover, propagates cancellation and disposes', { timeout: 10000 }, async () => {
  const png = await sharp({ create: { width: 480, height: 720, channels: 3, background: '#e48122' } }).png().toBuffer();
  const originalFetch = globalThis.fetch, calls = [], root = new Context();
  let blocked = false, startedResolve, imageSignal;
  let started = new Promise(resolve => { startedResolve = resolve; });
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    assert.equal(url.href, 'https://cdn-msp3.18comic.vip/media/albums/123_3x4.jpg', 'unexpected network request blocked');
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error');
    assert.equal(init.headers.cookie, undefined); assert.equal(init.headers.authorization, undefined);
    if (blocked) {
      imageSignal = init.signal; startedResolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('mock wait expired')), 2000);
        const abort = () => { clearTimeout(timer); reject(init.signal.reason); };
        if (init.signal.aborted) abort(); else init.signal.addEventListener('abort', abort, { once: true });
      });
    }
    return new Response(png);
  };
  try {
    await root.plugin(Registry); await root.plugin(RemoteAccess); await root.plugin(SystemPrompt, {});
    await root.plugin(Tools); await root.plugin(Gateway, {});
    const fiber = root.plugin(jmcomic, { apiDomain: 'https://example.invalid', timeoutMs: 3000, downloadRoot: '' });
    await fiber;
    assert.ok(root.typert.local.get('jmcomic/cover'));
    const invoke = (args, signal = new AbortController().signal) => root.typertGateway.invoke({
      namespace: 'jmcomic', method: 'cover', args, signal,
      peer: { principal: { kind: 'owner' }, signal, ctx: root, interactions: 'answer' },
    });
    for (const args of [{}, { id: 123 }, { id: null }, { id: ['123'] }, { id: '123', extra: 1 }]) {
      await assert.rejects(invoke(args), e => ['gateway/arguments-invalid', 'gateway/input-invalid'].includes(e.code), JSON.stringify(args));
    }
    for (const id of ['', '0', '01', '../123', '9223372036854775808']) await assert.rejects(invoke({ id }));
    assert.equal(calls.length, 0, 'invalid ids never reach network');
    const raw = await invoke({ id: '123' });
    assert.equal(typeof raw, 'string');
    const result = JSON.parse(raw);
    assert.deepEqual(Object.keys(result).sort(), ['data', 'id', 'mime']);
    assert.equal(result.id, '123'); assert.equal(result.mime, 'image/jpeg'); assert.equal(typeof result.data, 'string');
    const bytes = Buffer.from(result.data, 'base64');
    assert.equal(bytes.toString('base64'), result.data); assert.notDeepEqual(bytes, png);
    const metadata = await sharp(bytes).metadata();
    assert.equal(metadata.format, 'jpeg'); assert.equal(metadata.width, 240); assert.equal(metadata.height, 360);
    blocked = true;
    const controller = new AbortController();
    const pending = invoke({ id: '123' }, controller.signal);
    await started; controller.abort(new Error('mock cancel'));
    await assert.rejects(pending, e => e.cause?.code === 'ABORTED', 'Gateway wraps the service cancellation');
    assert.equal(imageSignal.aborted, true);
    blocked = false;
    assert.equal(JSON.parse(await invoke({ id: '123' })).id, '123', 'slot released after cancellation');
    blocked = true;
    started = new Promise(resolve => { startedResolve = resolve; });
    const pendingDispose = invoke({ id: '123' });
    await started;
    const rejected = assert.rejects(pendingDispose, e => e.code === 'DISPOSED');
    await fiber.dispose(); await rejected;
    assert.equal(imageSignal.aborted, true, 'plugin disposal cancels pending cover');
    assert.equal(root.typert.local.get('jmcomic/cover'), undefined);
  } finally {
    try { await root.fiber.dispose(); } finally { globalThis.fetch = originalFetch; }
  }
});
