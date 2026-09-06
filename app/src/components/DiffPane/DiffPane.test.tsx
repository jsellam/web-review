import { render, screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { DiffPane } from './DiffPane.js';
import type { ReviewApi } from '../../api/client.js';
import type { FileEntry, Thread } from '../../../../src/shared/types.js';

const OLD_CONTENT = 'export function sign() {\n  return 1;\n}\n';
const NEW_CONTENT = 'export function sign() {\n  return 2;\n}\n';

const file: FileEntry = {
  path: 'src/auth.ts',
  oldPath: 'src/auth.ts',
  status: 'modified',
  additions: 1,
  deletions: 1,
  binary: false,
};

const apiWith = (impl: ReviewApi['getFile']): ReviewApi => ({
  getSession: vi.fn(),
  getFile: impl,
  submit: vi.fn(),
});

const api = apiWith(async (_path, side) => (side === 'old' ? OLD_CONTENT : NEW_CONTENT));

const thread = (
  id: string,
  side: Thread['side'],
  line: number,
  content: string,
  body: string,
  status: Thread['status'] = 'open',
): Thread => ({
  id,
  file: 'src/auth.ts',
  side,
  anchor: { line, content, contextHash: 'h' },
  status,
  messages: [{ author: 'user', round: 1, body, at: '2026-09-04T10:00:00.000Z' }],
});

beforeAll(() => {
  // Same as App.test.tsx / test-setup.ts: AntD and useIsDark both call
  // matchMedia, which jsdom does not implement.
  window.matchMedia ??= (() => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

describe('DiffPane', () => {
  it('renders a thread\'s message under its anchored line (extendData -> renderExtendLine)', async () => {
    const threads = [thread('t1', 'new', 2, '  return 2;', 'return a token instead')];

    render(<DiffPane api={api} file={file} mode="split" enabled threads={threads} />);

    expect(await screen.findByText('return a token instead')).toBeInTheDocument();
  });

  it('does not throw when a split row has data on only one side (data: undefined on the other)', async () => {
    // A thread that exists on only the 'new' side means the library calls
    // renderExtendLine for the 'old' side of that same row with `data:
    // undefined` (extend data is per-side, but the row renders once either
    // side has something). DiffPane.tsx used to destructure `data` directly
    // there and throw, which would have taken this whole render down with it
    // — so simply completing this render at all is the regression check.
    const threads = [thread('t1', 'new', 2, '  return 2;', 'only on the new side')];

    render(<DiffPane api={api} file={file} mode="split" enabled threads={threads} />);

    expect(await screen.findByText('only on the new side')).toBeInTheDocument();
  });

  it('keeps a positioned thread in the diff body and an outdated one in the collapse', async () => {
    const threads = [
      thread('t1', 'new', 2, '  return 2;', 'live comment', 'open'),
      thread('t2', 'new', 99, 'long gone', 'stale comment', 'outdated'),
    ];

    render(<DiffPane api={api} file={file} mode="split" enabled threads={threads} />);

    await waitFor(() => expect(screen.getByText('live comment')).toBeInTheDocument());
    expect(screen.getByText(/1 outdated comment/i)).toBeInTheDocument();
  });

  it('keeps an old-side comment on a renamed file attached after the round trip', async () => {
    // Thread.file always stores the NEW path, even for an old-side comment
    // (see extendData.ts's `thread.file !== filePath` filter and the
    // server-side rename fix in files.ts/cli.ts) — the frontend never keys
    // threads by the old path, so this is really confirming that contract
    // holds end to end once the file itself is fetched from its old path.
    const renamed: FileEntry = {
      ...file,
      path: 'src/renamed.ts',
      oldPath: 'src/auth.ts',
      status: 'renamed',
    };
    const renameApi = apiWith(async (path, side) => {
      if (side === 'old') return path === 'src/auth.ts' ? OLD_CONTENT : null;
      return path === 'src/renamed.ts' ? NEW_CONTENT : null;
    });

    const threads: Thread[] = [
      {
        id: 't1',
        file: 'src/renamed.ts', // the new path, even though this is an old-side comment
        side: 'old',
        anchor: { line: 1, content: 'export function sign() {', contextHash: 'h' },
        status: 'open',
        messages: [
          { author: 'user', round: 1, body: 'old-side note on a renamed file', at: '2026-09-04T10:00:00.000Z' },
        ],
      },
    ];

    render(<DiffPane api={renameApi} file={renamed} mode="split" enabled threads={threads} />);

    expect(await screen.findByText('old-side note on a renamed file')).toBeInTheDocument();
  });
});

// Not covered here, and left as a manual check: a real click on the
// library's own "+" gutter button (jsdom cannot drive @git-diff-view/react's
// internal widget-open state the way a real browser interaction would), and
// whether the widget composer at DiffPane.tsx's renderWidgetLine — which has
// no `initialValue` and no stable `key`, and carries `autoFocus` — loses
// in-progress text when adding a draft on another line causes React to
// rebuild `extendData` and therefore remount the composer.
