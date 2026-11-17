import assert from 'node:assert/strict';
import test from 'node:test';
import { blobToDataUrl, inspectImageBlob, inspectImageBytes, MAX_IMAGE_BYTES, MAX_IMAGE_INPUT_BYTES, prepareImage } from '../src/images';

const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII=', 'base64'));

test('image inspection uses actual bytes, never filename or caller MIME', async () => {
  assert.deepEqual(await inspectImageBlob(new Blob([png], { type: 'application/octet-stream' })), { mimeType: 'image/png', width: 1, height: 1 });
  await assert.rejects(inspectImageBlob(new Blob(['<svg><script>bad</script></svg>'], { type: 'image/png' })), /请选择有效/);
  await assert.rejects(inspectImageBlob(new Blob()), /为空/);
  await assert.rejects(inspectImageBlob(new Blob([new Uint8Array(MAX_IMAGE_INPUT_BYTES + 1)])), /10 MB/);
});

test('excessive pixel dimensions are rejected before a decoder is allocated', async t => {
  const enormous = new Uint8Array(png);
  const view = new DataView(enormous.buffer); view.setUint32(16, 10000); view.setUint32(20, 10000);
  let calls = 0;
  const original = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: async () => { calls++; throw new Error('must not decode'); } });
  t.after(() => original ? Object.defineProperty(globalThis, 'createImageBitmap', original) : Reflect.deleteProperty(globalThis, 'createImageBitmap'));
  await assert.rejects(prepareImage(new File([enormous], 'large.png', { type: 'image/png' })), /2400 万像素/);
  assert.equal(calls, 0);
});

test('JPEG segment parsing finds dimensions and rejects truncated lengths', () => {
  const jpeg = Uint8Array.of(0xff,0xd8, 0xff,0xe0,0,4,0,0, 0xff,0xc0,0,8,8,0,48,0,80,3);
  assert.deepEqual(inspectImageBytes(jpeg), { mimeType: 'image/jpeg', width: 80, height: 48 });
  assert.throws(() => inspectImageBytes(jpeg.slice(0, 14)), /JPEG 图片尺寸/);
});

test('WebP extended, lossy and lossless dimensions are bounded', () => {
  const base = new Uint8Array(30);
  base.set(new TextEncoder().encode('RIFF'), 0); base.set(new TextEncoder().encode('WEBP'), 8);
  base.set(new TextEncoder().encode('VP8X'), 12); base[24] = 99; base[27] = 49;
  assert.deepEqual(inspectImageBytes(base), { mimeType: 'image/webp', width: 100, height: 50 });
  const lossy = new Uint8Array(base); lossy.set(new TextEncoder().encode('VP8 '), 12);
  lossy.set([0x9d,0x01,0x2a,100,0,50,0], 23);
  assert.deepEqual(inspectImageBytes(lossy), { mimeType: 'image/webp', width: 100, height: 50 });
  const lossless = new Uint8Array(base); lossless.set(new TextEncoder().encode('VP8L'), 12); lossless[20] = 0x2f;
  new DataView(lossless.buffer).setUint32(21, 99 | (49 << 14), true);
  assert.deepEqual(inspectImageBytes(lossless), { mimeType: 'image/webp', width: 100, height: 50 });
});

test('transient export data URL keeps binary bytes and rejects invalid output types or sizes', async () => {
  const dataUrl = await blobToDataUrl(new Blob([png], { type: 'image/png' }));
  assert.deepEqual(Buffer.from(dataUrl.split(',')[1], 'base64'), Buffer.from(png));
  await assert.rejects(blobToDataUrl(new Blob([png], { type: 'image/svg+xml' })), /导出要求/);
  await assert.rejects(blobToDataUrl(new Blob([new Uint8Array(MAX_IMAGE_BYTES + 1)], { type: 'image/png' })), /导出要求/);
});
