import { useState } from 'react';
import { Button, Input, Space } from 'antd';

interface Props {
  initialValue?: string;
  placeholder?: string;
  submitLabel?: string;
  onSubmit(body: string): void;
  onCancel(): void;
}

export function CommentComposer({
  initialValue = '',
  placeholder = 'Leave a comment',
  submitLabel = 'Add comment',
  onSubmit,
  onCancel,
}: Props) {
  const [value, setValue] = useState(initialValue);
  const empty = value.trim().length === 0;

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={8}>
      <Input.TextArea
        autoFocus
        rows={3}
        value={value}
        placeholder={placeholder}
        onChange={(event) => setValue(event.target.value)}
      />
      <Space>
        <Button type="primary" size="small" disabled={empty} onClick={() => onSubmit(value)}>
          {submitLabel}
        </Button>
        <Button size="small" onClick={onCancel}>
          Cancel
        </Button>
      </Space>
    </Space>
  );
}
