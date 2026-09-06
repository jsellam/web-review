// Uses @git-diff-view/react 0.1.7 and @git-diff-view/file 0.1.7. Names below
// were verified against the packages' shipped `index.d.ts` — see Task 12,
// Step 1 in the report. Notably, `generateDiffFile` does NOT exist on
// `@git-diff-view/react` (or its actual dependency, `@git-diff-view/core`) —
// that version only builds a `DiffFile` from real GNU unified-diff hunks. The
// "give it two whole file contents" entry point lives in the sibling package
// `@git-diff-view/file`, which wraps `diff` (jsdiff) to compute the hunks for
// you and returns the same `DiffFile` class `@git-diff-view/react` renders.
// Everything else — `DiffView`, `DiffModeEnum`, `initSyntax`/`init`/
// `buildSplitDiffLines`/`buildUnifiedDiffLines`, and the widget/extend-data
// props Task 13 needs — matched the brief as written.
//
// Task 13 verified the exact shapes of the widget/extend-data props against
// `index.d.ts` and the compiled `dist/cjs/index.development.js`, and two of
// the brief's guesses did not hold:
//
// - `extendData` has no nested `lines` level: it is
//   `{ oldFile?: Record<string, { data: T }>, newFile?: Record<string, { data: T }> }`,
//   keyed directly by line number. See `./extendData.ts`.
// - `onAddWidgetClick` (on plain `DiffView`, as opposed to the unrelated
//   `DiffViewWithMultiSelect`) is `(lineNumber: number, side: SplitSide) => void`
//   — two positional arguments, not an options object — and `side` is the
//   numeric `SplitSide` enum (`old = 1, new = 2`), not the string `Side` type
//   this app uses elsewhere. More importantly, tracing the compiled source
//   showed the open/closed state of the widget line is tracked entirely
//   inside the library's own `useWidget` store: the "+" button always calls
//   its internal `onOpenAddWidget` regardless of whether `onAddWidgetClick` is
//   supplied. So no local `widget` state is needed here — `onAddWidgetClick`
//   is dropped, and `renderWidgetLine` alone is enough to render the composer
//   when the library decides a widget line is open, and to close it via the
//   `onClose` it hands us.
import { useMemo } from 'react';
import { Alert, Skeleton } from 'antd';
import { DiffModeEnum, DiffView, SplitSide } from '@git-diff-view/react';
import { generateDiffFile } from '@git-diff-view/file';
import '@git-diff-view/react/styles/diff-view.css';
import { useFileContents } from './useFileContents.js';
import { useResolvedTheme } from '../../theme.js';
import { buildExtendData } from './extendData.js';
import { CommentThread } from '../CommentThread/CommentThread.js';
import { CommentComposer } from '../CommentComposer/CommentComposer.js';
import { OutdatedThreads } from '../CommentThread/OutdatedThreads.js';
import { draftKey, useDraftStore } from '../../state/draft.js';
import type { ReviewApi } from '../../api/client.js';
import type { FileEntry, Side, Thread } from '../../../../src/shared/types.js';

export type ViewMode = 'split' | 'unified';

interface Props {
  api: ReviewApi;
  file: FileEntry;
  mode: ViewMode;
  enabled: boolean;
  threads: Thread[];
}

/** Language hint for the highlighter, derived from the extension. */
function languageOf(path: string): string {
  return path.split('.').pop()?.toLowerCase() ?? 'text';
}

/** The library's numeric `SplitSide` enum, translated to this app's `Side`. */
function sideOf(side: SplitSide): Side {
  return side === SplitSide.old ? 'old' : 'new';
}

export function DiffPane({ api, file, mode, enabled, threads }: Props) {
  const theme = useResolvedTheme();
  const { old: older, next: newer, loading, error } = useFileContents(api, file, enabled);
  const drafts = useDraftStore((state) => state.comments);
  const setComment = useDraftStore((state) => state.setComment);
  const removeComment = useDraftStore((state) => state.removeComment);

  const positioned = useMemo(() => threads.filter((thread) => thread.status !== 'outdated'), [threads]);
  const outdated = useMemo(() => threads.filter((thread) => thread.status === 'outdated'), [threads]);

  // One entry per line that has either a thread or a draft, in the shape the
  // library expects: see `./extendData.ts` for the verified shape.
  const extendData = useMemo(
    () => buildExtendData(positioned, drafts, file.path),
    [positioned, drafts, file.path],
  );

  const diffFile = useMemo(() => {
    if (older === null || newer === null) return null;

    const language = languageOf(file.path);
    const instance = generateDiffFile(
      file.oldPath ?? file.path,
      older,
      file.path,
      newer,
      language,
      language,
    );
    instance.init();
    instance.buildSplitDiffLines();
    instance.buildUnifiedDiffLines();
    return instance;
  }, [file.oldPath, file.path, older, newer]);

  if (error) return <Alert type="error" message={error} showIcon />;
  if (loading || !diffFile) return <Skeleton active paragraph={{ rows: 4 }} />;

  return (
    <>
      <DiffView
        diffFile={diffFile}
        diffViewHighlight
        diffViewWrap={false}
        diffViewTheme={theme}
        diffViewMode={mode === 'split' ? DiffModeEnum.Split : DiffModeEnum.Unified}
        diffViewAddWidget
        extendData={extendData}
        renderExtendLine={({ data }) => {
          // In split mode, this row is rendered once per side of a line, and
          // the library calls `renderExtendLine` for BOTH sides whenever
          // *either* side has extend data — the side with nothing of its own
          // gets `data: undefined` (confirmed against
          // `InternalDiffSplitExtendLine$1` in the compiled source: `hasExtend`
          // is an OR across both sides, but `data` passed to the callback is
          // only the current side's entry). The brief's guess destructured
          // `data` and used it directly, which throws here.
          if (!data) return null;
          return (
            <div style={{ padding: '0 16px' }}>
              {data.threads.map((thread) => (
                <CommentThread key={thread.id} thread={thread} />
              ))}
              {data.draft ? (
                <CommentComposer
                  initialValue={data.draft.body}
                  submitLabel="Update comment"
                  onSubmit={(body) => setComment(file.path, data.draft!.side, data.draft!.line, body)}
                  onCancel={() => removeComment(draftKey(file.path, data.draft!.side, data.draft!.line))}
                />
              ) : null}
            </div>
          );
        }}
        renderWidgetLine={({ side, lineNumber, onClose }) => (
          <div style={{ padding: '0 16px' }}>
            <CommentComposer
              onSubmit={(body) => {
                setComment(file.path, sideOf(side), lineNumber, body);
                onClose();
              }}
              onCancel={onClose}
            />
          </div>
        )}
      />
      <OutdatedThreads threads={outdated} />
    </>
  );
}
