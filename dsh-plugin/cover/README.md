# Search cover service

`createCoverService({ fetch, codec, limits })` creates a host-owned service with `readCover({ id, signal })` and `dispose()`. Reuse one instance; dispose it during shutdown. `id` is a canonical positive signed 64-bit decimal string or a safe positive integer. `readCover` returns `{ id: string, mime: 'image/jpeg', data: string }`, where `data` is base64; no external URL is returned. Only `id` and optional `signal` are accepted.

The original search card uses `https://cdn-msp3.18comic.vip/media/albums/{id}_3x4.jpg`; the search API provides `id` and `image`, but this service constructs the fixed URL itself and never trusts the `image` field. Redirects are refused. Static JPEG, PNG and WebP are sniffed and decoded with sharp, rotated according to orientation, resized inside 240×360 without upscaling, flattened on white and encoded as metadata-free JPEG. GIF, animation, SVG and other formats are rejected. There is no cache and no disk write.

Hard/default limits are 4 MiB received, 1 MiB output, 4,000,000 decoded pixels, 15 seconds including queue time, four concurrent operations and at most 16 queued operations. `limits` can lower `maxBytes`, `maxOutputBytes`, `maxPixels`, `timeoutMs` and `maxQueue`. Requests can be aborted while queued or downloading. Native sharp operations cannot be safely interrupted; on cancellation, timeout or disposal their slot remains occupied and the request settles only after the codec finishes. `dispose()` aborts active and waiting requests, is idempotent and prevents further requests. `fetch` and optional `codec.convert(bytes, limits)` are trusted dependencies; injected implementations must honor their contracts, including fetch redirect refusal.

Invalid caller arguments throw `TypeError`. Other errors are `CoverError` with `code`: `ABORTED`, `TIMEOUT`, `DISPOSED`, `BUSY`, `NETWORK_ERROR`, `HTTP_ERROR` (has `status`), `INVALID_RESPONSE`, `RESPONSE_TOO_LARGE`, `IMAGE_ERROR`, `OUTPUT_TOO_LARGE`. Errors caused by dependencies preserve `cause` where relevant.

Run offline tests from the repository root: `node --test dsh-plugin/cover/*.test.mjs`.
