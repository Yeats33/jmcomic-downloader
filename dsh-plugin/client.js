window.__ModuleLoader__.load({
  id: '@local/dsh-jmcomic',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const PANEL_ID = 'jmcomic';

    // Host contract: strict unary Gateway methods return a JSON-encoded string.
    // The fixed same-origin targets and Connection envelope follow
    // createWebConnectionRpc; no destination or method comes from user input.
    function createAdapter() {
      const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
      async function call(method, args, signal) {
        if (!globalThis.crypto || typeof globalThis.crypto.randomUUID !== 'function') {
          throw new Error('当前环境无法生成安全的请求标识。');
        }
        const rpcId = globalThis.crypto.randomUUID();
        const endpoint = 'jmcomic/' + method;
        const response = await fetch('api/' + endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
          redirect: 'error',
          signal,
        });
        if (!response.ok) throw new Error('Host 连接失败（HTTP ' + response.status + '）。');
        const envelope = await response.json();
        if (signal && signal.aborted) throw new Error('请求已取消。');
        if (!isRecord(envelope) || envelope.type !== 'server-response' || envelope.rpcId !== rpcId || !isRecord(envelope.result)) {
          throw new Error('Host 响应格式或请求标识不正确。');
        }
        const result = envelope.result;
        if (result.ok === false) {
          if (!isRecord(result.error) || typeof result.error.code !== 'string' || typeof result.error.message !== 'string' || !isRecord(result.error.details)) {
            throw new Error('Host 错误响应格式不正确。');
          }
          throw new Error((result.error.message || 'Host 请求失败。') + '（错误码：' + String(result.error.code) + '）');
        }
        if (result.ok !== true || typeof result.value !== 'string') throw new Error('Host 响应数据格式不正确。');
        try { return JSON.parse(result.value); }
        catch { throw new Error('Host 响应数据不是有效 JSON。'); }
      }
      return {
        search: (keyword, page, signal) => call('search', { keyword, page: String(page) }, signal),
        comic: (id, signal) => call('comic', { id: String(id) }, signal),
        chapter: (id, signal) => call('chapter', { id: String(id) }, signal),
        readPage: (id, page, signal) => call('readPage', { id: String(id), page: String(page) }, signal),
        cover: (id, signal) => call('cover', { id: String(id) }, signal),
        download: (id, signal) => call('download', { id: String(id) }, signal),
      };
    }

    const css = `
      .jm-panel{height:100%;min-height:0;overflow:auto;box-sizing:border-box;color:var(--dsw-alias-label-primary,#222);font:14px/1.55 system-ui,sans-serif}
      .jm-inner{box-sizing:border-box;max-width:900px;margin:auto;padding:32px 24px 64px}
      .jm-title{font-size:24px;line-height:1.25;margin:0 0 6px}.jm-muted{color:var(--dsw-alias-label-tertiary,#777)}
      .jm-form{display:flex;gap:8px;margin:24px 0;flex-wrap:wrap}.jm-input{flex:1 1 220px;min-width:0;box-sizing:border-box;padding:9px 12px;border:1px solid var(--dsw-alias-border-l1,#ccc);border-radius:8px;background:transparent;color:inherit;font:inherit}
      .jm-button{border:1px solid var(--dsw-alias-border-l3,#888);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,CanvasText);cursor:pointer;font:inherit;padding:8px 14px}.jm-button:hover:not(:disabled),.jm-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 8%,transparent))}.jm-button:active:not(:disabled),.jm-item:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active,color-mix(in srgb,currentColor 14%,transparent))}.jm-button:disabled,.jm-item:disabled{opacity:.5;cursor:default}.jm-button:focus-visible,.jm-input:focus-visible,.jm-item:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4a8dff);outline-offset:2px}
      .jm-back{margin-bottom:20px}.jm-box{border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:10px;padding:16px;margin:16px 0}.jm-error{color:var(--dsw-alias-state-error-primary,#b42318);white-space:pre-wrap;overflow-wrap:anywhere}
      .jm-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,220px),1fr));gap:10px;list-style:none;padding:0;margin:16px 0}.jm-item{width:100%;height:100%;text-align:left;cursor:pointer;border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:10px;background:transparent;color:inherit;padding:14px;font:inherit;overflow-wrap:anywhere}
      .jm-item strong{display:block;margin-bottom:4px}.jm-heading{font-size:18px;margin:24px 0 8px}.jm-description{white-space:pre-wrap;overflow-wrap:anywhere}.jm-meta{margin:7px 0;overflow-wrap:anywhere}.jm-chapters{list-style:none;padding:0;margin:12px 0;display:grid;gap:8px}.jm-chapters .jm-item{padding:10px 12px}
      .jm-cover{display:block;width:100%;height:180px;object-fit:contain;margin:0 0 10px;border-radius:6px;background:var(--dsw-alias-bg-module-platform,rgba(128,128,128,.1))}.jm-cover-placeholder{display:flex;align-items:center;justify-content:center}
      .jm-reader-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:12px 0}.jm-page-input{flex:none;width:6em}.jm-reader-image{overflow:auto;text-align:center;margin:16px 0}.jm-reader-image img{display:block;height:auto;margin:auto;max-width:none}.jm-reader-info{min-width:6em}
      @media(max-width:600px){.jm-inner{padding:24px 16px 48px}}
    `;
    function Icon() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M4 5.5c3-1.2 5.5-.7 8 1v13c-2.5-1.7-5-2.2-8-1V5.5Zm16 0c-3-1.2-5.5-.7-8 1v13c2.5-1.7 5-2.2 8-1V5.5Z' }));
    }
    function text(value) {
      if (Array.isArray(value)) return value.filter(v => typeof v === 'string' || typeof v === 'number').join('、');
      return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
    }
    function idOf(item) {
      const id = item && item.id;
      return (typeof id === 'string' && /^[1-9]\d*$/.test(id)) || (Number.isSafeInteger(id) && id > 0) ? String(id) : '';
    }
    function metadata(label, value) {
      const content = text(value);
      return content ? h('p', { className: 'jm-meta', key: label }, h('span', { className: 'jm-muted' }, label + '：'), content) : null;
    }
    function Status({ state }) {
      if (state.status === 'loading') return h('p', { className: 'jm-box jm-muted', role: 'status' }, '正在加载，请稍候…');
      if (state.status === 'error') return h('div', { className: 'jm-box jm-error', role: 'alert' }, '请求失败：', state.error);
      return null;
    }
    // Bound the decoded allocation as well as the encoded input before decoding.
    const MAX_PAGE_BYTES = 16 * 1024 * 1024;
    function positiveInteger(value) {
      if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) value = Number(value);
      return Number.isSafeInteger(value) && value > 0 ? value : 0;
    }
    function pageBlob(result, chapterId, page) {
      if (!result || typeof result !== 'object' || Array.isArray(result) ||
          String(result.chapterId) !== chapterId || positiveInteger(result.page) !== page ||
          !positiveInteger(result.total) || page > positiveInteger(result.total)) {
        throw new Error('阅读页面响应的章节或页码不正确。');
      }
      return { blob: imageBlob(result, MAX_PAGE_BYTES, ['image/jpeg', 'image/png', 'image/webp', 'image/gif']), total: positiveInteger(result.total) };
    }
    function imageBlob(result, maxBytes, types) {
      if (!types.includes(result.mime)) throw new Error('不支持的图片格式。');
      const encoded = result.data;
      if (typeof encoded !== 'string' || !encoded.length || encoded.length > 4 * Math.ceil(maxBytes / 3) ||
          encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
        throw new Error('图片数据格式无效或超过大小限制。');
      }
      let decoded;
      try { decoded = atob(encoded); } catch { throw new Error('图片数据不是有效的 base64。'); }
      if (!decoded.length || decoded.length > maxBytes || btoa(decoded) !== encoded) {
        throw new Error('图片数据格式无效或超过大小限制。');
      }
      const bytes = new Uint8Array(decoded.length);
      for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
      return new Blob([bytes], { type: result.mime });
    }
    const READER_PREFETCH_PAGES = 10;
    const READER_CACHE_BYTES = 64 * 1024 * 1024;
    function createReaderSession(api, chapterId, notify) {
      const cache = new Map();
      const failures = new Map();
      let bytes = 0;
      let currentPage = 1;
      let total = null;
      let foreground = null;
      let background = null;
      let generation = 0;
      let closed = false;
      let limited = false;
      function remove(page) {
        const item = cache.get(page);
        if (!item) return;
        URL.revokeObjectURL(item.url);
        bytes -= item.size;
        cache.delete(page);
      }
      function trim() {
        const last = Math.min(total === null ? Infinity : total, currentPage + READER_PREFETCH_PAGES);
        for (const page of cache.keys()) if (page < currentPage || page > last) remove(page);
        for (const page of failures.keys()) if (page < currentPage || page > last) failures.delete(page);
      }
      function reportBuffer() {
        if (closed) return;
        const target = total === null ? 0 : Math.min(READER_PREFETCH_PAGES, Math.max(0, total - currentPage));
        let cached = 0;
        let failed = 0;
        for (let page = currentPage + 1; page <= currentPage + target; page++) {
          if (cache.has(page)) cached++;
          if (failures.has(page)) failed++;
        }
        notify.buffer({ cached, target, failed, limited, loading: !!background, known: total !== null });
      }
      function stopRequests() {
        generation++;
        if (foreground) foreground.abort();
        if (background) background.abort();
        foreground = null;
        background = null;
      }
      function prefetch(version) {
        if (closed || version !== generation || total === null || foreground || background || limited) return;
        const end = Math.min(total, currentPage + READER_PREFETCH_PAGES);
        let page = currentPage + 1;
        while (page <= end && (cache.has(page) || failures.has(page))) page++;
        if (page > end) { reportBuffer(); return; }
        const controller = new AbortController();
        background = controller;
        reportBuffer();
        Promise.resolve().then(() => {
          if (closed || generation !== version || controller.signal.aborted) return null;
          return api.readPage(chapterId, page, controller.signal);
        }).then(result => {
          if (closed || generation !== version || controller.signal.aborted) return;
          const image = pageBlob(result, chapterId, page);
          if (image.total !== total) throw new Error('章节页数发生变化，请重试。');
          if (bytes + image.blob.size > READER_CACHE_BYTES) {
            limited = true;
          } else {
            const url = URL.createObjectURL(image.blob);
            cache.set(page, { url, size: image.blob.size });
            bytes += image.blob.size;
          }
        }).catch(error => {
          if (!closed && generation === version && !controller.signal.aborted) failures.set(page, text(error && error.message) || '未知错误');
        }).finally(() => {
          if (closed || generation !== version || background !== controller) return;
          background = null;
          reportBuffer();
          if (!limited) prefetch(version);
        });
      }
      function go(page) {
        if (closed) return;
        stopRequests();
        currentPage = page;
        limited = false;
        trim();
        // A previous speculative failure must not prevent a fresh foreground attempt.
        failures.delete(page);
        reportBuffer();
        const item = cache.get(page);
        if (item) {
          notify.state({ status: 'done', url: item.url, page });
          prefetch(generation);
          return;
        }
        notify.state({ status: 'loading' });
        const version = generation;
        const controller = new AbortController();
        foreground = controller;
        Promise.resolve().then(() => {
          if (closed || generation !== version || controller.signal.aborted) return null;
          return api.readPage(chapterId, page, controller.signal);
        }).then(result => {
          if (closed || generation !== version || controller.signal.aborted) return;
          const image = pageBlob(result, chapterId, page);
          total = image.total;
          notify.total(total);
          trim();
          // Prefer the current page over speculative pages when space is tight.
          const future = [...cache.keys()].sort((a, b) => b - a);
          while (future.length && bytes + image.blob.size > READER_CACHE_BYTES) remove(future.shift());
          const url = URL.createObjectURL(image.blob);
          cache.set(page, { url, size: image.blob.size });
          bytes += image.blob.size;
          foreground = null;
          notify.state({ status: 'done', url, page });
          reportBuffer();
          prefetch(version);
        }).catch(error => {
          if (closed || generation !== version || controller.signal.aborted) return;
          foreground = null;
          failures.set(page, text(error && error.message) || '未知错误');
          notify.state({ status: 'error', error: failures.get(page) });
          reportBuffer();
        });
      }
      function failImage(page, url) {
        if (closed || page !== currentPage || !cache.has(page) || cache.get(page).url !== url) return;
        stopRequests();
        remove(page);
        failures.set(page, '图片无法显示，请重试。');
        notify.state({ status: 'error', error: failures.get(page) });
        reportBuffer();
      }
      function destroy() {
        if (closed) return;
        closed = true;
        stopRequests();
        for (const page of cache.keys()) remove(page);
        failures.clear();
      }
      return { go, failImage, destroy };
    }
    function Reader({ api, chapterId, chapterName, previousChapter, nextChapter, onChapter, onBack }) {
      const [page, setPage] = React.useState(1);
      const [input, setInput] = React.useState('1');
      const [total, setTotal] = React.useState(null);
      const [zoom, setZoom] = React.useState(100);
      const [state, setState] = React.useState({ status: 'loading' });
      const [buffer, setBuffer] = React.useState({ known: false });
      const pageRef = React.useRef(1);
      const totalRef = React.useRef(null);
      const readerRef = React.useRef(null);
      const sessionRef = React.useRef(null);
      function cancel() {
        const current = sessionRef.current;
        sessionRef.current = null;
        if (current) current.destroy();
      }
      React.useEffect(() => {
        const session = createReaderSession(api, chapterId, {
          state: setState,
          buffer: setBuffer,
          total: value => { totalRef.current = value; setTotal(value); },
        });
        sessionRef.current = session;
        session.go(pageRef.current);
        return () => {
          session.destroy();
          if (sessionRef.current === session) sessionRef.current = null;
        };
      }, [api, chapterId]);
      function navigate(next) {
        if (!Number.isSafeInteger(next) || next < 1 || (totalRef.current !== null && next > totalRef.current) || next === pageRef.current) return;
        pageRef.current = next;
        setInput(String(next));
        setPage(next);
        if (sessionRef.current) sessionRef.current.go(next);
        else setState({ status: 'loading' });
      }
      function retry() {
        if (sessionRef.current) sessionRef.current.go(pageRef.current);
      }
      function submitPage(event) {
        event.preventDefault();
        const next = positiveInteger(input);
        if (!next || (total !== null && next > total)) {
          setInput(String(page));
          return;
        }
        navigate(next);
        setInput(String(next));
      }
      React.useEffect(() => {
        function keyDown(event) {
          const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
          const root = readerRef.current;
          const target = event.target;
          const doc = root && root.ownerDocument;
          if (!root || !doc || (target !== doc.body && target !== doc.documentElement &&
              !path.includes(root) && !(target && typeof target.nodeType === 'number' && root.contains(target)))) return;
          if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.defaultPrevented ||
              path.some(node => node && (['INPUT', 'TEXTAREA', 'SELECT', 'DIALOG'].includes(node.tagName) || node.isContentEditable ||
                (typeof node.getAttribute === 'function' && (['textbox', 'dialog', 'alertdialog', 'combobox', 'listbox', 'menu'].includes(node.getAttribute('role')) || node.getAttribute('aria-modal') === 'true')) ||
                (typeof node.closest === 'function' && node.closest('[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="dialog"],[role="alertdialog"],[role="combobox"],[role="listbox"],[role="menu"],[aria-modal="true"],dialog'))))) return;
          const currentPage = pageRef.current;
          const currentTotal = totalRef.current;
          if (event.key === 'ArrowLeft' && currentPage > 1) { event.preventDefault(); navigate(currentPage - 1); }
          if (event.key === 'ArrowRight' && currentTotal !== null && currentPage < currentTotal) { event.preventDefault(); navigate(currentPage + 1); }
        }
        window.addEventListener('keydown', keyDown);
        return () => window.removeEventListener('keydown', keyDown);
      }, [page, total]);
      return h('section', { ref: readerRef, 'aria-label': '在线阅读' },
        h('button', { type: 'button', className: 'jm-button jm-back', onClick: () => { cancel(); onBack(); } }, '← 返回章节'),
        h('h2', { className: 'jm-heading' }, chapterName || '在线阅读'),
        h('div', { className: 'jm-reader-controls', 'aria-label': '章节切换' },
          h('button', { type: 'button', className: 'jm-button', disabled: !previousChapter, onClick: () => { cancel(); onChapter(previousChapter); } }, '上一章'),
          h('button', { type: 'button', className: 'jm-button', disabled: !nextChapter, onClick: () => { cancel(); onChapter(nextChapter); } }, '下一章')),
        h('div', { className: 'jm-reader-controls' },
          h('button', { type: 'button', className: 'jm-button', disabled: page <= 1, onClick: () => navigate(page - 1) }, '前一页'),
          h('span', { className: 'jm-reader-info', 'aria-live': 'polite' }, '第 ' + page + ' 页 / ' + (total === null ? '未知' : total + ' 页')),
          h('button', { type: 'button', className: 'jm-button', disabled: total === null || page >= total, onClick: () => navigate(page + 1) }, '后一页'),
          h('form', { className: 'jm-reader-controls', onSubmit: submitPage },
            h('label', null, '跳转页码 ', h('input', { className: 'jm-input jm-page-input', type: 'number', min: 1, max: total || undefined, step: 1, value: input, onChange: event => setInput(event.target.value), 'aria-label': '跳转页码' })),
            h('button', { type: 'submit', className: 'jm-button' }, '跳转'))),
        h('div', { className: 'jm-reader-controls', 'aria-label': '图片缩放' },
          h('button', { type: 'button', className: 'jm-button', disabled: zoom <= 50, onClick: () => setZoom(value => Math.max(50, value - 25)), 'aria-label': '缩小图片' }, '−'),
          h('span', null, zoom + '%'),
          h('button', { type: 'button', className: 'jm-button', disabled: zoom >= 200, onClick: () => setZoom(value => Math.min(200, value + 25)), 'aria-label': '放大图片' }, '+'),
          h('span', { className: 'jm-muted' }, '可使用左右方向键翻页。')),
        h('p', { className: 'jm-muted', role: 'status' }, buffer.known ?
          '后续页面缓冲：' + buffer.cached + ' / ' + buffer.target + ' 页' +
            (buffer.loading ? '，正在缓冲' : '') + (buffer.limited ? '，已达内存上限' : '') +
            (buffer.failed ? '，' + buffer.failed + ' 页缓冲失败，进入时自动重试' : '') : '缓冲：等待当前页加载。'),
        state.status === 'loading' ? h('p', { className: 'jm-box jm-muted', role: 'status' }, '正在加载图片…') : null,
        state.status === 'error' ? h('div', { className: 'jm-box' }, h('p', { className: 'jm-error', role: 'alert' }, '加载失败：', state.error), h('button', { type: 'button', className: 'jm-button', onClick: retry }, '重试')) : null,
        state.status === 'done' && state.page === page ? h('div', { className: 'jm-reader-image' },
          h('img', { src: state.url, alt: (chapterName || '章节') + '，第 ' + page + ' 页', style: { width: zoom + '%' }, onError: () => {
            if (sessionRef.current) sessionRef.current.failImage(page, state.url);
          } })) : null);
    }
    const SEARCH_SERVER_PAGE_SIZE = 80;
    const SEARCH_DISPLAY_PAGE_SIZE = 20;
    const MAX_COVER_BYTES = 1024 * 1024;
    function SearchResults({ api, data, page, onOpen }) {
      const [covers, setCovers] = React.useState({});
      const coverUrls = React.useRef(new Map());
      const items = data.content.slice(((page - 1) % (SEARCH_SERVER_PAGE_SIZE / SEARCH_DISPLAY_PAGE_SIZE)) * SEARCH_DISPLAY_PAGE_SIZE,
        ((page - 1) % (SEARCH_SERVER_PAGE_SIZE / SEARCH_DISPLAY_PAGE_SIZE) + 1) * SEARCH_DISPLAY_PAGE_SIZE);
      React.useEffect(() => {
        const controller = new AbortController();
        const urls = new Map();
        coverUrls.current = urls;
        let closed = false;
        let cursor = 0;
        const ids = [...new Set(items.map(idOf).filter(Boolean))];
        setCovers({});
        async function worker() {
          while (!closed && cursor < ids.length) {
            const id = ids[cursor++];
            try {
              const result = await api.cover(id, controller.signal);
              if (closed || controller.signal.aborted) return;
              if (!result || typeof result !== 'object' || Array.isArray(result) || idOf(result) !== id) throw new Error('封面响应编号不匹配。');
              const blob = imageBlob(result, MAX_COVER_BYTES, ['image/jpeg', 'image/png', 'image/webp']);
              if (closed || controller.signal.aborted) return;
              const url = URL.createObjectURL(blob);
              urls.set(id, url);
              setCovers(previous => ({ ...previous, [id]: url }));
            } catch (error) {
              // A missing or invalid cover is represented by the placeholder.
            }
          }
        }
        for (let i = 0; i < Math.min(4, ids.length); i++) worker();
        return () => {
          closed = true;
          controller.abort();
          for (const url of urls.values()) URL.revokeObjectURL(url);
        };
      }, [api, data, page]);
      return h('ul', { className: 'jm-list' }, items.map((item, index) => {
        const id = idOf(item);
        const name = text(item && item.name) || '未命名漫画';
        return h('li', { key: id || index }, h('button', { className: 'jm-item', type: 'button', disabled: !id, onClick: () => onOpen(id) },
          covers[id] ? h('img', { className: 'jm-cover', src: covers[id], alt: name + '封面', onError: () => {
            if (coverUrls.current.get(id) !== covers[id]) return;
            URL.revokeObjectURL(covers[id]);
            coverUrls.current.delete(id);
            setCovers(previous => ({ ...previous, [id]: null }));
          } }) :
            h('span', { className: 'jm-cover jm-cover-placeholder jm-muted', 'aria-hidden': true }, '暂无封面'),
          h('strong', null, name),
          h('span', { className: 'jm-muted' }, [text(item && item.author), id ? '编号 ' + id : '编号不可用'].filter(Boolean).join(' · '))));
      }));
    }
    function Panel({ api }) {
      const [query, setQuery] = React.useState('');
      const [search, setSearch] = React.useState({ status: 'idle', query: '', data: null });
      const [view, setView] = React.useState({ kind: 'search' });
      const [detail, setDetail] = React.useState({ status: 'idle' });
      const [download, setDownload] = React.useState({ status: 'idle' });
      const searchRequest = React.useRef(null);
      const searchCache = React.useRef(null);
      const detailRequest = React.useRef(null);
      const downloadRequest = React.useRef(null);
      React.useEffect(() => () => {
        if (searchRequest.current) searchRequest.current.abort();
        if (detailRequest.current) detailRequest.current.abort();
        if (downloadRequest.current) downloadRequest.current.abort();
      }, []);
      function cancelDetail() {
        if (detailRequest.current) detailRequest.current.abort();
        detailRequest.current = null;
      }
      function loadSearch(keyword, page, corrections = 0) {
        if (searchRequest.current) searchRequest.current.abort();
        searchRequest.current = null;
        const serverPage = Math.floor((page - 1) * SEARCH_DISPLAY_PAGE_SIZE / SEARCH_SERVER_PAGE_SIZE) + 1;
        const cached = searchCache.current;
        if (cached && cached.keyword === keyword && cached.serverPage === serverPage) {
          setSearch({ status: 'done', query: keyword, page, data: cached.data });
          return;
        }
        const controller = new AbortController();
        searchRequest.current = controller;
        setSearch({ status: 'loading', query: keyword, page, data: null });
        Promise.resolve().then(() => api.search(keyword, serverPage, controller.signal)).then(result => {
          if (searchRequest.current !== controller || controller.signal.aborted) return;
          if (!result || (result.type !== 'search' && result.type !== 'comic') || !result.data || typeof result.data !== 'object') throw new Error('搜索结果格式不正确');
          if (result.type === 'comic') {
            if (!idOf(result.data)) throw new Error('漫画详情格式不正确');
            searchRequest.current = null;
            setSearch({ status: 'done', query: keyword, page, data: null });
            setView({ kind: 'comic', id: idOf(result.data) });
            setDetail({ status: 'done', data: result.data });
          } else {
            const total = typeof result.data.total === 'string' && /^\d+$/.test(result.data.total) ? Number(result.data.total) : result.data.total;
            if (!Array.isArray(result.data.content) || !Number.isSafeInteger(total) || total < 0) throw new Error('搜索结果格式不正确');
            searchRequest.current = null;
            if (total === 0) {
              // An empty result from any server page is the first-page empty state.
              searchCache.current = null;
              setSearch({ status: 'done', query: keyword, page: 1, data: { ...result.data, content: [] } });
              return;
            }
            const lastPage = Math.ceil(total / SEARCH_DISPLAY_PAGE_SIZE);
            searchCache.current = { keyword, serverPage, data: result.data };
            if (page > lastPage) {
              const lastServerPage = Math.floor((lastPage - 1) * SEARCH_DISPLAY_PAGE_SIZE / SEARCH_SERVER_PAGE_SIZE) + 1;
              if (lastServerPage === serverPage) {
                setSearch({ status: 'done', query: keyword, page: lastPage, data: result.data });
              } else if (corrections < 3) {
                loadSearch(keyword, lastPage, corrections + 1);
              } else {
                searchCache.current = null;
                setSearch({ status: 'error', query: keyword, page: 1, data: null, resetToFirst: true, error: '搜索结果持续变化，请回到第 1 页重试。' });
              }
              return;
            }
            setSearch({ status: 'done', query: keyword, page, data: result.data });
          }
        }).catch(error => {
          if (searchRequest.current === controller && !controller.signal.aborted) {
            searchRequest.current = null;
            setSearch({ status: 'error', query: keyword, page, data: null, error: text(error && error.message) || '未知错误' });
          }
        });
      }
      function runSearch(event) {
        event.preventDefault();
        const keyword = query.trim();
        if (!keyword) return;
        if (downloadRequest.current) cancelDownload();
        setDownload({ status: 'idle' });
        cancelDetail();
        searchCache.current = null;
        setView({ kind: 'search' });
        loadSearch(keyword, 1);
      }
      function openDetail(kind, id, parent) {
        if (downloadRequest.current) cancelDownload();
        setDownload({ status: 'idle' });
        if (searchRequest.current) searchRequest.current.abort();
        cancelDetail();
        const controller = new AbortController();
        detailRequest.current = controller;
        setView({ kind, id, parent });
        setDetail({ status: 'loading' });
        Promise.resolve().then(() => api[kind](id, controller.signal)).then(data => {
          if (detailRequest.current !== controller || controller.signal.aborted) return;
          if (!data || typeof data !== 'object' || !idOf(data) || typeof data.name !== 'string' || (kind === 'chapter' && idOf(data) !== String(id))) throw new Error('详情数据格式不正确');
          setDetail({ status: 'done', data });
        }).catch(error => {
          if (detailRequest.current === controller && !controller.signal.aborted) setDetail({ status: 'error', error: text(error && error.message) || '未知错误' });
        });
      }
      function startDownload() {
        if (view.kind !== 'chapter' || !idOf(detail.data) || downloadRequest.current) return;
        const controller = new AbortController();
        downloadRequest.current = controller;
        setDownload({ status: 'loading' });
        Promise.resolve().then(() => api.download(idOf(detail.data), controller.signal)).then(result => {
          if (downloadRequest.current !== controller) return;
          downloadRequest.current = null;
          setDownload({ status: 'done', data: result });
        }).catch(error => {
          if (downloadRequest.current !== controller) return;
          downloadRequest.current = null;
          setDownload({ status: 'error', error: text(error && error.message) || '未知错误' });
        });
      }
      function cancelDownload() {
        if (!downloadRequest.current) return;
        downloadRequest.current.abort();
        downloadRequest.current = null;
        setDownload({ status: 'cancelled' });
      }
      function back() {
        if (downloadRequest.current) cancelDownload();
        setDownload({ status: 'idle' });
        cancelDetail();
        if (view.kind === 'chapter' && view.parent) {
          setView({ kind: 'comic', id: idOf(view.parent) });
          setDetail({ status: 'done', data: view.parent });
        } else {
          setView({ kind: 'search' });
          setDetail({ status: 'idle' });
        }
      }
      const data = detail.data;
      const chapters = data && Array.isArray(data.series)
        ? (data.series.length ? data.series : (view.kind === 'comic' && idOf(data) ? [{ id: idOf(data), name: '第1话（默认章节）' }] : []))
        : [];
      const readerParent = view.kind === 'reader' ? view.parent : null;
      const readerChapters = readerParent && Array.isArray(readerParent.series) && readerParent.series.length
        ? readerParent.series
        : (readerParent && idOf(readerParent) ? [{ id: idOf(readerParent), name: '第1话（默认章节）' }] : []);
      const readerIndex = view.kind === 'reader' ? readerChapters.findIndex(chapter => idOf(chapter) === view.id) : -1;
      function adjacentChapter(offset) {
        if (readerIndex < 0) return null;
        const chapter = readerChapters[readerIndex + offset];
        const id = idOf(chapter);
        return id && id !== view.id ? { id, name: text(chapter.name) } : null;
      }
      const content = search.data && Array.isArray(search.data.content) ? search.data.content : [];
      const searchPage = search.page || 1;
      const searchTotalPages = search.data ? Math.ceil(Number(search.data.total) / SEARCH_DISPLAY_PAGE_SIZE) : 0;
      const searchOffset = ((searchPage - 1) % (SEARCH_SERVER_PAGE_SIZE / SEARCH_DISPLAY_PAGE_SIZE)) * SEARCH_DISPLAY_PAGE_SIZE;
      const pageHasResults = content.slice(searchOffset, searchOffset + SEARCH_DISPLAY_PAGE_SIZE).length > 0;
      return h('main', { className: 'jm-panel' }, h('style', null, css), h('div', { className: 'jm-inner' },
        h('h1', { className: 'jm-title' }, '漫画搜索'),
        h('p', { className: 'jm-muted' }, '匿名搜索漫画，查看漫画和章节信息。'),
        h('form', { className: 'jm-form', onSubmit: runSearch },
          h('input', { className: 'jm-input', value: query, onChange: event => setQuery(event.target.value), placeholder: '输入关键词或漫画编号', 'aria-label': '搜索关键词' }),
          h('button', { className: 'jm-button', type: 'submit', disabled: !query.trim() }, '搜索')),
        view.kind === 'search' ? h(React.Fragment, null,
          h(Status, { state: search }),
          search.status === 'error' ? h('button', { type: 'button', className: 'jm-button', onClick: () => loadSearch(search.query, search.page || 1) }, search.resetToFirst ? '回到第 1 页重试' : '重试搜索') : null,
          search.status === 'idle' ? h('p', { className: 'jm-box jm-muted' }, '输入关键词开始搜索。') : null,
          search.status === 'done' && !search.data ? h('p', { className: 'jm-box jm-muted' }, '搜索结果直接定位到漫画，可继续搜索其他内容。') : null,
          search.status === 'done' && search.data ? h(React.Fragment, null,
            h('h2', { className: 'jm-heading' }, '搜索结果'),
            metadata('关键词', search.query), metadata('结果总数', search.data.total),
            pageHasResults ? h(SearchResults, { key: search.query + ':' + searchPage, api, data: search.data, page: searchPage, onOpen: id => openDetail('comic', id) }) :
              h('p', { className: 'jm-box jm-muted' }, searchPage === 1 ? '没有找到相关漫画。' : '本页没有搜索结果。'),
            searchTotalPages > 0 ? h('nav', { className: 'jm-reader-controls', 'aria-label': '搜索结果分页' },
              h('button', { type: 'button', className: 'jm-button', disabled: searchPage <= 1, onClick: () => loadSearch(search.query, searchPage - 1) }, '上一页'),
              h('span', { 'aria-live': 'polite' }, '第 ' + searchPage + ' 页 / 共 ' + searchTotalPages + ' 页'),
              h('button', { type: 'button', className: 'jm-button', disabled: searchPage >= searchTotalPages, onClick: () => loadSearch(search.query, searchPage + 1) }, '下一页')) : null) : null) : view.kind === 'reader' ? h(Reader, {
          key: view.id, api, chapterId: view.id, chapterName: view.name,
          previousChapter: adjacentChapter(-1), nextChapter: adjacentChapter(1),
          onChapter: chapter => {
            if (downloadRequest.current) cancelDownload();
            setDownload({ status: 'idle' });
            setView({ kind: 'reader', id: chapter.id, name: chapter.name, parent: view.parent });
          },
          onBack: () => {
            if (detail.status === 'done' && idOf(detail.data) === view.id) setView({ kind: 'chapter', id: view.id, parent: view.parent });
            else openDetail('chapter', view.id, view.parent);
          },
        }) : h(React.Fragment, null,
          h('button', { type: 'button', className: 'jm-button jm-back', onClick: back }, view.kind === 'chapter' && view.parent ? '← 返回漫画' : '← 返回搜索'),
          h(Status, { state: detail }),
          detail.status === 'done' && data ? h(React.Fragment, null,
            h('h2', { className: 'jm-heading' }, text(data.name) || (view.kind === 'comic' ? '漫画详情' : '章节详情')),
            metadata('编号', data.id), metadata('作者', data.author), metadata('标签', data.tags), metadata('更新时间', data.addtime),
            view.kind === 'comic' ? h(React.Fragment, null,
              metadata('浏览', data.total_views), metadata('喜欢', data.likes),
              text(data.description) ? h('p', { className: 'jm-description' }, text(data.description)) : null,
              h('h3', { className: 'jm-heading' }, '章节'),
              chapters.length === 0 ? h('p', { className: 'jm-box jm-muted' }, '暂无章节信息。') :
                h('ul', { className: 'jm-chapters' }, chapters.map((chapter, index) => {
                  const id = idOf(chapter);
                  return h('li', { key: id || index }, h('button', { type: 'button', className: 'jm-item', disabled: !id, onClick: () => openDetail('chapter', id, data) }, text(chapter && chapter.name) || '未命名章节', id ? ' · ' + id : ' · 编号不可用'));
                }))) : h(React.Fragment, null,
              metadata('所属系列', data.series_id),
              Array.isArray(data.images) ? metadata('页数', data.images.length) : null,
              h('button', { type: 'button', className: 'jm-button', onClick: () => setView({ kind: 'reader', id: idOf(data), name: text(data.name), parent: view.parent }) }, '在线阅读'),
              h('p', { className: 'jm-muted' }, '下载需要先在插件配置中设置专用下载目录。'),
              h('button', { type: 'button', className: 'jm-button', disabled: download.status === 'loading', onClick: startDownload }, '下载本章'),
              download.status === 'loading' ? h(React.Fragment, null,
                h('span', { role: 'status', className: 'jm-muted' }, ' 正在下载，请保持页面打开。'),
                h('button', { type: 'button', className: 'jm-button', onClick: cancelDownload }, '取消')) : null,
              download.status === 'error' ? h('p', { role: 'alert', className: 'jm-error' }, '下载失败：', download.error) : null,
              download.status === 'cancelled' ? h('p', { role: 'status', className: 'jm-muted' }, '已请求取消；服务端可能需要时间停止，请检查下载目录。') : null,
              download.status === 'done' ? h('p', { role: 'status' }, '下载完成：', text(download.data && download.data.imageCount), ' 页；目录：', text(download.data && download.data.directory)) : null)) : null)));
    }
    return {
      inject: ['slots'],
      createAdapter,
      apply(ctx) {
        const api = createAdapter();
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, inject: () => ({ api }) }, Panel));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: 'jmcomic' }, Icon));
      },
    };
  },
});
