import assert from 'node:assert/strict';
import test from 'node:test';
import { LIMITS, splitSources } from '../src/domain';
import { createHostPlatform } from '../src/platform';
import { makeDemoOutline, makeSampleDeck, SAMPLE_BRIEF, SAMPLE_OUTLINE } from '../src/sample';
import { addSlide, duplicateSlide } from '../src/page-operations';
import type { UsageRecord, WorkspaceDraft } from '../src/types';
import { applyDeckEdit, emptyWorkspace, hasWorkspaceContent, validateWorkspace, workspaceFromDeck, workspaceSnapshot } from '../src/workspace';

const clone = <T>(value: T): T => structuredClone(value);
const paidUsage: UsageRecord = {
  id: 'usage-paid', operation: 'outline', at: '2026-11-17T00:00:00Z', simulated: false,
  inputTokens: 123, outputTokens: 45, totalTokens: 168, quotaConsumed: 0.75,
};

function outlineWorkspace(): WorkspaceDraft {
  return {
    ...emptyWorkspace(), brief: clone(SAMPLE_BRIEF), outlineBrief: clone(SAMPLE_BRIEF),
    sources: splitSources(SAMPLE_BRIEF.source), outline: clone(SAMPLE_OUTLINE), stage: 'outline', usage: [clone(paidUsage)],
  };
}

test('startup ignores the untouched default form and whitespace-only input', () => {
  assert.deepEqual(emptyWorkspace().brief, { title: '', audience: '', goal: '', slideCount: 6, source: '' });
  assert.equal(hasWorkspaceContent(emptyWorkspace()), false);
  const blank = emptyWorkspace();
  blank.brief.title = '  \n';
  blank.brief.source = '\t  \n';
  blank.brief.audience = ` ${blank.brief.audience} `;
  blank.brief.goal = `\n${blank.brief.goal}\n`;
  assert.equal(hasWorkspaceContent(blank), false);
  blank.brief.audience = '';
  blank.brief.goal = '  ';
  assert.equal(hasWorkspaceContent(blank), false);
  blank.usage = [clone(paidUsage)];
  assert.equal(hasWorkspaceContent(blank), false, 'billing records alone are not recoverable document content');
});

test('legacy prefilled audience and goal alone do not create a recovery card', () => {
  const legacy = emptyWorkspace();
  legacy.brief.audience = ' 项目评审同事 ';
  legacy.brief.goal = '\n说明项目成果，争取下一阶段支持\n';
  const stored = workspaceSnapshot(legacy);
  assert.equal(hasWorkspaceContent(stored), false);
  stored.brief.source = '新增的一句材料';
  assert.equal(hasWorkspaceContent(stored), true);
  assert.deepEqual(legacy.brief, { title: '', audience: ' 项目评审同事 ', goal: '\n说明项目成果，争取下一阶段支持\n', slideCount: 6, source: '' });
});

test('startup offers recovery for incomplete material and individually customized brief fields', () => {
  for (const patch of [
    { title: '周会' }, { source: '刚开始记录' }, { audience: '运营同事' },
    { goal: '安排下周任务' }, { slideCount: 4 },
  ]) {
    const draft = emptyWorkspace();
    Object.assign(draft.brief, patch);
    const stored = workspaceSnapshot(draft);
    assert.equal(hasWorkspaceContent(stored), true, JSON.stringify(patch));
    assert.deepEqual(draft, stored, 'content detection must not modify the pending draft');
  }
});

test('startup preserves existing outline or deck even when current materials were cleared', () => {
  for (const draft of [outlineWorkspace(), workspaceFromDeck(makeSampleDeck())]) {
    draft.brief = emptyWorkspace().brief;
    draft.stage = 'brief';
    const before = clone(draft);
    const restored = validateWorkspace(draft)!;
    assert.ok(restored);
    assert.equal(hasWorkspaceContent(restored), true);
    assert.deepEqual(draft, before);
    assert.equal(restored.stage, 'brief', 'detection must not navigate into the old editor');
  }
  const legacy = validateWorkspace(makeSampleDeck())!;
  assert.equal(hasWorkspaceContent(legacy), true);
});

test('deck edits synchronize a mirrored outline without changing selection, usage, or the generation brief', () => {
  const draft = workspaceFromDeck(makeSampleDeck());
  // JSON key order is not part of equality, including after imported snapshots.
  draft.outline = { slides: draft.outline!.slides, subtitle: draft.outline!.subtitle, title: draft.outline!.title };
  draft.selected = 2;
  draft.usage = [clone(paidUsage)];
  const before = clone(draft);
  const next = addSlide(draft.deck!, 0);
  const edited = applyDeckEdit(draft, next);
  assert.equal(edited.deck, next);
  assert.deepEqual(edited.outline, next.outline);
  assert.deepEqual(edited.outlineBrief, next.brief);
  assert.deepEqual(edited.sources, next.sourceBlocks);
  assert.equal(edited.outline!.slides.length, 7);
  assert.deepEqual(edited.brief, before.brief);
  assert.equal(edited.selected, 2);
  assert.deepEqual(edited.usage, [paidUsage]);
  assert.deepEqual(draft, before);
  assert.ok(validateWorkspace(edited));
});

test('editing an older deck preserves a new outline and its independent material context', () => {
  const draft = workspaceFromDeck(makeSampleDeck());
  const newBrief = { ...clone(SAMPLE_BRIEF), title: '另一份汇报', source: `${SAMPLE_BRIEF.source}\n\n新的材料：下一份汇报关注文档交接流程。` };
  draft.brief = newBrief;
  draft.outlineBrief = clone(newBrief);
  draft.sources = splitSources(newBrief.source);
  draft.outline = makeDemoOutline(newBrief, draft.sources);
  draft.stage = 'outline';
  const before = clone(draft);
  const next = duplicateSlide(draft.deck!, 1);
  const edited = applyDeckEdit(draft, next);
  assert.equal(edited.deck, next);
  assert.deepEqual(edited.outline, before.outline);
  assert.deepEqual(edited.outlineBrief, before.outlineBrief);
  assert.deepEqual(edited.sources, before.sources);
  assert.equal(edited.stage, 'outline');
  assert.equal(edited.outline!.slides.length, 6);
  assert.equal(edited.deck!.slides.length, 7);
  assert.deepEqual(draft, before);
  assert.ok(validateWorkspace(edited));
});

test('independent outline edits survive later changes to the existing deck with the same materials', () => {
  const draft = workspaceFromDeck(makeSampleDeck());
  draft.outline!.slides[1].keyMessage = '这段已修改的大纲内容尚未用于重新生成文稿。';
  draft.outline!.title = '重新组织中的汇报';
  const before = clone(draft);
  const next = addSlide(draft.deck!, 1);
  const edited = applyDeckEdit(draft, next);
  assert.equal(edited.deck, next);
  assert.deepEqual(edited.outline, before.outline);
  assert.deepEqual(edited.outlineBrief, before.outlineBrief);
  assert.deepEqual(edited.sources, before.sources);
  assert.deepEqual(draft, before);
  assert.ok(validateWorkspace(edited));
});

test('material autosave preserves incomplete and empty input before AI validation', () => {
  const draft = emptyWorkspace();
  draft.brief = { title: '', audience: '', goal: '', slideCount: 4, source: '还在输入的短材料\n第二行' };
  assert.deepEqual(validateWorkspace(JSON.parse(JSON.stringify(draft))), draft);
  assert.deepEqual(workspaceSnapshot(emptyWorkspace()), emptyWorkspace());
  for (const field of ['title', 'audience', 'goal', 'source'] as const) {
    const max = field === 'source' ? LIMITS.sourceMax : LIMITS[field];
    assert.equal(validateWorkspace({ ...draft, brief: { ...draft.brief, [field]: '字'.repeat(max + 1) } }), null);
  }
  for (const slideCount of [0, 3, 11, 4.5, '6']) {
    assert.equal(validateWorkspace({ ...draft, brief: { ...draft.brief, slideCount } }), null);
  }
});

test('unfinished outline edits, order and paid usage survive an autosave round trip', () => {
  const draft = outlineWorkspace();
  draft.outline!.slides[1].title = '';
  draft.outline!.slides[1].keyMessage = '';
  [draft.outline!.slides[1], draft.outline!.slides[2]] = [draft.outline!.slides[2], draft.outline!.slides[1]];
  assert.deepEqual(workspaceSnapshot(draft), draft);
});

test('changing materials preserves original outline sources and the previous deck', () => {
  const draft = workspaceFromDeck(makeSampleDeck());
  draft.stage = 'brief';
  draft.brief.title = '另一个尚未写完的项目';
  draft.brief.source = '新的短材料';
  const restored = validateWorkspace(draft)!;
  assert.equal(restored.brief.source, '新的短材料');
  assert.equal(restored.outlineBrief!.source, SAMPLE_BRIEF.source);
  assert.equal(restored.deck!.brief.source, SAMPLE_BRIEF.source);
  assert.deepEqual(restored.sources, splitSources(SAMPLE_BRIEF.source));
});

test('legacy decks migrate into the editor without changing the storage format inputs', () => {
  const deck = makeSampleDeck();
  const restored = validateWorkspace(JSON.parse(JSON.stringify(deck)))!;
  assert.equal(restored.schemaVersion, 2);
  assert.equal(restored.stage, 'editor');
  assert.equal(restored.selected, 0);
  assert.deepEqual(restored.deck, deck);
  assert.deepEqual(workspaceSnapshot(deck), restored);
  assert.equal(validateWorkspace({ ...deck, schemaVersion: 1 }), null);
});

test('manually edited page counts restore independently of the original AI request', () => {
  for (const count of [1, LIMITS.maxEditedSlides]) {
    const deck = makeSampleDeck();
    const firstSlide = deck.slides[0];
    const firstOutline = deck.outline.slides[0];
    deck.slides = Array.from({ length: count }, (_, index) => ({
      ...clone(firstSlide), id: `slide-u-${index.toString(16).padStart(12, '0')}`,
    }));
    deck.outline.slides = deck.slides.map(slide => ({ ...clone(firstOutline), id: slide.id }));
    const draft = workspaceFromDeck(deck);
    draft.selected = count - 1;
    const restored = workspaceSnapshot(draft);
    assert.equal(restored.deck!.slides.length, count);
    assert.equal(restored.outline!.slides.length, count);
    assert.equal(restored.selected, count - 1);
    assert.equal(restored.brief.slideCount, SAMPLE_BRIEF.slideCount);
    assert.equal(restored.outlineBrief!.slideCount, SAMPLE_BRIEF.slideCount);
  }
});

test('corrupt fields, stage and selection are rejected rather than silently repaired', () => {
  const draft = workspaceFromDeck(makeSampleDeck());
  for (const invalid of [
    null, {}, { ...draft, schemaVersion: 3 }, { ...draft, unknown: true },
    { ...draft, stage: 'unknown' }, { ...draft, stage: 'editor', deck: null },
    { ...draft, stage: 'outline', outline: null },
    { ...draft, selected: -1 }, { ...draft, selected: 0.5 }, { ...draft, selected: draft.deck!.slides.length },
    { ...emptyWorkspace(), selected: 1 }, { ...draft, deck: { ...draft.deck, theme: 'unknown' } },
    { ...draft, brief: { ...draft.brief, extra: true } },
  ]) assert.equal(validateWorkspace(invalid), null);
  const missingField = clone(draft) as unknown as Record<string, unknown>;
  delete missingField.outlineBrief;
  assert.equal(validateWorkspace(missingField), null);
  assert.throws(() => workspaceSnapshot(missingField as unknown as WorkspaceDraft), /暂停保存/);
});

test('outline provenance must match its own complete brief exactly', () => {
  const draft = outlineWorkspace();
  for (const invalid of [
    { ...draft, outlineBrief: null },
    { ...draft, outlineBrief: { ...draft.outlineBrief, source: '不完整的材料' } },
    { ...draft, sources: [{ id: 'S1', text: '错误来源' }] },
    { ...draft, sources: draft.sources.map(source => ({ ...source, extra: true })) },
    { ...emptyWorkspace(), sources: draft.sources },
  ]) assert.equal(validateWorkspace(invalid), null);
  const unknownRef = clone(draft);
  unknownRef.outline!.slides[0].sourceIds = ['S999'];
  assert.equal(validateWorkspace(unknownRef), null);
});

test('workspace usage is authoritative when restoring an older content snapshot', () => {
  const draft = workspaceFromDeck(makeSampleDeck());
  draft.usage.push(clone(paidUsage));
  assert.deepEqual(draft.deck!.usage, []);
  const restored = workspaceSnapshot(draft);
  assert.deepEqual(restored.usage, [paidUsage]);
  assert.deepEqual(restored.deck!.usage, [paidUsage]);
  assert.deepEqual(draft.deck!.usage, [], 'validation must not mutate its input');
  for (const usage of [
    [{ ...paidUsage, quotaConsumed: -1 }], [{ ...paidUsage, at: 'today' }],
    [{ ...paidUsage, simulated: 'false' }], [{ ...paidUsage, extra: true }],
    [{ ...paidUsage, inputTokens: Number.NaN }],
  ]) assert.equal(validateWorkspace({ ...draft, usage }), null);
});

test('snapshots detach all nested editable content and contain only JSON values', () => {
  const draft = workspaceFromDeck(makeSampleDeck());
  draft.usage = [{ ...paidUsage, model: undefined }];
  const snapshot = workspaceSnapshot(draft);
  draft.brief.title = 'changed';
  draft.sources[0].text = 'changed';
  draft.outline!.slides[0].sourceIds.push('changed');
  draft.deck!.slides[1].body.push('changed');
  draft.usage[0].quotaConsumed = 100;
  assert.notEqual(snapshot.brief.title, draft.brief.title);
  assert.notEqual(snapshot.sources[0].text, 'changed');
  assert.ok(!snapshot.outline!.slides[0].sourceIds.includes('changed'));
  assert.ok(!snapshot.deck!.slides[1].body.includes('changed'));
  assert.equal(snapshot.usage[0].quotaConsumed, 0.75);
  assert.equal(Object.hasOwn(snapshot.usage[0], 'model'), false);
  snapshot.deck!.usage[0].quotaConsumed = 50;
  assert.equal(snapshot.usage[0].quotaConsumed, 0.75, 'deck and workspace ledgers must not alias');
});

test('invalid drafts never reach Anna storage or overwrite existing content', async () => {
  let writes = 0;
  let reads = 0;
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected host call'); };
  const platform = createHostPlatform({
    llm: { complete: unexpected },
    storage: {
      get: async () => { reads++; return { exists: true, value: makeSampleDeck(), etag: 'existing' }; },
      set: async () => { writes++; return { etag: 'next' }; },
    },
    files: { list: unexpected, upload_init: unexpected, upload_finalize: unexpected, download: unexpected },
    window: { set_title: unexpected },
  });
  await assert.rejects(platform.saveDraft({ ...emptyWorkspace(), selected: 1 }), /暂停保存/);
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  const oversized = emptyWorkspace();
  oversized.usage = Array.from({ length: 1000 }, (_, index) => ({ ...paidUsage, id: `usage-${index}`, model: '长'.repeat(200) }));
  await assert.rejects(platform.saveDraft(oversized), /200 KB/);
  assert.equal(writes, 0);
});
