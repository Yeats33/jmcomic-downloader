import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

// Isolated minimal hook renderer, not a DOM or React implementation. It exercises
// the actual Panel/Reader element handlers and effect cleanup without packages or
// timers. A tiny synthetic ownerDocument, element tree, ref and contains() model
// lets tests distinguish reader descendants from external targets; it does not
// implement actual focus, event propagation, portals, shadow DOM or reconciliation.
// Every test owns its VM, component state and URL registry.
function harness(fetch = async () => { throw new Error('unexpected network'); }, { BlobType = Blob } = {}) {
  const instances = new Map(), created = [], revoked = [], listeners = new Map();
  const document = { body: { tagName: 'BODY', nodeType: 1 }, documentElement: { tagName: 'HTML', nodeType: 1 } };
  let current, hookIndex, dirty = true, tree, Panel, plugin, refs = new Set(), nextRefs;
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
    window: {
      __ModuleLoader__: { load({ factory }) { plugin = factory(name => { assert.equal(name, 'react'); return React; }); } },
      addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
      removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    },
    document, crypto: { randomUUID: () => 'request-id' }, AbortController, Blob: BlobType, Uint8Array, atob, btoa,
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
    const element = {
      type: node.type, props: node.props, tagName: String(node.type).toUpperCase(), nodeType: 1, ownerDocument: document,
      contains(target) { for (let current = target; current; current = current.parentNode) if (current === element) return true; return false; },
      children: render(node.children, `${path}.h`, seen),
    };
    if (node.props.ref && typeof node.props.ref === 'object') { node.props.ref.current = element; nextRefs.add(node.props.ref); }
    return element;
  }
  function cleanup(instance) { for (const h of instance.hooks) h?.cleanup?.(); }
  function attachParents(node, parent = null) {
    if (Array.isArray(node)) { for (const child of node) attachParents(child, parent); return; }
    if (!node || typeof node !== 'object') return;
    node.parentNode = parent; attachParents(node.children, node);
  }
  let api;
  function flush() {
    for (let loops = 0; dirty; loops++) {
      assert.ok(loops < 30, 'renderer did not settle'); dirty = false;
      const seen = new Set(); nextRefs = new Set();
      tree = render(React.createElement(Panel, { api }), 'root', seen);
      attachParents(tree);
      for (const ref of refs) if (!nextRefs.has(ref)) ref.current = null;
      refs = nextRefs;
      for (const [key, instance] of instances) if (!seen.has(key)) { cleanup(instance); instances.delete(key); }
      for (const instance of instances.values()) for (const effect of instance.effects.splice(0)) effect();
    }
  }
  async function settle() { for (let i = 0; i < 6; i++) { await Promise.resolve(); flush(); } }
  function nodes(node = tree) { if (Array.isArray(node)) return node.flatMap(nodes); if (!node || typeof node !== 'object') return []; return [node, ...nodes(node.children)]; }
  function text(node) { if (Array.isArray(node)) return node.map(text).join(''); if (node == null || typeof node === 'boolean') return ''; return typeof node === 'object' ? text(node.children) : String(node); }
  function find(type, label) { const found = nodes().find(n => n.type === type && (text(n) === label || n.props['aria-label'] === label || n.props.alt === label)); assert.ok(found, `${type} ${label} not found; text: ${text(tree)}`); return found; }
  return {
    plugin, created, revoked, document, mount(value) { api = value; flush(); }, flush, settle, find,
    nodes: () => nodes(), text: () => text(tree),
    listenerCount: type => listeners.get(type)?.size ?? 0,
    dispatch(type, event) { for (const fn of [...(listeners.get(type) ?? [])]) fn(event); },
    unmount() { for (const ref of refs) ref.current = null; refs.clear(); for (const instance of instances.values()) cleanup(instance); instances.clear(); },
  };
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
  const prefetch = requests[1]; assert.equal(prefetch.page, 2);
  h.find('button', '后一页').props.onClick(); await h.settle();
  assert.equal(prefetch.signal.aborted, true); assert.deepEqual(h.revoked, ['blob:test-1']);
  const foreground = requests.at(-1); assert.equal(foreground.page, 2);
  h.find('input', '跳转页码').props.onChange({ target: { value: '3' } }); h.flush();
  h.find('form', '跳转页码 跳转').props.onSubmit({ preventDefault() {} }); await h.settle();
  assert.equal(foreground.signal.aborted, true); const third = requests.at(-1); assert.equal(third.page, 3);
  prefetch.resolve(result(2)); foreground.resolve(result(2)); await h.settle(); assert.equal(h.created.length, 1, 'late page 2 creates no URL');
  third.resolve(result(3)); await h.settle(); assert.equal(h.find('img', '').props.src, 'blob:test-2');
  h.find('button', '← 返回章节').props.onClick(); await h.settle();
  assert.deepEqual(h.revoked, ['blob:test-1', 'blob:test-2']);
  assert.ok(h.text().includes('下载本章'));
  h.find('button', '在线阅读').props.onClick(); await h.settle();
  const reopen = requests.at(-1);
  h.find('button', '← 返回章节').props.onClick(); await h.settle();
  assert.equal(reopen.signal.aborted, true);
  reopen.resolve(result(1)); await h.settle(); assert.equal(h.created.length, 2, 'late response after back creates no URL');
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
  h.find('button', '重试').props.onClick(); await h.settle(); requests.at(-1).resolve(result(1)); await h.settle();
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
  requests.at(-1).resolve(result(2)); await h.settle();
  assert.ok(h.text().includes('125%')); assert.ok(h.text().includes('第 2 页 / 3 页'));
  const oldPrefetch = requests.at(-1); assert.equal(oldPrefetch.page, 3);
  h.find('button', '下一章').props.onClick(); await h.settle();
  assert.equal(oldPrefetch.signal.aborted, true);
  assert.deepEqual(h.revoked, ['blob:test-1', 'blob:test-2']);
  const nextChapter = requests.at(-1); assert.equal(nextChapter.id, '457'); assert.equal(nextChapter.page, 1);
  oldPrefetch.resolve(result(3)); await h.settle();
  assert.equal(h.created.length, 2, 'late prefetch from previous chapter cannot publish a URL');
  assert.ok(h.text().includes('100%')); assert.ok(h.text().includes('第 1 页 / 未知'));
  assert.equal(h.find('button', '下一章').props.disabled, true);
  nextChapter.resolve({ ...result(1), chapterId: '457' }); await h.settle();
  const oldChapterPrefetch = requests.at(-1);
  h.find('button', '上一章').props.onClick(); await h.settle();
  assert.equal(oldChapterPrefetch.signal.aborted, true);
  const previousChapter = requests.at(-1); assert.equal(previousChapter.id, '456'); assert.equal(previousChapter.page, 1);
  assert.ok(h.revoked.includes('blob:test-3'));
  h.find('button', '下一章').props.onClick(); await h.settle();
  assert.equal(previousChapter.signal.aborted, true); const switched = requests.at(-1); assert.equal(switched.id, '457');
  h.find('button', '← 返回章节').props.onClick(); await h.settle();
  assert.equal(switched.signal.aborted, true); assert.deepEqual(chapterCalls, ['456', '457']);
  assert.ok(h.text().includes('下一话')); assert.ok(h.text().includes('下载本章'));
  h.unmount();
});

test('window arrow keys operate only while reader is mounted, ignore editors and cancel stale pages', async () => {
  const h = harness(), requests = [];
  const event = (overrides = {}) => ({ key: 'ArrowRight', target: h.document.body, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }, ...overrides });
  await openReader(h, baseApi((id, page, signal) => { const d = deferred(); requests.push({ id, page, signal, ...d }); return d.promise; }));
  assert.equal(h.listenerCount('keydown'), 1);
  requests[0].resolve(result(1)); await h.settle();
  for (const target of [
    { tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' },
    { tagName: 'DIV', isContentEditable: true }, { tagName: 'DIV', getAttribute: () => 'textbox' },
    { tagName: 'SPAN', closest: () => ({}) }, { tagName: 'DIALOG' },
    ...['dialog', 'alertdialog', 'combobox', 'listbox', 'menu'].map(role => ({ tagName: 'DIV', getAttribute: name => name === 'role' ? role : null })),
    { tagName: 'DIV', getAttribute: name => name === 'aria-modal' ? 'true' : null },
  ]) {
    target.nodeType = 1; target.parentNode = h.find('section', '在线阅读');
    const e = event({ target }); h.dispatch('keydown', e); await h.settle();
    assert.equal(e.defaultPrevented, false); assert.equal(requests.length, 2);
  }
  const shadowInput = event({ target: { tagName: 'SPAN' }, composedPath: () => [{ tagName: 'INPUT' }, h.find('section', '在线阅读')] });
  h.dispatch('keydown', shadowInput); await h.settle(); assert.equal(shadowInput.defaultPrevented, false);
  for (const extra of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }, { defaultPrevented: true }]) {
    h.dispatch('keydown', event(extra)); await h.settle(); assert.equal(requests.length, 2);
  }
  const first = event(); h.dispatch('keydown', first); await h.settle();
  assert.equal(first.defaultPrevented, true); assert.equal(requests[1].signal.aborted, true);
  const foreground2 = requests.at(-1); assert.equal(foreground2.page, 2);
  const second = event(); h.dispatch('keydown', second); await h.settle();
  assert.equal(second.defaultPrevented, true); assert.equal(foreground2.signal.aborted, true);
  const foreground3 = requests.at(-1); assert.equal(foreground3.page, 3);
  foreground2.resolve(result(2)); await h.settle(); assert.equal(h.created.length, 1);
  foreground3.resolve(result(3)); await h.settle();
  const boundary = event(); h.dispatch('keydown', boundary); await h.settle();
  assert.equal(boundary.defaultPrevented, false); assert.equal(requests.length, 4);
  h.find('button', '← 返回章节').props.onClick(); await h.settle();
  assert.equal(h.listenerCount('keydown'), 0);
  const outside = event(); h.dispatch('keydown', outside); await h.settle();
  assert.equal(outside.defaultPrevented, false); assert.equal(requests.length, 4);
  h.find('button', '在线阅读').props.onClick(); await h.settle();
  const reopened = requests.at(-1);
  assert.equal(h.listenerCount('keydown'), 1); h.unmount();
  assert.equal(h.listenerCount('keydown'), 0); assert.equal(reopened.signal.aborted, true);
  const unmounted = event(); h.dispatch('keydown', unmounted); assert.equal(unmounted.defaultPrevented, false);
});

test('keyboard scope excludes sidebar and other external controls while accepting reader descendants', async () => {
  const h = harness(), requests = [];
  await openReader(h, baseApi((id, page, signal) => { const d = deferred(); requests.push({ id, page, signal, ...d }); return d.promise; }));
  requests[0].resolve(result(1)); await h.settle();
  const event = (target, extra = {}) => ({ key: 'ArrowRight', target, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }, ...extra });
  for (const target of [{ nodeType: 1, tagName: 'BUTTON' }, { nodeType: 1, tagName: 'DIV' }, { nodeType: 1, tagName: 'BODY' }]) {
    const e = event(target, { composedPath: () => [target, h.document.body, h.document.documentElement] });
    h.dispatch('keydown', e); await h.settle();
    assert.equal(e.defaultPrevented, false, 'outside elements including a fake BODY do not control reader');
    assert.equal(requests.length, 2);
  }
  const html = event(h.document.documentElement); h.dispatch('keydown', html); await h.settle();
  assert.equal(html.defaultPrevented, true); assert.equal(requests.at(-1).page, 2);
  const readerButton = h.find('button', '后一页');
  const inside = event(readerButton); h.dispatch('keydown', inside); await h.settle();
  assert.equal(inside.defaultPrevented, true); assert.equal(requests.at(-1).page, 3);
  const shadow = event({ tagName: 'SPAN' }, { key: 'ArrowLeft', composedPath: () => [{ tagName: 'SPAN' }, h.find('section', '在线阅读')] });
  h.dispatch('keydown', shadow); await h.settle();
  assert.equal(shadow.defaultPrevented, true); assert.equal(requests.at(-1).page, 2);
  h.unmount();
});

test('two window arrow events before rendering advance twice without creating a stale page', async () => {
  const h = harness(), requests = [];
  await openReader(h, baseApi((id, page, signal) => { const d = deferred(); requests.push({ id, page, signal, ...d }); return d.promise; }));
  requests[0].resolve(result(1)); await h.settle();
  const key = () => ({ key: 'ArrowRight', target: h.document.body, prevented: false, preventDefault() { this.prevented = true; } });
  const first = key(), second = key();
  h.dispatch('keydown', first); h.dispatch('keydown', second);
  assert.equal(first.prevented, true); assert.equal(second.prevented, true);
  await h.settle();
  assert.deepEqual(requests.map(r => r.page), [1, 2, 3]);
  assert.equal(requests[1].signal.aborted, true); assert.ok(h.text().includes('第 3 页'));
  h.unmount(); assert.equal(h.listenerCount('keydown'), 0);
});

test('search paginates 20 items locally per 80-item server page', async () => {
  const h = harness(), searches = [], covers = [];
  const api = {
    search: async (keyword, page, signal) => {
      searches.push({ keyword, page, signal });
      const first = (page - 1) * 80 + 1, count = page === 1 ? 80 : 5;
      return { type: 'search', data: { total: '85', content: Array.from({ length: count }, (_, i) => ({ id: String(first + i), name: `项目${first + i}` })) } };
    },
    cover: (id, signal) => { const d = deferred(); covers.push({ id, signal, ...d }); return d.promise; },
  };
  h.mount(api); h.find('input', '搜索关键词').props.onChange({ target: { value: ' fixture ' } }); h.flush();
  h.find('form', '搜索').props.onSubmit({ preventDefault() {} }); await h.settle();
  assert.deepEqual(searches.map(r => [r.keyword, r.page]), [['fixture', 1]]);
  assert.equal(covers.length, 4, 'at most four concurrent cover requests');
  h.find('strong', '项目1'); h.find('strong', '项目20');
  assert.equal(h.find('button', '上一页').props.disabled, true);
  for (const [page, first, last] of [[2, 21, 40], [3, 41, 60], [4, 61, 80], [5, 81, 85]]) {
    h.find('button', '下一页').props.onClick(); await h.settle();
    h.find('strong', `项目${first}`); h.find('strong', `项目${last}`);
    assert.ok(h.text().includes(`第 ${page} 页 / 共 5 页`));
  }
  assert.deepEqual(searches.map(r => r.page), [1, 2]);
  assert.equal(h.find('button', '下一页').props.disabled, true);
  assert.ok(covers.slice(0, 16).every(request => request.signal.aborted), 'old page covers cancelled');
  h.find('button', '上一页').props.onClick(); await h.settle();
  assert.deepEqual(searches.map(r => r.page), [1, 2, 1], 'only most recent server page cached');
  h.unmount(); assert.ok(covers.every(request => request.signal.aborted));
});

for (const total of [0, 40]) test(`search repairs an out-of-range page after total shrinks from 81 to ${total}`, async () => {
  const h = harness(), searches = [];
  const api = {
    search: async (_keyword, serverPage) => {
      searches.push(serverPage);
      const newTotal = searches.length === 1 ? 81 : total;
      const start = (serverPage - 1) * 80 + 1;
      return { type: 'search', data: { total: newTotal, content: Array.from({ length: 80 }, (_, i) => ({ id: String(start + i), name: `结果${start + i}` })) } };
    },
    cover: () => new Promise(() => {}),
  };
  h.mount(api); h.find('input', '搜索关键词').props.onChange({ target: { value: 'shrink' } }); h.flush();
  h.find('form', '搜索').props.onSubmit({ preventDefault() {} }); await h.settle();
  for (let i = 0; i < 4; i++) { h.find('button', '下一页').props.onClick(); await h.settle(); }
  await h.settle();
  if (total === 0) {
    assert.deepEqual(searches, [1, 2]);
    assert.ok(h.text().includes('没有找到相关漫画。'));
    assert.ok(!h.text().includes('第 5 页')); assert.ok(!h.text().includes('结果81'));
  } else {
    assert.deepEqual(searches, [1, 2, 1]);
    assert.ok(h.text().includes('第 2 页 / 共 2 页'));
    h.find('strong', '结果21'); h.find('strong', '结果40');
  }
  h.unmount();
});

test('constantly shrinking totals bound correction requests and allow a fresh first-page retry', async () => {
  const h = harness(), searches = [];
  let shrinking = true;
  const api = {
    search: async (_keyword, serverPage) => {
      searches.push(serverPage);
      const changing = { 11: 640, 8: 400, 5: 160, 2: 1 };
      const total = shrinking && searches.includes(11) ? changing[serverPage] ?? 1000 : 1000;
      const start = (serverPage - 1) * 80 + 1;
      return { type: 'search', data: { total, content: Array.from({ length: 80 }, (_, i) => ({ id: String(start + i), name: `结果${start + i}` })) } };
    },
    cover: () => new Promise(() => {}),
  };
  h.mount(api); h.find('input', '搜索关键词').props.onChange({ target: { value: 'unstable' } }); h.flush();
  h.find('form', '搜索').props.onSubmit({ preventDefault() {} }); await h.settle();
  for (let i = 0; i < 40; i++) { h.find('button', '下一页').props.onClick(); await h.settle(); }
  await h.settle(); await h.settle();
  assert.deepEqual(searches.slice(-4), [11, 8, 5, 2]);
  assert.equal(searches.length, 14, 'initial ten server pages plus four bounded correction responses');
  assert.ok(h.text().includes('搜索结果持续变化'));
  shrinking = false;
  h.find('button', '回到第 1 页重试').props.onClick(); await h.settle();
  assert.equal(searches.at(-1), 1); assert.ok(h.text().includes('第 1 页 / 共 50 页'));
  h.unmount();
});

test('new search aborts a pending search and ignores its late response', async () => {
  const h = harness(), searches = [];
  const api = {
    search: (keyword, page, signal) => { const d = deferred(); searches.push({ keyword, page, signal, ...d }); return d.promise; },
    cover: async id => ({ id, mime: 'image/jpeg', data: 'AQID' }),
  };
  h.mount(api);
  for (const keyword of ['first', 'second']) {
    h.find('input', '搜索关键词').props.onChange({ target: { value: keyword } }); h.flush();
    h.find('form', '搜索').props.onSubmit({ preventDefault() {} }); await h.settle();
  }
  assert.equal(searches[0].signal.aborted, true);
  searches[1].resolve({ type: 'search', data: { total: 1, content: [{ id: '2', name: '当前结果' }] } }); await h.settle();
  searches[0].resolve({ type: 'search', data: { total: 1, content: [{ id: '1', name: '过期结果' }] } }); await h.settle();
  h.find('strong', '当前结果'); assert.ok(!h.text().includes('过期结果'));
  h.unmount();
});

test('cover responses respect identity, expiration, image errors, and URL cleanup', async () => {
  const h = harness(), covers = [];
  const content = Array.from({ length: 24 }, (_, i) => ({ id: String(i + 1), name: `封面项目${i + 1}` }));
  const api = {
    search: async () => ({ type: 'search', data: { total: 24, content } }),
    cover: (id, signal) => { const d = deferred(); covers.push({ id, signal, ...d }); return d.promise; },
  };
  const cover = id => ({ id, mime: 'image/jpeg', data: 'AQID' });
  h.mount(api); h.find('input', '搜索关键词').props.onChange({ target: { value: 'x' } }); h.flush();
  h.find('form', '搜索').props.onSubmit({ preventDefault() {} }); await h.settle();
  assert.deepEqual(covers.map(c => c.id), ['1', '2', '3', '4']);
  covers[0].resolve(cover('1')); await h.settle();
  assert.equal(h.created.length, 1); assert.equal(h.created[0].blob.type, 'image/jpeg');
  assert.equal(covers[4].id, '5', 'a worker fetches the next id after a response');
  covers[1].resolve(cover('999')); covers[2].resolve({ ...cover('3'), mime: 'image/svg+xml' });
  covers[3].reject(new Error('offline')); await h.settle();
  assert.equal(h.created.length, 1, 'wrong id, forbidden MIME and errors show placeholders');
  h.find('img', '封面项目1封面').props.onError(); h.flush();
  assert.deepEqual(h.revoked, ['blob:test-1']);
  covers[4].resolve(cover('5')); await h.settle(); assert.equal(h.created.length, 2);
  const stale = covers.filter(c => c.id !== '1' && !c.signal.aborted);
  h.find('button', '下一页').props.onClick(); await h.settle();
  assert.ok(stale.every(c => c.signal.aborted));
  assert.deepEqual(h.revoked, ['blob:test-1', 'blob:test-2']);
  for (const c of stale) c.resolve(cover(c.id));
  await h.settle(); assert.equal(h.created.length, 2, 'late old-page responses create no URL');
  const current = covers.find(c => c.id === '21'); assert.ok(current);
  current.resolve(cover('21')); await h.settle(); assert.equal(h.created.length, 3);
  h.unmount(); assert.equal(current.signal.aborted, true);
  assert.deepEqual(h.revoked, ['blob:test-1', 'blob:test-2', 'blob:test-3']);
  const stillPending = covers.find(c => c.id === '22'); stillPending.resolve(cover('22')); await h.settle();
  assert.equal(h.created.length, 3, 'late unmounted response creates no URL');
});

const pageResult = (page, total = 15, chapterId = '456', data = 'AQID') => ({ chapterId, page, total, mime: 'image/png', data });

test('reader prefetches ten pages sequentially; forward cache hit and backward refetch', async () => {
  const h = harness(), requests = [];
  await openReader(h, baseApi((id, page, signal) => { const d = deferred(); requests.push({ id, page, signal, ...d }); return d.promise; }));
  assert.deepEqual(requests.map(r => r.page), [1]);
  requests[0].resolve(pageResult(1)); await h.settle();
  for (let page = 2; page <= 11; page++) {
    assert.deepEqual(requests.map(r => r.page), Array.from({ length: page }, (_, i) => i + 1));
    requests[page - 1].resolve(pageResult(page)); await h.settle();
  }
  assert.deepEqual(requests.map(r => r.page), Array.from({ length: 11 }, (_, i) => i + 1), 'at most current plus ten ahead');
  assert.equal(h.created.length, 11);
  const page2Url = h.created[1].url;
  h.find('button', '后一页').props.onClick(); await h.settle();
  assert.equal(h.find('img', '').props.src, page2Url, 'forward cache hit uses existing URL');
  assert.ok(!h.revoked.includes(page2Url), 'currently displayed cached URL remains live');
  assert.equal(requests.filter(r => r.page === 2).length, 1);
  assert.equal(requests.at(-1).page, 12, 'sliding window requests newly available page');
  assert.ok(h.revoked.includes(h.created[0].url), 'page behind current is released');
  h.find('button', '前一页').props.onClick(); await h.settle();
  assert.equal(requests.filter(r => r.page === 1).length, 2, 'backwards page outside window is fetched again');
  assert.equal(requests.find(r => r.page === 12).signal.aborted, true);
  h.unmount();
  assert.ok(h.created.every(({ url }) => h.revoked.includes(url)), 'all object URLs eventually released');
});

test('navigating into a hung prefetch prioritizes foreground and ignores obsolete responses', async () => {
  const h = harness(), requests = [];
  await openReader(h, baseApi((id, page, signal) => { const d = deferred(); requests.push({ id, page, signal, ...d }); return d.promise; }));
  requests[0].resolve(pageResult(1)); await h.settle();
  const prefetch2 = requests.find(r => r.page === 2); assert.ok(prefetch2);
  h.find('button', '后一页').props.onClick(); await h.settle();
  assert.equal(prefetch2.signal.aborted, true);
  const foreground2 = requests.filter(r => r.page === 2).at(-1);
  assert.notEqual(foreground2, prefetch2, 'foreground starts without waiting for uncooperative old prefetch');
  const key = () => ({ key: 'ArrowRight', target: h.document.body, prevented: false, preventDefault() { this.prevented = true; } });
  const next = key(), nextAgain = key();
  h.dispatch('keydown', next); h.dispatch('keydown', nextAgain); await h.settle();
  assert.equal(next.prevented, true); assert.equal(nextAgain.prevented, true);
  assert.equal(foreground2.signal.aborted, true);
  const foreground4 = requests.find(r => r.page === 4); assert.ok(foreground4, 'latest navigation starts immediately');
  const beforeLate = h.created.length;
  prefetch2.resolve(pageResult(2)); foreground2.resolve(pageResult(2)); await h.settle();
  assert.equal(h.created.length, beforeLate, 'stale requests cannot publish an image');
  foreground4.resolve(pageResult(4)); await h.settle();
  assert.equal(h.find('img', '').props.alt, '第一话，第 4 页');
  h.find('button', '← 返回章节').props.onClick(); await h.settle();
  const count = h.created.length;
  for (const r of requests) if (!r.signal.aborted) r.resolve(pageResult(r.page));
  await h.settle(); assert.equal(h.created.length, count, 'late results after exit are ignored');
  assert.ok(h.created.every(({ url }) => h.revoked.includes(url)));
  h.unmount();
});

for (const failAgain of [false, true]) test(`prefetch failure remains silent, then automatically retries on selection (foreground failure: ${failAgain})`, async () => {
  const h = harness(), requests = [];
  await openReader(h, baseApi((id, page, signal) => { const d = deferred(); requests.push({ id, page, signal, ...d }); return d.promise; }));
  requests[0].resolve(pageResult(1, 3)); await h.settle();
  assert.equal(requests[1].page, 2);
  requests[1].reject(new Error('prefetch fixture failure')); await h.settle();
  assert.ok(!h.text().includes('加载失败')); assert.ok(h.text().includes('1 页缓冲失败'));
  assert.equal(h.find('img', '').props.alt, '第一话，第 1 页');
  assert.equal(requests[2].page, 3, 'failed prefetch does not block later pages');
  requests[2].resolve(pageResult(3, 3)); await h.settle();
  assert.deepEqual(requests.map(r => r.page), [1, 2, 3], 'never requests beyond the chapter');
  h.find('button', '后一页').props.onClick(); await h.settle();
  assert.equal(requests.filter(r => r.page === 2).length, 2, 'selection automatically retries once');
  const foreground = requests.at(-1);
  if (failAgain) {
    foreground.reject(new Error('foreground fixture failure')); await h.settle();
    assert.ok(h.text().includes('加载失败')); assert.ok(h.text().includes('foreground fixture failure'));
    await h.settle(); assert.equal(requests.filter(r => r.page === 2).length, 2, 'failure does not loop');
    h.find('button', '重试').props.onClick(); await h.settle();
    assert.equal(requests.filter(r => r.page === 2).length, 3);
    requests.at(-1).resolve(pageResult(2, 3));
  } else foreground.resolve(pageResult(2, 3));
  await h.settle();
  assert.equal(h.find('img', '').props.alt, '第一话，第 2 页');
  h.unmount();
});

test('synthetic Blob.size enforces 64 MiB cache limit and resumes after eviction', async () => {
  // Only size accounting is modeled: the underlying fixture is three bytes.
  class SizedBlob extends Blob { get size() { return 16 * 1024 * 1024; } }
  const h = harness(undefined, { BlobType: SizedBlob }), requests = [];
  await openReader(h, baseApi((id, page, signal) => { const d = deferred(); requests.push({ id, page, signal, ...d }); return d.promise; }));
  for (let page = 1; page <= 5; page++) {
    assert.equal(requests.at(-1).page, page); requests.at(-1).resolve(pageResult(page)); await h.settle();
  }
  assert.equal(h.created.length, 4, 'fifth 16 MiB item is not assigned an object URL');
  assert.ok(h.text().includes('已达内存上限')); assert.equal(requests.length, 5, 'no further prefetch while full');
  h.find('button', '后一页').props.onClick(); await h.settle();
  assert.equal(h.find('img', '').props.src, h.created[1].url);
  assert.ok(!h.revoked.includes(h.created[1].url)); assert.ok(h.revoked.includes(h.created[0].url));
  assert.equal(requests.at(-1).page, 5, 'eviction reopens capacity');
  requests.at(-1).resolve(pageResult(5)); await h.settle();
  assert.equal(h.created.length, 5);
  h.unmount(); assert.ok(h.created.every(({ url }) => h.revoked.includes(url)));
});

test('real 16 MiB page allocation and cleanup (opt-in)', { skip: process.env.READER_REAL_LARGE !== '1', timeout: 30000 }, async () => {
  const h = harness(), requests = [];
  const encoded = Buffer.alloc(16 * 1024 * 1024, 0x42).toString('base64');
  await openReader(h, baseApi((id, page, signal) => { const d = deferred(); requests.push({ id, page, signal, ...d }); return d.promise; }));
  requests[0].resolve(pageResult(1, 1, '456', encoded)); await h.settle();
  assert.equal(h.created.length, 1); assert.equal(h.created[0].blob.size, 16 * 1024 * 1024);
  assert.equal(h.find('img', '').props.src, h.created[0].url);
  h.unmount(); assert.deepEqual(h.revoked, [h.created[0].url]);
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
  await h.plugin.createAdapter().cover(456, controller.signal);
  assert.equal(requests[1].url, 'api/jmcomic/cover');
  const coverMessage = JSON.parse(requests[1].init.body);
  assert.equal(coverMessage.method, 'jmcomic/cover'); assert.deepEqual(coverMessage.payload.args, { id: '456' });
  assert.equal(requests[1].init.signal, controller.signal); assert.equal(requests[1].init.redirect, 'error');
});
