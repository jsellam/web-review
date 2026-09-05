import { useEffect, useState } from 'react';
import type { GlobalToken } from 'antd';

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

/**
 * Feed the AntD palette to the diff component's CSS variables, so diff greens
 * and reds belong to the same design system as the rest of the shell.
 */
export function applyDiffTokens(token: GlobalToken): void {
  const root = document.documentElement.style;
  root.setProperty('--diff-add-bg', token.colorSuccessBg);
  root.setProperty('--diff-add-border', token.colorSuccessBorder);
  root.setProperty('--diff-del-bg', token.colorErrorBg);
  root.setProperty('--diff-del-border', token.colorErrorBorder);
  root.setProperty('--diff-gutter-bg', token.colorFillQuaternary);
  root.setProperty('--diff-text', token.colorText);
  root.setProperty('--diff-border', token.colorBorderSecondary);
}
