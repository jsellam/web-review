import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applySubmission,
  emptyState,
  openRound,
  readState,
  stateDirFor,
  writeState,
  type LinesLookup,
} from './state.js';
import type { ReviewRequest, ReviewState, SubmitPayload } from '../../shared/types.js';

const AT = '2026-09-04T10:00:00.000Z';
const now = () => AT;

const request = (over: Partial<ReviewRequest> = {}): ReviewRequest => ({
  summary: '',
  base: 'auto',
  annotations: [],
  replies: [],
  ...over,
});

const submission = (over: Partial<SubmitPayload> = {}): SubmitPayload => ({
  verdict: 'request_changes',
  general: '',
  newComments: [],
  replies: [],
  resolved: [],
  reopened: [],
  deletions: [],
  ...over,
});

const lookupOf = (files: Record<string, string[]>): LinesLookup =>
  async (file) => files[file] ?? null;

describe('applySubmission deletions', () => {
  const lookup = lookupOf({ 'a.ts': ['one', 'two'] });

  const withMessages = (...bodies: string[]): ReviewState => ({
    version: 1,
    round: 2,
    threads: [
      {
        id: 't1',
        file: 'a.ts',
        side: 'new',
        anchor: { line: 1, content: 'one', contextHash: 'h' },
        status: 'open',
        messages: bodies.map((body, index) => ({
          author: index % 2 === 0 ? ('agent' as const) : ('user' as const),
          round: 1,
          body,
          at: 'now',
        })),
      },
    ],
  });

  it('removes the addressed message and leaves the rest of the thread alone', async () => {
    const { state } = await applySubmission(
      withMessages('agent note', 'my reply'),
      submission({ deletions: [{ threadId: 't1', index: 0 }] }),
      lookup,
    );

    expect(state.threads[0]?.messages.map((m) => m.body)).toEqual(['my reply']);
  });

  it("deletes an agent's comment as readily as the reviewer's own", async () => {
    const { state } = await applySubmission(
      withMessages('agent note'),
      submission({ deletions: [{ threadId: 't1', index: 0 }] }),
      lookup,
    );

    expect(state.threads).toEqual([]);
  });

  it('drops a thread once every one of its messages is deleted', async () => {
    const { state } = await applySubmission(
      withMessages('one', 'two'),
      submission({
        deletions: [
          { threadId: 't1', index: 0 },
          { threadId: 't1', index: 1 },
        ],
      }),
      lookup,
    );

    expect(state.threads).toEqual([]);
  });

  it('keeps a reply added in the same submission as the deletion', async () => {
    const { state } = await applySubmission(
      withMessages('agent note'),
      submission({
        replies: [{ threadId: 't1', body: 'actually, this' }],
        deletions: [{ threadId: 't1', index: 0 }],
      }),
      lookup,
    );

    expect(state.threads[0]?.messages.map((m) => m.body)).toEqual(['actually, this']);
  });

  it('ignores a deletion naming a thread or an index that is not there', async () => {
    const before = withMessages('only one');
    const { state } = await applySubmission(
      before,
      submission({
        deletions: [
          { threadId: 'nope', index: 0 },
          { threadId: 't1', index: 7 },
        ],
      }),
      lookup,
    );

    expect(state.threads[0]?.messages.map((m) => m.body)).toEqual(['only one']);
  });

  it('never touches a thread that arrived with no messages at all', async () => {
    const { state } = await applySubmission(
      withMessages(),
      submission({ deletions: [{ threadId: 't1', index: 0 }] }),
      lookup,
    );

    expect(state.threads).toHaveLength(1);
  });
});

describe('stateDirFor', () => {
  it('places state inside .git so it never shows up in the diff under review', () => {
    expect(stateDirFor('/repo/.git')).toBe(join('/repo/.git', 'web-review'));
  });
});

describe('readState / writeState', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'web-review-state-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns an empty state when nothing has been written', async () => {
    expect(await readState(dir)).toEqual({ version: 1, round: 0, threads: [] });
  });

  it('round-trips a state through disk, creating the directory', async () => {
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
          messages: [{ author: 'user', round: 1, body: 'hi', at: AT }],
        },
      ],
    };

    await writeState(join(dir, 'nested'), state);

    expect(await readState(join(dir, 'nested'))).toEqual(state);
  });

  it('falls back to an empty state when the file is corrupt', async () => {
    await writeState(dir, emptyState());
    await rm(join(dir, 'state.json'));

    expect(await readState(dir)).toEqual(emptyState());
  });

  it('rejects malformed JSON instead of silently discarding every round of state', async () => {
    await writeFile(join(dir, 'state.json'), '{not valid json', 'utf8');

    // Returning an empty state here would look like a normal read to the
    // caller, and the next writeState would then persist that empty state,
    // permanently destroying every thread ever recorded. A corrupt file must
    // surface as an error instead.
    await expect(readState(dir)).rejects.toThrow(/state\.json/i);
  });

  it('rejects an unexpected version instead of silently discarding every round of state', async () => {
    await writeFile(join(dir, 'state.json'), JSON.stringify({ version: 2, round: 5, threads: [] }), 'utf8');

    await expect(readState(dir)).rejects.toThrow(/state\.json/i);
  });

  it('rethrows a non-ENOENT read error instead of masking it as empty state', async () => {
    // Make state.json a directory so readFile fails with EISDIR, not ENOENT.
    await mkdir(join(dir, 'state.json'));

    await expect(readState(dir)).rejects.toThrow();
  });
});

describe('openRound', () => {
  const lookup = lookupOf({ 'a.ts': ['one', 'two', 'three'] });

  it('bumps the round counter', async () => {
    expect((await openRound(emptyState(), request(), lookup, now)).round).toBe(1);
  });

  it('turns agent annotations into threads authored by the agent', async () => {
    const next = await openRound(
      emptyState(),
      request({ annotations: [{ file: 'a.ts', line: 2, side: 'new', body: 'unsure' }] }),
      lookup,
      now,
    );

    expect(next.threads).toEqual([
      {
        id: 't1',
        file: 'a.ts',
        side: 'new',
        anchor: { line: 2, content: 'two', contextHash: expect.any(String) },
        status: 'open',
        messages: [{ author: 'agent', round: 1, body: 'unsure', at: AT }],
      },
    ]);
  });

  it('drops an annotation pointing at a line that does not exist', async () => {
    const next = await openRound(
      emptyState(),
      request({ annotations: [{ file: 'a.ts', line: 99, side: 'new', body: 'x' }] }),
      lookup,
      now,
    );

    expect(next.threads).toEqual([]);
  });

  it('appends agent replies to existing threads', async () => {
    const first = await openRound(
      emptyState(),
      request({ annotations: [{ file: 'a.ts', line: 1, side: 'new', body: 'q' }] }),
      lookup,
      now,
    );

    const second = await openRound(first, request({ replies: [{ threadId: 't1', body: 'done' }] }), lookup, now);

    expect(second.threads[0]?.messages).toEqual([
      { author: 'agent', round: 1, body: 'q', at: AT },
      { author: 'agent', round: 2, body: 'done', at: AT },
    ]);
  });

  it('follows a thread whose line moved', async () => {
    const first = await openRound(
      emptyState(),
      request({ annotations: [{ file: 'a.ts', line: 2, side: 'new', body: 'q' }] }),
      lookup,
      now,
    );

    const second = await openRound(
      first,
      request(),
      lookupOf({ 'a.ts': ['inserted', 'one', 'two', 'three'] }),
      now,
    );

    expect(second.threads[0]?.anchor.line).toBe(3);
    expect(second.threads[0]?.status).toBe('open');
  });

  it('marks a thread outdated when its line is gone, without deleting it', async () => {
    const first = await openRound(
      emptyState(),
      request({ annotations: [{ file: 'a.ts', line: 2, side: 'new', body: 'q' }] }),
      lookup,
      now,
    );

    const second = await openRound(first, request(), lookupOf({ 'a.ts': ['one', 'three'] }), now);

    expect(second.threads).toHaveLength(1);
    expect(second.threads[0]?.status).toBe('outdated');
  });

  it('marks a thread outdated when its file disappeared entirely', async () => {
    const first = await openRound(
      emptyState(),
      request({ annotations: [{ file: 'a.ts', line: 1, side: 'new', body: 'q' }] }),
      lookup,
      now,
    );

    const second = await openRound(first, request(), lookupOf({}), now);

    expect(second.threads[0]?.status).toBe('outdated');
  });

  it('leaves resolved threads resolved when they relocate cleanly', async () => {
    const first = await openRound(
      emptyState(),
      request({ annotations: [{ file: 'a.ts', line: 1, side: 'new', body: 'q' }] }),
      lookup,
      now,
    );
    const { state: resolved } = await applySubmission(first, submission({ resolved: ['t1'] }), lookup, now);

    const second = await openRound(resolved, request(), lookup, now);

    expect(second.threads[0]?.status).toBe('resolved');
  });

  it('never lets a round where the file goes missing undo a human resolve', async () => {
    const first = await openRound(
      emptyState(),
      request({ annotations: [{ file: 'a.ts', line: 1, side: 'new', body: 'q' }] }),
      lookup,
      now,
    );
    const { state: resolved } = await applySubmission(first, submission({ resolved: ['t1'] }), lookup, now);
    expect(resolved.threads[0]?.status).toBe('resolved');

    const fileMissing = await openRound(resolved, request(), lookupOf({}), now);
    expect(fileMissing.threads[0]?.status).toBe('resolved');

    const fileBack = await openRound(fileMissing, request(), lookup, now);
    expect(fileBack.threads[0]?.status).toBe('resolved');
  });

  it('still takes an open thread through outdated and back to open across the same sequence', async () => {
    const first = await openRound(
      emptyState(),
      request({ annotations: [{ file: 'a.ts', line: 1, side: 'new', body: 'q' }] }),
      lookup,
      now,
    );
    expect(first.threads[0]?.status).toBe('open');

    const fileMissing = await openRound(first, request(), lookupOf({}), now);
    expect(fileMissing.threads[0]?.status).toBe('outdated');

    const fileBack = await openRound(fileMissing, request(), lookup, now);
    expect(fileBack.threads[0]?.status).toBe('open');
  });

  it('silently ignores an agent reply naming a thread id that does not exist', async () => {
    const next = await openRound(
      emptyState(),
      request({ replies: [{ threadId: 'nope', body: 'x' }] }),
      lookup,
      now,
    );

    expect(next.threads).toEqual([]);
  });
});

describe('applySubmission', () => {
  const lookup = lookupOf({ 'a.ts': ['one', 'two', 'three'] });

  it('anchors a new comment against the current file contents', async () => {
    const state = await openRound(emptyState(), request(), lookup, now);

    const { state: next, unanchored } = await applySubmission(
      state,
      submission({
        newComments: [{ file: 'a.ts', side: 'new', line: 3, body: 'rename this' }],
      }),
      lookup,
      now,
    );

    expect(next.threads).toEqual([
      {
        id: 't1',
        file: 'a.ts',
        side: 'new',
        anchor: { line: 3, content: 'three', contextHash: expect.any(String) },
        status: 'open',
        messages: [{ author: 'user', round: 1, body: 'rename this', at: AT }],
      },
    ]);
    expect(unanchored).toEqual([]);
  });

  it('appends a human reply to an existing thread', async () => {
    const state = await openRound(
      emptyState(),
      request({ annotations: [{ file: 'a.ts', line: 1, side: 'new', body: 'q' }] }),
      lookup,
      now,
    );

    const { state: next } = await applySubmission(
      state,
      submission({ replies: [{ threadId: 't1', body: 'no, keep it' }] }),
      lookup,
      now,
    );

    expect(next.threads[0]?.messages.at(-1)).toEqual({
      author: 'user',
      round: 1,
      body: 'no, keep it',
      at: AT,
    });
  });

  it('resolves and reopens threads by id', async () => {
    const state = await openRound(
      emptyState(),
      request({ annotations: [{ file: 'a.ts', line: 1, side: 'new', body: 'q' }] }),
      lookup,
      now,
    );

    const { state: resolved } = await applySubmission(state, submission({ resolved: ['t1'] }), lookup, now);
    expect(resolved.threads[0]?.status).toBe('resolved');

    const { state: reopened } = await applySubmission(resolved, submission({ reopened: ['t1'] }), lookup, now);
    expect(reopened.threads[0]?.status).toBe('open');
  });

  it('reports, rather than silently drops, a new comment on a line that no longer exists', async () => {
    const state = await openRound(emptyState(), request(), lookup, now);

    const { state: next, unanchored } = await applySubmission(
      state,
      submission({ newComments: [{ file: 'a.ts', side: 'new', line: 99, body: 'x' }] }),
      lookup,
      now,
    );

    expect(next.threads).toEqual([]);
    expect(unanchored).toEqual([{ file: 'a.ts', side: 'new', line: 99, body: 'x' }]);
  });

  it('reports a new comment on a file the lookup cannot find at all', async () => {
    const state = await openRound(emptyState(), request(), lookup, now);

    const { state: next, unanchored } = await applySubmission(
      state,
      submission({ newComments: [{ file: 'gone.ts', side: 'new', line: 1, body: 'x' }] }),
      lookup,
      now,
    );

    expect(next.threads).toEqual([]);
    expect(unanchored).toEqual([{ file: 'gone.ts', side: 'new', line: 1, body: 'x' }]);
  });

  it('gives every new thread a distinct id', async () => {
    const state = await openRound(emptyState(), request(), lookup, now);

    const { state: next } = await applySubmission(
      state,
      submission({
        newComments: [
          { file: 'a.ts', side: 'new', line: 1, body: 'a' },
          { file: 'a.ts', side: 'new', line: 2, body: 'b' },
        ],
      }),
      lookup,
      now,
    );

    expect(next.threads.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('silently ignores a reply, resolve, or reopen naming a thread id that does not exist', async () => {
    const state = await openRound(
      emptyState(),
      request({ annotations: [{ file: 'a.ts', line: 1, side: 'new', body: 'q' }] }),
      lookup,
      now,
    );

    const { state: next } = await applySubmission(
      state,
      submission({
        replies: [{ threadId: 'nope', body: 'x' }],
        resolved: ['nope'],
        reopened: ['nope'],
      }),
      lookup,
      now,
    );

    expect(next.threads).toEqual(state.threads);
  });
});
