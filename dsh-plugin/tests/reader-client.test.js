import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

// Isolated minimal hook renderer, not a DOM or React implementation. It exercises
// the actual Panel/Reader element handlers and effect cleanup without packages or
// timers. Every test owns its VM, component state and URL registry.
function harness(fetch = async () => { throw new Error('unexpected network'); }) {
  const instances = new Map(), created = [], revoked = [];
  let current, hookIndex, dirty = true, tree, Panel, plugin;
  const fragment = Symbol('fragment');
  const React = {
    Fragment: fragment,
    createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat(Infinity) }; },
    useState(initial) {
      const instance = current, index = hookIndex++;
      if (!(index in instance.hooks)) instance.hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [instance.hooks[index], value => { const next = typeof value === 'function' ? value(instance.hooks[index]) : value; if (!Object.is(next, instance.hooks[index])) { instance.hooks[index] = next; dirty = true; } }];
    },
    useRef(initial) { const index = hookIndex++; return current.hooks[index] ??= { current: initial }; },
    useEffect(effect, deps) {
      const instance = current, index = hookIndex++, previous = instance.hooks[index];
      if (!previous || deps.some((v, i) => !Object.is(v, previous.deps[i]))) {
        instance.effects.push(() => { previous?.cleanup?.(); instance.hooks[index] = { deps, cleanup: effect() }; });
      }
    },
  };
  const context = {
    window: { __ModuleLoader__: { load({ factory }) { plugin = factory(name => { assert.equal(name, 'react'); return React; }); } } },
    crypto: { randomUUID: () => 'request-id' }, AbortController, Blob, Uint8Array, atob, btoa,
    URL: { createObjectURL(blob) { const url = `blob:test-${created.length + 1}`; created.push({ url, blob }); return url; }, revokeObjectURL(url) { revoked.push(url); } },
    fetch,
  };
  runInNewContext(source, context);
  plugin.apply({ slots: { inject(_name, fn) { fn(); }, register(spec, component) { if (spec.name === 'main') Panel = component; } } });
  function render(node, path, seen) {
    if (node == null || typeof node === 'boolean') return null;
    if (Array.isArray(node)) return node.map((child, i) => render(child, `${path}.${i}`, seen));
    if (typeof node !== 'object') return node;
    if (node.type === fragment) return render(node.children, `${path}.f`, seen);
    if (typeof node.type === 'function') {
      const key = `${path}:${node.type.name}:${node.props.key ?? ''}`;
      let instance = instances.get(key);
      if (!instance) { instance = { hooks: [], effects: [] }; instances.set(key, instance); }
      seen.add(key); current = instance; hookIndex = 0;
      const output = node.type({ ...node.props, children: node.children });
      return render(output, `${path}.c`, seen);
    }
    return { type: node.type, props: node.props, children: render(node.children, `${path}.h`, seen) };
  }
  function cleanup(instance) { for (const h of instance.hooks) h?.cleanup?.(); }
  let api;
  function flush() {
    for (let loops = 0; dirty; loops++) {
      assert.ok(loops < 30, 'renderer did not settle'); dirty = false;
      const seen = new Set();
      tree = render(React.createElement(Panel, { api }), 'root', seen);
      for (const [key, instance] of instances) if (!seen.has(key)) { cleanup(instance); instances.delete(key); }
      for (const instance of instances.values()) for (const effect of instance.effects.splice(0)) effect();
    }
  }
  async function settle() { for (let i = 0; i < 6; i++) { await Promise.resolve(); flush(); } }
  function nodes(node = tree) { if (Array.isArray(node)) return node.flatMap(nodes); if (!node || typeof node !== 'object') return []; return [node, ...nodes(node.children)]; }
  function text(node) { if (Array.isArray(node)) return node.map(text).join(''); if (node == null || typeof node === 'boolean') return ''; return typeof node === 'object' ? text(node.children) : String(node); }
  function find(type, label) { const found = nodes().find(n => n.type === type && (text(n) === label || n.props['aria-label'] === label)); assert.ok(found, `${type} ${label} not found; text: ${text(tree)}`); return found; }
  return { plugin, created, revoked, mount(value) { api = value; flush(); }, flush, settle, find, text: () => text(tree), unmount() { for (const instance of instances.values()) cleanup(instance); instances.clear(); } };
}
const result = page => ({ chapterId: '456', page, total: 3, mime: 'image/png', data: 'AQID' });
async function openReader(h, api) {
  h.mount(api);
  h.find('input', '搜索关键词').props.onChange({ target: { value: 'fixture' } }); h.flush();
  h.find('form', '搜索').props.onSubmit({ preventDefault() {} }); await h.settle();
  h.find('button', '第一话 · 456').props.onClick(); await h.settle();
  h.find('button', '在线阅读').props.onClick(); await h.settle();
}
const baseApi = readPage => ({
  search: async () => ({ type: 'comic', data: { id: '123', name: '漫画', series: [{ id: '456', name: '第一话' }] } }),
  chapter: async () => ({ id: '456', name: '第一话', images: ['a', 'b', 'c'] }), readPage,
});

test('reader cancels quick page changes and back, ignores late responses, and releases URLs', async () => {
  const h = harness(), requests = [];
  await openReader(h, baseApi((id, page, signal) => { const d = deferred(); requests.push({ id, page, signal, ...d }); return d.promise; }));
  assert.equal(requests.length, 1); assert.equal(requests[0].id, '456'); assert.equal(requests[0].page, 1);
  requests[0].resolve(result(1)); await h.settle();
  assert.equal(h.find('img', '').props.src, 'blob:test-1');
  assert.equal(h.created[0].blob.type, 'image/png');
  h.find('button', '后一页').props.onClick(); await h.settle();
  assert.equal(requests[0].signal.aborted, true); assert.deepEqual(h.revoked, ['blob:test-1']);
  assert.equal(requests[1].page, 2);
  h.find('input', '跳转页码').props.onChange({ target: { value: '3' } }); h.flush();
  h.find('form', '跳转页码 跳转').props.onSubmit({ preventDefault() {} }); await h.settle();
  assert.equal(requests[1].signal.aborted, true); assert.equal(requests[2].page, 3);
  requests[1].resolve(result(2)); await h.settle(); assert.equal(h.created.length, 1, 'late page 2 creates no URL');
  requests[2].resolve(result(3)); await h.settle(); assert.equal(h.find('img', '').props.src, 'blob:test-2');
  h.find('button', '← 返回章节').props.onClick(); await h.settle();
  assert.equal(requests[2].signal.aborted, true); assert.deepEqual(h.revoked, ['blob:test-1', 'blob:test-2']);
  assert.ok(h.text().includes('下载本章'));
  h.find('button', '在线阅读').props.onClick(); await h.settle();
  h.find('button', '← 返回章节').props.onClick(); await h.settle();
  assert.equal(requests[3].signal.aborted, true);
  requests[3].resolve(result(1)); await h.settle(); assert.equal(h.created.length, 2, 'late response after back creates no URL');
  h.unmount();
});

test('reader exposes errors and retry, revokes broken image and unmounted image', async () => {
  const h = harness(), requests = [];
  await openReader(h, baseApi((_id, page, signal) => { const d = deferred(); requests.push({ page, signal, ...d }); return d.promise; }));
  requests[0].reject(new Error('mock offline')); await h.settle();
  assert.ok(h.text().includes('mock offline')); h.find('button', '重试').props.onClick(); await h.settle();
  assert.equal(requests[1].page, 1); requests[1].resolve(result(1)); await h.settle();
  h.find('img', '').props.onError(); h.flush(); assert.ok(h.text().includes('图片无法显示'));
  assert.deepEqual(h.revoked, ['blob:test-1']);
  h.find('button', '重试').props.onClick(); await h.settle(); requests[2].resolve(result(1)); await h.settle();
  assert.equal(h.find('img', '').props.src, 'blob:test-2'); h.unmount();
  assert.deepEqual(h.revoked, ['blob:test-1', 'blob:test-2']);
});

test('chapter navigation resets page and zoom, releases URLs, and back loads the selected chapter', async () => {
  const h = harness(), requests = [], chapterCalls = [];
  const api = {
    search: async () => ({ type: 'comic', data: { id: '123', name: '漫画', series: [
      { id: '455', name: '前一话' }, { id: '456', name: '第一话' }, { id: '457', name: '下一话' },
    ] } }),
    chapter: async id => { chapterCalls.push(id); return { id, name: id === '457' ? '下一话' : '第一话', images: ['a', 'b', 'c'] }; },
    readPage: (id, page, signal) => { const d = deferred(); requests.push({ id, page, signal, ...d }); return d.promise; },
  };
  await openReader(h, api);
  requests[0].resolve(result(1)); await h.settle();
  h.find('button', '放大图片').props.onClick(); h.flush();
  h.find('button', '后一页').props.onClick(); await h.settle();
  requests[1].resolve(result(2)); await h.settle();
  assert.ok(h.text().includes('125%')); assert.ok(h.text().includes('第 2 页 / 3 页'));
  h.find('button', '下一章').props.onClick(); await h.settle();
  assert.equal(requests[1].signal.aborted, true);
  assert.deepEqual(h.revoked, ['blob:test-1', 'blob:test-2']);
  assert.equal(requests[2].id, '457'); assert.equal(requests[2].page, 1);
  assert.ok(h.text().includes('100%')); assert.ok(h.text().includes('第 1 页 / 未知'));
  assert.equal(h.find('button', '下一章').props.disabled, true);
  requests[2].resolve({ ...result(1), chapterId: '457' }); await h.settle();
  h.find('button', '上一章').props.onClick(); await h.settle();
  assert.equal(requests[3].id, '456'); assert.equal(requests[3].page, 1);
  assert.ok(h.revoked.includes('blob:test-3'));
  h.find('button', '下一章').props.onClick(); await h.settle();
  assert.equal(requests[3].signal.aborted, true); assert.equal(requests[4].id, '457');
  h.find('button', '← 返回章节').props.onClick(); await h.settle();
  assert.equal(requests[4].signal.aborted, true); assert.deepEqual(chapterCalls, ['456', '457']);
  assert.ok(h.text().includes('下一话')); assert.ok(h.text().includes('下载本章'));
  h.unmount();
});

test('readPage adapter sends strict string fields and forwards signal', async () => {
  const requests = [], controller = new AbortController();
  const h = harness(async (url, init) => {
    requests.push({ url, init });
    return { ok: true, json: async () => ({ type: 'server-response', rpcId: 'request-id', result: { ok: true, value: JSON.stringify(result(2)) } }) };
  });
  const value = await h.plugin.createAdapter().readPage(456, 2, controller.signal);
  assert.equal(value.page, 2); assert.equal(requests[0].url, 'api/jmcomic/readPage');
  const message = JSON.parse(requests[0].init.body);
  assert.equal(message.method, 'jmcomic/readPage'); assert.deepEqual(message.payload.args, { id: '456', page: '2' });
  assert.equal(requests[0].init.signal, controller.signal); assert.equal(requests[0].init.redirect, 'error');
});
