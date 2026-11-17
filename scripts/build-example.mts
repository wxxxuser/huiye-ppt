import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { buildBackup, readBackup } from '../src/backup.ts';
import { validateStoredDeck } from '../src/domain.ts';
import { buildPptx } from '../src/export-pptx.ts';
import { inspectImageBytes } from '../src/images.ts';
import { makeSampleDeck, SAMPLE_IMAGES } from '../src/sample.ts';
import type { ImageAsset } from '../src/types.ts';

// Rebuild distributable examples from checked-in material and image assets.
// No browser runtime, credentials, platform storage, or AI service is involved.
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(project, 'examples');
await mkdir(output, { recursive: true });

const deck = makeSampleDeck();
deck.id = 'deck-demo-coffee';
deck.createdAt = deck.updatedAt = '2026-11-17T00:00:00.000Z';
const ids = [
  'img-83b884c8-b2ed-46ee-9d7f-cf2ad129d233',
  'img-3c9d0060-2c59-4c2c-8042-c87269893c81',
];
assert.equal(SAMPLE_IMAGES.length, ids.length, 'Assign stable IDs when changing example assets.');
const blobs = new Map<string, Blob>();
const imageData: Record<string, string> = {};

for (const [index, entry] of SAMPLE_IMAGES.entries()) {
  const data = await readFile(resolve(project, 'public/examples', entry.file));
  const info = inspectImageBytes(data);
  assert.ok(info.mimeType === 'image/jpeg' || info.mimeType === 'image/png');
  const mimeType = info.mimeType as ImageAsset['mimeType'];
  const id = ids[index];
  const asset: ImageAsset = {
    id, path: `assets/${id}.${mimeType === 'image/png' ? 'png' : 'jpg'}`,
    name: entry.file, mimeType, width: info.width, height: info.height,
    sizeBytes: data.byteLength,
  };
  blobs.set(id, new Blob([new Uint8Array(data)], { type: mimeType }));
  imageData[id] = `data:${mimeType};base64,${data.toString('base64')}`;
  const slide = deck.slides[entry.slideIndex];
  assert.ok(slide, `Missing example slide ${entry.slideIndex + 1}`);
  slide.layout = 'image';
  slide.image = { asset, side: 'left', fit: 'contain' };
  deck.outline.slides[entry.slideIndex].layout = 'image';
}
assert.ok(validateStoredDeck(deck), 'Example deck must pass the actual draft validator.');

const pptx = await buildPptx(deck, imageData);
const archive = await buildBackup(deck, async asset => {
  const blob = blobs.get(asset.id);
  assert.ok(blob, `Missing bytes for ${asset.name}`);
  return blob;
});

// Verify actual exported packages rather than just the scene description.
const pptxZip = await JSZip.loadAsync(pptx, { checkCRC32: true });
const slides = Object.keys(pptxZip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name));
const media = Object.keys(pptxZip.files).filter(name => /^ppt\/media\//.test(name) && !pptxZip.files[name].dir);
assert.equal(slides.length, 6);
assert.equal(media.length, 2);
for (const entry of SAMPLE_IMAGES) {
  const xml = await pptxZip.file(`ppt/slides/slide${entry.slideIndex + 1}.xml`)!.async('string');
  assert.match(xml, /<p:pic>/, 'Image slide must contain an actual picture object.');
  assert.match(xml, /<a:t>/, 'Image slide must retain editable text.');
}
const restored = await readBackup(archive);
assert.equal(restored.deck.slides.length, 6);
assert.equal(restored.images.size, 2);
for (const [id, blob] of blobs) {
  assert.deepEqual(new Uint8Array(await restored.images.get(id)!.arrayBuffer()), new Uint8Array(await blob.arrayBuffer()));
}

await writeFile(resolve(output, 'huiye-demo.pptx'), pptx);
await writeFile(resolve(output, 'huiye-demo.huiye.zip'), archive);
console.log(`Built coffee demo: 6 slides / 2 embedded images; PPTX ${pptx.byteLength} bytes, portable ZIP ${archive.byteLength} bytes. Zero AI calls.`);
console.log('Kept huiye-demo.huiye.json as the image-independent text-only compatibility example.');
