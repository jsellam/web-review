import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { CommentThread } from './CommentThread.js';
import { useDraftStore } from '../../state/draft.js';
import type { Thread } from '../../../../src/shared/types.js';

const thread: Thread = {
  id: 't1',
  file: 'src/auth.ts',
  side: 'new',
  anchor: { line: 42, content: 'const t = sign(u);', contextHash: 'h' },
  status: 'open',
  messages: [
    { author: 'user', round: 1, body: 'Extract into a hook.', at: '2026-09-04T10:00:00.000Z' },
    { author: 'agent', round: 2, body: 'Done: useAuthToken().', at: '2026-09-04T10:05:00.000Z' },
  ],
};

beforeEach(() => {
  useDraftStore.getState().reset();
});

describe('CommentThread', () => {
  it('shows every message with its author and round', () => {
    render(<CommentThread thread={thread} />);

    expect(screen.getByText('Extract into a hook.')).toBeInTheDocument();
    expect(screen.getByText('Done: useAuthToken().')).toBeInTheDocument();
    expect(screen.getByText(/you · round 1/i)).toBeInTheDocument();
    expect(screen.getByText(/agent · round 2/i)).toBeInTheDocument();
  });

  it('stages a reply in the draft store', async () => {
    render(<CommentThread thread={thread} />);

    await userEvent.click(screen.getByRole('button', { name: /reply/i }));
    await userEvent.type(screen.getByRole('textbox'), 'no, keep it');
    await userEvent.click(screen.getByRole('button', { name: /add reply/i }));

    expect(useDraftStore.getState().replies['t1']).toBe('no, keep it');
  });

  it('stages a resolve without mutating the thread', async () => {
    render(<CommentThread thread={thread} />);

    await userEvent.click(screen.getByRole('button', { name: /^resolve$/i }));

    expect(useDraftStore.getState().resolved['t1']).toBe(true);
    expect(screen.getByText(/will be resolved/i)).toBeInTheDocument();
  });

  it('offers reopen on an already-resolved thread', async () => {
    render(<CommentThread thread={{ ...thread, status: 'resolved' }} />);

    await userEvent.click(screen.getByRole('button', { name: /reopen/i }));

    expect(useDraftStore.getState().resolved['t1']).toBe(false);
  });

  it('clears the staged toggle when resolve is clicked and then undone', async () => {
    render(<CommentThread thread={thread} />);

    await userEvent.click(screen.getByRole('button', { name: /^resolve$/i }));
    expect(useDraftStore.getState().resolved['t1']).toBe(true);

    // The button now reads "Reopen" because the staged state is resolved.
    await userEvent.click(screen.getByRole('button', { name: /reopen/i }));

    expect(useDraftStore.getState().resolved).toEqual({});
    expect(screen.queryByText(/will be resolved/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/will be reopened/i)).not.toBeInTheDocument();
  });

  it('marks an outdated thread and still shows its messages', () => {
    render(<CommentThread thread={{ ...thread, status: 'outdated' }} />);

    expect(screen.getByText(/outdated/i)).toBeInTheDocument();
    expect(screen.getByText('Extract into a hook.')).toBeInTheDocument();
  });
});
