import test from 'node:test';
import assert from 'node:assert/strict';
import type { CompletionRequest, CompletionResponse, Platform } from '../src/types';
import { assertSources, checkSlide, createDeck, LIMITS, parseStrictJSON, splitSources, unsupportedNumbers, validateBrief, validateOutlineValue, validateSlideValue, validateStoredDeck } from '../src/domain';
import { generateDeck, generateOutline, GenerationError, rewriteSlide, usageFromError } from '../src/ai';
import { makeDemoOutline, makeDemoSlides, makeSampleDeck, SAMPLE_BRIEF, SAMPLE_OUTLINE, SAMPLE_SLIDES } from '../src/sample';

const sources = splitSources(SAMPLE_BRIEF.source);
const clone = <T>(value: T): T => structuredClone(value);
function mockPlatform(value: unknown, overrides: Partial<CompletionResponse> = {}) {
  const calls: CompletionRequest[] = [];
  const platform: Platform = {
    mode: 'anna', label: 'test',
    async complete(request) { calls.push(request); return { content: { type: 'text', text: JSON.stringify(value) }, stopReason: 'endTurn', usage: { inputTokens: 120, outputTokens: 80, totalTokens: 200 }, _meta: { quotaConsumed: 2.5 }, ...overrides }; },
    async loadDraft() { return null; }, async saveDraft() {}, async setTitle() {}, async saveFile() {},
  };
  return { platform, calls };
}

test('source IDs are stable, bounded, and preserve all non-whitespace material', () => {
  const material = `开头\r\n\r\n${'内容😀'.repeat(540)}\n\n结尾`;
  const result = splitSources(material);
  assert.deepEqual(result.map(source => source.id), result.map((_, index) => `S${index + 1}`));
  assert.equal(result.map(source => source.text).join('').replace(/\s/g, ''), material.replace(/\s/g, ''));
  assert.ok(result.every(source => source.text.length <= 900));
  assert.deepEqual(splitSources(material), result);
  assert.deepEqual(splitSources(' \n\t '), []);
  assert.throws(() => assertSources([{ id: 'S1', text: 'different' }], SAMPLE_BRIEF), /材料来源已变化/);
});

test('brief validation enforces the input and slide-count budget boundaries', () => {
  assert.equal(validateBrief(SAMPLE_BRIEF), null);
  assert.match(validateBrief({ ...SAMPLE_BRIEF, source: '短材料' })!, /至少 80/);
  assert.match(validateBrief({ ...SAMPLE_BRIEF, source: '字'.repeat(LIMITS.sourceMax + 1) })!, /8000/);
  for (const slideCount of [3, 11, 4.5]) assert.match(validateBrief({ ...SAMPLE_BRIEF, slideCount })!, /4–10/);
  for (const slideCount of [4, 6, 8, 10]) assert.equal(validateBrief({ ...SAMPLE_BRIEF, slideCount }), null);
});

test('fixed sample is explicitly fictional and does not invent AI usage', () => {
  const deck = makeSampleDeck();
  assert.equal(deck.slides.length, 6);
  assert.match(deck.brief.source, /所有团队、项目、人物与数字均为虚构/);
  assert.match(deck.slides[0].subtitle, /虚构样例/);
  assert.deepEqual(deck.usage, []);
  assert.ok(validateStoredDeck(deck));
});

test('stored drafts are fully validated and corrupt drafts are not silently repaired', () => {
  const deck = makeSampleDeck();
  assert.deepEqual(validateStoredDeck(JSON.parse(JSON.stringify(deck))), deck);
  const before = JSON.stringify(deck);
  const invalids = [null, {}, { ...deck, theme: 'unknown' }, { ...deck, slides: deck.slides.slice(1) }, { ...deck, sourceBlocks: [{ id: 'S1', text: 'different' }] }, { ...deck, unknown: true }, { ...deck, usage: [{ id: 'x', operation: 'deck', at: 'today', simulated: false }] }];
  for (const invalid of invalids) assert.equal(validateStoredDeck(invalid), null);
  assert.equal(JSON.stringify(deck), before);
  const copied = createDeck(SAMPLE_BRIEF, SAMPLE_OUTLINE, SAMPLE_SLIDES, sources, []);
  copied.slides[1].body[0] = '编辑副本';
  assert.notEqual(copied.slides[1].body[0], SAMPLE_SLIDES[1].body[0]);
});

test('strict JSON rejects fences, truncated JSON, and trailing prose', () => {
  for (const value of ['```json\n{}\n```', '{"slides":[', '{} explanation', '']) assert.throws(() => parseStrictJSON(value));
  assert.deepEqual(parseStrictJSON('  {"value":"<script>not executable</script>"}  '), { value: '<script>not executable</script>' });
});

test('numeral checks and source navigation warnings do not claim verification', () => {
  assert.deepEqual(unsupportedNumbers('6分钟→2分钟；24篇', '从6分钟到2分钟，24篇文档'), []);
  assert.deepEqual(unsupportedNumbers('提升67%，节省999元', '6分钟到2分钟'), ['67%', '999']);
  const issues = checkSlide({ ...SAMPLE_SLIDES[1], body: ['新增999项'], sourceIds: ['S404'] }, sources);
  assert.ok(issues.some(issue => issue.includes('无法定位')));
  assert.ok(issues.some(issue => issue.includes('人工核对数字')));
});

test('outline generation makes one bounded real completion and preserves actual usage', async () => {
  const { platform, calls } = mockPlatform(SAMPLE_OUTLINE);
  const result = await generateOutline(platform, SAMPLE_BRIEF, sources);
  assert.deepEqual(result.outline, SAMPLE_OUTLINE);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].maxTokens, 1600);
  assert.equal(calls[0].thinking, false);
  assert.match(calls[0].messages[1].content.text, /"id":"S1"/);
  assert.equal(result.usage.quotaConsumed, 2.5);
  assert.equal(result.usage.totalTokens, 200);
  assert.equal(result.usage.simulated, false);
});

test('missing quota data remains unknown, never a fabricated zero or token conversion', async () => {
  const { platform } = mockPlatform(SAMPLE_OUTLINE, { usage: undefined, _meta: undefined });
  const result = await generateOutline(platform, SAMPLE_BRIEF, sources);
  assert.equal(result.usage.quotaConsumed, undefined);
  assert.equal(result.usage.totalTokens, undefined);
});

test('truncation is rejected even when the partial output happens to be valid JSON; usage survives', async () => {
  const { platform, calls } = mockPlatform(SAMPLE_OUTLINE, { stopReason: 'maxTokens' });
  await assert.rejects(generateOutline(platform, SAMPLE_BRIEF, sources), error => {
    assert.ok(error instanceof GenerationError);
    assert.match(error.message, /截断/);
    assert.equal(usageFromError(error)?.quotaConsumed, 2.5);
    return true;
  });
  assert.equal(calls.length, 1);
});

test('unknown source IDs, duplicate IDs and missing pages are rejected without repair calls', async () => {
  for (const mutate of [
    (outline: typeof SAMPLE_OUTLINE) => { outline.slides[1].sourceIds = ['S404']; },
    (outline: typeof SAMPLE_OUTLINE) => { outline.slides[1].id = 'slide-1'; },
    (outline: typeof SAMPLE_OUTLINE) => { outline.slides.pop(); },
  ]) {
    const outline = clone(SAMPLE_OUTLINE); mutate(outline);
    const { platform, calls } = mockPlatform(outline);
    await assert.rejects(generateOutline(platform, SAMPLE_BRIEF, sources), GenerationError);
    assert.equal(calls.length, 1);
  }
});

test('deck generation observes the per-page token budget and rejects partial decks', async () => {
  const { platform, calls } = mockPlatform({ slides: SAMPLE_SLIDES });
  const result = await generateDeck(platform, SAMPLE_BRIEF, SAMPLE_OUTLINE, sources);
  assert.equal(result.slides.length, 6);
  assert.equal(calls[0].maxTokens, 3700);
  assert.equal(calls[0].thinking, false);
  const partial = mockPlatform({ slides: SAMPLE_SLIDES.slice(0, 3) });
  await assert.rejects(generateDeck(partial.platform, SAMPLE_BRIEF, SAMPLE_OUTLINE, sources), /页数不完整/);
  assert.equal(partial.calls.length, 1);
});

test('rewrite preserves slide ID and layout; failure never overwrites the original or retries', async () => {
  const slide = clone(SAMPLE_SLIDES[2]);
  const good = mockPlatform({ ...slide, title: '建立可维护的知识入口' });
  const result = await rewriteSlide(good.platform, SAMPLE_BRIEF, slide, sources, '表达更简洁');
  assert.equal(result.slide.id, slide.id);
  assert.equal(good.calls[0].maxTokens, 900);
  assert.equal(good.calls.length, 1);
  const wrong = mockPlatform({ ...slide, id: 'slide-2' });
  await assert.rejects(rewriteSlide(wrong.platform, SAMPLE_BRIEF, slide, sources, '表达更简洁'), /改变了页面编号或版式/);
  assert.equal(wrong.calls.length, 1);
  assert.deepEqual(slide, SAMPLE_SLIDES[2]);
});

test('unsupported numbers, oversized fields and non-text termination fail closed', async () => {
  const badNumber = mockPlatform({ ...SAMPLE_SLIDES[1], body: ['节省999元'] });
  await assert.rejects(rewriteSlide(badNumber.platform, SAMPLE_BRIEF, SAMPLE_SLIDES[1], sources, '简洁'), /未出现的数字/);
  const tooLong = mockPlatform({ ...SAMPLE_SLIDES[1], body: ['长'.repeat(91)] });
  await assert.rejects(rewriteSlide(tooLong.platform, SAMPLE_BRIEF, SAMPLE_SLIDES[1], sources, '简洁'), /90/);
  const toolUse = mockPlatform(SAMPLE_OUTLINE, { stopReason: 'toolUse' });
  await assert.rejects(generateOutline(toolUse.platform, SAMPLE_BRIEF, sources), /未正常完成/);
  assert.equal(badNumber.calls.length + tooLong.calls.length + toolUse.calls.length, 3);
});

test('invalid inputs and demo mode cause zero platform calls', async () => {
  const { platform, calls } = mockPlatform(SAMPLE_OUTLINE);
  await assert.rejects(generateOutline(platform, { ...SAMPLE_BRIEF, source: '' }, []));
  platform.mode = 'demo';
  await assert.rejects(generateOutline(platform, SAMPLE_BRIEF, sources), /本地演示模式/);
  assert.equal(calls.length, 0);
});

test('local rule demo supports 4–10 pages and explicitly says it is not AI', () => {
  for (const slideCount of [4, 6, 8, 10]) {
    const brief = { ...SAMPLE_BRIEF, slideCount };
    const outline = makeDemoOutline(brief, sources);
    const slides = makeDemoSlides(brief, outline, sources);
    const deck = createDeck(brief, outline, slides, sources, []);
    assert.equal(deck.slides.length, slideCount);
    assert.ok(deck.slides.every(slide => slide.subtitle.includes('未调用 AI')));
    assert.ok(validateStoredDeck(deck));
  }
});

test('edited outline order and free layouts survive generation, deck creation and storage', async () => {
  const order = [1, 0, 2, 3, 5, 4];
  const outline = { ...clone(SAMPLE_OUTLINE), slides: order.map(index => clone(SAMPLE_OUTLINE.slides[index])) };
  const slides = order.map(index => clone(SAMPLE_SLIDES[index]));
  // Exactly as the outline editor does: swap pages without renumbering stable IDs.
  outline.slides[0].layout = 'split';
  slides[0].layout = 'split';
  outline.slides[2].keyMessage = '';
  assert.throws(() => validateOutlineValue(outline, SAMPLE_BRIEF, sources), /编号或顺序/);
  assert.deepEqual(validateOutlineValue(outline, SAMPLE_BRIEF, sources, 'edited'), outline);
  const { platform, calls } = mockPlatform({ slides });
  const result = await generateDeck(platform, SAMPLE_BRIEF, outline, sources);
  const deck = createDeck(SAMPLE_BRIEF, outline, result.slides, sources, [result.usage]);
  assert.deepEqual(deck.slides.map(slide => slide.id), order.map(index => `slide-${index + 1}`));
  assert.deepEqual(validateStoredDeck(deck), deck);
  assert.equal(calls.length, 1);
  assert.match(calls[0].messages[1].content.text, /JSON结构示例[^\n]+"id":"slide-2"[^\n]+"layout":"split"/);
  const demo = createDeck(SAMPLE_BRIEF, outline, makeDemoSlides(SAMPLE_BRIEF, outline, sources), sources, []);
  assert.deepEqual(demo.slides.map(slide => slide.id), deck.slides.map(slide => slide.id));
  // The same reordered result is not silently accepted as an initial AI outline.
  const freshOutline = mockPlatform(outline);
  await assert.rejects(generateOutline(freshOutline.platform, SAMPLE_BRIEF, sources), GenerationError);
});

test('draft editing allows layout switches and unfinished text while keeping quality hints', () => {
  const deck = makeSampleDeck();
  deck.slides[0].layout = 'bullets'; // Cover has no body yet.
  deck.outline.slides[0].layout = 'bullets';
  deck.slides[1].layout = 'cover'; // Existing content has more than one point.
  deck.outline.slides[1].layout = 'cover';
  deck.slides[2].subtitle = '';
  deck.outline.slides[2].keyMessage = '';
  deck.slides[3].title = '';
  deck.outline.slides[3].title = '';
  deck.slides[3].body.push('');
  assert.deepEqual(validateStoredDeck(deck), deck);
  assert.ok(checkSlide(deck.slides[0], sources).some(issue => issue.includes('没有正文')));
  assert.ok(checkSlide(deck.slides[1], sources).some(issue => issue.includes('封面最多一条')));
  assert.ok(checkSlide(deck.slides[3], sources).some(issue => issue.includes('缺少标题')));
  assert.ok(checkSlide(deck.slides[3], sources).some(issue => issue.includes('空白要点')));
  assert.throws(() => validateSlideValue(deck.slides[0], sources), /正文应为/);
  assert.throws(() => validateSlideValue(deck.slides[1], sources), /正文应为/);
  assert.throws(() => validateSlideValue(deck.slides[3], sources), /页面标题/);
});

test('edited validation still rejects duplicated IDs, out-of-range IDs and unknown references', () => {
  for (const mutate of [
    (outline: typeof SAMPLE_OUTLINE) => { outline.slides[1].id = outline.slides[0].id; },
    (outline: typeof SAMPLE_OUTLINE) => { outline.slides[1].id = 'slide-11'; },
    (outline: typeof SAMPLE_OUTLINE) => { outline.slides[1].sourceIds = ['S404']; },
  ]) {
    const outline = clone(SAMPLE_OUTLINE); mutate(outline);
    assert.throws(() => validateOutlineValue(outline, SAMPLE_BRIEF, sources, 'edited'));
    assert.equal(validateStoredDeck({ ...makeSampleDeck(), outline }), null);
  }
});

test('rewrite can repair an unfinished edited page and sends only its linked material', async () => {
  const unfinished = { ...clone(SAMPLE_SLIDES[1]), title: '', subtitle: '', body: [''] };
  const { platform, calls } = mockPlatform(SAMPLE_SLIDES[1]);
  const result = await rewriteSlide(platform, SAMPLE_BRIEF, unfinished, sources, '补全这页的标题和要点');
  assert.equal(result.slide.id, unfinished.id);
  const prompt = calls[0].messages[1].content.text;
  const payload = JSON.parse(prompt.split('输入数据：\n')[1].split('\n当前页面：')[0]);
  assert.deepEqual(payload.sources.map((source: { id: string }) => source.id), unfinished.sourceIds);
  assert.ok(payload.sources.length < sources.length);
  assert.equal(calls.length, 1);
  const otherSource = sources.find(source => !unfinished.sourceIds.includes(source.id))!;
  const unseenReference = mockPlatform({ ...SAMPLE_SLIDES[1], sourceIds: [otherSource.id] });
  await assert.rejects(rewriteSlide(unseenReference.platform, SAMPLE_BRIEF, unfinished, sources, '补全这页'), /来源编号/);
  assert.equal(unseenReference.calls.length, 1);
});

test('manual pages without linked material never start a paid rewrite call', async () => {
  for (const slide of [
    { ...clone(SAMPLE_SLIDES[1]), sourceIds: [] },
    { ...clone(SAMPLE_SLIDES[1]), id: 'slide-u-012345abcdef', title: '', subtitle: '', body: [], speakerNotes: '', sourceIds: [] },
  ]) {
    const before = clone(slide);
    const { platform, calls } = mockPlatform(SAMPLE_SLIDES[1]);
    assert.deepEqual(validateSlideValue(slide, sources, 'edited'), slide, 'manual content is valid for persistence');
    await assert.rejects(rewriteSlide(platform, SAMPLE_BRIEF, slide, sources, '补全标题和要点'), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /没有关联材料/);
      assert.equal(usageFromError(error), undefined, 'preflight rejection must not fabricate paid usage');
      return true;
    });
    assert.equal(calls.length, 0);
    assert.deepEqual(slide, before);
  }
});

test('usage from a failed paid response survives edited draft persistence and undo content restoration', async () => {
  const beforeRewrite = makeSampleDeck();
  const { platform } = mockPlatform(SAMPLE_SLIDES[1], { stopReason: 'maxTokens' });
  let consumed;
  try { await rewriteSlide(platform, SAMPLE_BRIEF, SAMPLE_SLIDES[1], sources, '简洁'); }
  catch (error) { consumed = usageFromError(error); }
  assert.ok(consumed);
  const draft = clone(beforeRewrite);
  draft.slides[0].layout = 'bullets';
  draft.outline.slides[0].layout = 'bullets';
  draft.usage.push(consumed);
  const saved = validateStoredDeck(JSON.parse(JSON.stringify(draft)));
  assert.ok(saved);
  assert.equal(saved.usage[0].quotaConsumed, 2.5);
  // App restores content when undoing, but keeps the latest irreversible usage.
  const undone = validateStoredDeck({ ...beforeRewrite, usage: saved.usage });
  assert.ok(undone);
  assert.equal(undone.slides[0].layout, 'cover');
  assert.deepEqual(undone.usage, saved.usage);
});
