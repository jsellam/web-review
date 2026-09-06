import { createHash } from 'node:crypto';
import type { Anchor } from '../../shared/types.js';

/** How far from the recorded line we still call a match a simple shift. */
export const SEARCH_WINDOW = 25;

export type RelocationStatus = 'unchanged' | 'moved' | 'outdated';

export interface Relocation {
  line: number | null;
  status: RelocationStatus;
}

export function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/**
 * A fingerprint of the anchored line plus its two neighbours, indentation
 * ignored. Used only to tell duplicate lines apart, never to match on its own.
 */
export function contextHash(lines: string[], index: number): string {
  const window = [lines[index - 1] ?? '', lines[index] ?? '', lines[index + 1] ?? ''];
  const normalised = window.map((line) => line.trim()).join('\n');
  return createHash('sha1').update(normalised).digest('hex').slice(0, 12);
}

/** `line` is 1-based, matching every line number the UI and git speak. */
export function makeAnchor(lines: string[], line: number): Anchor {
  const content = lines[line - 1];
  if (content === undefined) {
    throw new Error(`web-review: line ${line} is out of range (${lines.length} lines)`);
  }
  return { line, content, contextHash: contextHash(lines, line - 1) };
}

export function relocate(anchor: Anchor, lines: string[]): Relocation {
  if (lines[anchor.line - 1] === anchor.content) {
    return { line: anchor.line, status: 'unchanged' };
  }

  const matches: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] === anchor.content) matches.push(i + 1);
  }
  if (matches.length === 0) return { line: null, status: 'outdated' };

  const near = nearest(matches, anchor.line, SEARCH_WINDOW);
  if (near !== null) return { line: near, status: 'moved' };

  if (matches.length === 1) return { line: matches[0]!, status: 'moved' };

  const byContext = matches.filter((line) => contextHash(lines, line - 1) === anchor.contextHash);
  if (byContext.length === 1) return { line: byContext[0]!, status: 'moved' };

  return { line: null, status: 'outdated' };
}

/**
 * The candidate closest to `target`, if any lies within `window` lines of it.
 * On a tie, the later candidate wins (`<=`, not `<`) — arbitrarily. Distance
 * alone cannot tell two equidistant candidates apart, and no distance-only
 * rule is more "correct" than another; this just needs to pick one consistently.
 */
function nearest(candidates: number[], target: number, window: number): number | null {
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const distance = Math.abs(candidate - target);
    if (distance <= window && distance <= bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}
