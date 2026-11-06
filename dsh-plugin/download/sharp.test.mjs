import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createChapterDownloader } from './index.mjs';

async function makeRoot(t) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'jm-sharp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

// Construct the inverse of the Rust stitch mapping, without calling the module's
// restoreRows helper. The 13-row image exercises the remainder of a 10-way split.
function scramble(plain, width, height, blocks) {
  const stride = width * 3;
  const base = Math.floor(height / blocks), remainder = height % blocks;
  const result = Buffer.alloc(plain.length);
  for (let i = 0; i < blocks; i++) {
    const count = base + (i === 0 ? remainder : 0);
    const plainY = base * i + (i === 0 ? 0 : remainder);
    const scrambledY = height - base * (i + 1) - remainder;
    plain.copy(result, scrambledY * stride, plainY * stride, (plainY + count) * stride);
  }
  return result;
}

test('real sharp decodes lossless webp, restores stripes and encodes PNG', async t => {
  const root = await makeRoot(t);
  const width = 4, height = 13;
  const plain = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 3;
    plain[i] = y * 17; plain[i + 1] = x * 51; plain[i + 2] = (y * 19 + x * 7) % 256;
  }
  const scrambled = scramble(plain, width, height, 10);
  const webp = await sharp(scrambled, { raw: { width, height, channels: 3 } }).webp({ lossless: true }).toBuffer();
  const dl = createChapterDownloader({ root, fetch: async () => new Response(webp) });
  await dl.downloadChapter({ chapterId: 220980, scrambleId: 220980, chapter: { images: ['00001.webp'] }, format: 'png' });
  const saved = await readFile(path.join(root, 'chapter-220980', '0001.png'));
  const { data, info } = await sharp(saved).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, width); assert.equal(info.height, height); assert.equal(info.channels, 3);
  assert.deepEqual(data, plain);
});

test('real sharp validates a GIF and its bytes are preserved', async t => {
  const root = await makeRoot(t);
  const pixels = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]);
  const gif = await sharp(pixels, { raw: { width: 2, height: 2, channels: 3 } }).gif().toBuffer();
  const dl = createChapterDownloader({ root, fetch: async () => new Response(gif) });
  await dl.downloadChapter({ chapterId: 1, scrambleId: 2, chapter: { images: ['test.gif'] } });
  assert.deepEqual(await readFile(path.join(root, 'chapter-1', '0001.gif')), gif);
});
