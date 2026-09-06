import { Collapse } from 'antd';
import { CommentThread } from './CommentThread.js';
import type { Thread } from '../../../../src/shared/types.js';

interface Props {
  threads: Thread[];
}

export function OutdatedThreads({ threads }: Props) {
  if (threads.length === 0) return null;

  return (
    <Collapse
      size="small"
      style={{ marginTop: 12 }}
      items={[
        {
          key: 'outdated',
          label: `${threads.length} outdated comment${threads.length === 1 ? '' : 's'}`,
          children: threads.map((thread) => (
            <CommentThread key={thread.id} thread={thread} />
          )),
        },
      ]}
    />
  );
}
