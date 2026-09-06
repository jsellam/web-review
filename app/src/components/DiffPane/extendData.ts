import type { Draft } from '../../state/draft.js';
import type { Side, Thread } from '../../../../src/shared/types.js';

export interface LineData {
  threads: Thread[];
  draft: Draft | null;
}

// Shaped to match `DiffViewProps<T>['extendData']` in
// `@git-diff-view/react@0.1.7` (see `index.d.ts` and the compiled
// `DiffSplitExtendLine`/`DiffUnifiedExtendLine` lookups): each side is a flat
// map from line number straight to `{ data }` — there is no nested `lines`
// level. The brief guessed an extra `{ oldFile: { lines: { ... } } }` layer;
// that guess was wrong and is corrected here.
export interface ExtendData {
  oldFile: Record<number, { data: LineData }>;
  newFile: Record<number, { data: LineData }>;
}

/**
 * Group everything that should render under a line — existing threads and any
 * unsent draft — into the per-side, per-line shape the diff component expects.
 */
export function buildExtendData(
  threads: Thread[],
  drafts: Record<string, Draft>,
  filePath: string,
): ExtendData {
  const data: ExtendData = { oldFile: {}, newFile: {} };

  const at = (side: Side, line: number): LineData => {
    const lines = side === 'old' ? data.oldFile : data.newFile;
    const existing = lines[line];
    if (existing) return existing.data;

    const fresh: LineData = { threads: [], draft: null };
    lines[line] = { data: fresh };
    return fresh;
  };

  for (const thread of threads) {
    if (thread.file !== filePath) continue;
    at(thread.side, thread.anchor.line).threads.push(thread);
  }

  for (const draft of Object.values(drafts)) {
    if (draft.file !== filePath) continue;
    at(draft.side, draft.line).draft = draft;
  }

  return data;
}
