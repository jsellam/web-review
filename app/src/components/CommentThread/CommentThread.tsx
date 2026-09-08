import { useState } from 'react';
import { Avatar, Button, Card, List, Space, Tag, Tooltip, Typography } from 'antd';
import { DeleteOutlined, RobotOutlined, UndoOutlined, UserOutlined } from '@ant-design/icons';
import { CommentComposer } from '../CommentComposer/CommentComposer.js';
import { deletionKey, useDraftStore } from '../../state/draft.js';
import type { Thread } from '../../../../src/shared/types.js';
import styles from './CommentThread.module.css';

interface Props {
  thread: Thread;
}

export function CommentThread({ thread }: Props) {
  const [replying, setReplying] = useState(false);
  const stagedReply = useDraftStore((state) => state.replies[thread.id]);
  const stagedResolve = useDraftStore((state) => state.resolved[thread.id]);
  const deletions = useDraftStore((state) => state.deletions);
  const setReply = useDraftStore((state) => state.setReply);
  const setResolved = useDraftStore((state) => state.setResolved);
  const setDeleted = useDraftStore((state) => state.setDeleted);
  const setThreadDeleted = useDraftStore((state) => state.setThreadDeleted);

  const resolved = stagedResolve ?? thread.status === 'resolved';
  const isDeleted = (index: number) => deletions[deletionKey(thread.id, index)] !== undefined;

  // Deleting every message deletes the thread: the server drops a thread it has
  // emptied, so say so up front rather than letting it vanish on submit.
  const wholeThread =
    thread.messages.length > 0 && thread.messages.every((_, index) => isDeleted(index));

  return (
    <Card size="small" style={{ margin: '8px 0' }}>
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Space>
          {thread.status === 'outdated' ? <Tag color="orange">Outdated</Tag> : null}
          {thread.status === 'resolved' ? <Tag color="green">Resolved</Tag> : null}
          {stagedResolve === true ? <Tag color="blue">Will be resolved</Tag> : null}
          {stagedResolve === false ? <Tag color="blue">Will be reopened</Tag> : null}
          {wholeThread ? <Tag color="red">Will be deleted</Tag> : null}
        </Space>

        <List
          size="small"
          dataSource={thread.messages}
          renderItem={(message, index) => {
            const gone = isDeleted(index);

            return (
              <List.Item
                actions={[
                  <Tooltip
                    key="delete"
                    title={gone ? 'Keep this comment after all' : 'Delete this comment'}
                  >
                    <Button
                      type="text"
                      size="small"
                      aria-label={`${gone ? 'Restore' : 'Delete'} message ${index + 1}`}
                      icon={gone ? <UndoOutlined /> : <DeleteOutlined />}
                      danger={!gone}
                      onClick={() => setDeleted(thread.id, index, !gone)}
                    />
                  </Tooltip>,
                ]}
              >
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
                  description={
                    <Typography.Paragraph className={gone ? styles.deleted : undefined}>
                      {message.body}
                    </Typography.Paragraph>
                  }
                />
              </List.Item>
            );
          }}
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
            {/*
              Replying to, or resolving, a thread that is on its way out would
              be sent to the server and then thrown away with the thread. Only
              the way back is offered while the whole thread is staged.
            */}
            {wholeThread ? null : (
              <>
                <Button size="small" onClick={() => setReplying(true)}>
                  Reply
                </Button>
                <Button
                  size="small"
                  onClick={() => setResolved(thread.id, !resolved, thread.status === 'resolved')}
                >
                  {resolved ? 'Reopen' : 'Resolve'}
                </Button>
              </>
            )}
            <Button
              size="small"
              danger={!wholeThread}
              onClick={() => setThreadDeleted(thread.id, thread.messages.length, !wholeThread)}
            >
              {wholeThread ? 'Restore thread' : 'Delete thread'}
            </Button>
          </Space>
        )}
      </Space>
    </Card>
  );
}
