import { useState } from 'react';
import { Avatar, Button, Card, List, Space, Tag, Typography } from 'antd';
import { RobotOutlined, UserOutlined } from '@ant-design/icons';
import { CommentComposer } from '../CommentComposer/CommentComposer.js';
import { useDraftStore } from '../../state/draft.js';
import type { Thread } from '../../../../src/shared/types.js';

interface Props {
  thread: Thread;
}

export function CommentThread({ thread }: Props) {
  const [replying, setReplying] = useState(false);
  const stagedReply = useDraftStore((state) => state.replies[thread.id]);
  const stagedResolve = useDraftStore((state) => state.resolved[thread.id]);
  const setReply = useDraftStore((state) => state.setReply);
  const setResolved = useDraftStore((state) => state.setResolved);

  const resolved = stagedResolve ?? thread.status === 'resolved';

  return (
    <Card size="small" style={{ margin: '8px 0' }}>
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Space>
          {thread.status === 'outdated' ? <Tag color="orange">Outdated</Tag> : null}
          {thread.status === 'resolved' ? <Tag color="green">Resolved</Tag> : null}
          {stagedResolve === true ? <Tag color="blue">Will be resolved</Tag> : null}
          {stagedResolve === false ? <Tag color="blue">Will be reopened</Tag> : null}
        </Space>

        <List
          size="small"
          dataSource={thread.messages}
          renderItem={(message) => (
            <List.Item>
              <List.Item.Meta
                avatar={
                  <Avatar
                    size="small"
                    icon={message.author === 'agent' ? <RobotOutlined /> : <UserOutlined />}
                  />
                }
                title={
                  <Typography.Text type="secondary">
                    {message.author === 'agent' ? 'agent' : 'you'} · round {message.round}
                  </Typography.Text>
                }
                description={<Typography.Paragraph>{message.body}</Typography.Paragraph>}
              />
            </List.Item>
          )}
        />

        {stagedReply ? (
          <Card size="small" type="inner" title="Your reply (not sent yet)">
            <Typography.Paragraph>{stagedReply}</Typography.Paragraph>
          </Card>
        ) : null}

        {replying ? (
          <CommentComposer
            initialValue={stagedReply ?? ''}
            submitLabel="Add reply"
            placeholder="Reply to this thread"
            onSubmit={(body) => {
              setReply(thread.id, body);
              setReplying(false);
            }}
            onCancel={() => setReplying(false)}
          />
        ) : (
          <Space>
            <Button size="small" onClick={() => setReplying(true)}>
              Reply
            </Button>
            <Button size="small" onClick={() => setResolved(thread.id, !resolved)}>
              {resolved ? 'Reopen' : 'Resolve'}
            </Button>
          </Space>
        )}
      </Space>
    </Card>
  );
}
