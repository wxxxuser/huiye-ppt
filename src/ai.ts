import type { Brief, CompletionResponse, Outline, Platform, Slide, SourceBlock, UsageRecord } from './types';
import { assertAINumbers, assertSources, newId, parseStrictJSON, unsupportedNumbers, validateBrief, validateOutlineValue, validateSlideValue, validateSlidesValue } from './domain';
import { outlinePrompt, PRESENTATION_SYSTEM, presentationInput } from './prompts';

export class GenerationError extends Error {
  readonly usage: UsageRecord;
  constructor(message: string, usage: UsageRecord) {
    super(message);
    this.name = 'GenerationError';
    this.usage = usage;
  }
}

/** Failed validation can still follow a paid response. Keep that real usage visible. */
export function usageFromError(error: unknown): UsageRecord | undefined {
  return error instanceof GenerationError ? error.usage : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function usageRecord(response: CompletionResponse, operation: UsageRecord['operation']): UsageRecord {
  const record: UsageRecord = { id: newId('usage'), operation, at: new Date().toISOString(), simulated: false };
  if (typeof response.model === 'string' && response.model.trim()) record.model = response.model;
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
    const amount = finite(response.usage?.[key]);
    if (amount !== undefined) record[key] = amount;
  }
  const quota = finite(response._meta?.quotaConsumed);
  if (quota !== undefined) record.quotaConsumed = quota;
  return record;
}

function validateInputs(platform: Platform, brief: Brief, sources: SourceBlock[]): void {
  if (platform.mode !== 'anna') throw new Error('本地演示模式不执行 AI 调用，请在 Anna 平台中使用正式生成。');
  const issue = validateBrief(brief);
  if (issue) throw new Error(issue);
  assertSources(sources, brief);
}
function responseText(response: CompletionResponse): string {
  if (response.stopReason === 'maxTokens' || response.stopReason === 'length' || response.stopReason === 'max_tokens') throw new Error('AI 输出达到长度上限，可能被截断；已停止采用，未自动重试。可减少页数或缩短材料后手动重试。');
  if (response.stopReason && !['endTurn', 'stop'].includes(response.stopReason)) throw new Error(`AI 未正常完成文本输出（${response.stopReason}），已停止采用。`);
  if (response.content?.type !== 'text' || typeof response.content.text !== 'string') throw new Error('平台未返回文本结果，已停止采用。');
  return response.content.text;
}
async function completeOnce<T>(platform: Platform, operation: UsageRecord['operation'], prompt: string, maxTokens: number, parse: (value: unknown) => T): Promise<{ value: T; usage: UsageRecord }> {
  // One user action = exactly one call. No hidden retries or repair calls.
  const response = await platform.complete({ messages: [{ role: 'system', content: { type: 'text', text: PRESENTATION_SYSTEM } }, { role: 'user', content: { type: 'text', text: prompt } }], maxTokens, thinking: false });
  const usage = usageRecord(response, operation);
  try {
    return { value: parse(parseStrictJSON(responseText(response))), usage };
  } catch (error) {
    throw new GenerationError(error instanceof Error ? error.message : 'AI 输出未通过格式校验。', usage);
  }
}

export async function generateOutline(platform: Platform, brief: Brief, sources: SourceBlock[]): Promise<{ outline: Outline; usage: UsageRecord }> {
  validateInputs(platform, brief, sources);
  const result = await completeOnce(platform, 'outline', outlinePrompt(brief, sources), 1600, value => {
    const outline = validateOutlineValue(value, brief, sources);
    if (outline.slides.some(slide => slide.layout === 'image')) throw new Error('AI 大纲不能生成缺少图片的图文页。请在编辑时上传图片并选择图文版式。');
    assertAINumbers(outline.slides, brief, sources);
    if (unsupportedNumbers(`${outline.title}\n${outline.subtitle}`, `${brief.title}\n${brief.audience}\n${brief.goal}\n${brief.source}`).length) throw new Error('大纲标题包含材料未提供的数字，已停止采用。');
    return outline;
  });
  return { outline: result.value, usage: result.usage };
}

export async function generateDeck(platform: Platform, brief: Brief, outline: Outline, sources: SourceBlock[]): Promise<{ slides: Slide[]; usage: UsageRecord }> {
  validateInputs(platform, brief, sources);
  const checkedOutline = validateOutlineValue(outline, brief, sources, 'edited');
  const firstPage = checkedOutline.slides[0];
  const prompt = `请将下列已确认的大纲扩写为完整演示文稿。
JSON结构示例（仅展示首项格式，实际必须输出完整大纲）：{"slides":[{"id":"${firstPage.id}","title":"页面标题","subtitle":"简短副标题或空字符串","body":["简洁要点"],"speakerNotes":"演讲备注","sourceIds":${JSON.stringify(firstPage.sourceIds)},"layout":"${firstPage.layout}"}]}。
恰好输出${brief.slideCount}页；保持大纲每页的id、顺序、layout。封面body允许0–1条，其余每页1–4条。每条最多90字，建议30–55字；每页speakerNotes建议80–150字、最多600字。不要使用数字编号，不要生成图片提示词、样式代码或额外字段。每页最多表达一个主结论，建议和已发生事实要区分。
输入数据：\n${presentationInput(brief, sources)}\n已确认大纲：\n${JSON.stringify(checkedOutline)}`;
  const result = await completeOnce(platform, 'deck', prompt, Math.min(6500, brief.slideCount * 550 + 400), value => {
    const slides = validateSlidesValue(value, checkedOutline, sources);
    assertAINumbers(slides, brief, sources);
    return slides;
  });
  return { slides: result.value, usage: result.usage };
}

export async function rewriteSlide(platform: Platform, brief: Brief, slide: Slide, sources: SourceBlock[], instruction: string): Promise<{ slide: Slide; usage: UsageRecord }> {
  validateInputs(platform, brief, sources);
  const checkedSlide = validateSlideValue(slide, sources, 'edited');
  const relatedSources = sources.filter(source => checkedSlide.sourceIds.includes(source.id));
  if (!relatedSources.length) throw new Error('当前页没有关联材料，暂不能使用 AI 改写。可手动编辑，或复制已有材料引用的页面后改写。');
  if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > 200) throw new Error('请用 1–200 字描述改写要求。');
  const { image: attachedImage, typography, ...textSlide } = checkedSlide;
  const prompt = `请仅改写下面这一页，满足改写要求但仍遵守事实来源与字数限制。
只返回单页JSON对象（不要外包slides数组）：{"id":"${checkedSlide.id}","title":"页面标题","subtitle":"副标题或空字符串","body":["简洁要点"],"speakerNotes":"演讲备注","sourceIds":${JSON.stringify(checkedSlide.sourceIds)},"layout":"${checkedSlide.layout}"}。
必须保持id=${checkedSlide.id}和layout=${checkedSlide.layout}。只优化表达，不能添加材料中没有的事实。每条正文最多90字、最多4条；封面允许0–1条；讲稿建议80–150字且最多600字。
输入数据：\n${presentationInput(brief, relatedSources)}\n当前页面：\n${JSON.stringify(textSlide)}\n改写要求：\n${JSON.stringify(instruction.trim())}`;
  const result = await completeOnce(platform, 'rewrite', prompt, 900, value => {
    const rewritten = validateSlideValue(value, relatedSources);
    if (rewritten.id !== checkedSlide.id || rewritten.layout !== checkedSlide.layout) throw new Error('改写改变了页面编号或版式，已保留原页。');
    assertAINumbers([rewritten], brief, relatedSources);
    return rewritten;
  });
  return { slide: { ...result.value, ...(attachedImage ? { image: structuredClone(attachedImage) } : {}), ...(typography ? { typography: structuredClone(typography) } : {}) }, usage: result.usage };
}
