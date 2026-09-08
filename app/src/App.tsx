import { useEffect, useState, type CSSProperties } from 'react';
import { Alert, ConfigProvider, Result, Spin, Typography, theme } from 'antd';
import { useResolvedTheme } from './theme.js';
import { Segmented } from './components/Segmented/Segmented.js';
import { ThemeToggle } from './components/ThemeToggle/ThemeToggle.js';
import { FileTree } from './components/FileTree/FileTree.js';
import { Resizer } from './components/Resizer/Resizer.js';
import { countThreadsByFile } from './components/FileTree/tree.js';
import { FileSection } from './components/FileSection/FileSection.js';
import { SummaryPanel } from './components/SummaryPanel/SummaryPanel.js';
import { DiffPane, type ViewMode } from './components/DiffPane/index.js';
import { SubmitDrawer } from './components/SubmitDrawer/SubmitDrawer.js';
import { pendingCount, useDraftStore } from './state/draft.js';
import type { ReviewApi } from './api/client.js';
import type { NewComment, SessionPayload } from '../../src/shared/types.js';
import styles from './App.module.css';

/** Typed as ViewMode[] so Segmented's generic infers T = ViewMode. */
const MODE_OPTIONS: { value: ViewMode; label: string }[] = [
  { value: 'split', label: 'Split' },
  { value: 'unified', label: 'Unified' },
];

/** Sidebar width, in px: the default the shell grid also falls back to, and its bounds. */
const SIDEBAR_DEFAULT = 280;
const SIDEBAR_MIN = 160;
const SIDEBAR_MAX = 640;

interface Props {
  api: ReviewApi;
}

export function App({ api }: Props) {
  const resolved = useResolvedTheme();
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>('split');
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [done, setDone] = useState(false);
  const [unanchored, setUnanchored] = useState<NewComment[]>([]);
  const viewed = useDraftStore((state) => state.viewed);
  const setViewed = useDraftStore((state) => state.setViewed);
  const pending = useDraftStore(pendingCount);

  useEffect(() => {
    api.getSession().then(setSession, (e: Error) => setError(e.message));
  }, [api]);

  if (done) {
    return (
      <ConfigProvider theme={{ algorithm: resolved === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm }}>
        <Result
          status="success"
          title="Review submitted"
          subTitle="The agent has your feedback. You can close this tab."
        />
        {unanchored.length > 0 ? (
          <div style={{ maxWidth: 480, margin: '0 auto' }}>
            <Alert
              type="warning"
              showIcon
              message={`${unanchored.length} comment${unanchored.length === 1 ? '' : 's'} could not be placed`}
              description={
                <>
                  <Typography.Paragraph>
                    The file changed in a way that made the line these comments were on
                    unrecognisable, so they were not attached to the review. The agent still
                    receives them.
                  </Typography.Paragraph>
                  <ul>
                    {unanchored.map((comment, index) => (
                      <li key={index}>
                        <Typography.Text code>
                          {comment.file}:{comment.line} ({comment.side})
                        </Typography.Text>{' '}
                        {comment.body}
                      </li>
                    ))}
                  </ul>
                </>
              }
            />
          </div>
        ) : null}
      </ConfigProvider>
    );
  }

  return (
    <ConfigProvider
      theme={{ algorithm: resolved === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm }}
    >
      <div
        className={styles.shell}
        style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}
      >
        <header className={styles.header}>
          <span className={styles.brand}>web-review</span>
          {session ? (
            <>
              <span className={styles.meta}>{session.baseLabel}</span>
              <span className={styles.meta}>{session.files.length} files</span>
            </>
          ) : null}

          <div className={styles.spacer} />

          {/*
            `onChange={setMode}` would not type-check: a setState dispatch also
            accepts an updater function, which widens Segmented's T to string.
          */}
          <Segmented
            legend="Diff view"
            name="mode"
            options={MODE_OPTIONS}
            value={mode}
            onChange={(next) => setMode(next)}
          />

          <ThemeToggle />

          {/*
            The counter is a sibling of the button, never a child: App.test.tsx
            queries the button with the anchored name /^review$/i, and nesting
            the count inside would make its accessible name "Review 1".
            `title` is what findByTitle('1') matches, the way antd's Badge did.
          */}
          <span className={styles.reviewGroup}>
            <button type="button" className={styles.review} onClick={() => setDrawerOpen(true)}>
              Review
            </button>
            {pending > 0 ? (
              <span className={styles.count} title={String(pending)} aria-hidden="true">
                {pending}
              </span>
            ) : null}
          </span>
        </header>

        <aside className={styles.sidebar}>
          {session ? (
            <FileTree
              files={session.files}
              commentCounts={countThreadsByFile(session.threads)}
              onSelect={(path) =>
                document.getElementById(`file-${path}`)?.scrollIntoView({ behavior: 'smooth' })
              }
            />
          ) : null}
        </aside>

        <Resizer
          width={sidebarWidth}
          min={SIDEBAR_MIN}
          max={SIDEBAR_MAX}
          onChange={setSidebarWidth}
          onReset={() => setSidebarWidth(SIDEBAR_DEFAULT)}
        />

        <main className={styles.content}>
          {error ? <Alert type="error" message={error} showIcon /> : null}
          {!session && !error ? <Spin /> : null}

          {session ? (
            <>
              <SummaryPanel
                summary={session.summary}
                threadCount={session.threads.filter((t) => t.status === 'open').length}
              />
              {session.files.map((file) => (
                <div id={`file-${file.path}`} key={file.path}>
                  <FileSection
                    file={file}
                    viewed={viewed[file.path] ?? false}
                    onViewedChange={(value) => setViewed(file.path, value)}
                  >
                    <DiffPane
                      api={api}
                      file={file}
                      mode={mode}
                      enabled={!(viewed[file.path] ?? false)}
                      threads={session.threads.filter((t) => t.file === file.path)}
                    />
                  </FileSection>
                </div>
              ))}
            </>
          ) : null}
        </main>
      </div>

      <SubmitDrawer
        api={api}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onSubmitted={(droppedComments) => {
          setUnanchored(droppedComments);
          setDrawerOpen(false);
          setDone(true);
        }}
      />
    </ConfigProvider>
  );
}
