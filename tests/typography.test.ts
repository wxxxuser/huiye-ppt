import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSlideValue, validateStoredDeck } from '../src/domain';
import { createSlideScene, getDefaultSlideTypography, getSlideTypography, THEMES, TYPOGRAPHY_RANGES } from '../src/presentation';
import { makeSampleDeck } from '../src/sample';
import { duplicateSlide } from '../src/page-operations';
import { validateWorkspace, workspaceFromDeck, workspaceSnapshot } from '../src/workspace';
import { commitHistory, createHistory, redoHistory, undoHistory } from '../src/history';
import { buildBackup, readBackup } from '../src/backup';
import type { Layout, Slide, SlideTypography, ThemeId } from '../src/types';

const layouts: Layout[] = ['cover', 'bullets', 'split', 'steps', 'closing', 'image'];
const shortSlide: Slide = {
  id: 'slide-1', title: '门店复盘', subtitle: '先看结果，再确定下一步',
  body: ['确认订单与取餐记录'], speakerNotes: '', sourceIds: ['S1'], layout: 'bullets',
};

test('legacy layouts retain automatic typography and manual fields override independently', () => {
  for (const layout of layouts) {
    const slide = { ...shortSlide, layout };
    const defaults = getDefaultSlideTypography(slide);
    assert.deepEqual(getSlideTypography(slide), defaults);
    const original = createSlideScene(slide, 'paper', 0, 1);
    assert.deepEqual(createSlideScene({ ...slide, typography: {} }, 'paper', 0, 1), original);
    for (const [role, field] of [['title', 'titleSize'], ['subtitle', 'subtitleSize'], ['body-0', 'bodySize']] as const) {
      const text = original.elements.find(element => element.kind === 'text' && element.role === role)!;
      assert.equal(text.kind, 'text');
      assert.equal(text.fontSize, defaults[field]);
      assert.equal(text.fontSizeExplicit, false);
    }
    const manual = { ...slide, typography: { bodySize: 19 } };
    assert.deepEqual(getSlideTypography(manual), { ...defaults, bodySize: 19 });
    const updated = createSlideScene(manual, 'paper', 0, 1);
    for (const [index, element] of updated.elements.entries()) {
      if (element.kind !== 'text') continue;
      if (element.role.startsWith('body')) {
        assert.equal(element.fontSize, 19);
        assert.equal(element.fontSizeExplicit, true);
      } else assert.deepEqual(element, original.elements[index]);
    }
  }
  assert.deepEqual(getSlideTypography({ ...shortSlide, layout: 'cover', body: ['甲', '乙', '丙'] }), { titleSize: 36, subtitleSize: 18, bodySize: 23 });
  assert.equal(getSlideTypography({ ...shortSlide, layout: 'image', body: ['甲', '乙', '丙'] }).bodySize, 22);
});

test('manual typography remains exact across themes and layouts, including oversized text', () => {
  const typography = { titleSize: 49, subtitleSize: 26, bodySize: 29 };
  for (const layout of layouts) {
    for (const theme of Object.keys(THEMES) as ThemeId[]) {
      const scene = createSlideScene({ ...shortSlide, layout, typography }, theme, 0, 1);
      assert.equal(scene.issues.some(issue => issue.severity === 'error'), false, `${theme}/${layout}`);
      for (const [role, field] of [['title', 'titleSize'], ['subtitle', 'subtitleSize'], ['body-0', 'bodySize']] as const) {
        const element = scene.elements.find(element => element.kind === 'text' && element.role === role)!;
        assert.equal(element.kind, 'text');
        assert.equal(element.fontSize, typography[field]);
        assert.equal(element.fontSizeExplicit, true);
      }
    }
  }
  for (const [field, content, value] of [
    ['titleSize', { title: '标题'.repeat(30) }, 64],
    ['subtitleSize', { subtitle: '核心信息'.repeat(25) }, 36],
    ['bodySize', { body: Array.from({ length: 4 }, () => '正文'.repeat(45)) }, 40],
  ] as const) {
    const scene = createSlideScene({ ...shortSlide, ...content, typography: { [field]: value } }, 'paper', 0, 1);
    const role = field === 'titleSize' ? 'title' : field === 'subtitleSize' ? 'subtitle' : 'body-0';
    const element = scene.elements.find(element => element.kind === 'text' && element.role === role)!;
    assert.equal(element.kind, 'text');
    assert.equal(element.fontSize, value, 'manual size is never silently reduced');
    assert.ok(scene.issues.some(issue => issue.severity === 'error' && issue.message.includes(`${value} pt`)));
  }
  const small = createSlideScene({ ...shortSlide, typography: { bodySize: 12 } }, 'paper', 0, 1);
  assert.ok(small.issues.some(issue => issue.message.includes('手动字号较小')));
  assert.ok(small.issues.every(issue => !issue.message.includes('自动缩小')));
});

test('stored typography validates optional bounded integer fields and rejects AI injection', () => {
  const deck = makeSampleDeck();
  const source = deck.slides[1];
  for (const typography of [{}, { bodySize: 24 }, { titleSize: 18, subtitleSize: 12, bodySize: 12 }, { titleSize: 64, subtitleSize: 36, bodySize: 40 }]) {
    const slide = { ...source, typography };
    assert.deepEqual(validateSlideValue(slide, deck.sourceBlocks, 'edited'), slide);
    assert.throws(() => validateSlideValue(slide, deck.sourceBlocks, 'generated'), /未知字段/);
  }
  for (const field of Object.keys(TYPOGRAPHY_RANGES) as (keyof SlideTypography)[]) {
    const range = TYPOGRAPHY_RANGES[field];
    for (const value of [range.min - 1, range.max + 1, 23.5, Number.NaN, Infinity, '24', null, undefined]) {
      assert.throws(() => validateSlideValue({ ...source, typography: { [field]: value } }, deck.sourceBlocks, 'edited'), /字号/);
    }
  }
  for (const typography of [null, [], 24, { unknown: 24 }]) {
    assert.throws(() => validateSlideValue({ ...source, typography }, deck.sourceBlocks, 'edited'), /字号/);
  }
  const bad = structuredClone(deck);
  bad.slides[1].typography = { bodySize: -1 };
  assert.equal(validateStoredDeck(bad), null);
  assert.deepEqual(validateStoredDeck(JSON.parse(JSON.stringify(deck))), deck, 'legacy decks need no migration');
});

test('font changes persist in workspace and ZIP backups and participate in undo/redo', async () => {
  const deck = makeSampleDeck();
  const workspace = workspaceFromDeck(deck);
  let history = createHistory(workspace);
  const changed = structuredClone(workspace);
  changed.deck!.slides[1].typography = { titleSize: 38, bodySize: 19 };
  history = commitHistory(history, changed);
  assert.equal(undoHistory(history).present.deck!.slides[1].typography, undefined);
  assert.deepEqual(redoHistory(undoHistory(history)).present.deck!.slides[1].typography, { titleSize: 38, bodySize: 19 });
  const snapshot = workspaceSnapshot(history.present);
  assert.deepEqual(validateWorkspace(JSON.parse(JSON.stringify(snapshot)))!.deck!.slides[1].typography, { titleSize: 38, bodySize: 19 });
  snapshot.deck!.slides[1].typography!.bodySize = 12;
  assert.equal(history.present.deck!.slides[1].typography!.bodySize, 19, 'storage snapshot is detached');
  const bytes = await buildBackup(changed.deck!, async () => { throw new Error('a text-only draft must not load images'); });
  const restored = await readBackup(bytes);
  assert.deepEqual(restored.deck.slides[1].typography, { titleSize: 38, bodySize: 19 });
  assert.equal(restored.images.size, 0);
});

test('duplicating a slide copies typography independently', () => {
  const deck = makeSampleDeck();
  deck.slides[1].typography = { titleSize: 32, bodySize: 18 };
  const result = duplicateSlide(deck, 1);
  assert.deepEqual(result.slides[2].typography, deck.slides[1].typography);
  assert.notEqual(result.slides[2].typography, deck.slides[1].typography);
  result.slides[2].typography!.bodySize = 24;
  assert.equal(result.slides[1].typography!.bodySize, 18);
  assert.equal(deck.slides[1].typography!.bodySize, 18);
});
