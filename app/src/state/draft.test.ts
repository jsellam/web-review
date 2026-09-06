import { beforeEach, describe, expect, it } from 'vitest';
import { buildSubmit, draftKey, pendingCount, useDraftStore } from './draft.js';

beforeEach(() => {
  useDraftStore.getState().reset();
});

describe('draftKey', () => {
  it('identifies a comment position uniquely', () => {
    expect(draftKey('src/a.ts', 'new', 12)).toBe('src/a.ts:new:12');
    expect(draftKey('src/a.ts', 'old', 12)).not.toBe(draftKey('src/a.ts', 'new', 12));
  });
});

describe('the draft store', () => {
  it('adds, edits and removes a comment', () => {
    const store = useDraftStore.getState();

    store.setComment('src/a.ts', 'new', 12, 'first');
    expect(useDraftStore.getState().comments[draftKey('src/a.ts', 'new', 12)]?.body).toBe('first');

    useDraftStore.getState().setComment('src/a.ts', 'new', 12, 'second');
    expect(useDraftStore.getState().comments[draftKey('src/a.ts', 'new', 12)]?.body).toBe('second');

    useDraftStore.getState().removeComment(draftKey('src/a.ts', 'new', 12));
    expect(useDraftStore.getState().comments).toEqual({});
  });

  it('drops a comment set to an empty body, so a cleared box is not submitted', () => {
    useDraftStore.getState().setComment('src/a.ts', 'new', 12, 'x');
    useDraftStore.getState().setComment('src/a.ts', 'new', 12, '   ');

    expect(useDraftStore.getState().comments).toEqual({});
  });

  it('tracks replies and resolve toggles per thread', () => {
    useDraftStore.getState().setReply('t1', 'agreed');
    useDraftStore.getState().setResolved('t2', true);
    useDraftStore.getState().setResolved('t3', false);

    const state = useDraftStore.getState();
    expect(state.replies).toEqual({ t1: 'agreed' });
    expect(state.resolved).toEqual({ t2: true, t3: false });
  });

  it('clears a resolve toggle that is switched back to the thread\'s original state', () => {
    // t2 started open (original: false). Staging "resolve" then "un-resolve"
    // must leave no trace — not a `{ t2: false }` entry that still counts
    // toward the pending badge and still gets sent as a reopen.
    useDraftStore.getState().setResolved('t2', true, false);
    expect(useDraftStore.getState().resolved).toEqual({ t2: true });

    useDraftStore.getState().setResolved('t2', false, false);
    expect(useDraftStore.getState().resolved).toEqual({});
  });

  it('keeps a resolve toggle that lands on the opposite of the original state', () => {
    useDraftStore.getState().setResolved('t2', true, false);
    useDraftStore.getState().setResolved('t2', false, false);
    useDraftStore.getState().setResolved('t2', true, false);

    expect(useDraftStore.getState().resolved).toEqual({ t2: true });
  });

  it('remembers which files have been marked viewed', () => {
    useDraftStore.getState().setViewed('src/a.ts', true);

    expect(useDraftStore.getState().viewed['src/a.ts']).toBe(true);
  });
});

describe('pendingCount', () => {
  it('counts comments, replies and resolve toggles together', () => {
    useDraftStore.getState().setComment('src/a.ts', 'new', 1, 'a');
    useDraftStore.getState().setReply('t1', 'b');
    useDraftStore.getState().setResolved('t2', true);

    expect(pendingCount(useDraftStore.getState())).toBe(3);
  });

  it('drops back to zero once a resolve-only toggle is undone', () => {
    useDraftStore.getState().setResolved('t2', true, false);
    expect(pendingCount(useDraftStore.getState())).toBe(1);

    useDraftStore.getState().setResolved('t2', false, false);
    expect(pendingCount(useDraftStore.getState())).toBe(0);
  });

  it('ignores the general comment and viewed flags', () => {
    useDraftStore.getState().setGeneral('looks fine');
    useDraftStore.getState().setViewed('src/a.ts', true);

    expect(pendingCount(useDraftStore.getState())).toBe(0);
  });
});

describe('buildSubmit', () => {
  it('turns the store into the payload the server expects', () => {
    const store = useDraftStore.getState();
    store.setComment('src/a.ts', 'new', 12, 'rename this');
    useDraftStore.getState().setReply('t1', 'agreed');
    useDraftStore.getState().setResolved('t2', true);
    useDraftStore.getState().setResolved('t3', false);
    useDraftStore.getState().setGeneral('Two things.');

    expect(buildSubmit(useDraftStore.getState(), 'request_changes')).toEqual({
      verdict: 'request_changes',
      general: 'Two things.',
      newComments: [{ file: 'src/a.ts', side: 'new', line: 12, body: 'rename this' }],
      replies: [{ threadId: 't1', body: 'agreed' }],
      resolved: ['t2'],
      reopened: ['t3'],
    });
  });

  it('produces an empty payload when nothing was drafted', () => {
    expect(buildSubmit(useDraftStore.getState(), 'approve')).toEqual({
      verdict: 'approve',
      general: '',
      newComments: [],
      replies: [],
      resolved: [],
      reopened: [],
    });
  });
});
