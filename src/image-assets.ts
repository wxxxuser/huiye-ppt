import type { Deck, ImageAsset } from './types';

export function deckAssets(deck:Deck):ImageAsset[]{
  return [...new Map(deck.slides.flatMap(slide=>slide.image?[[slide.image.asset.id,slide.image.asset] as const]:[])).values()];
}
