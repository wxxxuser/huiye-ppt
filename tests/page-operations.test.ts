import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { LIMITS, validateOutlineValue, validateSlideValue, validateStoredDeck } from '../src/domain';
import { addSlide, deleteSlide, duplicateSlide } from '../src/page-operations';
import { buildPptx } from '../src/export-pptx';
import { makeSampleDeck } from '../src/sample';

test('adding pages preserves existing IDs and the original generation brief without inventing sources', () => {
  const original = makeSampleDeck();
  original.updatedAt = '2020-01-01T00:00:00.000Z';
  original.usage = [{ id: 'paid-call', operation: 'deck', at: original.createdAt, quotaConsumed: 2, simulated: false }];
  const before = structuredClone(original);
  const result = addSlide(original, 1);
  assert.deepEqual(original, before);
  const added = result.slides[2];
  assert.match(added.id, /^slide-u-[a-f0-9]{12}$/);
  assert.deepEqual(added, { id: added.id, title: '', subtitle: '', body: [], speakerNotes: '', sourceIds: [], layout: 'bullets' });
  assert.deepEqual(result.slides.filter(slide => slide.id !== added.id), original.slides);
  assert.deepEqual(result.brief, original.brief);
  assert.equal(result.brief.slideCount, 6);
  assert.equal(result.slides.length, 7);
  assert.deepEqual(result.usage, original.usage);
  assert.equal(result.createdAt, original.createdAt);
  assert.notEqual(result.updatedAt, original.updatedAt);
  assert.deepEqual(result.outline.slides.map(slide => slide.id), result.slides.map(slide => slide.id));
  assert.deepEqual(result.outline.slides[2], { id: added.id, title: '', keyMessage: '', layout: 'bullets', sourceIds: [] });
  assert.deepEqual(validateStoredDeck(result), result);
});

test('copies have independent body and references while preserving content and usage', () => {
  const original = makeSampleDeck();
  const result = duplicateSlide(original, 1);
  const copy = result.slides[2];
  assert.notEqual(copy.id, original.slides[1].id);
  assert.deepEqual({ ...copy, id: original.slides[1].id }, original.slides[1]);
  assert.deepEqual(result.outline.slides[2], {
    id: copy.id, title: copy.title, keyMessage: copy.subtitle, layout: copy.layout, sourceIds: copy.sourceIds,
  });
  assert.equal(result.brief.slideCount, 6);
  assert.deepEqual(validateStoredDeck(result), result);
  copy.body[0] = '只修改副本';
  copy.sourceIds.push('S999');
  assert.notEqual(original.slides[1].body[0], '只修改副本');
  assert.equal(original.slides[1].sourceIds.includes('S999'), false);
  assert.equal(result.slides[1].sourceIds.includes('S999'), false);
  assert.equal(result.outline.slides[2].sourceIds.includes('S999'), false);
});

test('manual editing supports 1–30 pages with unique IDs and retains at least one page', () => {
  let deck = makeSampleDeck();
  while (deck.slides.length < LIMITS.maxEditedSlides) deck = addSlide(deck, deck.slides.length - 1);
  assert.equal(new Set(deck.slides.map(slide => slide.id)).size, 30);
  assert.deepEqual(validateStoredDeck(deck), deck);
  assert.throws(() => addSlide(deck, 0), /最多支持 30 页/);
  assert.throws(() => duplicateSlide(deck, 0), /最多支持 30 页/);
  const lastId = deck.slides.at(-1)!.id;
  while (deck.slides.length > 1) deck = deleteSlide(deck, 0);
  assert.equal(deck.slides[0].id, lastId);
  assert.equal(deck.outline.slides[0].id, lastId);
  assert.equal(deck.brief.slideCount, 6);
  assert.deepEqual(validateStoredDeck(deck), deck);
  assert.throws(() => deleteSlide(deck, 0), /至少需要保留 1 页/);
});

test('page operations reject missing selections instead of editing another page', () => {
  const deck = makeSampleDeck();
  for (const operation of [addSlide, duplicateSlide, deleteSlide]) {
    for (const index of [-1, 1.5, Number.NaN, deck.slides.length]) assert.throws(() => operation(deck, index), /选择一个有效的页面/);
  }
});

test('storage accepts unfinished manual content but rejects broken alignment, IDs, and references', () => {
  const deck = addSlide(makeSampleDeck(), 0);
  deck.title = '';
  deck.outline.title = '';
  assert.deepEqual(validateStoredDeck(deck), deck);
  for (const mutate of [
    (value: typeof deck) => { value.outline.slides.reverse(); },
    (value: typeof deck) => { value.slides[1].id = value.slides[0].id; value.outline.slides[1].id = value.slides[0].id; },
    (value: typeof deck) => { value.slides[1].sourceIds = ['S404']; },
    (value: typeof deck) => { value.outline.slides[1].sourceIds = ['S1', 'S1']; },
    (value: typeof deck) => { value.slides = []; value.outline.slides = []; },
  ]) {
    const corrupted = structuredClone(deck);
    mutate(corrupted);
    assert.equal(validateStoredDeck(corrupted), null);
  }
  const excessive = structuredClone(deck);
  excessive.slides = Array.from({ length: 31 }, () => excessive.slides[0]);
  assert.equal(validateStoredDeck(excessive), null);
});

test('empty references are allowed only in edited content and generated outlines stay sequential and bounded', () => {
  const deck = makeSampleDeck();
  const noSource = { ...deck.slides[1], sourceIds: [] };
  assert.deepEqual(validateSlideValue(noSource, deck.sourceBlocks, 'edited'), noSource);
  assert.throws(() => validateSlideValue(noSource, deck.sourceBlocks), /至少一个有效的材料来源/);
  const outline = structuredClone(deck.outline);
  outline.slides[1].sourceIds = [];
  assert.deepEqual(validateOutlineValue(outline, deck.brief, deck.sourceBlocks, 'edited'), outline);
  assert.throws(() => validateOutlineValue(outline, deck.brief, deck.sourceBlocks), /至少一个有效的材料来源/);
  outline.slides[1].sourceIds = [...deck.slides[1].sourceIds];
  outline.slides[1].id = 'slide-u-012345abcdef';
  assert.deepEqual(validateOutlineValue(outline, deck.brief, deck.sourceBlocks, 'edited'), outline);
  assert.throws(() => validateOutlineValue(outline, deck.brief, deck.sourceBlocks), /编号或顺序/);
  for (const slideCount of [1, 3, 11, 30]) assert.throws(() => validateOutlineValue(outline, { ...deck.brief, slideCount }, deck.sourceBlocks), /4–10/);
  for (const id of ['slide-11', 'slide-u-xyz', 'slide-u-012345ABCDEF']) {
    assert.throws(() => validateSlideValue({ ...deck.slides[1], id }, deck.sourceBlocks, 'edited'), /页面编号/);
  }
});

test('generated single-page rewrites can retain the stable ID of a manually copied page', () => {
  const deck = duplicateSlide(makeSampleDeck(), 1);
  const copy = deck.slides[2];
  assert.match(copy.id, /^slide-u-[a-f0-9]{12}$/);
  assert.deepEqual(validateSlideValue(copy, deck.sourceBlocks), copy);
});

test('legacy drafts and edited page counts remain compatible with real PPTX output', async () => {
  const original = makeSampleDeck();
  assert.deepEqual(validateStoredDeck(JSON.parse(JSON.stringify(original))), original);
  const edited = duplicateSlide(original, 1);
  assert.notEqual(edited.slides.length, edited.brief.slideCount);
  assert.deepEqual(validateStoredDeck(JSON.parse(JSON.stringify(edited))), edited);
  const zip = await JSZip.loadAsync(await buildPptx(edited));
  const pages = Object.keys(zip.files).filter(path => /^ppt\/slides\/slide\d+\.xml$/.test(path));
  assert.equal(pages.length, edited.slides.length);
  const copiedPage = await zip.file('ppt/slides/slide3.xml')!.async('string');
  assert.ok(copiedPage.includes(edited.slides[2].title));
});
