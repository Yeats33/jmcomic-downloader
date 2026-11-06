import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, realpath, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import * as jmcomic from '../index.js';

// Resolve all Host dependencies from one DSH installation, not from a user profile.
const dshPackage = process.env.DSH_PACKAGE_JSON ?? '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/package.json';
const requireFromDsh = createRequire(dshPackage);
async function hostPackage(name) {
  return import(pathToFileURL(requireFromDsh.resolve(`@deepseek-ai/${name}`)).href);
}
const [{ Context }, { default: Registry }, { default: Gateway }, { default: RemoteAccess }, { default: SystemPrompt }, { default: Tools }] = await Promise.all([
  hostPackage('cordis'), hostPackage('dsh-typert-registry'), hostPackage('dsh-api-gateway'),
  hostPackage('dsh-api-remote-access'), hostPackage('dsh-system-prompt'), hostPackage('dsh-tools'),
]);

function encryptedSearch(fetchCalls) {
  return async (url, init) => {
    fetchCalls.push({ url: new URL(url), init });
    const timestamp = init.headers.tokenparam.split(',')[0];
    const key = createHash('md5').update(`${timestamp}185Hcomic3PAPP7R`).digest('hex');
    const cipher = createCipheriv('aes-256-ecb', Buffer.from(key, 'ascii'), null);
    const pathname = new URL(url).pathname;
    const fixture = pathname === '/search'
      ? { search_query: 'example', content: [{ id: '123', name: 'fixture' }], total: 1 }
      : pathname === '/album'
        ? { id: '123', name: 'album fixture', series: [] }
        : pathname === '/chapter'
          ? { id: '123', name: 'chapter fixture', series: [], images: [] }
          : assert.fail(`Unexpected outbound request: ${pathname}`);
    const plain = JSON.stringify(fixture);
    const data = Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64');
    return new Response(JSON.stringify({ code: 200, data }), { status: 200 });
  };
}

test('Cordis host registers real Typert, Gateway, and tools; strict RPC and anonymous search', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = encryptedSearch(calls);
  const root = new Context();
  try {
    await root.plugin(Registry);
    await root.plugin(RemoteAccess);
    await root.plugin(SystemPrompt, {});
    await root.plugin(Tools);
    await root.plugin(Gateway, {});
    const fiber = root.plugin(jmcomic, { apiDomain: 'https://example.invalid', timeoutMs: 3000, downloadRoot: '' });
    await fiber;
    assert.ok(root.jmcomic, 'host service is active');
    assert.ok(root.typert.getPackage('@local/dsh-jmcomic', 'host'));
    for (const method of ['chapter', 'comic', 'download', 'search']) {
      assert.ok(root.typert.local.get(`jmcomic/${method}`), `${method} has a strict registered descriptor`);
    }
    for (const name of ['jmcomic_chapter', 'jmcomic_comic', 'jmcomic_download_chapter', 'jmcomic_search']) {
      assert.ok(root.tools.get(name), `${name} is registered in the real tools service`);
    }

    const peer = { principal: { kind: 'owner' }, signal: new AbortController().signal, ctx: root, interactions: 'answer' };
    const invoke = (method, args) => root.typertGateway.invoke({ namespace: 'jmcomic', method, args, peer });
    for (const args of [
      { keyword: 'example' },
      { keyword: 'example', page: '1', extra: true },
      { keyword: 'example', page: 1 },
      { keyword: ['example'], page: '1' },
      { keyword: 'example', page: null },
    ]) {
      await assert.rejects(invoke('search', args), error => ['gateway/arguments-invalid', 'gateway/input-invalid'].includes(error.code), JSON.stringify(args));
    }
    for (const method of ['comic', 'chapter']) {
      for (const args of [{}, { id: 123 }, { id: null }, { id: '123', extra: 1 }]) {
        await assert.rejects(invoke(method, args), error => ['gateway/arguments-invalid', 'gateway/input-invalid'].includes(error.code), `${method}: ${JSON.stringify(args)}`);
      }
      await assert.rejects(invoke(method, { id: '../invalid' }));
    }
    for (const args of [{}, { id: 123 }, { id: null }, { id: '123', extra: true }]) {
      await assert.rejects(invoke('download', args), error => ['gateway/arguments-invalid', 'gateway/input-invalid'].includes(error.code));
    }
    await assert.rejects(invoke('download', { id: '123' }), /下载未启用/);
    await assert.rejects(root.tools.get('jmcomic_download_chapter').execute({ id: '123' }, { signal: new AbortController().signal }), /下载未启用/);
    assert.equal(calls.length, 0, 'invalid or disabled requests never reach fetch');
    for (const args of [{ keyword: '', page: '1' }, { keyword: 'example', page: '0' }]) {
      await assert.rejects(invoke('search', args));
    }
    assert.equal(calls.length, 0, 'invalid semantic inputs never reach fetch');
    const result = JSON.parse(await invoke('search', { keyword: ' example ', page: '2' }));
    assert.equal(result.type, 'search');
    assert.equal(result.data.content[0].name, 'fixture');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.href, 'https://example.invalid/search?main_tag=0&search_query=example&page=2&o=mr');
    assert.equal(calls[0].init.headers.cookie, undefined);
    assert.equal(calls[0].init.headers.authorization, undefined);
    assert.equal(calls[0].init.redirect, 'error');
    assert.equal(JSON.parse(await invoke('comic', { id: '123' })).name, 'album fixture');
    assert.equal(JSON.parse(await invoke('chapter', { id: '123' })).name, 'chapter fixture');
    assert.equal(calls[1].url.pathname, '/album');
    assert.equal(calls[2].url.pathname, '/chapter');

    const tool = root.tools.get('jmcomic_search');
    assert.ok(tool);
    const toolResult = JSON.parse(await tool.execute({ keyword: 'example' }, { signal: new AbortController().signal }));
    assert.equal(toolResult.data.content[0].id, '123');
    for (const [name, expected] of [['jmcomic_comic', 'album fixture'], ['jmcomic_chapter', 'chapter fixture']]) {
      const definition = root.tools.get(name);
      assert.ok(definition);
      assert.equal(JSON.parse(await definition.execute({ id: '123' }, { signal: new AbortController().signal })).name, expected);
    }
    assert.equal(calls.length, 6);
    await fiber.dispose();
    assert.equal(root.typert.local.get('jmcomic/search'), undefined);
    assert.equal(root.tools.get('jmcomic_search'), undefined);
  } finally {
    try { await root.fiber.dispose(); }
    finally { globalThis.fetch = originalFetch; }
  }
});

test('Gateway and tool download real images into an isolated root without overwrite; failures clean up', async () => {
  // Resolve /var (a symlink on macOS) before making the root: the downloader
  // correctly rejects any symlink in the root's ancestor chain.
  const downloadRoot = await mkdtemp(path.join(await realpath(tmpdir()), 'jm-dsh-integration-'));
  const originalFetch = globalThis.fetch;
  const root = new Context();
  const calls = [];
  let imageStarted;
  let releaseImage;
  const imageStartedPromise = new Promise(resolve => { imageStarted = resolve; });
  const imageReleasePromise = new Promise(resolve => { releaseImage = resolve; });
  let holdFirstImage = true;
  try {
    const webp = await sharp({ create: { width: 2, height: 3, channels: 3, background: '#ff8000' } }).webp({ lossless: true }).toBuffer();
    globalThis.fetch = async (input, init) => {
      const url = new URL(input);
      calls.push({ url, init });
      if (url.origin === 'https://example.invalid' && url.pathname === '/chapter_view_template') {
        assert.match(url.searchParams.get('id'), /^(123|124|125)$/);
        assert.equal(url.searchParams.get('mode'), 'vertical');
        return new Response('var scramble_id = 999999;');
      }
      if (url.origin === 'https://example.invalid' && url.pathname === '/chapter') {
        const id = url.searchParams.get('id');
        assert.match(id, /^(123|124|125)$/);
        const fixture = { id, name: 'fixture', series: [], images: id === '124' ? ['one.webp', 'fail.webp'] : ['one.webp'] };
        const timestamp = init.headers.tokenparam.split(',')[0];
        const key = createHash('md5').update(`${timestamp}185Hcomic3PAPP7R`).digest('hex');
        const cipher = createCipheriv('aes-256-ecb', Buffer.from(key, 'ascii'), null);
        const data = Buffer.concat([cipher.update(JSON.stringify(fixture)), cipher.final()]).toString('base64');
        return new Response(JSON.stringify({ code: 200, data }));
      }
      if (url.origin === 'https://cdn-msp2.jmapiproxy2.cc' && /^\/media\/photos\/(123|124|125)\/(one|fail)\.webp$/.test(url.pathname)) {
        assert.equal(init.redirect, 'error');
        if (holdFirstImage && url.pathname === '/media/photos/123/one.webp') {
          holdFirstImage = false;
          imageStarted();
          await imageReleasePromise;
        }
        return url.pathname.endsWith('/fail.webp') ? new Response('mock failure', { status: 503 }) : new Response(webp);
      }
      assert.fail(`Unexpected request blocked by mock fetch: ${url.href}`);
    };
    await root.plugin(Registry);
    await root.plugin(RemoteAccess);
    await root.plugin(SystemPrompt, {});
    await root.plugin(Tools);
    await root.plugin(Gateway, {});
    const fiber = root.plugin(jmcomic, { apiDomain: 'https://example.invalid', timeoutMs: 3000, downloadRoot });
    await fiber;
    assert.ok(root.jmcomic, 'configured host service is active');
    const peer = { principal: { kind: 'owner' }, signal: new AbortController().signal, ctx: root, interactions: 'answer' };
    const invoke = id => root.typertGateway.invoke({ namespace: 'jmcomic', method: 'download', args: { id }, peer });
    const tool = root.tools.get('jmcomic_download_chapter');
    assert.ok(tool, 'download tool registered');
    const agent = { id: 'integration-agent' };
    const signal = new AbortController().signal;
    const exec = { agent, callId: 'integration-call', signal };
    await assert.rejects(tool.execute({ id: '125' }, exec), /审批通道/);
    assert.equal(calls.length, 0, 'missing approval service never reaches network');

    const approvalCalls = [];
    let approvalOutcome = 'rejected';
    root.provide('approval', { request: async request => { approvalCalls.push(request); return approvalOutcome; } });
    await assert.rejects(tool.execute({ id: '125' }, { callId: exec.callId, signal }), /审批通道/);
    assert.equal(approvalCalls.length, 0, 'missing agent never invokes approval');
    assert.equal(calls.length, 0, 'missing agent never reaches network');
    for (const outcome of ['rejected', 'cancelled', 'unavailable']) {
      approvalOutcome = outcome;
      await assert.rejects(tool.execute({ id: '125' }, exec), /未获批准/);
      assert.equal(calls.length, 0, `${outcome} approval never reaches network`);
    }
    assert.equal(approvalCalls.length, 3);
    assert.equal(approvalCalls[0].agent, agent);
    assert.equal(approvalCalls[0].toolName, 'jmcomic_download_chapter');
    assert.equal(approvalCalls[0].callId, exec.callId);
    assert.equal(approvalCalls[0].signal, signal);
    assert.ok(approvalCalls[0].reason.includes('125'));
    assert.ok(approvalCalls[0].reason.includes(downloadRoot));
    approvalOutcome = 'allowed-once';
    const aborted = new AbortController();
    aborted.abort(new Error('integration cancellation'));
    await assert.rejects(tool.execute({ id: '125' }, { ...exec, signal: aborted.signal }), /integration cancellation/);
    assert.equal(calls.length, 0, 'cancellation after approval never reaches network');
    const beforeInvalidApproval = approvalCalls.length;
    await assert.rejects(tool.execute({ id: '../invalid' }, exec), /章节 ID/);
    assert.equal(approvalCalls.length, beforeInvalidApproval, 'invalid id is rejected before approval');
    assert.equal(calls.length, 0, 'invalid id never reaches network');

    // A manual Gateway call requires no approval; while it is in flight, both
    // Gateway and approved tool calls must hit the same lock before I/O.
    const pending = invoke('123');
    await imageStartedPromise;
    const beforeBusy = calls.length;
    const beforeBusyApprovals = approvalCalls.length;
    await assert.rejects(invoke('125'), /已有章节正在下载/);
    await assert.rejects(tool.execute({ id: '125' }, exec), /已有章节正在下载/);
    assert.equal(approvalCalls.length, beforeBusyApprovals + 1);
    assert.equal(calls.length, beforeBusy, 'busy download attempts do not reach network');
    releaseImage();
    const result = JSON.parse(await pending);
    assert.deepEqual(result, { chapterId: '123', imageCount: 1, directory: path.join(downloadRoot, 'chapter-123') });
    const output = path.join(result.directory, '0001.jpg');
    const before = await readFile(output);
    assert.deepEqual(await readdir(result.directory).then(items => items.sort()), ['.complete.json', '0001.jpg']);
    assert.deepEqual(JSON.parse(await readFile(path.join(result.directory, '.complete.json'), 'utf8')), { chapterId: '123', imageCount: 1, format: 'jpeg' });
    const metadata = await sharp(before).metadata();
    assert.equal(metadata.format, 'jpeg');
    assert.equal(metadata.width, 2);
    assert.equal(metadata.height, 3);
    await assert.rejects(invoke('123'), error => error.code === 'EEXIST');
    assert.deepEqual(await readFile(output), before, 'existing output is never overwritten');

    await assert.rejects(invoke('124'), /image HTTP status 503/);
    assert.ok(calls.some(({ url }) => url.pathname === '/media/photos/124/one.webp'), 'first page was fetched before failure');
    assert.ok(calls.some(({ url }) => url.pathname === '/media/photos/124/fail.webp'), 'second page caused the failure');
    assert.ok(!(await readdir(downloadRoot)).includes('chapter-124'), 'partial files and chapter directory were cleaned up');

    const approvedBeforeDownload = approvalCalls.length;
    const toolResult = JSON.parse(await tool.execute({ id: '125' }, exec));
    assert.equal(approvalCalls.length, approvedBeforeDownload + 1, 'tool requires a fresh explicit approval');
    assert.deepEqual(toolResult, { chapterId: '125', imageCount: 1, directory: path.join(downloadRoot, 'chapter-125') });
    assert.equal((await sharp(await readFile(path.join(toolResult.directory, '0001.jpg'))).metadata()).format, 'jpeg');
    const toolOutput = await readFile(path.join(toolResult.directory, '0001.jpg'));
    await assert.rejects(tool.execute({ id: '125' }, exec), error => error.code === 'EEXIST');
    assert.equal(approvalCalls.length, approvedBeforeDownload + 2, 'each retry requests approval again');
    assert.deepEqual(await readFile(path.join(toolResult.directory, '0001.jpg')), toolOutput);
    assert.ok(calls.some(({ url }) => url.pathname === '/chapter_view_template'));
    assert.ok(calls.some(({ url }) => url.pathname === '/chapter'));
    assert.ok(calls.some(({ url }) => url.pathname === '/media/photos/123/one.webp'));
    await fiber.dispose();
    assert.equal(root.tools.get('jmcomic_download_chapter'), undefined);
    assert.equal(root.typert.local.get('jmcomic/download'), undefined);
  } finally {
    releaseImage();
    try { await root.fiber.dispose(); }
    finally {
      globalThis.fetch = originalFetch;
      // Only delete the exact isolated directory created by mkdtemp above.
      await rm(downloadRoot, { recursive: true, force: true });
    }
  }
});
