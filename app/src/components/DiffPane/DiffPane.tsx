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
import { useMemo } from 'react';
import { Alert, Skeleton } from 'antd';
import { DiffModeEnum, DiffView } from '@git-diff-view/react';
import { generateDiffFile } from '@git-diff-view/file';
import '@git-diff-view/react/styles/diff-view.css';
import { useFileContents } from './useFileContents.js';
import { useIsDark } from '../../theme.js';
import type { ReviewApi } from '../../api/client.js';
import type { FileEntry } from '../../../../src/shared/types.js';

export type ViewMode = 'split' | 'unified';

interface Props {
  api: ReviewApi;
  file: FileEntry;
  mode: ViewMode;
  enabled: boolean;
}

/** Language hint for the highlighter, derived from the extension. */
function languageOf(path: string): string {
  return path.split('.').pop()?.toLowerCase() ?? 'text';
}

export function DiffPane({ api, file, mode, enabled }: Props) {
  const isDark = useIsDark();
  const { old: older, next: newer, loading, error } = useFileContents(api, file, enabled);

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
    <DiffView
      diffFile={diffFile}
      diffViewHighlight
      diffViewWrap={false}
      diffViewTheme={isDark ? 'dark' : 'light'}
      diffViewMode={mode === 'split' ? DiffModeEnum.Split : DiffModeEnum.Unified}
    />
  );
}
