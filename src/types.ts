export type Layout = 'cover' | 'bullets' | 'split' | 'steps' | 'closing' | 'image';
export type ThemeId = 'ink' | 'paper' | 'forest';

export interface Brief {
  title: string;
  audience: string;
  goal: string;
  slideCount: number;
  source: string;
}

export interface SourceBlock { id: string; text: string }

export interface ImageAsset {
  id: string;
  path: string;
  name: string;
  mimeType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  sizeBytes: number;
}
export interface SlideImage {
  asset: ImageAsset;
  fit: 'contain' | 'cover';
  side: 'left' | 'right';
}
export interface PreparedImage { blob: Blob; name: string; width: number; height: number }

/** User-selected font sizes in points; omitted fields keep layout auto-fit. */
export interface SlideTypography {
  titleSize: number;
  subtitleSize: number;
  bodySize: number;
}
export const TYPOGRAPHY_RANGES = {
  titleSize: { min: 18, max: 64, step: 1 },
  subtitleSize: { min: 12, max: 36, step: 1 },
  bodySize: { min: 12, max: 40, step: 1 },
} as const;

export interface OutlineSlide {
  id: string;
  title: string;
  keyMessage: string;
  layout: Layout;
  sourceIds: string[];
}

export interface Outline {
  title: string;
  subtitle: string;
  slides: OutlineSlide[];
}

export interface Slide {
  id: string;
  title: string;
  subtitle: string;
  body: string[];
  speakerNotes: string;
  sourceIds: string[];
  layout: Layout;
  image?: SlideImage;
  typography?: Partial<SlideTypography>;
}

export interface UsageRecord {
  id: string;
  operation: 'outline' | 'deck' | 'rewrite';
  at: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  quotaConsumed?: number;
  simulated: boolean;
}

export interface Deck {
  id: string;
  title: string;
  subtitle: string;
  theme: ThemeId;
  slides: Slide[];
  brief: Brief;
  outline: Outline;
  sourceBlocks: SourceBlock[];
  usage: UsageRecord[];
  createdAt: string;
  updatedAt: string;
}

/** Versioned autosave envelope, including work that has not become a deck yet. */
export interface WorkspaceDraft {
  schemaVersion: 2;
  brief: Brief;
  outlineBrief: Brief | null;
  sources: SourceBlock[];
  outline: Outline | null;
  deck: Deck | null;
  stage: 'brief' | 'outline' | 'editor';
  selected: number;
  usage: UsageRecord[];
}

export interface CompletionRequest {
  messages: {role: 'system' | 'user' | 'assistant'; content: {type: 'text'; text: string}}[];
  maxTokens: number;
  thinking?: false;
}

export interface CompletionResponse {
  content: {type: 'text'; text: string};
  model?: string;
  stopReason?: string;
  usage?: {inputTokens?: number; outputTokens?: number; totalTokens?: number};
  _meta?: {quotaConsumed?: number};
}

export interface Platform {
  mode: 'anna' | 'demo';
  label: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  loadDraft(): Promise<unknown>;
  saveDraft(draft: WorkspaceDraft | Deck): Promise<void>;
  setTitle(title: string): Promise<void>;
  saveFile(bytes: Uint8Array, filename: string, mimeType: string): Promise<void>;
  saveImage(image: PreparedImage): Promise<ImageAsset>;
  loadImage(asset: ImageAsset): Promise<Blob>;
}
