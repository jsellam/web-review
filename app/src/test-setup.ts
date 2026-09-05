import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { useDraftStore } from './state/draft.js';

// vitest.config.ts does not set `globals: true`, so @testing-library/react's
// own auto-cleanup (which only fires when it finds a global `afterEach`)
// never registers. Without this, DOM from one test leaks into the next.
afterEach(() => {
  cleanup();
});

// useDraftStore is a module-level singleton shared across every test file.
// Reset it after each test so one test's draft state (viewed flags, drafted
// comments, ...) cannot leak into the next — the same isolation problem as
// the DOM leak above, for the store instead of the document.
afterEach(() => {
  useDraftStore.getState().reset();
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

// jsdom has no canvas backend, so HTMLCanvasElement#getContext('2d') always
// returns null (jsdom defines the method, it just can't implement it).
// @git-diff-view/react measures line-number gutter width with a canvas 2D
// context on mount, which would otherwise throw and take down the whole
// render tree in any test that mounts DiffPane. The exact width returned
// doesn't matter for tests — only that measuring doesn't crash.
HTMLCanvasElement.prototype.getContext = (() => ({
  font: '',
  measureText: (text: string) => ({ width: text.length * 7 }),
})) as unknown as typeof HTMLCanvasElement.prototype.getContext;
