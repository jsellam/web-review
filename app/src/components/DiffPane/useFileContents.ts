import { useEffect, useState } from 'react';
import type { ReviewApi } from '../../api/client.js';
import type { FileEntry } from '../../../../src/shared/types.js';

export interface FileContents {
  old: string | null;
  next: string | null;
  loading: boolean;
  error: string | null;
}

const IDLE: FileContents = { old: null, next: null, loading: false, error: null };

/**
 * Fetches both sides of one file, and only once the section is open. A 500-file
 * review therefore loads instantly and pays for content only where you look.
 */
export function useFileContents(
  api: ReviewApi,
  file: FileEntry,
  enabled: boolean,
): FileContents {
  const [state, setState] = useState<FileContents>(IDLE);
  const oldPath = file.oldPath ?? file.path;

  useEffect(() => {
    if (!enabled) {
      setState(IDLE);
      return;
    }

    let cancelled = false;
    setState({ ...IDLE, loading: true });

    Promise.all([api.getFile(oldPath, 'old'), api.getFile(file.path, 'new')])
      .then(([older, newer]) => {
        if (cancelled) return;
        setState({ old: older ?? '', next: newer ?? '', loading: false, error: null });
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setState({ ...IDLE, error: error.message });
      });

    return () => {
      cancelled = true;
    };
    // `api` is intentionally excluded: it is a stable reference for the life of
    // the app, and keying the effect on its identity risks a render loop for
    // any caller that (like this hook's own test) constructs a fresh `api`
    // object per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, file.path, oldPath]);

  return state;
}
