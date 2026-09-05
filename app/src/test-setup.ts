import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// vitest.config.ts does not set `globals: true`, so @testing-library/react's
// own auto-cleanup (which only fires when it finds a global `afterEach`)
// never registers. Without this, DOM from one test leaks into the next.
afterEach(() => {
  cleanup();
});

// jsdom has no matchMedia; AntD's ConfigProvider and useIsDark both call it.
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;
