import { Alert, Card, Typography } from 'antd';
import Markdown from 'react-markdown';

interface Props {
  summary: string;
  threadCount: number;
}

export function SummaryPanel({ summary, threadCount }: Props) {
  if (!summary && threadCount === 0) return null;

  return (
    <Card size="small" style={{ marginBottom: 16 }}>
      {summary ? (
        <Typography>
          <Markdown>{summary}</Markdown>
        </Typography>
      ) : null}

      {threadCount > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={`${threadCount} point${threadCount === 1 ? '' : 's'} to confirm`}
          style={{ marginTop: summary ? 12 : 0 }}
        />
      ) : null}
    </Card>
  );
}
