import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';
import { buildBackup, deckAssets, readBackup } from '../src/backup';
import { validateImageAsset, validateStoredDeck } from '../src/domain';
import { commitHistory, createHistory, redoHistory, undoHistory } from '../src/history';
import { duplicateSlide } from '../src/page-operations';
import { makeSampleDeck } from '../src/sample';
import { workspaceFromDeck, workspaceSnapshot } from '../src/workspace';
import { rewriteSlide } from '../src/ai';
import type { CompletionRequest, Deck, ImageAsset, Platform, SlideImage } from '../src/types';

const imageBytes = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII=', 'base64'));
const imageBlob = () => new Blob([imageBytes], { type: 'image/png' });
function asset(suffix = '1'): ImageAsset {
  const id = `img-00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
  return { id, path: `assets/${id}.png`, name: '外带场景示意.png', mimeType: 'image/png', width: 1, height: 1, sizeBytes: imageBytes.length };
}
function imageDeck(): Deck {
  const deck = makeSampleDeck();
  deck.slides[1] = { ...deck.slides[1], layout: 'image', image: { asset: asset(), fit: 'contain', side: 'left' } };
  deck.outline.slides[1].layout = 'image';
  return deck;
}

test('image metadata survives JSON autosave without URLs or binary bytes, and legacy decks still load', () => {
  const deck = imageDeck();
  const workspace = workspaceFromDeck(deck);
  const saved = workspaceSnapshot(JSON.parse(JSON.stringify(workspace)));
  assert.deepEqual(saved.deck!.slides[1].image, deck.slides[1].image);
  assert.notEqual(saved.deck!.slides[1].image, deck.slides[1].image);
  assert.doesNotMatch(JSON.stringify(saved), /data:image|blob:|get_url|put_url/);
  assert.ok(validateStoredDeck(makeSampleDeck()));
  assert.ok(validateStoredDeck(deck));
});

test('image metadata rejects paths, URL injection, impossible sizes and inconsistent duplicate assets', () => {
  for (const patch of [
    { path: '../private.png' }, { path: 'https://example.com/a.png' }, { sizeBytes: 1024 * 1024 + 1 },
    { width: 1921 }, { height: 0 }, { mimeType: 'image/svg+xml' }, { id: 'malformed-id' },
  ]) assert.throws(() => validateImageAsset({ ...asset(), ...patch }));
  const deck = duplicateSlide(imageDeck(), 1);
  deck.slides[2].image!.asset.name = '不一致的同编号资产.png';
  assert.equal(validateStoredDeck(deck), null);
});

test('copied image pages share immutable asset identity but keep fit, side and metadata independently editable', () => {
  const original = imageDeck();
  const duplicated = duplicateSlide(original, 1);
  assert.equal(duplicated.slides[1].image!.asset.id, duplicated.slides[2].image!.asset.id);
  assert.notEqual(duplicated.slides[1].image, duplicated.slides[2].image);
  assert.notEqual(duplicated.slides[1].image!.asset, duplicated.slides[2].image!.asset);
  duplicated.slides[2].image!.fit = 'cover'; duplicated.slides[2].image!.side = 'right';
  assert.equal(original.slides[1].image!.fit, 'contain');
  assert.equal(duplicated.slides[1].image!.side, 'left');
  assert.ok(validateStoredDeck(duplicated));
  assert.equal(deckAssets(duplicated).length, 1, 'copying a page does not duplicate the stored image');
});

test('replacing and removing images undo/redo restores exact references without reuploading', () => {
  let history = createHistory(workspaceFromDeck(imageDeck()));
  const first = structuredClone(history.present.deck!.slides[1].image!);
  const second: SlideImage = { asset: asset('2'), fit: 'cover', side: 'right' };
  function update(image: SlideImage | undefined) {
    const next = structuredClone(history.present);
    if (image) next.deck!.slides[1].image = image;
    else delete next.deck!.slides[1].image;
    history = commitHistory(history, next);
  }
  update(second); update(undefined);
  history = undoHistory(history);
  assert.deepEqual(history.present.deck!.slides[1].image, second);
  history = undoHistory(history);
  assert.deepEqual(history.present.deck!.slides[1].image, first);
  history = redoHistory(history);
  assert.deepEqual(history.present.deck!.slides[1].image, second);
  assert.deepEqual(workspaceSnapshot(history.present).deck!.slides[1].image, second);
});

test('AI text rewrite preserves image metadata while excluding file references from the model prompt', async () => {
  const deck = imageDeck(); const original = deck.slides[1];
  const { image, ...textSlide } = original;
  const calls: CompletionRequest[] = [];
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected image or storage call'); };
  const platform: Platform = {
    mode: 'anna', label: 'Mock Anna', loadDraft: unexpected, saveDraft: unexpected, setTitle: unexpected,
    saveFile: unexpected, saveImage: unexpected, loadImage: unexpected,
    async complete(request) { calls.push(request); return { content: { type: 'text', text: JSON.stringify(textSlide) }, stopReason: 'endTurn' }; },
  };
  const result = await rewriteSlide(platform, deck.brief, original, deck.sourceBlocks, '保持原有事实，调整语气');
  assert.equal(calls.length, 1);
  assert.deepEqual(result.slide.image, image);
  assert.notEqual(result.slide.image, image);
  assert.ok(!calls[0].messages[1].content.text.includes(image!.asset.path));
  assert.ok(!calls[0].messages[1].content.text.includes(image!.asset.id));
  assert.doesNotMatch(calls[0].messages[1].content.text, /mimeType|sizeBytes|data:image/);
});

test('portable backup round trip includes each image once and retains the complete deck', async () => {
  const deck = duplicateSlide(imageDeck(), 1); let reads = 0;
  const bytes = await buildBackup(deck, async requested => { reads++; assert.equal(requested.id, asset().id); return imageBlob(); });
  const restored = await readBackup(bytes);
  assert.equal(reads, 1);
  assert.deepEqual(restored.deck, deck);
  assert.equal(restored.images.size, 1);
  assert.deepEqual(new Uint8Array(await restored.images.get(asset().id)!.arrayBuffer()), imageBytes);
  assert.equal(restored.images.get(asset().id)!.type, 'image/png');
});

test('backup rejects missing and truncated image payloads before replacing the active document', async () => {
  const deck = imageDeck();
  for (const payload of [undefined, imageBytes.subarray(0, 20)]) {
    const zip = new JSZip();
    zip.file('deck.json', JSON.stringify({ format: 'huiye-backup', version: 1, deck }));
    if (payload) zip.file(asset().path, payload);
    await assert.rejects(readBackup(await zip.generateAsync({ type: 'uint8array' })), /缺少图片|图片文件损坏/);
  }
});

test('backup rejects path traversal, foreign files, inflated image size and oversized input archives', async () => {
  const deck = imageDeck();
  for (const name of ['../escape.png', 'assets/../../escape.png', 'unexpected.txt']) {
    const zip = new JSZip();
    zip.file('deck.json', JSON.stringify({ format: 'huiye-backup', version: 1, deck }));
    zip.file(name, 'should not be accepted');
    await assert.rejects(readBackup(await zip.generateAsync({ type: 'uint8array' })), /未知文件|备份目录/);
  }
  const zip = new JSZip();
  zip.file('deck.json', JSON.stringify({ format: 'huiye-backup', version: 1, deck }));
  zip.file(asset().path, new Uint8Array(1024 * 1024 + 1));
  await assert.rejects(readBackup(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })), /过大的图片/);
  await assert.rejects(readBackup(new Uint8Array(20 * 1024 * 1024 + 1)), /20 MB/);
});
