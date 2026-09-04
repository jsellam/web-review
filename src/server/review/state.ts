import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { contextHash, makeAnchor, relocate } from './anchor.js';
import { isENOENT } from './request.js';
import type {
  Message,
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

  try {
    const parsed = JSON.parse(raw) as ReviewState;
    if (parsed.version !== 1 || !Array.isArray(parsed.threads)) return emptyState();
    return parsed;
  } catch {
    return emptyState();
  }
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

/** Fold the human's submission into the state. New comments are anchored here. */
export async function applySubmission(
  state: ReviewState,
  payload: SubmitPayload,
  lookup: LinesLookup,
  now: () => string = nowIso,
): Promise<ReviewState> {
  const threads = state.threads.map((thread) => ({ ...thread }));

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

  for (const comment of payload.newComments) {
    const lines = await lookup(comment.file, comment.side);
    if (!lines || lines[comment.line - 1] === undefined) continue;

    threads.push({
      id: nextId(threads),
      file: comment.file,
      side: comment.side,
      anchor: makeAnchor(lines, comment.line),
      status: 'open',
      messages: [message('user', state.round, comment.body, now)],
    });
  }

  return { ...state, threads };
}

function message(
  author: Message['author'],
  round: number,
  body: string,
  now: () => string,
): Message {
  return { author, round, body, at: now() };
}
