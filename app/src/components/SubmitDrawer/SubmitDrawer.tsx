import { useState } from 'react';
import { Alert, Button, Drawer, Input, Radio, Space, Typography } from 'antd';
import { buildSubmit, useDraftStore } from '../../state/draft.js';
import { ApiError, type ReviewApi } from '../../api/client.js';
import type { NewComment, Verdict } from '../../../../src/shared/types.js';

interface Props {
  api: ReviewApi;
  open: boolean;
  onClose(): void;
  /** `unanchored` lists any new comments the server could not place on a line. */
  onSubmitted(unanchored: NewComment[]): void;
}

function describeDrafts(comments: number, replies: number, toggles: number): string {
  const parts = [
    comments > 0 ? `${comments} comment${comments === 1 ? '' : 's'}` : null,
    replies > 0 ? `${replies} repl${replies === 1 ? 'y' : 'ies'}` : null,
    toggles > 0 ? `${toggles} thread update${toggles === 1 ? '' : 's'}` : null,
  ].filter(Boolean);

  return parts.length === 0 ? 'No pending comments' : parts.join(', ');
}

export function SubmitDrawer({ api, open, onClose, onSubmitted }: Props) {
  const [verdict, setVerdict] = useState<Verdict>('comment');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const general = useDraftStore((state) => state.general);
  const setGeneral = useDraftStore((state) => state.setGeneral);
  const comments = useDraftStore((state) => state.comments);
  const replies = useDraftStore((state) => state.replies);
  const resolved = useDraftStore((state) => state.resolved);

  const send = async () => {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      const { unanchored } = await api.submit(buildSubmit(useDraftStore.getState(), verdict));
      onSubmitted(unanchored);
    } catch (cause) {
      // The server rejects a second submission with 409, because re-applying
      // drafts twice would duplicate the reviewer's threads. If we get here,
      // the review already landed once — that is a success from this page's
      // point of view, not a failure to report. A retry after 409 cannot
      // recover which comments (if any) were unanchored the first time, but
      // that response is long gone by now regardless.
      if (cause instanceof ApiError && cause.status === 409) {
        onSubmitted([]);
        return;
      }
      setError(cause instanceof Error ? cause.message : 'submission failed');
    } finally {
      setSending(false);
    }
  };

  return (
    <Drawer title="Submit review" open={open} onClose={onClose} width={420}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Typography.Text type="secondary">
          {describeDrafts(
            Object.keys(comments).length,
            Object.keys(replies).length,
            Object.keys(resolved).length,
          )}
        </Typography.Text>

        <Input.TextArea
          rows={4}
          value={general}
          placeholder="Overall comment (optional)"
          onChange={(event) => setGeneral(event.target.value)}
        />

        <Radio.Group value={verdict} onChange={(event) => setVerdict(event.target.value)}>
          <Space direction="vertical">
            <Radio value="approve">Approve</Radio>
            <Radio value="request_changes">Request changes</Radio>
            <Radio value="comment">Comment</Radio>
          </Space>
        </Radio.Group>

        {error ? <Alert type="error" message={error} showIcon /> : null}

        <Button type="primary" loading={sending} disabled={sending} onClick={() => void send()}>
          Submit review
        </Button>
      </Space>
    </Drawer>
  );
}
