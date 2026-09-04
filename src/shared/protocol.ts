import type { CliResult } from './types.js';

export const RESULT_START = '<<<WEB_REVIEW_RESULT';
export const RESULT_END = 'WEB_REVIEW_RESULT>>>';

/** Wrap a result in markers so it survives any incidental logging around it. */
export function frameResult(result: CliResult): string {
  return `${RESULT_START}\n${JSON.stringify(result, null, 2)}\n${RESULT_END}`;
}

/**
 * Pull the last framed result out of arbitrary text. Exported so both our tests
 * and any agent-side helper parse the stream the same way.
 */
export function parseFramed(text: string): CliResult {
  const start = text.lastIndexOf(RESULT_START);
  if (start === -1) throw new Error('web-review: no result block found in output');

  // A comment body can itself contain the literal end marker (a reviewer typed
  // it, or quoted it). The real terminator is always the last occurrence in the
  // text, so search from the end rather than stopping at the first match.
  const end = text.lastIndexOf(RESULT_END);
  if (end === -1 || end < start) throw new Error('web-review: result block is not terminated');

  return JSON.parse(text.slice(start + RESULT_START.length, end)) as CliResult;
}
