import type { WorkspaceDraft } from './types';

export const HISTORY_LIMIT = 50;
const GROUP_WINDOW_MS = 800;
export interface EditHistory {
  past: WorkspaceDraft[];
  present: WorkspaceDraft;
  future: WorkspaceDraft[];
  group?: string;
  at: number;
}

// Usage is an audit trail: rolling back content must never roll back consumed credits.
function withUsage(value: WorkspaceDraft, usage: WorkspaceDraft['usage']): WorkspaceDraft {
  return { ...value, usage, deck: value.deck ? { ...value.deck, usage } : null };
}
function retainUsage(history: EditHistory, value: WorkspaceDraft): WorkspaceDraft {
  const ids = new Set(history.present.usage.map(record => record.id));
  return withUsage(value, [...history.present.usage, ...value.usage.filter(record => !ids.has(record.id))]);
}
function contentKey(value: WorkspaceDraft) {
  const { usage: _usage, ...content } = value;
  if (!content.deck) return JSON.stringify(content);
  const { usage: _deckUsage, updatedAt: _updatedAt, ...deck } = content.deck;
  return JSON.stringify({ ...content, deck });
}
export function createHistory(value: WorkspaceDraft): EditHistory {
  return { past: [], present: structuredClone(value), future: [], at: 0 };
}
export function commitHistory(history: EditHistory, value: WorkspaceDraft, group?: string, now = Date.now()): EditHistory {
  const next = retainUsage(history, value);
  if (contentKey(history.present) === contentKey(next)) return { ...history, present: next };
  const coalesce = !!group && history.group === group && now - history.at < GROUP_WINDOW_MS && !history.future.length;
  return {
    past: coalesce ? history.past : [...history.past, history.present].slice(-HISTORY_LIMIT),
    present: next, future: [], group, at: now,
  };
}
export function replacePresent(history: EditHistory, value: WorkspaceDraft): EditHistory {
  return { ...history, present: retainUsage(history, value), group: undefined };
}
export function breakHistoryGroup(history: EditHistory): EditHistory {
  return history.group ? { ...history, group: undefined } : history;
}
export function undoHistory(history: EditHistory): EditHistory {
  const previous = history.past.at(-1);
  if (!previous) return history;
  return { past: history.past.slice(0, -1), present: withUsage(previous, history.present.usage), future: [history.present, ...history.future], at: 0 };
}
export function redoHistory(history: EditHistory): EditHistory {
  const next = history.future[0];
  if (!next) return history;
  return { past: [...history.past, history.present].slice(-HISTORY_LIMIT), present: withUsage(next, history.present.usage), future: history.future.slice(1), at: 0 };
}
