const COVER_ORIGIN = 'https://cdn-msp3.18comic.vip';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const HARD_LIMITS = Object.freeze({ maxBytes: 4 * 1024 * 1024, maxOutputBytes: 1024 * 1024, maxPixels: 4_000_000, timeoutMs: 15_000, maxQueue: 16 });

/** Service errors have a stable code and may carry a cause or HTTP status. */
export class CoverError extends Error {
  constructor(code, message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'CoverError'; this.code = code;
    if (details.status !== undefined) this.status = details.status;
  }
}
const error = (code, message, details) => new CoverError(code, message, details);
function idString(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
  if (typeof value !== 'string' || value.length > 19 || !/^[1-9]\d*$/.test(value) || BigInt(value) > 9223372036854775807n) throw new TypeError('id must be a canonical positive i64');
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
async function download(fetchImpl, url, signal, maxBytes) {
  let response;
  try {
    const request = Promise.resolve().then(() => fetchImpl(url, { method: 'GET', redirect: 'error', signal, headers: { 'user-agent': USER_AGENT } })).then(response => {
      if (signal.aborted) cancelBody(response);
      return response;
    });
    response = await abortable(request, signal);
  } catch (cause) { check(signal); throw error('NETWORK_ERROR', 'Cover request failed', { cause }); }
  if (!response || response.status !== 200 || response.redirected) {
    cancelBody(response);
    throw error('HTTP_ERROR', `Unexpected cover HTTP status ${response?.status}`, { status: response?.status });
  }
  const length = response.headers?.get?.('content-length');
  if (length != null && (!/^\d+$/.test(length) || length.length > 20 || BigInt(length) > BigInt(maxBytes))) {
    cancelBody(response); throw error('RESPONSE_TOO_LARGE', 'Cover exceeds byte limit or has invalid Content-Length');
  }
  if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') {
    cancelBody(response); throw error('INVALID_RESPONSE', 'Streaming cover response required');
  }
  const iterator = response.body[Symbol.asyncIterator](), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const part = await abortable(iterator.next(), signal);
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) throw error('INVALID_RESPONSE', 'Invalid cover response chunk');
      if (part.value.byteLength > maxBytes - size) throw error('RESPONSE_TOO_LARGE', 'Cover exceeds byte limit');
      size += part.value.byteLength; chunks.push(Buffer.from(part.value));
    }
  } catch (cause) {
    try { Promise.resolve(iterator.return?.()).catch(() => {}); } catch {}
    check(signal); if (cause instanceof CoverError) throw cause;
    throw error('NETWORK_ERROR', 'Cover response stream failed', { cause });
  }
  if (!size) throw error('INVALID_RESPONSE', 'Empty cover response');
  return Buffer.concat(chunks, size);
}
function rasterFormat(input) {
  if (input.length >= 3 && input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff) return 'jpeg';
  if (input.length >= 8 && input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    for (let at = 8; at + 12 <= input.length;) {
      const length = input.readUInt32BE(at), end = at + 12 + length;
      if (end > input.length) throw new Error('truncated PNG chunk');
      const type = input.toString('ascii', at + 4, at + 8);
      if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') throw new Error('animated PNG is unsupported');
      at = end;
    }
    return 'png';
  }
  if (input.length >= 12 && input.toString('ascii', 0, 4) === 'RIFF' && input.toString('ascii', 8, 12) === 'WEBP') {
    const end = input.readUInt32LE(4) + 8;
    if (end > input.length || end < 12) throw new Error('truncated WebP');
    for (let at = 12; at + 8 <= end;) {
      const type = input.toString('ascii', at, at + 4), length = input.readUInt32LE(at + 4), next = at + 8 + length + (length % 2);
      if (next > end) throw new Error('truncated WebP chunk');
      if (type === 'ANIM' || type === 'ANMF' || (type === 'VP8X' && length && (input[at + 8] & 2))) throw new Error('animated WebP is unsupported');
      at = next;
    }
    return 'webp';
  }
  throw new Error('unsupported cover image format');
}
function createCodec() {
  let sharpPromise;
  const sharp = () => sharpPromise ??= import('sharp').then(m => m.default);
  return {
    async convert(input, { maxPixels }) {
      const format = rasterFormat(input);
      const s = await sharp(), options = { animated: true, limitInputPixels: maxPixels, failOn: 'warning' };
      const metadata = await s(input, options).metadata();
      if (metadata.format !== format || !Number.isSafeInteger(metadata.width) || metadata.width < 1 || !Number.isSafeInteger(metadata.height) || metadata.height < 1 || (metadata.pages || 1) !== 1 || metadata.width * metadata.height > maxPixels) throw new Error('unsupported cover image format, animation or dimensions');
      // Re-encode instead of relaying untrusted bytes and discard metadata.
      return s(input, options).rotate().resize({ width: 240, height: 360, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).toColourspace('srgb').jpeg({ quality: 82 }).toBuffer();
    },
  };
}
/**
 * One trusted host-owned instance: up to four operations, bounded cancellable
 * queue. Injected fetch/codec are trusted and must honor fetch redirect semantics.
 */
export function createCoverService({ fetch: fetchImpl = globalThis.fetch, codec = createCodec(), limits: supplied = {} } = {}) {
  if (typeof fetchImpl !== 'function' || typeof codec?.convert !== 'function') throw new TypeError('invalid fetch or codec');
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) throw new TypeError('invalid limits');
  const limits = { ...HARD_LIMITS };
  for (const [key, value] of Object.entries(supplied)) {
    if (!Object.hasOwn(HARD_LIMITS, key) || !Number.isSafeInteger(value) || value < 1 || value > HARD_LIMITS[key]) throw new TypeError('invalid limit');
    limits[key] = value;
  }
  let active = 0, disposed = false;
  const queue = [], controllers = new Set();
  function acquire(signal) {
    check(signal);
    if (active < 4) { active++; return Promise.resolve(); }
    if (queue.length >= limits.maxQueue) throw error('BUSY', 'Cover request queue is full');
    return new Promise((resolve, reject) => {
      const item = { signal, resolve, abort() { const index = queue.indexOf(item); if (index !== -1) queue.splice(index, 1); reject(signal.reason); } };
      queue.push(item); signal.addEventListener('abort', item.abort, { once: true });
      if (signal.aborted) item.abort();
    });
  }
  function release() {
    const next = queue.shift();
    if (next) { next.signal.removeEventListener('abort', next.abort); next.resolve(); }
    else active--;
  }
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const controller of controllers) controller.abort(error('DISPOSED', 'Cover service disposed'));
    },
    async readCover(args = {}) {
      if (disposed) throw error('DISPOSED', 'Cover service disposed');
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !['id', 'signal'].includes(k))) throw new TypeError('readCover accepts only id and signal');
      const id = idString(args.id), signal = args.signal;
      if (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function' || typeof signal.aborted !== 'boolean')) throw new TypeError('invalid AbortSignal');
      if (signal?.aborted) throw error('ABORTED', 'Cover request aborted', { cause: signal.reason });
      const controller = new AbortController(); controllers.add(controller);
      const onAbort = () => controller.abort(error('ABORTED', 'Cover request aborted', { cause: signal.reason }));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      const timer = setTimeout(() => controller.abort(error('TIMEOUT', `Cover request timed out after ${limits.timeoutMs}ms`)), limits.timeoutMs);
      let acquired = false;
      try {
        await acquire(controller.signal); acquired = true; check(controller.signal);
        const input = await download(fetchImpl, `${COVER_ORIGIN}/media/albums/${id}_3x4.jpg`, controller.signal, limits.maxBytes);
        check(controller.signal);
        let output;
        // Native sharp cannot be interrupted safely; hold the slot until it settles.
        try { output = await codec.convert(input, limits); check(controller.signal); }
        catch (cause) { check(controller.signal); throw error('IMAGE_ERROR', 'Invalid or unsupported cover image', { cause }); }
        if (!Buffer.isBuffer(output) || !output.length || output.length > limits.maxOutputBytes) throw error('OUTPUT_TOO_LARGE', 'Invalid or oversized cover output');
        check(controller.signal);
        return { id, mime: 'image/jpeg', data: output.toString('base64') };
      } finally {
        clearTimeout(timer); signal?.removeEventListener('abort', onAbort); controllers.delete(controller);
        if (acquired) release();
      }
    },
  };
}
