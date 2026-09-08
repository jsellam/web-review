import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { contextHash, makeAnchor, relocate } from './anchor.js';
import { isENOENT } from './request.js';
import type {
  Message,
  MessageRef,
  NewComment,
  ReviewRequest,
  ReviewState,
  Side,
  SubmitPayload,
  Thread,
} from '../../shared/types.js';

export const STATE_FILE = 'state.json';

/** All review state lives inside .git, never in the working tree. */
export function stateDirFor(gitDir: string): string {
  return join(gitDir, 'web-review');
}

export function emptyState(): ReviewState {
  return { version: 1, round: 0, threads: [] };
}

/** Supplies the current lines of one side of one file. Injected so the pure logic stays testable. */
export type LinesLookup = (file: string, side: Side) => Promise<string[] | null>;

export async function readState(stateDir: string): Promise<ReviewState> {
  let raw: string;
  try {
    raw = await readFile(join(stateDir, STATE_FILE), 'utf8');
  } catch (error) {
    if (isENOENT(error)) return emptyState();
    throw error;
  }

  const path = join(stateDir, STATE_FILE);
  let parsed: ReviewState;
  try {
    parsed = JSON.parse(raw) as ReviewState;
  } catch (error) {
    // Returning an empty state here would look like an ordinary read to the
    // caller; the next writeState would then persist that empty state,
    // permanently destroying every thread from every round with no error.
    // Surface the failure instead of masking it — the same principle commit
    // 59bd78b already applied to the read-error branch above.
    throw new Error(
      `web-review: ${path} is not valid JSON and was left in place; refusing to discard its contents. (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }

  if (parsed.version !== 1 || !Array.isArray(parsed.threads)) {
    throw new Error(
      `web-review: ${path} has an unrecognised shape (version ${JSON.stringify((parsed as { version?: unknown }).version)}) and was left in place; refusing to discard its contents.`,
    );
  }

  return parsed;
}

export async function writeState(stateDir: string, state: ReviewState): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const target = join(stateDir, STATE_FILE);
  const temp = `${target}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temp, target);
}

function nextId(threads: Thread[]): string {
  const highest = threads.reduce((max, thread) => {
    const n = Number.parseInt(thread.id.slice(1), 10);
    return Number.isNaN(n) ? max : Math.max(max, n);
  }, 0);
  return `t${highest + 1}`;
}

const nowIso = () => new Date().toISOString();

/**
 * Start a new round: bump the counter, relocate every thread against the
 * current file contents, then fold in the agent's replies and annotations.
 */
export async function openRound(
  state: ReviewState,
  request: ReviewRequest,
  lookup: LinesLookup,
  now: () => string = nowIso,
): Promise<ReviewState> {
  const round = state.round + 1;
  const threads: Thread[] = [];

  for (const thread of state.threads) {
    const lines = await lookup(thread.file, thread.side);
    if (lines === null) {
      threads.push({ ...thread, status: thread.status === 'open' ? 'outdated' : thread.status });
      continue;
    }

    const moved = relocate(thread.anchor, lines);
    if (moved.line === null) {
      threads.push({ ...thread, status: thread.status === 'open' ? 'outdated' : thread.status });
      continue;
    }

    threads.push({
      ...thread,
      status: thread.status === 'outdated' ? 'open' : thread.status,
      anchor: {
        ...thread.anchor,
        line: moved.line,
        contextHash: contextHash(lines, moved.line - 1),
      },
    });
  }

  for (const reply of request.replies) {
    const thread = threads.find((t) => t.id === reply.threadId);
    if (thread) thread.messages = [...thread.messages, message('agent', round, reply.body, now)];
  }

  for (const annotation of request.annotations) {
    const lines = await lookup(annotation.file, annotation.side);
    if (!lines || lines[annotation.line - 1] === undefined) continue;

    threads.push({
      id: nextId(threads),
      file: annotation.file,
      side: annotation.side,
      anchor: makeAnchor(lines, annotation.line),
      status: 'open',
      messages: [message('agent', round, annotation.body, now)],
    });
  }

  return { version: 1, round, threads };
}

export interface ApplySubmissionResult {
  state: ReviewState;
  /**
   * New comments whose line could not be found in the current file contents
   * — a race between the diff shown to the reviewer and the files on disk,
   * or (before the rename fix) an old-side comment on a renamed file. These
   * are never silently dropped: `openRound` marks the analogous case
   * (a thread that can no longer be relocated) `outdated` rather than
   * deleting it, and a new comment that cannot even be anchored once
   * deserves the same visibility, not less — the caller surfaces this list
   * to both the reviewer's response and the agent's `CliResult`.
   */
  unanchored: NewComment[];
}

/**
 * Drop the messages the reviewer deleted, and with them any thread left empty.
 *
 * Indices address `Thread.messages` as the browser was shown it. Replies from
 * the same submission are appended before this runs, but appending never moves
 * an existing message, so those indices are still the ones they were — and a
 * reply is deliberately not deletable in the same round it is written, so no
 * index can point at one.
 *
 * A thread emptied of every message is removed outright rather than kept as a
 * husk: `openRound` would keep relocating it forever, and the agent would keep
 * receiving a thread with nothing in it. Only threads this call actually
 * touched are considered, so a thread that arrived empty is left alone.
 */
function applyDeletions(threads: Thread[], deletions: MessageRef[]): Thread[] {
  if (deletions.length === 0) return threads;

  const byThread = new Map<string, Set<number>>();
  for (const { threadId, index } of deletions) {
    const set = byThread.get(threadId) ?? new Set<number>();
    set.add(index);
    byThread.set(threadId, set);
  }

  const result: Thread[] = [];
  for (const thread of threads) {
    const removed = byThread.get(thread.id);
    if (!removed) {
      result.push(thread);
      continue;
    }

    const messages = thread.messages.filter((_, index) => !removed.has(index));
    // Nothing actually matched — a stale index, or a thread that was already
    // empty. Leave it exactly as it was rather than treating "no messages
    // left" as "the reviewer deleted the last one".
    if (messages.length === thread.messages.length) {
      result.push(thread);
      continue;
    }
    if (messages.length > 0) result.push({ ...thread, messages });
  }
  return result;
}

/** Fold the human's submission into the state. New comments are anchored here. */
export async function applySubmission(
  state: ReviewState,
  payload: SubmitPayload,
  lookup: LinesLookup,
  now: () => string = nowIso,
): Promise<ApplySubmissionResult> {
  let threads = state.threads.map((thread) => ({ ...thread }));
  const unanchored: NewComment[] = [];

  for (const reply of payload.replies) {
    const thread = threads.find((t) => t.id === reply.threadId);
    if (thread) {
      thread.messages = [...thread.messages, message('user', state.round, reply.body, now)];
    }
  }

  for (const id of payload.resolved) {
    const thread = threads.find((t) => t.id === id);
    if (thread) thread.status = 'resolved';
  }

  for (const id of payload.reopened) {
    const thread = threads.find((t) => t.id === id);
    if (thread) thread.status = 'open';
  }

  // Before the new comments are appended, so a fresh thread can never collide
  // with a deletion index meant for one of the threads already in the state.
  threads = applyDeletions(threads, payload.deletions);

  for (const comment of payload.newComments) {
    const lines = await lookup(comment.file, comment.side);
    if (!lines || lines[comment.line - 1] === undefined) {
      unanchored.push(comment);
      continue;
    }

    threads.push({
      id: nextId(threads),
      file: comment.file,
      side: comment.side,
      anchor: makeAnchor(lines, comment.line),
      status: 'open',
      messages: [message('user', state.round, comment.body, now)],
    });
  }

  return { state: { ...state, threads }, unanchored };
}

function message(
  author: Message['author'],
  round: number,
  body: string,
  now: () => string,
): Message {
  return { author, round, body, at: now() };
}
