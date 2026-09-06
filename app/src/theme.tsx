import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type ThemeChoice = 'auto' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'web-review:theme';
const QUERY = '(prefers-color-scheme: dark)';

interface ThemeContextValue {
  choice: ThemeChoice;
  resolved: ResolvedTheme;
  setChoice(next: ThemeChoice): void;
}

const ThemeContext = createContext<ThemeContextValue>({
  choice: 'auto',
  resolved: 'light',
  setChoice: () => {},
});

function isChoice(value: unknown): value is ThemeChoice {
  return value === 'auto' || value === 'light' || value === 'dark';
}

/** Reading localStorage throws in a private window, so never let it take the app down. */
function readStored(): ThemeChoice {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isChoice(raw) ? raw : 'auto';
  } catch {
    return 'auto';
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(readStored);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.(QUERY).matches ?? false);

  // Only `matches` and add/removeEventListener are touched here: App.test.tsx
  // stubs matchMedia with an object that has nothing else on it.
  useEffect(() => {
    const media = window.matchMedia?.(QUERY);
    if (!media) return;

    const listener = (event: { matches: boolean }) => setSystemDark(event.matches);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, []);

  const resolved: ResolvedTheme =
    choice === 'auto' ? (systemDark ? 'dark' : 'light') : choice;

  // The attribute is what lets an explicit choice beat the media query in
  // tokens.css. Auto removes it, so the media query governs again.
  useEffect(() => {
    const root = document.documentElement;
    if (choice === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', choice);
  }, [choice]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      choice,
      resolved,
      setChoice: (next) => {
        setChoiceState(next);
        try {
          localStorage.setItem(STORAGE_KEY, next);
        } catch {
          // A private window refuses writes. The choice still applies for this session.
        }
      },
    }),
    [choice, resolved],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

/** Replaces the old `useIsDark()`. `@git-diff-view` takes its theme as a prop, not from CSS. */
export function useResolvedTheme(): ResolvedTheme {
  return useContext(ThemeContext).resolved;
}
