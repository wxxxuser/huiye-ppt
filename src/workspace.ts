import { assertSources, LIMITS, validateBrief, validateOutlineValue, validateStoredDeck, validateUsage } from './domain';
import type { Brief, Deck, SourceBlock, WorkspaceDraft } from './types';

export function emptyWorkspace(): WorkspaceDraft {
  return {
    schemaVersion: 2,
    brief: { title: '', audience: '', goal: '', slideCount: 6, source: '' },
    outlineBrief: null, sources: [], outline: null, deck: null,
    stage: 'brief', selected: 0, usage: [],
  };
}

/** Distinguish recoverable work from the untouched default form at startup. */
export function hasWorkspaceContent(workspace: WorkspaceDraft): boolean {
  if (workspace.outline || workspace.deck) return true;
  const brief = workspace.brief;
  const defaults = emptyWorkspace().brief;
  // Older releases prefilled these fields before the user entered any content.
  const legacyDefaults = { audience: '项目评审同事', goal: '说明项目成果，争取下一阶段支持' };
  return !!(brief.title.trim() || brief.source.trim())
    || (['audience', 'goal'] as const).some(field => {
      const value = brief[field].trim();
      return !!value && value !== legacyDefaults[field];
    })
    || brief.slideCount !== defaults.slideCount;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('草稿格式不正确。');
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, fields: readonly string[]): void {
  if (fields.some(field => !Object.hasOwn(value, field)) || Object.keys(value).some(field => !fields.includes(field))) {
    throw new Error('草稿字段缺失或包含未知字段。');
  }
}

/** Saving unfinished input is allowed; generation still uses validateBrief(). */
function partialBrief(value: unknown): Brief {
  const row = record(value);
  exactKeys(row, ['title', 'audience', 'goal', 'slideCount', 'source']);
  for (const [field, max] of [['title', LIMITS.title], ['audience', LIMITS.audience], ['goal', LIMITS.goal], ['source', LIMITS.sourceMax]] as const) {
    if (typeof row[field] !== 'string' || row[field].length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(row[field])) {
      throw new Error('材料输入格式不正确。');
    }
  }
  if (!Number.isInteger(row.slideCount) || (row.slideCount as number) < LIMITS.minSlides || (row.slideCount as number) > LIMITS.maxSlides) {
    throw new Error('生成页数必须为 4–10 页。');
  }
  return { title: row.title as string, audience: row.audience as string, goal: row.goal as string, source: row.source as string, slideCount: row.slideCount as number };
}

/** Legacy .huiye.json decks keep working; their first save upgrades the envelope. */
export function workspaceFromDeck(value: Deck): WorkspaceDraft {
  const deck = validateStoredDeck(value);
  if (!deck) throw new Error('文稿格式不正确，无法恢复草稿。');
  return {
    schemaVersion: 2, brief: { ...deck.brief }, outlineBrief: { ...deck.brief },
    sources: deck.sourceBlocks.map(source => ({ ...source })),
    outline: structuredClone(deck.outline), deck,
    stage: 'editor', selected: 0, usage: deck.usage.map(item => ({ ...item })),
  };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => sameValue(value, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}

/** Keep a mirrored outline in sync, without replacing an independently edited outline. */
export function applyDeckEdit(workspace: WorkspaceDraft, next: Deck): WorkspaceDraft {
  const previous = workspace.deck;
  const mirrored = !!previous
    && sameValue(workspace.outline, previous.outline)
    && sameValue(workspace.outlineBrief, previous.brief)
    && sameValue(workspace.sources, previous.sourceBlocks);
  if (!mirrored) return { ...workspace, deck: next };
  return {
    ...workspace, deck: next,
    outline: structuredClone(next.outline), outlineBrief: { ...next.brief },
    sources: next.sourceBlocks.map(source => ({ ...source })),
  };
}

export function validateWorkspace(value: unknown): WorkspaceDraft | null {
  try {
    const row = record(value);
    if (!Object.hasOwn(row, 'schemaVersion')) {
      const legacy = validateStoredDeck(value);
      return legacy ? workspaceFromDeck(legacy) : null;
    }
    exactKeys(row, ['schemaVersion', 'brief', 'outlineBrief', 'sources', 'outline', 'deck', 'stage', 'selected', 'usage']);
    if (row.schemaVersion !== 2) return null;
    const brief = partialBrief(row.brief);
    const outlineBrief = row.outlineBrief === null ? null : partialBrief(row.outlineBrief);
    if (outlineBrief && validateBrief(outlineBrief)) return null;
    if (!Array.isArray(row.sources)) return null;
    const sources: SourceBlock[] = row.sources.map(item => {
      const source = record(item);
      exactKeys(source, ['id', 'text']);
      if (typeof source.id !== 'string' || typeof source.text !== 'string') throw new Error('材料来源格式不正确。');
      return { id: source.id, text: source.text };
    });
    if (outlineBrief) assertSources(sources, outlineBrief);
    else if (sources.length || row.outline !== null) return null;
    // After manual page edits the outline mirrors the deck's actual page count;
    // the original brief keeps its independently bounded AI generation request.
    const outlineRow = row.outline === null ? null : record(row.outline);
    if (outlineRow && (!outlineBrief || !Array.isArray(outlineRow.slides))) return null;
    const outline = outlineRow && outlineBrief
      ? validateOutlineValue(outlineRow, { ...outlineBrief, slideCount: (outlineRow.slides as unknown[]).length }, sources, 'edited')
      : null;
    if (outline && (outline.slides.length < 1 || outline.slides.length > LIMITS.maxEditedSlides)) return null;
    const deck = row.deck === null ? null : validateStoredDeck(row.deck);
    if (row.deck !== null && !deck) return null;
    if (!['brief', 'outline', 'editor'].includes(row.stage as string)) return null;
    if ((row.stage === 'outline' && !outline) || (row.stage === 'editor' && !deck)) return null;
    if (!Number.isInteger(row.selected) || (row.selected as number) < 0
      || (deck ? (row.selected as number) >= deck.slides.length : row.selected !== 0)) return null;
    const usage = validateUsage(row.usage);
    // The workspace ledger is authoritative. Restoring older content cannot
    // restore an older billing snapshot embedded in that content's deck.
    if (deck) deck.usage = usage.map(item => ({ ...item }));
    return {
      schemaVersion: 2, brief, outlineBrief, sources, outline, deck,
      stage: row.stage as WorkspaceDraft['stage'], selected: row.selected as number, usage,
    };
  } catch { return null; }
}

/** Validate and detach the exact JSON value before enqueueing a storage write. */
export function workspaceSnapshot(value: WorkspaceDraft | Deck): WorkspaceDraft {
  const workspace = validateWorkspace(value);
  if (!workspace) throw new Error('草稿格式不正确，已暂停保存以保护已有内容。');
  return JSON.parse(JSON.stringify(workspace)) as WorkspaceDraft;
}
