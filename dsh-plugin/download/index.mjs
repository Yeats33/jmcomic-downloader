import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';

const IMAGE_DOMAIN = 'cdn-msp2.jmapiproxy2.cc';
const HARD_LIMITS = Object.freeze({
  maxBytes: 32 * 1024 * 1024,
  maxOutputBytes: 128 * 1024 * 1024,
  maxTotalInputBytes: 512 * 1024 * 1024,
  maxTotalOutputBytes: 512 * 1024 * 1024,
  maxPixels: 40_000_000,
  maxPages: 100,
  maxImages: 500,
  imageDownloadTimeoutMs: 30_000,
});
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

function decimal(value, name, zero = false) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
  if (typeof value !== 'string' || !(zero ? /^(0|[1-9]\d*)$/ : /^[1-9]\d*$/).test(value) || BigInt(value) > 9223372036854775807n) throw new TypeError(`${name} must be a canonical ${zero ? 'nonnegative' : 'positive'} i64`);
  return value;
}

/** Implements download_img_task.rs, including ASCII code of the last hex character. */
export function calculateBlockNum(scrambleId, chapterId, stem) {
  const scramble = BigInt(decimal(scrambleId, 'scrambleId', true));
  const idString = decimal(chapterId, 'chapterId');
  const id = BigInt(idString);
  if (typeof stem !== 'string' || !stem.length) throw new TypeError('stem is required');
  if (id < scramble) return 0;
  if (id < 268850n) return 10;
  const mod = id < 421926n ? 10 : 8;
  const hash = createHash('md5').update(idString + stem).digest('hex');
  return (hash.charCodeAt(hash.length - 1) % mod) * 2 + 2;
}

/** Reorder raw interleaved rows; remainder is part of the first destination block. */
export function restoreRows(data, width, height, channels, blocks) {
  if (!Buffer.isBuffer(data) || ![width, height, channels].every(v => Number.isSafeInteger(v) && v > 0) || !Number.isSafeInteger(blocks) || blocks < 0 || data.length !== width * height * channels) throw new TypeError('invalid raw image');
  if (!blocks) return Buffer.from(data);
  if (blocks > height) throw new Error('image height is smaller than block count');
  const result = Buffer.allocUnsafe(data.length);
  const row = width * channels, base = Math.floor(height / blocks), rem = height % blocks;
  for (let i = 0; i < blocks; i++) {
    const srcY = height - base * (i + 1) - rem;
    const dstY = base * i + (i ? rem : 0);
    const rows = base + (i === 0 ? rem : 0);
    data.copy(result, dstY * row, srcY * row, (srcY + rows) * row);
  }
  return result;
}

class ImageTimeoutError extends Error {
  constructor(ms) { super(`Image download timed out after ${ms}ms`); this.name = 'TimeoutError'; }
}
function abortError(signal) {
  return signal.reason instanceof ImageTimeoutError ? signal.reason : Object.assign(new Error('Download aborted', { cause: signal.reason }), { name: 'AbortError' });
}
function checkAbort(signal) {
  if (signal?.aborted) throw abortError(signal);
}
async function abortable(promise, signal) {
  // The operation may synchronously trigger abort before this function is called.
  // Attach a rejection handler even when we will not await it.
  promise = Promise.resolve(promise);
  if (signal?.aborted) { promise.catch(() => {}); checkAbort(signal); }
  if (!signal) return promise;
  let onAbort;
  const aborted = new Promise((_, reject) => { onAbort = () => reject(abortError(signal)); signal.addEventListener('abort', onAbort, { once: true }); });
  try { checkAbort(signal); return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}
async function settleCodec(operation, signal) {
  // Native codecs are not safely cancellable. Keep the task occupied until the
  // operation has settled so a host's single-download lock bounds native work.
  try { const result = await operation(); checkAbort(signal); return result; }
  catch (error) { checkAbort(signal); throw error; }
}
function dimensions(width, height, pages, limits) {
  if (![width, height, pages].every(v => Number.isSafeInteger(v) && v > 0) || pages > limits.maxPages || width * height * pages > limits.maxPixels) throw new Error('image dimensions, pixels or frames exceed limits');
}

/** Default codec. The dependency is optional until actual image decoding is requested. */
export function createSharpCodec() {
  let sharpPromise;
  const sharp = () => sharpPromise ??= import('sharp').then(m => m.default);
  return {
    async decode(input, { maxPixels, maxPages }) {
      const s = await sharp();
      const options = { animated: true, limitInputPixels: maxPixels, failOn: 'warning' };
      const metadata = await s(input, options).metadata();
      const pages = metadata.pages || 1;
      dimensions(metadata.width, metadata.pageHeight || metadata.height, pages, { maxPixels, maxPages });
      // Decode every frame (including GIFs) to reject corrupt data before accepting it.
      const { data, info } = await s(input, options).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
      return { data, width: info.width, height: info.height, channels: info.channels, format: metadata.format, pages };
    },
    async encode(image, format) {
      const s = await sharp();
      return s(image.data, { raw: { width: image.width, height: image.height, channels: image.channels } }).toFormat(format).toBuffer();
    },
  };
}

async function checkedDirectory(dir) {
  // Every existing component, including the root itself, must be a real directory.
  const parsed = path.parse(dir);
  let current = parsed.root;
  for (const component of dir.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const st = await lstat(current);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('output path contains a symlink or non-directory');
  }
  const st = await lstat(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('output root must be a real directory');
  return st;
}
function same(a, b) { return a.dev === b.dev && a.ino === b.ino; }
async function verifyDirs(root, rootStat, chapterPath, chapterStat) {
  if (!same(await checkedDirectory(root), rootStat)) throw new Error('output root changed');
  const st = await lstat(chapterPath);
  if (st.isSymbolicLink() || !st.isDirectory() || !same(st, chapterStat)) throw new Error('chapter directory changed');
}
function cancelBody(response) {
  try { Promise.resolve(response?.body?.cancel?.()).catch(() => {}); } catch { /* best effort */ }
}
async function fetchBytes(fetchImpl, url, signal, limit, budget) {
  const request = Promise.resolve(fetchImpl(url, { signal, redirect: 'error', headers: { 'user-agent': USER_AGENT } })).then(response => {
    if (signal.aborted) cancelBody(response);
    return response;
  });
  const response = await abortable(request, signal);
  if (!response || response.status !== 200) { cancelBody(response); throw new Error(`image HTTP status ${response?.status}`); }
  const length = response.headers?.get?.('content-length');
  if (length && (!/^\d+$/.test(length) || BigInt(length) > BigInt(limit))) { cancelBody(response); throw new Error('image exceeds byte limit'); }
  if (length && BigInt(length) > BigInt(budget.limit - budget.used)) { cancelBody(response); throw new Error('chapter exceeds total input byte limit'); }
  if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') { cancelBody(response); throw new Error('streaming response body required'); }
  const chunks = []; let size = 0;
  const iterator = response.body[Symbol.asyncIterator]();
  try {
    while (true) {
      const part = await abortable(iterator.next(), signal);
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) throw new Error('invalid response body chunk');
      size += part.value.byteLength;
      if (size > limit) throw new Error('image exceeds byte limit');
      budget.used += part.value.byteLength;
      if (budget.used > budget.limit) throw new Error('chapter exceeds total input byte limit');
      chunks.push(Buffer.from(part.value));
    }
  } catch (error) {
    // Do not await a potentially uncooperative stream during cancellation.
    try { Promise.resolve(iterator.return?.()).catch(() => {}); } catch { /* preserve original error */ }
    throw error;
  }
  return Buffer.concat(chunks, size);
}
async function fetchImage(fetchImpl, url, signal, limits, budget) {
  checkAbort(signal);
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const timer = setTimeout(() => controller.abort(new ImageTimeoutError(limits.imageDownloadTimeoutMs)), limits.imageDownloadTimeoutMs);
  try {
    let bytes = await fetchBytes(fetchImpl, url, controller.signal, limits.maxBytes, budget);
    if (!bytes.length) bytes = await fetchBytes(fetchImpl, `${url}?ts=${Math.floor(Date.now() / 1000)}`, controller.signal, limits.maxBytes, budget);
    if (!bytes.length) throw new Error('empty image response');
    checkAbort(controller.signal);
    return bytes;
  } catch (error) {
    controller.abort(error);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
function validateFilename(filename) {
  if (typeof filename !== 'string' || filename.length > 200 || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:webp|gif)$/i.test(filename) || filename.includes('..')) throw new TypeError('invalid image filename');
  return filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
}

/**
 * Construct once with an existing fixed absolute root. Each chapter writes only to
 * root/chapter-<id>, using generated names and exclusive creation. The root and
 * all its ancestors must not be writable/renameable by untrusted concurrent
 * processes: Node lacks portable dirfd/openat operations to prevent TOCTOU races.
 * codec and fetch are trusted dependencies. No persistent queue or resume.
 */
export function createChapterDownloader({ root, fetch: fetchImpl = globalThis.fetch, codec = createSharpCodec(), limits: supplied = {} } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.normalize(root) !== root) throw new TypeError('root must be a normalized absolute existing directory');
  if (typeof fetchImpl !== 'function' || typeof codec?.decode !== 'function' || typeof codec?.encode !== 'function') throw new TypeError('invalid fetch or codec');
  const limits = { ...HARD_LIMITS };
  for (const [key, value] of Object.entries(supplied)) {
    if (!Object.hasOwn(HARD_LIMITS, key) || !Number.isSafeInteger(value) || value < 1 || value > HARD_LIMITS[key]) throw new TypeError('invalid limit');
    limits[key] = value;
  }
  return {
    async downloadChapter({ chapterId, chapter, scrambleId, format = 'jpeg', signal } = {}) {
      const id = decimal(chapterId, 'chapterId');
      decimal(scrambleId, 'scrambleId', true);
      if (!chapter || !Array.isArray(chapter.images) || !chapter.images.length || chapter.images.length > limits.maxImages) throw new TypeError('chapter images must be a non-empty bounded array');
      if (chapter.id !== undefined && decimal(chapter.id, 'chapter.id') !== id) throw new TypeError('chapter ID mismatch');
      if (!['jpeg', 'png', 'webp'].includes(format)) throw new TypeError('unsupported output format');
      if (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function' || typeof signal.aborted !== 'boolean')) throw new TypeError('invalid AbortSignal');
      const images = chapter.images.map(name => ({ name, ext: validateFilename(name) }));
      checkAbort(signal);
      const rootStat = await checkedDirectory(root);
      const chapterPath = path.join(root, `chapter-${id}`);
      await mkdir(chapterPath, { mode: 0o700 }); // EEXIST is always an error, never replace or resume.
      let chapterStat;
      const owned = [];
      const inputBudget = { used: 0, limit: limits.maxTotalInputBytes };
      let totalOutput = 0;
      try {
        chapterStat = await lstat(chapterPath);
        if (!chapterStat.isDirectory() || chapterStat.isSymbolicLink()) throw new Error('chapter directory is not safe');
        const writeOwned = async (name, bytes) => {
          checkAbort(signal);
          if (bytes.length > limits.maxTotalOutputBytes - totalOutput) throw new Error('chapter exceeds total output byte limit');
          totalOutput += bytes.length;
          await verifyDirs(root, rootStat, chapterPath, chapterStat);
          const target = path.join(chapterPath, name);
          const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
          try {
            const st = await handle.stat();
            owned.push({ target, st });
            await handle.writeFile(bytes);
            checkAbort(signal);
          } finally { await handle.close(); }
        };
        for (let i = 0; i < images.length; i++) {
          checkAbort(signal);
          const { name, ext } = images[i];
          const url = `https://${IMAGE_DOMAIN}/media/photos/${id}/${encodeURIComponent(name)}`;
          const bytes = await fetchImage(fetchImpl, url, signal, limits, inputBudget);
          checkAbort(signal);
          const decoded = await settleCodec(() => codec.decode(bytes, limits), signal);
          checkAbort(signal);
          if (!decoded || !['gif', 'webp'].includes(decoded.format) || decoded.format !== ext || !Number.isSafeInteger(decoded.channels) || decoded.channels < 1 || decoded.channels > 4 || !Buffer.isBuffer(decoded.data)) throw new Error('invalid decoded image or format mismatch');
          dimensions(decoded.width, decoded.height, 1, limits);
          if (!Number.isSafeInteger(decoded.pages) || decoded.pages < 1 || decoded.pages > limits.maxPages || decoded.height % decoded.pages !== 0 || decoded.data.length !== decoded.width * decoded.height * decoded.channels) throw new Error('invalid decoded image data');
          let output = bytes;
          let outputExt = 'gif';
          if (ext !== 'gif') {
            if (decoded.pages !== 1) throw new Error('animated webp is not supported');
            const blocks = calculateBlockNum(scrambleId, id, name.slice(0, name.lastIndexOf('.')));
            const data = restoreRows(decoded.data, decoded.width, decoded.height, decoded.channels, blocks);
            output = await settleCodec(() => codec.encode({ ...decoded, data }, format), signal);
            outputExt = format === 'jpeg' ? 'jpg' : format;
          }
          if (!Buffer.isBuffer(output) || !output.length || output.length > limits.maxOutputBytes) throw new Error('encoded image exceeds output limit or is empty');
          await writeOwned(`${String(i + 1).padStart(4, '0')}.${outputExt}`, output);
        }
        checkAbort(signal);
        await writeOwned('.complete.json', Buffer.from(JSON.stringify({ chapterId: id, imageCount: images.length, format })));
        checkAbort(signal);
        return { chapterId: id, imageCount: images.length, directory: chapterPath };
      } catch (error) {
        // Delete only this invocation's exact inodes. Never recursively remove unknown data.
        if (chapterStat) {
          for (const item of owned.reverse()) {
            try { await verifyDirs(root, rootStat, chapterPath, chapterStat); if (same(await lstat(item.target), item.st)) await unlink(item.target); } catch { /* preserve anything we cannot safely identify */ }
          }
          try { await verifyDirs(root, rootStat, chapterPath, chapterStat); await rmdir(chapterPath); } catch { /* do not remove unknown files */ }
        }
        throw error;
      }
    },
  };
}
