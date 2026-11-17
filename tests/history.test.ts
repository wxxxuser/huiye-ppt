import assert from 'node:assert/strict';
import test from 'node:test';
import { breakHistoryGroup, commitHistory, createHistory, HISTORY_LIMIT, redoHistory, replacePresent, undoHistory } from '../src/history';
import { emptyWorkspace, workspaceFromDeck } from '../src/workspace';
import { makeSampleDeck } from '../src/sample';
import { addSlide, deleteSlide, duplicateSlide } from '../src/page-operations';

test('typing coalesces within one focus session; blur and pauses start new undo entries', () => {
  let h = createHistory(emptyWorkspace());
  const title = (value: string, now: number) => { h = commitHistory(h, { ...h.present, brief: { ...h.present.brief, title: value } }, 'brief', now); };
  title('a', 100); title('ab', 200); title('abc', 300);
  assert.equal(h.past.length, 1);
  h = breakHistoryGroup(h); title('abcd', 400); title('abcde', 1400);
  assert.equal(h.past.length, 3);
  assert.equal(undoHistory(h).present.brief.title, 'abcd');
  assert.equal(undoHistory(undoHistory(h)).present.brief.title, 'abc');
});
test('page operations undo/redo restore content, IDs, order, and selected page', () => {
  let h = createHistory(workspaceFromDeck(makeSampleDeck()));
  const original = structuredClone(h.present);
  for (const operation of [addSlide, duplicateSlide, deleteSlide]) {
    const deck = operation(h.present.deck!, h.present.selected);
    h = commitHistory(h, { ...h.present, deck, outline: deck.outline, selected: Math.min(1, deck.slides.length - 1) });
  }
  const edited = structuredClone(h.present);
  h = undoHistory(undoHistory(undoHistory(h)));
  assert.deepEqual(h.present, original);
  h = redoHistory(redoHistory(redoHistory(h)));
  assert.deepEqual(h.present, edited);
  h = undoHistory(h);
  h = commitHistory(h, { ...h.present, brief: { ...h.present.brief, title: '新分支' } });
  assert.equal(h.future.length, 0);
});
test('usage survives undo, redo, and failed-call bookkeeping without becoming an undo action', () => {
  let h = createHistory(workspaceFromDeck(makeSampleDeck()));
  const record = { id: 'charged', at: new Date().toISOString(), operation: 'rewrite' as const, simulated: false, quotaConsumed: 2.5 };
  h = commitHistory(h, { ...h.present, deck: { ...h.present.deck!, title: '改写后' }, usage: [record] });
  h = undoHistory(h);
  assert.deepEqual(h.present.usage, [record]);
  assert.deepEqual(h.present.deck?.usage, [record]);
  h = replacePresent(h, { ...h.present, usage: [record, { ...record, id: 'failed-call' }] });
  h = redoHistory(h);
  assert.equal(h.present.deck?.title, '改写后');
  assert.equal(h.present.usage.length, 2);
  assert.equal(h.present.deck?.usage.length, 2);
  h = commitHistory(h, { ...h.present, usage: [], brief: { ...h.present.brief, title: '旧快照回写' } });
  assert.equal(h.present.usage.length, 2, 'stale snapshots cannot erase a paid call');
  assert.equal(undoHistory(h).present.usage.length, 2);
});
test('history is bounded, navigation does not add entries, and reload starts a new history', () => {
  let h = createHistory(emptyWorkspace());
  for (let i = 0; i < 70; i++) h = commitHistory(h, { ...h.present, brief: { ...h.present.brief, title: String(i) } });
  assert.equal(h.past.length, HISTORY_LIMIT);
  h = replacePresent(h, { ...h.present, stage: 'brief' });
  assert.equal(h.past.length, HISTORY_LIMIT);
  const reload = createHistory(h.present);
  assert.equal(reload.past.length, 0);
  assert.deepEqual(undoHistory(reload).present, h.present);
});
