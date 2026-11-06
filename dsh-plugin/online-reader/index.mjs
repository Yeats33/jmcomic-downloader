import { calculateBlockNum, restoreRows } from '../download/index.mjs';

const CDN = 'https://cdn-msp2.jmapiproxy2.cc';
const METADATA_TTL_MS = 2 * 60 * 1000;
const METADATA_CACHE_SIZE = 2;
const HARD_LIMITS = Object.freeze({ maxBytes: 16 * 1024 * 1024, maxOutputBytes: 16 * 1024 * 1024, maxPixels: 20_000_000, maxPages: 100, maxImages: 500, timeoutMs: 30_000 });
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// The downloader's createSharpCodec removes alpha. Preserve it for online PNGs.
function createReaderCodec() {
  let promise;
  const sharp = () => promise ??= import('sharp').then(m => m.default);
  return {
    async decode(input, { maxPixels, maxPages }) {
      const s = await sharp();
      const options = { animated: true, limitInputPixels: maxPixels, failOn: 'warning' };
      const metadata = await s(input, options).metadata();
      const pages = metadata.pages || 1;
      const width = metadata.width, pageHeight = metadata.pageHeight || metadata.height;
      if (![width, pageHeight, pages].every(v => Number.isSafeInteger(v) && v > 0) || pages > maxPages || width * pageHeight * pages > maxPixels) throw new Error('image dimensions, pixels or frames exceed limits');
      const { data, info } = await s(input, options).toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
      return { data, width: info.width, height: info.height, channels: info.channels, format: metadata.format, pages };
    },
    async encode(image, format) {
      const s = await sharp();
      return s(image.data, { raw: { width: image.width, height: image.height, channels: image.channels } }).toFormat(format).toBuffer();
    },
  };
}

/** Failures carry a stable code; upstream client errors retain their original identity. */
export class OnlineReaderError extends Error {
  constructor(code, message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'OnlineReaderError';
    this.code = code;
    if (details.status !== undefined) this.status = details.status;
  }
}
const failure = (code, message, details) => new OnlineReaderError(code, message, details);

function decimal(value, name, allowZero = false) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
  // Limit length before BigInt to avoid work on unbounded attacker input.
  if (typeof value !== 'string' || value.length > 19 || !(allowZero ? /^(0|[1-9]\d*)$/ : /^[1-9]\d*$/).test(value) || BigInt(value) > 9223372036854775807n) throw new TypeError(`${name} must be a canonical ${allowZero ? 'nonnegative' : 'positive'} i64`);
  return value;
}
function filename(value) {
  if (typeof value !== 'string' || value.length > 200 || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:webp|gif|jpe?g|png)$/i.test(value) || value.includes('..')) throw failure('INVALID_METADATA', 'Invalid image basename in chapter metadata');
  return value;
}
function check(signal) { if (signal.aborted) throw signal.reason; }
function cancelBody(response) { try { Promise.resolve(response?.body?.cancel?.()).catch(() => {}); } catch {} }
async function abortable(value, signal) {
  const promise = Promise.resolve(value);
  if (signal.aborted) { promise.catch(() => {}); check(signal); }
  let onAbort;
  const aborted = new Promise((_, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener('abort', onAbort, { once: true }); });
  try { check(signal); return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}
// Never race native codec operations: retain the single slot until native work settles.
async function settleCodec(fn, signal) {
  check(signal);
  try { const value = await fn(); check(signal); return value; }
  catch (cause) { check(signal); throw failure('IMAGE_ERROR', 'Image processing failed', { cause }); }
}
async function imageBytes(fetchImpl, url, signal, maxBytes) {
  let response;
  try {
    const request = Promise.resolve().then(() => fetchImpl(url, { method: 'GET', redirect: 'error', signal, headers: { 'user-agent': USER_AGENT } })).then(result => {
      if (signal.aborted) cancelBody(result);
      return result;
    });
    response = await abortable(request, signal);
  } catch (cause) {
    check(signal);
    throw failure('NETWORK_ERROR', 'Image request failed', { cause });
  }
  if (!response || response.status !== 200 || response.redirected) {
    cancelBody(response);
    throw failure('HTTP_ERROR', `Unexpected image HTTP status ${response?.status}`, { status: response?.status });
  }
  const length = response.headers?.get?.('content-length');
  if (length != null && (!/^\d+$/.test(length) || length.length > 20 || BigInt(length) > BigInt(maxBytes))) {
    cancelBody(response);
    throw failure('RESPONSE_TOO_LARGE', 'Image exceeds byte limit or has invalid Content-Length');
  }
  if (response.body === null) return Buffer.alloc(0);
  if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') {
    cancelBody(response);
    throw failure('INVALID_RESPONSE', 'Streaming image response required');
  }
  const iterator = response.body[Symbol.asyncIterator]();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const part = await abortable(iterator.next(), signal);
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) throw failure('INVALID_RESPONSE', 'Invalid image response chunk');
      if (part.value.byteLength > maxBytes - size) throw failure('RESPONSE_TOO_LARGE', 'Image exceeds byte limit');
      size += part.value.byteLength;
      chunks.push(Buffer.from(part.value));
    }
  } catch (cause) {
    try { Promise.resolve(iterator.return?.()).catch(() => {}); } catch {}
    check(signal);
    if (cause instanceof OnlineReaderError) throw cause;
    throw failure('NETWORK_ERROR', 'Image response stream failed', { cause });
  }
  return Buffer.concat(chunks, size);
}

/**
 * Independent in-memory reader. client, fetch and codec are trusted host dependencies.
 * A reader instance permits one active request and at most four queued requests;
 * hosts must reuse one instance rather than creating one per request.
 * timeoutMs covers queue, metadata, download and codec; native codec cancellation waits for settlement.
 */
export function createOnlineReader({ client, fetch: fetchImpl = globalThis.fetch, codec = createReaderCodec(), limits: supplied = {} } = {}) {
  if (typeof client?.getChapter !== 'function' || typeof client?.getScrambleId !== 'function' || typeof fetchImpl !== 'function' || typeof codec?.decode !== 'function' || typeof codec?.encode !== 'function') throw new TypeError('invalid client, fetch or codec');
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) throw new TypeError('invalid limits');
  const limits = { ...HARD_LIMITS };
  for (const [key, value] of Object.entries(supplied)) {
    if (!Object.hasOwn(HARD_LIMITS, key) || !Number.isSafeInteger(value) || value < 1 || value > HARD_LIMITS[key]) throw new TypeError('invalid limit');
    limits[key] = value;
  }
  let busy = false, disposed = false;
  const queue = [], controllers = new Set(), metadataCache = new Map();
  function cachedMetadata(id) {
    const entry = metadataCache.get(id);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) { metadataCache.delete(id); return null; }
    return entry;
  }
  // Called only after a page is successfully processed. Do not extend the TTL
  // of previously fetched chapter data, even when adding a new scramble ID.
  function commitMetadata(id, images, scramble, prior) {
    const now = Date.now();
    if (prior && now >= prior.expiresAt) { metadataCache.delete(id); return; }
    metadataCache.delete(id);
    metadataCache.set(id, { images, scramble, expiresAt: prior?.expiresAt ?? now + METADATA_TTL_MS });
    while (metadataCache.size > METADATA_CACHE_SIZE) metadataCache.delete(metadataCache.keys().next().value);
  }
  function release() {
    const next = queue.shift();
    if (next) { next.signal.removeEventListener('abort', next.abort); next.resolve(); }
    else busy = false;
  }
  function acquire(signal) {
    check(signal);
    if (!busy) { busy = true; return Promise.resolve(); }
    if (queue.length >= 4) throw failure('BUSY', 'Page request queue is full');
    return new Promise((resolve, reject) => {
      const item = { signal, resolve, abort: () => {
        const index = queue.indexOf(item);
        if (index !== -1) queue.splice(index, 1);
        reject(signal.reason);
      } };
      queue.push(item);
      signal.addEventListener('abort', item.abort, { once: true });
      if (signal.aborted) item.abort();
    });
  }
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      metadataCache.clear();
      for (const controller of controllers) controller.abort(failure('DISPOSED', 'Online reader disposed'));
    },
    async readPage(args = {}) {
      if (disposed) throw failure('DISPOSED', 'Online reader disposed');
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !['chapterId', 'page', 'signal'].includes(k))) throw new TypeError('readPage accepts only chapterId, page and signal');
      const { chapterId, page, signal } = args;
      const id = decimal(chapterId, 'chapterId');
      if (!Number.isSafeInteger(page) || page < 1) throw new TypeError('page must be a positive integer');
      if (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function' || typeof signal.aborted !== 'boolean')) throw new TypeError('invalid AbortSignal');
      if (signal?.aborted) throw failure('ABORTED', 'Page request aborted', { cause: signal.reason });
      const controller = new AbortController();
      controllers.add(controller);
      const onAbort = () => controller.abort(failure('ABORTED', 'Page request aborted', { cause: signal.reason }));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      const timer = setTimeout(() => controller.abort(failure('TIMEOUT', `Page request timed out after ${limits.timeoutMs}ms`)), limits.timeoutMs);
      let acquired = false;
      try {
        await acquire(controller.signal);
        acquired = true;
        check(controller.signal);
        const prior = cachedMetadata(id);
        let images;
        if (prior) images = prior.images;
        else {
          const chapter = await abortable(Promise.resolve().then(() => client.getChapter(id, { signal: controller.signal })), controller.signal);
          check(controller.signal);
          let metadataId;
          try { metadataId = decimal(chapter?.id, 'chapter.id'); } catch (cause) { throw failure('INVALID_METADATA', 'Invalid chapter ID', { cause }); }
          if (metadataId !== id || !Array.isArray(chapter.images) || chapter.images.length < 1 || chapter.images.length > limits.maxImages) throw failure('INVALID_METADATA', 'Invalid chapter metadata');
          // Keep bounded strings only; validate the requested basename separately,
          // so a malformed *other* page does not make this page unreadable.
          images = Array.from(chapter.images);
          if (images.some(name => typeof name !== 'string' || name.length > 200)) throw failure('INVALID_METADATA', 'Invalid chapter image list');
        }
        if (page > images.length) throw failure('PAGE_OUT_OF_RANGE', `页码超出章节范围；当前共 ${images.length} 页，请跳转到有效页。`);
        const name = filename(images[page - 1]);
        let scramble = prior?.scramble;
        const url = `${CDN}/media/photos/${id}/${encodeURIComponent(name)}`;
        let bytes;
        try {
          bytes = await imageBytes(fetchImpl, url, controller.signal, limits.maxBytes);
          // The upstream CDN occasionally caches an empty file; retry once, within
          // the same deadline, with only a server-generated cache-busting query.
          if (!bytes.length) bytes = await imageBytes(fetchImpl, `${url}?ts=${Math.floor(Date.now() / 1000)}`, controller.signal, limits.maxBytes);
          if (!bytes.length) throw failure('INVALID_RESPONSE', 'Empty image response');
        } catch (error) {
          // A cached basename can become stale when the upstream chapter changes.
          // Invalidate only for an actual cached-URL 404; the next request refreshes
          // metadata, and this failed request never populates the cache.
          if (prior && error instanceof OnlineReaderError && error.code === 'HTTP_ERROR' && error.status === 404) metadataCache.delete(id);
          throw error;
        }
        const decoded = await settleCodec(() => codec.decode(bytes, limits), controller.signal);
        const { width, height, channels, pages, format, data } = decoded ?? {};
        if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1 || !Number.isSafeInteger(pages) || pages < 1 || pages > limits.maxPages || height % pages !== 0 || width * height > limits.maxPixels || !Number.isSafeInteger(channels) || channels < 1 || channels > 4 || !Buffer.isBuffer(data) || data.length !== width * height * channels || !['gif', 'webp', 'jpeg', 'png'].includes(format)) throw failure('IMAGE_ERROR', 'Invalid image dimensions, frames, data or format');
        let output = bytes, mime = 'image/gif';
        // libvips may accept a truncated GIF as a valid shorter animation.
        // Require the standard final trailer before returning its original bytes.
        if (format === 'gif' && bytes[bytes.length - 1] !== 0x3b) throw failure('IMAGE_ERROR', 'GIF trailer is missing');
        if (format !== 'gif') {
          if (pages !== 1) throw failure('IMAGE_ERROR', 'Animated non-GIF images are unsupported');
          if (scramble === undefined) {
            const value = await abortable(Promise.resolve().then(() => client.getScrambleId(id, { signal: controller.signal })), controller.signal);
            try { scramble = decimal(value, 'scrambleId', true); } catch (cause) { throw failure('INVALID_METADATA', 'Invalid scramble ID', { cause }); }
          }
          let restored;
          try { restored = restoreRows(data, width, height, channels, calculateBlockNum(scramble, id, name.slice(0, name.lastIndexOf('.')))); }
          catch (cause) { throw failure('IMAGE_ERROR', 'Image restoration failed', { cause }); }
          output = await settleCodec(() => codec.encode({ ...decoded, data: restored }, 'png'), controller.signal);
          mime = 'image/png';
        }
        if (!Buffer.isBuffer(output) || !output.length || output.length > limits.maxOutputBytes) throw failure('OUTPUT_TOO_LARGE', 'Invalid or oversized output image');
        check(controller.signal);
        const result = { chapterId: id, page, total: images.length, mime, data: output.toString('base64') };
        check(controller.signal);
        commitMetadata(id, images, scramble, prior);
        return result;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        controllers.delete(controller);
        if (acquired) release();
      }
    },
  };
}
