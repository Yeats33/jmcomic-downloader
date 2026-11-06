import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
function load(fetch) {
  let plugin;
  const slots = [];
  const context = {
    window: { __ModuleLoader__: { load({ id, factory }) {
      assert.equal(id, '@local/dsh-jmcomic');
      plugin = factory(name => {
        assert.equal(name, 'react');
        return { createElement() {} };
      });
    } } },
    crypto: { randomUUID: () => 'request-123' }, fetch, AbortController,
  };
  runInNewContext(source, context);
  plugin.apply({ slots: {
    inject(name, fn) { slots.push(name); fn(); },
    register(spec) { assert.ok(spec.name === 'main' || spec.name === 'sidebar.panellist'); },
  } });
  return { adapter: plugin.createAdapter(), slots };
}
function response(value, rpcId = 'request-123') {
  return { ok: true, json: async () => ({ type: 'server-response', rpcId, result: { ok: true, value: JSON.stringify(value) } }) };
}

test('client registers sidebar and main, calls same-origin strict Gateway', async () => {
  const requests = [];
  const { adapter, slots } = load(async (url, init) => {
    requests.push({ url, init, message: JSON.parse(init.body) });
    return response({ id: '123', images: [] });
  });
  const controller = new AbortController();
  const value = await adapter.download('123', controller.signal);
  assert.equal(value.id, '123');
  assert.equal(slots.join(','), 'main,sidebar.panellist');
  assert.equal(requests[0].url, 'api/jmcomic/download');
  assert.equal(requests[0].message.method, 'jmcomic/download');
  assert.equal(requests[0].message.payload.args.id, '123');
  assert.equal(requests[0].init.signal, controller.signal);
  assert.equal(requests[0].init.redirect, 'error');
});

test('client rejects mismatched envelopes, host failures and invalid JSON', async () => {
  const { adapter: badId } = load(async () => response({}, 'other'));
  await assert.rejects(badId.comic('1'), /请求标识/);
  const { adapter: failure } = load(async () => ({ ok: true, json: async () => ({ type: 'server-response', rpcId: 'request-123', result: { ok: false, error: { code: 'test/error', message: 'failed', details: {} } } }) }));
  await assert.rejects(failure.chapter('1'), /test\/error/);
  const { adapter: badJson } = load(async () => ({ ok: true, json: async () => ({ type: 'server-response', rpcId: 'request-123', result: { ok: true, value: '{' } }) }));
  await assert.rejects(badJson.search('test', 1), /JSON/);
});
