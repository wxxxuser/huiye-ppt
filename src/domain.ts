import { TYPOGRAPHY_RANGES, type Brief, type Deck, type ImageAsset, type Layout, type Outline, type OutlineSlide, type Slide, type SlideImage, type SlideTypography, type SourceBlock, type UsageRecord } from './types';

export const LIMITS = {
  title: 60, audience: 80, goal: 200, sourceMin: 80, sourceMax: 8000,
  minSlides: 4, maxSlides: 10, maxEditedSlides: 30, subtitle: 100, keyMessage: 140,
  bodyItems: 4, bodyItem: 90, speakerNotes: 600,
} as const;

const LAYOUTS: Layout[] = ['cover', 'bullets', 'split', 'steps', 'closing', 'image'];
const SLIDE_ID = /^slide-(?:[1-9]|10|u-[a-f0-9]{12})$/;
const SOURCE_CHARS = 900;
export type ValidationMode = 'generated' | 'edited';

export function newId(prefix = 'deck'): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;
}

/** Stable navigation chunks; every non-whitespace source character is retained. */
export function splitSources(source: string): SourceBlock[] {
  const paragraphs = source.replace(/\r\n?/g, '\n').trim().split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let pending = '';
  for (const paragraph of paragraphs) {
    if (pending && pending.length + paragraph.length + 2 <= SOURCE_CHARS) {
      pending += `\n\n${paragraph}`;
      continue;
    }
    if (pending) chunks.push(pending);
    pending = paragraph;
    while (pending.length > SOURCE_CHARS) {
      let cut = pending.lastIndexOf('\n', SOURCE_CHARS);
      if (cut < SOURCE_CHARS / 2) cut = SOURCE_CHARS;
      // Do not split a UTF-16 surrogate pair (for example an emoji).
      if (/[\uD800-\uDBFF]/.test(pending.charAt(cut - 1))) cut--;
      chunks.push(pending.slice(0, cut).trim());
      pending = pending.slice(cut).trim();
    }
  }
  if (pending) chunks.push(pending);
  return chunks.map((text, i) => ({ id: `S${i + 1}`, text }));
}

export function validateBrief(brief: Brief): string | null {
  if (!brief || typeof brief !== 'object') return '请填写演示目标与材料。';
  for (const [field, name, max] of [['title', '演示标题', LIMITS.title], ['audience', '目标听众', LIMITS.audience], ['goal', '演示目标', LIMITS.goal]] as const) {
    const value = brief[field];
    if (typeof value !== 'string' || !value.trim()) return `请填写${name}。`;
    if (value.trim().length > max) return `${name}不能超过 ${max} 字。`;
  }
  if (!Number.isInteger(brief.slideCount) || brief.slideCount < LIMITS.minSlides || brief.slideCount > LIMITS.maxSlides) return '请选择 4–10 页。';
  if (typeof brief.source !== 'string' || brief.source.trim().length < LIMITS.sourceMin) return `请提供至少 ${LIMITS.sourceMin} 字的材料，便于生成有依据的内容。`;
  if (brief.source.trim().length > LIMITS.sourceMax) return `材料不能超过 ${LIMITS.sourceMax} 字，请先保留重点。`;
  return null;
}

function fail(message: string): never { throw new Error(message); }
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}格式不正确。`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  if (Object.keys(value).some(key => !fields.includes(key)) || fields.some(key => !(key in value))) fail(`${label}字段缺失或包含未知字段。`);
}
function text(value: unknown, max: number, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) fail(`${label}必须是${allowEmpty ? '不超过' : '非空且不超过'} ${max} 字的文本。`);
  return value;
}
function layout(value: unknown): Layout {
  if (!LAYOUTS.includes(value as Layout)) fail('页面使用了不支持的版式。');
  return value as Layout;
}
function references(value: unknown, sources: SourceBlock[], allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > sources.length || value.some(id => typeof id !== 'string')) fail(allowEmpty ? '页面的材料来源格式不正确。' : '每页需要至少一个有效的材料来源。');
  const ids = value as string[];
  const allowed = new Set(sources.map(source => source.id));
  if (new Set(ids).size !== ids.length || ids.some(id => !allowed.has(id))) fail('输出包含不存在或重复的来源编号。');
  return [...ids];
}

export function assertSources(sources: SourceBlock[], brief: Brief): void {
  const expected = splitSources(brief.source);
  if (!Array.isArray(sources) || sources.length !== expected.length || sources.some((source, index) => !source || source.id !== expected[index].id || source.text !== expected[index].text)) fail('材料来源已变化，请根据当前材料重新生成大纲。');
}

export function validateOutlineValue(value: unknown, brief: Brief, sources: SourceBlock[], mode: ValidationMode = 'generated'): Outline {
  const root = object(value, '大纲');
  keys(root, ['title', 'subtitle', 'slides'], '大纲');
  const minSlides = mode === 'edited' ? 1 : LIMITS.minSlides;
  const maxSlides = mode === 'edited' ? LIMITS.maxEditedSlides : LIMITS.maxSlides;
  if (!Number.isInteger(brief.slideCount) || brief.slideCount < minSlides || brief.slideCount > maxSlides) fail(`大纲页数应为 ${minSlides}–${maxSlides} 页。`);
  if (!Array.isArray(root.slides) || root.slides.length !== brief.slideCount) fail(`大纲必须完整包含 ${brief.slideCount} 页，不能缺页或增加页面。`);
  const ids = new Set<string>();
  const slides: OutlineSlide[] = root.slides.map((entry, index) => {
    const row = object(entry, '大纲页面');
    keys(row, ['id', 'title', 'keyMessage', 'layout', 'sourceIds'], '大纲页面');
    const id = text(row.id, 30, '页面编号');
    if (!SLIDE_ID.test(id) || ids.has(id)) fail('大纲页面编号不正确或存在重复。');
    if (mode === 'generated' && id !== `slide-${index + 1}`) fail('大纲页面编号或顺序不正确。');
    ids.add(id);
    return { id, title: text(row.title, LIMITS.title, '页面标题', mode === 'edited'), keyMessage: text(row.keyMessage, LIMITS.keyMessage, '页面主旨', mode === 'edited'), layout: layout(row.layout), sourceIds: references(row.sourceIds, sources, mode === 'edited') };
  });
  if (mode === 'generated') {
    if (slides[0].layout !== 'cover' || slides.at(-1)?.layout !== 'closing') fail('大纲应以封面开始、行动总结结束。');
    if (slides.slice(1, -1).some(slide => slide.layout === 'cover' || slide.layout === 'closing')) fail('封面与总结版式只能位于首尾页。');
  }
  return { title: text(root.title, LIMITS.title, '演示标题', mode === 'edited'), subtitle: text(root.subtitle, LIMITS.subtitle, '演示副标题', true), slides };
}

export function validateSlideValue(value: unknown, sources: SourceBlock[], mode: ValidationMode = 'generated'): Slide {
  const row = object(value, '页面');
  const {image, typography, ...content}=row;
  keys(mode==='edited'?content:row, ['id', 'title', 'subtitle', 'body', 'speakerNotes', 'sourceIds', 'layout'], '页面');
  const id = text(row.id, 30, '页面编号');
  if (!SLIDE_ID.test(id)) fail('页面编号不正确。');
  const slideLayout = layout(row.layout);
  // Draft persistence preserves unfinished edits and layout switches. AI output
  // remains stricter; content quality is separately exposed by checkSlide().
  const minItems = mode === 'edited' || slideLayout === 'cover' ? 0 : 1;
  const maxItems = mode === 'generated' && slideLayout === 'cover' ? 1 : LIMITS.bodyItems;
  if (!Array.isArray(row.body) || row.body.length < minItems || row.body.length > maxItems) fail(`页面正文应为 ${minItems}–${maxItems} 条要点。`);
  return { id, title: text(row.title, LIMITS.title, '页面标题', mode === 'edited'), subtitle: text(row.subtitle, LIMITS.subtitle, '页面副标题', true), body: row.body.map(item => text(item, LIMITS.bodyItem, '正文要点', mode === 'edited')), speakerNotes: text(row.speakerNotes, LIMITS.speakerNotes, '演讲备注', true), sourceIds: references(row.sourceIds, sources, mode === 'edited'), layout: slideLayout, ...(mode==='edited'&&image!==undefined?{image:validateSlideImage(image)}:{}), ...(mode==='edited'&&typography!==undefined?{typography:validateSlideTypography(typography)}:{}) };
}

function validateSlideTypography(value: unknown): Partial<SlideTypography> {
  const row = object(value, '页面字号');
  if (Object.keys(row).some(key => !Object.hasOwn(TYPOGRAPHY_RANGES, key))) fail('页面字号包含未知字段。');
  const result: Partial<SlideTypography> = {};
  for (const field of Object.keys(TYPOGRAPHY_RANGES) as (keyof SlideTypography)[]) {
    if (!Object.hasOwn(row, field)) continue;
    const value = row[field];
    const range = TYPOGRAPHY_RANGES[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < range.min || value > range.max) {
      fail(`页面字号应为 ${range.min}–${range.max} pt 的整数。`);
    }
    result[field] = value;
  }
  return result;
}

export function validateImageAsset(value: unknown): ImageAsset {
  const row=object(value,'图片资产');
  keys(row,['id','path','name','mimeType','width','height','sizeBytes'],'图片资产');
  const id=text(row.id,40,'图片编号');
  if(!/^img-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))fail('图片编号无效。');
  if(row.mimeType!=='image/png'&&row.mimeType!=='image/jpeg')fail('图片格式无效。');
  const path=`assets/${id}.${row.mimeType==='image/png'?'png':'jpg'}`;
  if(row.path!==path)fail('图片路径无效。');
  for(const field of ['width','height','sizeBytes'] as const){
    const max=field==='sizeBytes'?1024*1024:1920;
    if(!Number.isInteger(row[field])||(row[field] as number)<1||(row[field] as number)>max)fail('图片尺寸或大小无效。');
  }
  return {id,path,name:text(row.name,160,'图片名称'),mimeType:row.mimeType,width:row.width as number,height:row.height as number,sizeBytes:row.sizeBytes as number};
}
function validateSlideImage(value: unknown): SlideImage {
  const row=object(value,'页面图片');keys(row,['asset','fit','side'],'页面图片');
  if(!['contain','cover'].includes(row.fit as string)||!['left','right'].includes(row.side as string))fail('图片排版无效。');
  return {asset:validateImageAsset(row.asset),fit:row.fit as SlideImage['fit'],side:row.side as SlideImage['side']};
}

export function validateSlidesValue(value: unknown, outline: Outline, sources: SourceBlock[], mode: ValidationMode = 'generated'): Slide[] {
  const root = object(value, '完整文稿');
  keys(root, ['slides'], '完整文稿');
  if (!Array.isArray(root.slides) || root.slides.length !== outline.slides.length) fail('AI 文稿页数不完整，未替换现有内容。');
  return root.slides.map((entry, index) => {
    const slide = validateSlideValue(entry, sources, mode);
    if (slide.id !== outline.slides[index].id || slide.layout !== outline.slides[index].layout) fail('AI 文稿改变了大纲的页面编号、顺序或版式。');
    return slide;
  });
}

export function parseStrictJSON(value: string): unknown {
  if (typeof value !== 'string' || !value.trim() || value.length > 100_000) fail('AI 没有返回可用的 JSON 内容。');
  try { return JSON.parse(value); } catch { return fail('AI 返回的 JSON 不完整或格式不正确；未自动重试，也未替换现有内容。'); }
}

function numericClaims(value: string): string[] {
  return value.replace(/\bS\d+\b/g, '').replace(/(?<=\d)[,，](?=\d{3}\b)/g, '').match(/\d+(?:\.\d+)?(?:[%％])?/g)?.map(number => number.replace('％', '%')) ?? [];
}
/** A conservative numeral check, not a claim that factual correctness is verified. */
export function unsupportedNumbers(value: string, reference: string): string[] {
  const allowed = new Set(numericClaims(reference));
  return [...new Set(numericClaims(value).filter(number => !allowed.has(number)))];
}

export function assertAINumbers(slides: (OutlineSlide | Slide)[], brief: Brief, sources: SourceBlock[]): void {
  for (const slide of slides) {
    const input = [brief.title, brief.audience, brief.goal, ...sources.filter(source => slide.sourceIds.includes(source.id)).map(source => source.text)].join('\n');
    const output = 'body' in slide ? [slide.title, slide.subtitle, ...slide.body, slide.speakerNotes].join('\n') : `${slide.title}\n${slide.keyMessage}`;
    if (unsupportedNumbers(output, input).length) fail('AI 输出包含所引材料中未出现的数字，已停止采用。请核对材料后手动重试。');
  }
}

export function checkSlide(slide: Slide, sources: SourceBlock[]): string[] {
  const issues: string[] = [];
  if (!slide.title.trim()) issues.push('页面缺少标题。');
  if (slide.title.length > LIMITS.title) issues.push('标题较长，可能影响可读性。');
  if (slide.body.length > (slide.layout === 'cover' ? 1 : LIMITS.bodyItems) || slide.body.some(item => item.length > LIMITS.bodyItem)) issues.push('正文较密，请缩短要点；封面最多一条，其他页最多四条。');
  if (slide.layout !== 'cover' && slide.body.length === 0) issues.push('页面还没有正文要点。');
  if (slide.body.some(item => !item.trim())) issues.push('存在空白要点，请补充文字或移除该条。');
  const valid = new Set(sources.map(source => source.id));
  if (!slide.sourceIds.length) issues.push('未关联材料来源。');
  if (slide.sourceIds.some(id => !valid.has(id))) issues.push('存在无法定位的来源编号。');
  const citedText = sources.filter(source => slide.sourceIds.includes(source.id)).map(source => source.text).join('\n');
  const numbers = unsupportedNumbers([slide.title, slide.subtitle, ...slide.body, slide.speakerNotes].join('\n'), citedText);
  if (numbers.length) issues.push(`请人工核对数字 ${numbers.join('、')}：所引材料未出现相同数字。`);
  if (!slide.speakerNotes.trim()) issues.push('可补充演讲备注，方便讲述。');
  if(slide.layout==='image'&&!slide.image)issues.push('图文页还没有图片，请上传后导出。');
  return issues;
}

export function validateUsage(value: unknown): UsageRecord[] {
  if (!Array.isArray(value) || value.length > 1000) fail('使用记录格式不正确。');
  return value.map(entry => {
    const row = object(entry, '使用记录');
    const allowed = ['id', 'operation', 'at', 'model', 'inputTokens', 'outputTokens', 'totalTokens', 'quotaConsumed', 'simulated'];
    if (Object.keys(row).some(key => !allowed.includes(key))) fail('使用记录含未知字段。');
    if (!['outline', 'deck', 'rewrite'].includes(row.operation as string) || typeof row.simulated !== 'boolean') fail('使用记录格式不正确。');
    const result: UsageRecord = { id: text(row.id, 100, '记录编号'), operation: row.operation as UsageRecord['operation'], at: dateText(row.at), simulated: row.simulated };
    if (row.model !== undefined) result.model = text(row.model, 200, '模型名称');
    for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'quotaConsumed'] as const) {
      if (row[key] !== undefined) {
        if (typeof row[key] !== 'number' || !Number.isFinite(row[key]) || row[key] < 0) fail('使用记录包含无效数值。');
        result[key] = row[key];
      }
    }
    return result;
  });
}
function dateText(value: unknown): string {
  const date = text(value, 40, '时间');
  if (!Number.isFinite(Date.parse(date))) fail('保存时间格式不正确。');
  return date;
}

export function createDeck(brief: Brief, outline: Outline, slides: Slide[], sources: SourceBlock[], usage: UsageRecord[]): Deck {
  const error = validateBrief(brief); if (error) fail(error);
  assertSources(sources, brief);
  const validOutline = validateOutlineValue(outline, brief, sources, 'edited');
  const validSlides = validateSlidesValue({ slides }, validOutline, sources);
  const now = new Date().toISOString();
  return { id: newId(), title: validOutline.title, subtitle: validOutline.subtitle, theme: 'ink', slides: validSlides, brief: { ...brief }, outline: validOutline, sourceBlocks: sources.map(source => ({ ...source })), usage: validateUsage(usage), createdAt: now, updatedAt: now };
}

export function validateStoredDeck(value: unknown): Deck | null {
  try {
    const row = object(value, '草稿');
    keys(row, ['id', 'title', 'subtitle', 'theme', 'slides', 'brief', 'outline', 'sourceBlocks', 'usage', 'createdAt', 'updatedAt'], '草稿');
    const briefRow = object(row.brief, '演示目标');
    keys(briefRow, ['title', 'audience', 'goal', 'slideCount', 'source'], '演示目标');
    const brief = briefRow as unknown as Brief;
    if (validateBrief(brief)) return null;
    if (!Array.isArray(row.sourceBlocks)) return null;
    for (const source of row.sourceBlocks) keys(object(source, '来源'), ['id', 'text'], '来源');
    const sourceBlocks = row.sourceBlocks as SourceBlock[];
    assertSources(sourceBlocks, brief);
    if (!Array.isArray(row.slides) || row.slides.length < 1 || row.slides.length > LIMITS.maxEditedSlides) return null;
    const outline = validateOutlineValue(row.outline, { ...brief, slideCount: row.slides.length }, sourceBlocks, 'edited');
    const slides = validateSlidesValue({ slides: row.slides }, outline, sourceBlocks, 'edited');
    const assets=new Map<string,string>();
    for(const slide of slides){if(!slide.image)continue;const asset=slide.image.asset;const key=JSON.stringify(asset);if(assets.has(asset.id)&&assets.get(asset.id)!==key)return null;assets.set(asset.id,key);}
    if (!['ink', 'paper', 'forest'].includes(row.theme as string)) return null;
    return { id: text(row.id, 100, '文稿编号'), title: text(row.title, LIMITS.title, '文稿标题', true), subtitle: text(row.subtitle, LIMITS.subtitle, '文稿副标题', true), theme: row.theme as Deck['theme'], slides, brief: { ...brief }, outline, sourceBlocks: sourceBlocks.map(source => ({ ...source })), usage: validateUsage(row.usage), createdAt: dateText(row.createdAt), updatedAt: dateText(row.updatedAt) };
  } catch { return null; }
}
