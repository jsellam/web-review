import { gitRaw, type GitOptions } from './exec.js';
import type { DiffRange } from './range.js';
import type { FileEntry } from '../../shared/types.js';

export type LineKind = 'hunk' | 'context' | 'add' | 'del';

/**
 * One line of a rendered diff, carrying the line number it has on each side.
 * `old` is null for an addition, `new` is null for a deletion, and both are
 * null for the `@@` header itself.
 */
export interface NumberedLine {
  kind: LineKind;
  old: number | null;
  new: number | null;
  text: string;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Attach old- and new-side line numbers to every line of a unified diff.
 *
 * Everything before the first `@@` is git's own metadata (`diff --git`,
 * `index`, `---`, `+++`, `similarity index`) and is dropped: the numbering
 * only has meaning inside a hunk, and the caller already knows which file
 * this is — it asked for it by path.
 */
export function numberHunks(text: string): NumberedLine[] {
  const out: NumberedLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;

  for (const raw of text.split('\n')) {
    const hunk = HUNK.exec(raw);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      out.push({ kind: 'hunk', old: null, new: null, text: raw });
      continue;
    }
    if (!inHunk) continue;

    // `split('\n')` on trailing-newline-terminated output yields a final
    // empty string that is not a line. A genuinely empty context line is a
    // single space in a unified diff, never the empty string.
    if (raw === '') continue;

    // "\ No newline at end of file" annotates the line above it; it is not
    // itself a line anyone can anchor a comment to.
    if (raw.startsWith('\\')) continue;

    const marker = raw.charAt(0);
    const body = raw.slice(1);

    if (marker === '+') {
      out.push({ kind: 'add', old: null, new: newNo, text: body });
      newNo += 1;
    } else if (marker === '-') {
      out.push({ kind: 'del', old: oldNo, new: null, text: body });
      oldNo += 1;
    } else {
      out.push({ kind: 'context', old: oldNo, new: newNo, text: body });
      oldNo += 1;
      newNo += 1;
    }
  }

  return out;
}

/**
 * The unified diff for exactly one file.
 *
 * Diffing per file rather than splitting one combined diff avoids parsing
 * paths back out of `diff --git a/… b/…` headers, where git quotes anything
 * non-ASCII. A rename is passed both of its paths: `-M` cannot recognise one
 * if the pathspec hides the other, and the file would come back as a whole
 * new addition instead.
 */
export async function readFileDiff(
  entry: FileEntry,
  range: DiffRange,
  opts: GitOptions,
): Promise<string> {
  const paths =
    entry.status === 'renamed' && entry.oldPath ? [entry.oldPath, entry.path] : [entry.path];

  const args = range.staged
    ? ['diff', '--cached', '-M', '-U3', range.base, '--', ...paths]
    : ['diff', '-M', '-U3', range.base, '--', ...paths];

  return gitRaw(args, opts);
}
