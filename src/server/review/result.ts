import type { CliResult, NewComment, ReviewState, Verdict } from '../../shared/types.js';

/**
 * Every thread is returned, including resolved and outdated ones: the agent
 * needs the whole conversation, not just what is actionable this round.
 *
 * `unanchored` carries any new comments from this submission that could not
 * be placed on a line (see `applySubmission`) — surfaced here rather than
 * silently dropped, so the agent knows a piece of feedback never made it in.
 * Omitted entirely when empty, so the common case stays exactly as before.
 */
export function submittedResult(
  state: ReviewState,
  verdict: Verdict,
  general: string,
  unanchored: NewComment[] = [],
): CliResult {
  return {
    status: 'submitted',
    verdict,
    round: state.round,
    general,
    threads: state.threads,
    ...(unanchored.length > 0 ? { unanchored } : {}),
  };
}

/** The foreground timed out; the server is still up and the agent should run again. */
export function pendingResult(url: string): CliResult {
  return { status: 'pending', url };
}

export function noChangesResult(): CliResult {
  return { status: 'no_changes' };
}

/** Deliberately carries no verdict: a cancelled review must never read as approval. */
export function abortedResult(): CliResult {
  return { status: 'aborted' };
}

export function errorResult(message: string): CliResult {
  return { status: 'error', message };
}
