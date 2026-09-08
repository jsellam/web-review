import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { useDraftStore } from './state/draft.js';
import type { ReviewApi } from './api/client.js';
import type { SessionPayload } from '../../src/shared/types.js';

const session: SessionPayload = {
  round: 1,
  base: 'HEAD',
  baseLabel: 'working tree vs HEAD',
  summary: 'Add **JWT** refresh.',
  files: [
    { path: 'src/auth.ts', oldPath: 'src/auth.ts', status: 'modified',
      additions: 48, deletions: 12, binary: false },
  ],
  threads: [
    { id: 't1', file: 'src/auth.ts', side: 'new',
      anchor: { line: 2, content: 'x', contextHash: 'h' },
      status: 'open', messages: [] },
  ],
};

const api: ReviewApi = {
  getSession: vi.fn().mockResolvedValue(session),
  getFile: vi.fn().mockResolvedValue(null),
  submit: vi.fn().mockResolvedValue({ unanchored: [] }),
};

beforeAll(() => {
  // jsdom has no matchMedia; AntD and useIsDark both call it.
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as unknown as typeof window.matchMedia;
});

describe('App', () => {
  it('renders the base label, the summary and the file list', async () => {
    render(<App api={api} />);

    expect(await screen.findByText('working tree vs HEAD')).toBeInTheDocument();
    expect(screen.getByText('JWT')).toBeInTheDocument();
    expect(screen.getByText('src/auth.ts')).toBeInTheDocument();
    expect(screen.getByText('1 point to confirm')).toBeInTheDocument();
  });

  it('shows the open-thread count next to the file in the tree', async () => {
    render(<App api={api} />);

    expect(await screen.findByTitle('1 open comment')).toHaveTextContent('1');
  });

  it('badges each file in the tree with its status', async () => {
    render(<App api={api} />);

    expect(await screen.findByRole('img', { name: 'modified' })).toHaveTextContent('m');
  });

  it('surfaces a session failure instead of spinning forever', async () => {
    const failing: ReviewApi = { ...api, getSession: vi.fn().mockRejectedValue(new Error('invalid token')) };

    render(<App api={failing} />);

    expect(await screen.findByText('invalid token')).toBeInTheDocument();
  });

  it('counts pending drafts on the Review button and ends on a success screen', async () => {
    useDraftStore.getState().reset();
    useDraftStore.getState().setComment('src/auth.ts', 'new', 2, 'rename this');

    render(<App api={api} />);

    expect(await screen.findByTitle('1')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^review$/i }));
    await userEvent.click(screen.getByRole('button', { name: /submit review/i }));

    expect(await screen.findByText('Review submitted')).toBeInTheDocument();
  });

  it('warns about comments the server could not anchor, instead of hiding the loss', async () => {
    useDraftStore.getState().reset();
    useDraftStore.getState().setComment('src/auth.ts', 'new', 2, 'rename this');
    const droppedApi: ReviewApi = {
      ...api,
      submit: vi.fn().mockResolvedValue({
        unanchored: [{ file: 'src/auth.ts', side: 'new', line: 2, body: 'rename this' }],
      }),
    };

    render(<App api={droppedApi} />);

    await userEvent.click(screen.getByRole('button', { name: /^review$/i }));
    await userEvent.click(screen.getByRole('button', { name: /submit review/i }));

    expect(await screen.findByText('Review submitted')).toBeInTheDocument();
    expect(screen.getByText(/1 comment could not be placed/i)).toBeInTheDocument();
    expect(screen.getByText(/rename this/)).toBeInTheDocument();
  });
});
