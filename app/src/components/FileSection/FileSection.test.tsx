import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FileSection } from './FileSection.js';
import type { FileEntry } from '../../../../src/shared/types.js';

const file: FileEntry = {
  path: 'src/auth.ts',
  oldPath: 'src/auth.ts',
  status: 'modified',
  additions: 48,
  deletions: 12,
  binary: false,
};

describe('FileSection', () => {
  it('shows the path and the line counts', () => {
    render(<FileSection file={file} viewed={false} onViewedChange={vi.fn()}>body</FileSection>);

    expect(screen.getByText('src/auth.ts')).toBeInTheDocument();
    expect(screen.getByText('+48')).toBeInTheDocument();
    expect(screen.getByText('-12')).toBeInTheDocument();
  });

  it('renders its children when expanded', () => {
    render(<FileSection file={file} viewed={false} onViewedChange={vi.fn()}>diff body</FileSection>);

    expect(screen.getByText('diff body')).toBeInTheDocument();
  });

  it('hides the body once marked viewed', async () => {
    const onViewedChange = vi.fn();
    const { rerender } = render(
      <FileSection file={file} viewed={false} onViewedChange={onViewedChange}>diff body</FileSection>,
    );

    await userEvent.click(screen.getByRole('checkbox', { name: /viewed/i }));
    expect(onViewedChange).toHaveBeenCalledWith(true);

    rerender(
      <FileSection file={file} viewed onViewedChange={onViewedChange}>diff body</FileSection>,
    );
    expect(screen.queryByText('diff body')).not.toBeInTheDocument();
  });

  it('starts collapsed for a very large file', () => {
    const big: FileEntry = { ...file, additions: 900, deletions: 200 };

    render(<FileSection file={big} viewed={false} onViewedChange={vi.fn()}>diff body</FileSection>);

    expect(screen.queryByText('diff body')).not.toBeInTheDocument();
  });

  it('says so instead of rendering a diff for a binary file', () => {
    render(
      <FileSection file={{ ...file, binary: true }} viewed={false} onViewedChange={vi.fn()}>
        diff body
      </FileSection>,
    );

    expect(screen.getByText(/binary file not shown/i)).toBeInTheDocument();
    expect(screen.queryByText('diff body')).not.toBeInTheDocument();
  });
});
