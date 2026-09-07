import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider, useResolvedTheme } from './theme.js';
import { ThemeToggle } from './components/ThemeToggle/ThemeToggle.js';

function Probe() {
  return <span data-testid="resolved">{useResolvedTheme()}</span>;
}

/** Replaces matchMedia with one whose `matches` we control and whose listener we can fire. */
function mockMatchMedia(matches: boolean) {
  const listeners = new Set<(event: { matches: boolean }) => void>();
  window.matchMedia = vi.fn().mockReturnValue({
    matches,
    addEventListener: (_: string, fn: (event: { matches: boolean }) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (event: { matches: boolean }) => void) => listeners.delete(fn),
  }) as unknown as typeof window.matchMedia;
  return (next: boolean) => act(() => listeners.forEach((fn) => fn({ matches: next })));
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
});

describe('theme', () => {
  it('follows the system in auto mode and sets no attribute', () => {
    mockMatchMedia(true);
    render(<ThemeProvider><Probe /></ThemeProvider>);

    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('reacts when the system preference changes while in auto mode', () => {
    const fire = mockMatchMedia(false);
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('resolved')).toHaveTextContent('light');

    fire(true);

    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
  });

  it('lets an explicit light choice win over a dark system preference', async () => {
    mockMatchMedia(true);
    render(<ThemeProvider><ThemeToggle /><Probe /></ThemeProvider>);

    await userEvent.click(screen.getByRole('radio', { name: /light/i }));

    expect(screen.getByTestId('resolved')).toHaveTextContent('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('remembers the choice across a remount', async () => {
    mockMatchMedia(false);
    const { unmount } = render(<ThemeProvider><ThemeToggle /><Probe /></ThemeProvider>);
    await userEvent.click(screen.getByRole('radio', { name: /dark/i }));
    unmount();

    render(<ThemeProvider><Probe /></ThemeProvider>);

    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
  });

  it('ignores a corrupt stored value instead of crashing', () => {
    localStorage.setItem('web-review:theme', 'chartreuse');
    mockMatchMedia(false);

    render(<ThemeProvider><Probe /></ThemeProvider>);

    expect(screen.getByTestId('resolved')).toHaveTextContent('light');
  });
});
