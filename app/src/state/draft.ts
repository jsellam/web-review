import { create } from 'zustand';
import type { MessageRef, Side, SubmitPayload, Verdict } from '../../../src/shared/types.js';

export interface Draft {
  file: string;
  side: Side;
  line: number;
  body: string;
}

export interface DraftState {
  comments: Record<string, Draft>;
  replies: Record<string, string>;
  /** true = resolve on submit, false = reopen on submit. */
  resolved: Record<string, boolean>;
  /** Messages staged for deletion, keyed by `deletionKey`. */
  deletions: Record<string, MessageRef>;
  general: string;
  viewed: Record<string, boolean>;
  setComment(file: string, side: Side, line: number, body: string): void;
  removeComment(key: string): void;
  setReply(threadId: string, body: string): void;
  setResolved(threadId: string, value: boolean, original?: boolean): void;
  setDeleted(threadId: string, index: number, value: boolean): void;
  /** Stage (or unstage) every message of a thread at once — "delete the whole thread". */
  setThreadDeleted(threadId: string, messageCount: number, value: boolean): void;
  setGeneral(body: string): void;
  setViewed(file: string, value: boolean): void;
  reset(): void;
}

export function draftKey(file: string, side: Side, line: number): string {
  return `${file}:${side}:${line}`;
}

export function deletionKey(threadId: string, index: number): string {
  return `${threadId}#${index}`;
}

const EMPTY = {
  comments: {} as Record<string, Draft>,
  replies: {} as Record<string, string>,
  resolved: {} as Record<string, boolean>,
  deletions: {} as Record<string, MessageRef>,
  general: '',
  viewed: {} as Record<string, boolean>,
};

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

export const useDraftStore = create<DraftState>((set) => ({
  ...EMPTY,

  setComment(file, side, line, body) {
    const key = draftKey(file, side, line);
    set((state) =>
      body.trim().length === 0
        ? { comments: withoutKey(state.comments, key) }
        : { comments: { ...state.comments, [key]: { file, side, line, body } } },
    );
  },

  removeComment(key) {
    set((state) => ({ comments: withoutKey(state.comments, key) }));
  },

  setReply(threadId, body) {
    set((state) =>
      body.trim().length === 0
        ? { replies: withoutKey(state.replies, threadId) }
        : { replies: { ...state.replies, [threadId]: body } },
    );
  },

  setResolved(threadId, value, original) {
    // When the caller tells us what the thread's status was before any
    // staging (CommentThread does), a toggle that lands back on that value
    // is not a pending change at all — clear the key rather than leave a
    // `{ [id]: original }` entry that still inflates pendingCount and still
    // gets sent as a resolve/reopen on submit.
    set((state) =>
      original !== undefined && value === original
        ? { resolved: withoutKey(state.resolved, threadId) }
        : { resolved: { ...state.resolved, [threadId]: value } },
    );
  },

  setDeleted(threadId, index, value) {
    const key = deletionKey(threadId, index);
    set((state) =>
      value
        ? { deletions: { ...state.deletions, [key]: { threadId, index } } }
        : { deletions: withoutKey(state.deletions, key) },
    );
  },

  setThreadDeleted(threadId, messageCount, value) {
    set((state) => {
      const deletions = { ...state.deletions };
      for (let index = 0; index < messageCount; index += 1) {
        const key = deletionKey(threadId, index);
        if (value) deletions[key] = { threadId, index };
        else delete deletions[key];
      }
      return { deletions };
    });
  },

  setGeneral(general) {
    set({ general });
  },

  setViewed(file, value) {
    set((state) => ({ viewed: { ...state.viewed, [file]: value } }));
  },

  reset() {
    set({ ...EMPTY });
  },
}));

/** What the "Review (n)" badge shows: everything that would be sent right now. */
export function pendingCount(state: DraftState): number {
  return (
    Object.keys(state.comments).length +
    Object.keys(state.replies).length +
    Object.keys(state.resolved).length +
    Object.keys(state.deletions).length
  );
}

export function buildSubmit(state: DraftState, verdict: Verdict): SubmitPayload {
  return {
    verdict,
    general: state.general,
    newComments: Object.values(state.comments).map(({ file, side, line, body }) => ({
      file,
      side,
      line,
      body,
    })),
    replies: Object.entries(state.replies).map(([threadId, body]) => ({ threadId, body })),
    resolved: Object.entries(state.resolved).filter(([, v]) => v).map(([id]) => id),
    reopened: Object.entries(state.resolved).filter(([, v]) => !v).map(([id]) => id),
    deletions: Object.values(state.deletions),
  };
}
