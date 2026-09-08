import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SubmitDrawer } from './SubmitDrawer.js';
import { useDraftStore } from '../../state/draft.js';
import type { ReviewApi } from '../../api/client.js';

const apiWith = (submit: ReviewApi['submit']): ReviewApi => ({
  getSession: vi.fn(),
  getFile: vi.fn(),
  submit,
});

beforeEach(() => {
  useDraftStore.getState().reset();
});

describe('SubmitDrawer', () => {
  it('sends the drafted comments with the chosen verdict', async () => {
    const submit = vi.fn().mockResolvedValue({ unanchored: [] });
    useDraftStore.getState().setComment('src/a.ts', 'new', 12, 'rename this');

    render(<SubmitDrawer api={apiWith(submit)} open onClose={vi.fn()} onSubmitted={vi.fn()} />);

    await userEvent.click(screen.getByRole('radio', { name: /request changes/i }));
    await userEvent.type(screen.getByPlaceholderText(/overall comment/i), 'Two things.');
    await userEvent.click(screen.getByRole('button', { name: /submit review/i }));

    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith({
        verdict: 'request_changes',
        general: 'Two things.',
        newComments: [{ file: 'src/a.ts', side: 'new', line: 12, body: 'rename this' }],
        replies: [],
        resolved: [],
        reopened: [],
        deletions: [],
      }),
    );
  });

  it('defaults to comment and can approve with nothing drafted', async () => {
    const submit = vi.fn().mockResolvedValue({ unanchored: [] });

    render(<SubmitDrawer api={apiWith(submit)} open onClose={vi.fn()} onSubmitted={vi.fn()} />);

    await userEvent.click(screen.getByRole('radio', { name: /approve/i }));
    await userEvent.click(screen.getByRole('button', { name: /submit review/i }));

    await waitFor(() => expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: 'approve', newComments: [] }),
    ));
  });

  it('summarises what is about to be sent', () => {
    useDraftStore.getState().setComment('src/a.ts', 'new', 12, 'x');
    useDraftStore.getState().setReply('t1', 'y');

    render(<SubmitDrawer api={apiWith(vi.fn())} open onClose={vi.fn()} onSubmitted={vi.fn()} />);

    expect(screen.getByText(/1 comment, 1 reply/i)).toBeInTheDocument();
  });

  it('reports a failed submission and keeps the drafts', async () => {
    const submit = vi.fn().mockRejectedValue(new Error('invalid token'));
    useDraftStore.getState().setComment('src/a.ts', 'new', 12, 'x');

    render(<SubmitDrawer api={apiWith(submit)} open onClose={vi.fn()} onSubmitted={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /submit review/i }));

    expect(await screen.findByText('invalid token')).toBeInTheDocument();
    expect(useDraftStore.getState().comments).not.toEqual({});
  });

  it('tells the parent once the review is through', async () => {
    const onSubmitted = vi.fn();

    render(
      <SubmitDrawer
        api={apiWith(vi.fn().mockResolvedValue({ unanchored: [] }))}
        open
        onClose={vi.fn()}
        onSubmitted={onSubmitted}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /submit review/i }));

    await waitFor(() => expect(onSubmitted).toHaveBeenCalled());
  });

  it('treats a 409 (already submitted) as success rather than an error', async () => {
    const { ApiError } = await import('../../api/client.js');
    const submit = vi.fn().mockRejectedValue(new ApiError(409, 'already submitted'));
    const onSubmitted = vi.fn();

    render(<SubmitDrawer api={apiWith(submit)} open onClose={vi.fn()} onSubmitted={onSubmitted} />);
    await userEvent.click(screen.getByRole('button', { name: /submit review/i }));

    await waitFor(() => expect(onSubmitted).toHaveBeenCalled());
    expect(screen.queryByText('already submitted')).not.toBeInTheDocument();
  });

  it('disables the submit button while a request is in flight', async () => {
    let resolveSubmit: () => void = () => {};
    const submit = vi.fn(
      () =>
        new Promise<{ unanchored: [] }>((resolve) => {
          resolveSubmit = () => resolve({ unanchored: [] });
        }),
    );

    render(<SubmitDrawer api={apiWith(submit)} open onClose={vi.fn()} onSubmitted={vi.fn()} />);
    const button = screen.getByRole('button', { name: /submit review/i });
    await userEvent.click(button);

    expect(button).toBeDisabled();
    expect(submit).toHaveBeenCalledTimes(1);

    await userEvent.click(button);
    expect(submit).toHaveBeenCalledTimes(1);

    resolveSubmit();
  });
});
