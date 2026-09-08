import { useState } from 'react';
import { Button, Card, Space, Typography } from 'antd';
import { CommentComposer } from '../CommentComposer/CommentComposer.js';
import { draftKey, useDraftStore, type Draft } from '../../state/draft.js';

interface Props {
  draft: Draft;
}

/**
 * A comment the reviewer has written but not submitted yet, shown the way a
 * posted comment is: as a card you read, with Edit and Delete next to it.
 *
 * The editor is a mode this component enters, never the resting state — the
 * composer carries `autoFocus` and a primary button, so leaving a written
 * draft sitting in one reads as "you are still typing" long after the comment
 * was written. `editing` is local for the same reason: which line is being
 * edited is this card's business and nothing else's, and it must not survive
 * in the draft store, where it would be one more thing to clear on submit.
 */
export function DraftComment({ draft }: Props) {
  const [editing, setEditing] = useState(false);
  const setComment = useDraftStore((state) => state.setComment);
  const removeComment = useDraftStore((state) => state.removeComment);

  if (editing) {
    return (
      <CommentComposer
        initialValue={draft.body}
        submitLabel="Save comment"
        onSubmit={(body) => {
          setComment(draft.file, draft.side, draft.line, body);
          setEditing(false);
        }}
        // Cancel leaves the editor, it does not throw the comment away —
        // Delete is right there on the card and says what it does.
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <Card size="small" type="inner" title="Your comment (not sent yet)" style={{ margin: '8px 0' }}>
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Typography.Paragraph style={{ marginBottom: 0 }}>{draft.body}</Typography.Paragraph>
        <Space>
          <Button size="small" onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button
            size="small"
            danger
            onClick={() => removeComment(draftKey(draft.file, draft.side, draft.line))}
          >
            Delete
          </Button>
        </Space>
      </Space>
    </Card>
  );
}
