import { useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  ConfigProvider,
  Layout,
  Result,
  Segmented,
  Space,
  Spin,
  Typography,
  theme,
} from 'antd';
import { useResolvedTheme } from './theme.js';
import { ThemeToggle } from './components/ThemeToggle/ThemeToggle.js';
import { FileTree } from './components/FileTree/FileTree.js';
import { countThreadsByFile } from './components/FileTree/tree.js';
import { FileSection } from './components/FileSection/FileSection.js';
import { SummaryPanel } from './components/SummaryPanel/SummaryPanel.js';
import { DiffPane, type ViewMode } from './components/DiffPane/index.js';
import { SubmitDrawer } from './components/SubmitDrawer/SubmitDrawer.js';
import { pendingCount, useDraftStore } from './state/draft.js';
import type { ReviewApi } from './api/client.js';
import type { NewComment, SessionPayload } from '../../src/shared/types.js';

interface Props {
  api: ReviewApi;
}

export function App({ api }: Props) {
  const resolved = useResolvedTheme();
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>('split');
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
      <Layout style={{ minHeight: '100vh' }}>
        <Layout.Header style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <Typography.Text strong style={{ color: '#fff' }}>web-review</Typography.Text>
          {session ? (
            <Space>
              <Typography.Text style={{ color: '#fff' }}>{session.baseLabel}</Typography.Text>
              <Typography.Text style={{ color: '#fff' }}>
                {session.files.length} files
              </Typography.Text>
            </Space>
          ) : null}
          <Segmented
            value={mode}
            onChange={(value) => setMode(value as ViewMode)}
            options={[
              { label: 'Split', value: 'split' },
              { label: 'Unified', value: 'unified' },
            ]}
          />
          <ThemeToggle />
          <Badge count={pending}>
            <Button type="primary" onClick={() => setDrawerOpen(true)}>
              Review
            </Button>
          </Badge>
        </Layout.Header>

        <Layout>
          <Layout.Sider width={280} theme="light" style={{ padding: 12, overflow: 'auto' }}>
            {session ? (
              <FileTree
                files={session.files}
                commentCounts={countThreadsByFile(session.threads)}
                onSelect={(path) =>
                  document.getElementById(`file-${path}`)?.scrollIntoView({ behavior: 'smooth' })
                }
              />
            ) : null}
          </Layout.Sider>

          <Layout.Content style={{ padding: 16 }}>
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
          </Layout.Content>
        </Layout>
      </Layout>

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
