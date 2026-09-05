import { render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
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
  submit: vi.fn().mockResolvedValue(undefined),
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

    expect(await screen.findByText('auth.ts (1)')).toBeInTheDocument();
  });

  it('surfaces a session failure instead of spinning forever', async () => {
    const failing: ReviewApi = { ...api, getSession: vi.fn().mockRejectedValue(new Error('invalid token')) };

    render(<App api={failing} />);

    expect(await screen.findByText('invalid token')).toBeInTheDocument();
  });
});
