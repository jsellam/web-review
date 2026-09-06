import { describe, expect, it } from 'vitest';
import {
  abortedResult,
  errorResult,
  noChangesResult,
  pendingResult,
  submittedResult,
} from './result.js';
import type { ReviewState } from '../../shared/types.js';

const state: ReviewState = {
  version: 1,
  round: 2,
  threads: [
    {
      id: 't1',
      file: 'a.ts',
      side: 'new',
      anchor: { line: 1, content: 'x', contextHash: 'abc' },
      status: 'open',
      messages: [{ author: 'user', round: 1, body: 'fix', at: '2026-09-04T10:00:00.000Z' }],
    },
  ],
};

describe('submittedResult', () => {
  it('carries the verdict, round, general comment and every thread', () => {
    expect(submittedResult(state, 'request_changes', 'two things')).toEqual({
      status: 'submitted',
      verdict: 'request_changes',
      round: 2,
      general: 'two things',
      threads: state.threads,
    });
  });

  it('includes outdated and resolved threads, so the agent sees the whole picture', () => {
    const mixed: ReviewState = {
      ...state,
      threads: [
        { ...state.threads[0]!, id: 't1', status: 'outdated' },
        { ...state.threads[0]!, id: 't2', status: 'resolved' },
      ],
    };

    expect(submittedResult(mixed, 'approve', '').threads).toHaveLength(2);
  });

  it('omits unanchored entirely when nothing was dropped', () => {
    expect(submittedResult(state, 'approve', '')).not.toHaveProperty('unanchored');
  });

  it('carries comments that could not be anchored, so the agent learns they were dropped', () => {
    const unanchored = [{ file: 'b.ts', side: 'new' as const, line: 42, body: 'orphaned' }];

    expect(submittedResult(state, 'comment', '', unanchored)).toMatchObject({ unanchored });
  });
});

describe('the non-submitted results', () => {
  it('pending carries the URL to reopen', () => {
    expect(pendingResult('http://127.0.0.1:1/?t=x')).toEqual({
      status: 'pending',
      url: 'http://127.0.0.1:1/?t=x',
    });
  });

  it('no_changes needs no other field', () => {
    expect(noChangesResult()).toEqual({ status: 'no_changes' });
  });

  it('aborted is distinct from approval', () => {
    expect(abortedResult().status).toBe('aborted');
    expect(abortedResult().verdict).toBeUndefined();
  });

  it('error carries a message', () => {
    expect(errorResult('not a git repository')).toEqual({
      status: 'error',
      message: 'not a git repository',
    });
  });
});
