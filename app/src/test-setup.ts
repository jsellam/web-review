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

// jsdom has no ResizeObserver. @git-diff-view/react uses one (in
// useSyncHeight/useDomWidth) to track the diff container's size once it has
// real line content to lay out — a test that mounts DiffPane with non-empty
// file contents (unlike App.test.tsx's empty-string stub files) reaches this
// path and would otherwise crash with "ResizeObserver is not defined". A
// no-op observer is enough: layout measurements are irrelevant in jsdom.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// jsdom never lays out the page, so getBoundingClientRect always returns all
// zeros. @git-diff-view/react measures its extend/widget row's container
// width this way and only renders the row's real content once that width is
// greater than zero (`width > 0 && content`) — with the real jsdom behaviour,
// a comment thread or the comment composer would never appear in a test no
// matter how long it waited. A fixed non-zero width is enough to satisfy
// that gate; the exact number is never asserted on.
Element.prototype.getBoundingClientRect = (() => ({
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  bottom: 0,
  right: 800,
  width: 800,
  height: 20,
  toJSON() {
    return {};
  },
})) as typeof Element.prototype.getBoundingClientRect;
