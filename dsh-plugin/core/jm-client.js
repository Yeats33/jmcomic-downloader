import { createDecipheriv, createHash } from 'node:crypto';

const APP_VERSION = '2.0.13';
const TOKEN_SECRET = '18comicAPP';
const CONTENT_TOKEN_SECRET = '18comicAPPContent';
const DATA_SECRET = '185Hcomic3PAPP7R';
const DEFAULT_DOMAIN = 'www.cdnzack.cc';
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const SORTS = Object.freeze({ latest: 'mr', view: 'mv', picture: 'mp', like: 'tf', mr: 'mr', mv: 'mv', mp: 'mp', tf: 'tf' });
const md5 = value => createHash('md5').update(value).digest('hex');

/** Error code: HTTP_ERROR, API_ERROR, INVALID_RESPONSE, DECRYPT_ERROR,
 * RESPONSE_TOO_LARGE, NETWORK_ERROR, TIMEOUT or ABORTED. */
export class JmError extends Error {
  constructor(code, message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'JmError';
    this.code = code;
    if (details.status !== undefined) this.status = details.status;
    if (details.apiCode !== undefined) this.apiCode = details.apiCode;
  }
}

function originFor(domain) {
  if (typeof domain !== 'string' || !domain.trim()) throw new TypeError('domain must be a non-empty hostname or HTTP(S) origin');
  let url;
  try { url = new URL(domain.includes('://') ? domain : `https://${domain}`); }
  catch { throw new TypeError('domain must be a valid hostname or HTTP(S) origin'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('domain must be an HTTP(S) origin without credentials, path, query or fragment');
  }
  return url.origin;
}

function identifier(id) {
  const value = typeof id === 'number' && Number.isSafeInteger(id) ? String(id) : id;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw new TypeError('id must be a positive integer or decimal string');
  return value;
}

function decryptData(timestamp, data) {
  try {
    // Buffer.from is permissive, so reject malformed base64 before decoding.
    if (typeof data !== 'string' || !data.length || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new Error('invalid base64');
    const ciphertext = Buffer.from(data, 'base64');
    if (!ciphertext.length || ciphertext.length % 16 || ciphertext.toString('base64') !== data) throw new Error('invalid ciphertext');
    const key = Buffer.from(md5(`${timestamp}${DATA_SECRET}`), 'ascii');
    const decipher = createDecipheriv('aes-256-ecb', key, null);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
  } catch (cause) {
    throw new JmError('DECRYPT_ERROR', 'Could not decrypt or parse JM response data', { cause });
  }
}

// Enforce the limit on bytes returned by fetch (after HTTP decompression), not
// Content-Length, which may be absent, incorrect, or describe compressed data.
async function readBody(response, signal) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new JmError('INVALID_RESPONSE', 'JM response has no readable body stream');
  }
  const reader = response.body.getReader();
  const cancel = () => { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    const buffer = Buffer.allocUnsafe(MAX_RESPONSE_BYTES);
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new JmError('INVALID_RESPONSE', 'JM response stream did not contain bytes');
      if (value.byteLength > MAX_RESPONSE_BYTES - length) {
        cancel();
        throw new JmError('RESPONSE_TOO_LARGE', `JM response exceeds ${MAX_RESPONSE_BYTES} bytes`);
      }
      buffer.set(value, length);
      length += value.byteLength;
    }
    return buffer.toString('utf8', 0, length);
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

function objectData(data, kind) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new JmError('INVALID_RESPONSE', `Invalid ${kind} response`);
  return data;
}

/** Anonymous, read-only JM API client. No cookies, retries or download support. */
export class JmClient {
  constructor({ domain = DEFAULT_DOMAIN, timeoutMs = 15000, fetch: fetchImpl = globalThis.fetch } = {}) {
    this.origin = originFor(domain);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new TypeError('timeoutMs must be an integer between 1 and 2147483647');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch must be a function');
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  async request(path, query, { signal, plaintext = false, tokenSecret = TOKEN_SECRET } = {}) {
    if (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function' || typeof signal.aborted !== 'boolean')) throw new TypeError('signal must be an AbortSignal');
    if (signal?.aborted) throw new JmError('ABORTED', 'JM request was aborted', { cause: signal.reason });
    const timestamp = Math.floor(Date.now() / 1000);
    const url = new URL(path, this.origin);
    for (const [key, value] of Object.entries(typeof query === 'function' ? query(timestamp) : query)) url.searchParams.set(key, String(value));
    const controller = new AbortController();
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const abort = (code, message, cause) => {
      const error = new JmError(code, message, { cause });
      controller.abort(error);
      rejectAbort(error);
    };
    const onAbort = () => abort('ABORTED', 'JM request was aborted', signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    // Close the race between the initial check and listener registration.
    if (signal?.aborted) onAbort();
    const timer = setTimeout(() => abort('TIMEOUT', `JM request timed out after ${this.timeoutMs}ms`), this.timeoutMs);
    try {
      const operation = (async () => {
        let response;
        try {
          response = await this.fetch(url, {
            method: 'GET',
            headers: { token: md5(`${timestamp}${tokenSecret}`), tokenparam: `${timestamp},${APP_VERSION}`, 'user-agent': USER_AGENT },
            signal: controller.signal,
            redirect: 'error',
          });
        } catch (cause) {
          if (controller.signal.aborted) throw controller.signal.reason;
          throw new JmError('NETWORK_ERROR', 'JM network request failed', { cause });
        }
        if (controller.signal.aborted) {
          try { Promise.resolve(response.body?.cancel()).catch(() => {}); } catch {}
          throw controller.signal.reason;
        }
        if (response.status !== 200) {
          try { Promise.resolve(response.body?.cancel()).catch(() => {}); } catch {}
          throw new JmError('HTTP_ERROR', `JM HTTP status ${response.status}`, { status: response.status });
        }
        let body;
        try { body = await readBody(response, controller.signal); }
        catch (cause) {
          if (controller.signal.aborted) throw controller.signal.reason;
          if (cause instanceof JmError) throw cause;
          throw new JmError('NETWORK_ERROR', 'Could not read JM response', { cause });
        }
        if (plaintext) return body;
        let envelope;
        try { envelope = JSON.parse(body); }
        catch (cause) { throw new JmError('INVALID_RESPONSE', 'JM response is not JSON', { cause }); }
        if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || typeof envelope.code !== 'number') throw new JmError('INVALID_RESPONSE', 'Invalid JM response envelope');
        if (envelope.code !== 200) throw new JmError('API_ERROR', `JM API error ${envelope.code}${typeof envelope.errorMsg === 'string' && envelope.errorMsg ? `: ${envelope.errorMsg}` : ''}`, { apiCode: envelope.code });
        if (typeof envelope.data !== 'string') throw new JmError('INVALID_RESPONSE', 'JM response data must be an encrypted string');
        return decryptData(timestamp, envelope.data);
      })();
      return await Promise.race([operation, aborted]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async search(keyword, { page = 1, sort = 'latest', signal } = {}) {
    if (typeof keyword !== 'string' || !keyword.trim()) throw new TypeError('keyword must be a non-empty string');
    if (!Number.isSafeInteger(page) || page < 1) throw new TypeError('page must be a positive integer');
    if (typeof sort !== 'string' || !Object.hasOwn(SORTS, sort)) throw new TypeError('unknown search sort');
    const data = objectData(await this.request('/search', { main_tag: 0, search_query: keyword, page, o: SORTS[sort] }, { signal }), 'search');
    if (Object.hasOwn(data, 'redirect_aid')) {
      let id;
      try { id = identifier(data.redirect_aid); }
      catch (cause) { throw new JmError('INVALID_RESPONSE', 'Invalid search redirect ID', { cause }); }
      return { type: 'comic', data: await this.getComic(id, { signal }) };
    }
    if (typeof data.search_query !== 'string' || !Array.isArray(data.content) || !(typeof data.total === 'number' && Number.isSafeInteger(data.total) || typeof data.total === 'string' && /^\d+$/.test(data.total))) throw new JmError('INVALID_RESPONSE', 'Invalid search response');
    return { type: 'search', data };
  }

  async getComic(id, { signal } = {}) {
    const data = objectData(await this.request('/album', { id: identifier(id) }, { signal }), 'comic');
    if (!('id' in data) || typeof data.name !== 'string' || !Array.isArray(data.series)) throw new JmError('INVALID_RESPONSE', 'Invalid comic response');
    return data;
  }

  async getChapter(id, { signal } = {}) {
    const data = objectData(await this.request('/chapter', { id: identifier(id) }, { signal }), 'chapter');
    if (!('id' in data) || typeof data.name !== 'string' || !Array.isArray(data.images) || !Array.isArray(data.series)) throw new JmError('INVALID_RESPONSE', 'Invalid chapter response');
    return data;
  }

  async getScrambleId(chapterId, { signal } = {}) {
    const id = identifier(chapterId);
    const body = await this.request('/chapter_view_template', timestamp => ({
      id, v: timestamp, mode: 'vertical', page: 0, app_img_shunt: 1, express: 'off',
    }), { signal, plaintext: true, tokenSecret: CONTENT_TOKEN_SECRET });
    // Require exactly one declaration and a complete positive decimal literal;
    // never silently substitute the desktop client's fallback on malformed data.
    const declaration = /\bvar\s+scramble_id\b/g;
    const first = declaration.exec(body);
    const match = first && !declaration.exec(body) && /^var\s+scramble_id\s*=\s*([1-9]\d*)\s*;/.exec(body.slice(first.index));
    const value = match && Number(match[1]);
    if (!match || !Number.isSafeInteger(value)) throw new JmError('INVALID_RESPONSE', 'Invalid or missing scramble_id');
    return value;
  }
}
