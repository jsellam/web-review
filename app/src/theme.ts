import { useEffect, useState } from 'react';

const QUERY = '(prefers-color-scheme: dark)';

export function useIsDark(): boolean {
  const [isDark, setIsDark] = useState(() => window.matchMedia?.(QUERY).matches ?? false);

  useEffect(() => {
    const media = window.matchMedia?.(QUERY);
    if (!media) return;

    const listener = (event: MediaQueryListEvent) => setIsDark(event.matches);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, []);

  return isDark;
}
