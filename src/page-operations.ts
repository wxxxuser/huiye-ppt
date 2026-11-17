import { LIMITS } from './domain';
import type { Deck, Slide } from './types';

function assertIndex(deck: Deck, index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= deck.slides.length) throw new Error('请先选择一个有效的页面。');
}

function assertRoom(deck: Deck): void {
  if (deck.slides.length >= LIMITS.maxEditedSlides) throw new Error(`文稿最多支持 ${LIMITS.maxEditedSlides} 页，请先删除不需要的页面。`);
}

function newSlideId(deck: Deck): string {
  const ids = new Set(deck.slides.map(slide => slide.id));
  // A collision must not renumber any existing page or break its references.
  for (let attempt = 0; attempt < 100; attempt++) {
    const bytes = new Uint8Array(6);
    if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
    else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
    const id = `slide-u-${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
    if (!ids.has(id)) return id;
  }
  throw new Error('暂时无法分配新的页面编号，请重试。');
}

function withSlides(deck: Deck, slides: Slide[]): Deck {
  return {
    ...deck,
    slides,
    outline: {
      ...deck.outline,
      slides: slides.map(slide => ({
        id: slide.id, title: slide.title, keyMessage: slide.subtitle,
        layout: slide.layout, sourceIds: [...slide.sourceIds],
      })),
    },
    updatedAt: new Date().toISOString(),
  };
}

/** Insert an unfinished manual page after the selected page, without an AI call. */
export function addSlide(deck: Deck, index: number): Deck {
  assertIndex(deck, index);
  assertRoom(deck);
  const slide: Slide = {
    id: newSlideId(deck), title: '', subtitle: '', body: [], speakerNotes: '',
    sourceIds: [], layout: 'bullets',
  };
  return withSlides(deck, [...deck.slides.slice(0, index + 1), slide, ...deck.slides.slice(index + 1)]);
}

/** Copy content and references; editing the copy cannot change the source page. */
export function duplicateSlide(deck: Deck, index: number): Deck {
  assertIndex(deck, index);
  assertRoom(deck);
  const original = deck.slides[index];
  const copy: Slide = { ...original, id: newSlideId(deck), body: [...original.body], sourceIds: [...original.sourceIds], ...(original.image?{image:structuredClone(original.image)}:{}), ...(original.typography?{typography:{...original.typography}}:{}) };
  return withSlides(deck, [...deck.slides.slice(0, index + 1), copy, ...deck.slides.slice(index + 1)]);
}

/** Remove only the selected page; a document always retains at least one page. */
export function deleteSlide(deck: Deck, index: number): Deck {
  assertIndex(deck, index);
  if (deck.slides.length <= 1) throw new Error('文稿至少需要保留 1 页。');
  return withSlides(deck, deck.slides.filter((_, pageIndex) => pageIndex !== index));
}
