import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CommentComposer } from './CommentComposer.js';

describe('CommentComposer', () => {
  it('submits the typed text', async () => {
    const onSubmit = vi.fn();
    render(<CommentComposer onSubmit={onSubmit} onCancel={vi.fn()} />);

    await userEvent.type(screen.getByRole('textbox'), 'extract a hook');
    await userEvent.click(screen.getByRole('button', { name: /add comment/i }));

    expect(onSubmit).toHaveBeenCalledWith('extract a hook');
  });

  it('will not submit an empty comment', async () => {
    const onSubmit = vi.fn();
    render(<CommentComposer onSubmit={onSubmit} onCancel={vi.fn()} />);

    expect(screen.getByRole('button', { name: /add comment/i })).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox'), '   ');
    expect(screen.getByRole('button', { name: /add comment/i })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('starts from an existing draft so editing keeps the text', () => {
    render(<CommentComposer initialValue="earlier draft" onSubmit={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByRole('textbox')).toHaveValue('earlier draft');
  });

  it('cancels', async () => {
    const onCancel = vi.fn();
    render(<CommentComposer onSubmit={vi.fn()} onCancel={onCancel} />);

    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(onCancel).toHaveBeenCalled();
  });
});
