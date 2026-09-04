import type { CliResult, ReviewState, Verdict } from '../../shared/types.js';

/**
 * Every thread is returned, including resolved and outdated ones: the agent
 * needs the whole conversation, not just what is actionable this round.
 */
export function submittedResult(
  state: ReviewState,
  verdict: Verdict,
  general: string,
): CliResult {
  return {
    status: 'submitted',
    verdict,
    round: state.round,
    general,
    threads: state.threads,
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
