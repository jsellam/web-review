import { useEffect, useState } from 'react';
import { Alert, ConfigProvider, Layout, Segmented, Space, Spin, Typography, theme } from 'antd';
import { useIsDark } from './theme.js';
import { FileTree } from './components/FileTree/FileTree.js';
import { countThreadsByFile } from './components/FileTree/tree.js';
import { FileSection } from './components/FileSection/FileSection.js';
import { SummaryPanel } from './components/SummaryPanel/SummaryPanel.js';
import { useDraftStore } from './state/draft.js';
import type { ReviewApi } from './api/client.js';
import type { SessionPayload } from '../../src/shared/types.js';

export type ViewMode = 'split' | 'unified';

interface Props {
  api: ReviewApi;
}

export function App({ api }: Props) {
  const isDark = useIsDark();
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>('split');
  const viewed = useDraftStore((state) => state.viewed);
  const setViewed = useDraftStore((state) => state.setViewed);

  useEffect(() => {
    api.getSession().then(setSession, (e: Error) => setError(e.message));
  }, [api]);

  return (
    <ConfigProvider
      theme={{ algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm }}
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
                      {/* Task 12 replaces this with the diff body. */}
                      <Typography.Text type="secondary">diff</Typography.Text>
                    </FileSection>
                  </div>
                ))}
              </>
            ) : null}
          </Layout.Content>
        </Layout>
      </Layout>
    </ConfigProvider>
  );
}
