import { useState, type ReactNode } from 'react';
import { Card, Checkbox, Empty, Space, Tag, Typography } from 'antd';
import { DownOutlined, RightOutlined } from '@ant-design/icons';
import type { FileEntry } from '../../../../src/shared/types.js';

/** Above this many changed lines a file starts collapsed, per the spec. */
const LARGE_FILE_LINES = 1000;

interface Props {
  file: FileEntry;
  viewed: boolean;
  onViewedChange(value: boolean): void;
  children: ReactNode;
}

export function FileSection({ file, viewed, onViewedChange, children }: Props) {
  const isLarge = file.additions + file.deletions > LARGE_FILE_LINES;
  const [collapsed, setCollapsed] = useState(isLarge);
  const open = !viewed && !collapsed;

  return (
    <Card
      size="small"
      style={{ marginBottom: 16, opacity: viewed ? 0.6 : 1 }}
      title={
        <Space>
          <span
            role="button"
            tabIndex={0}
            aria-label={collapsed ? 'Expand file' : 'Collapse file'}
            onClick={() => setCollapsed((value) => !value)}
            onKeyDown={(event) => event.key === 'Enter' && setCollapsed((value) => !value)}
          >
            {collapsed ? <RightOutlined /> : <DownOutlined />}
          </span>
          <Typography.Text strong>{file.path}</Typography.Text>
          {file.status === 'renamed' && file.oldPath ? (
            <Tag>renamed from {file.oldPath}</Tag>
          ) : null}
        </Space>
      }
      extra={
        <Space>
          <Typography.Text type="success">+{file.additions}</Typography.Text>
          <Typography.Text type="danger">-{file.deletions}</Typography.Text>
          <Checkbox checked={viewed} onChange={(e) => onViewedChange(e.target.checked)}>
            Viewed
          </Checkbox>
        </Space>
      }
    >
      {open
        ? file.binary
          ? <Empty description="Binary file not shown" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          : children
        : null}
    </Card>
  );
}
