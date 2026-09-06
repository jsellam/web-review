import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useFileContents } from './useFileContents.js';
import type { ReviewApi } from '../../api/client.js';
import type { FileEntry } from '../../../../src/shared/types.js';

const file: FileEntry = {
  path: 'src/auth.ts',
  oldPath: 'src/auth.ts',
  status: 'modified',
  additions: 1,
  deletions: 1,
  binary: false,
};

const apiWith = (impl: ReviewApi['getFile']): ReviewApi => ({
  getSession: vi.fn(),
  getFile: impl,
  submit: vi.fn(),
});

describe('useFileContents', () => {
  it('fetches nothing while disabled, so collapsed files cost nothing', () => {
    const getFile = vi.fn();

    renderHook(() => useFileContents(apiWith(getFile), file, false));

    expect(getFile).not.toHaveBeenCalled();
  });

  it('fetches both sides once enabled', async () => {
    const getFile = vi.fn(async (_path: string, side: string) =>
      side === 'old' ? 'one\n' : 'two\n',
    );

    const { result } = renderHook(() => useFileContents(apiWith(getFile), file, true));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.old).toBe('one\n');
    expect(result.current.next).toBe('two\n');
    expect(getFile).toHaveBeenCalledTimes(2);
  });

  it('uses the old path when the file was renamed', async () => {
    const getFile = vi.fn(async () => 'x\n');
    const renamed: FileEntry = { ...file, path: 'src/new.ts', oldPath: 'src/old.ts', status: 'renamed' };

    const { result } = renderHook(() => useFileContents(apiWith(getFile), renamed, true));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getFile).toHaveBeenCalledWith('src/old.ts', 'old');
    expect(getFile).toHaveBeenCalledWith('src/new.ts', 'new');
  });

  it('treats a missing side as empty, which is how added files render', async () => {
    const getFile = vi.fn(async (_path: string, side: string) => (side === 'old' ? null : 'new\n'));
    const added: FileEntry = { ...file, oldPath: null, status: 'added' };

    const { result } = renderHook(() => useFileContents(apiWith(getFile), added, true));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.old).toBe('');
    expect(result.current.next).toBe('new\n');
  });

  it('reports an error instead of hanging', async () => {
    const getFile = vi.fn().mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() => useFileContents(apiWith(getFile), file, true));

    await waitFor(() => expect(result.current.error).toBe('boom'));
    expect(result.current.loading).toBe(false);
  });

  it('does not refetch when re-rendered with the same file', async () => {
    const getFile = vi.fn(async () => 'x\n');

    const { result, rerender } = renderHook(() => useFileContents(apiWith(getFile), file, true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender();

    expect(getFile).toHaveBeenCalledTimes(2);
  });
});
