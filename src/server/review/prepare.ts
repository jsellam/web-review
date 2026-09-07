import { splitLines } from './anchor.js';
import type { NumberedLine } from '../git/diff.js';
import type { FileEntry } from '../../shared/types.js';

/** Beyond this many changed or rendered lines, a file is shown as a header only. */
export const PER_FILE_LIMIT = 400;
/** Beyond this many rendered lines in total, the remaining files are headers only. */
export const TOTAL_LIMIT = 2000;

/** Width of each of the two line-number columns. */
const COLUMN = 5;

/** A changed file with its numbered diff, or null when the body was never fetched. */
export interface PreparedFile {
  entry: FileEntry;
  lines: NumberedLine[] | null;
}

/**
 * Whether a file is too big to render, judged before it is diffed at all.
 * The rendered body is checked again in `renderPrepare`, because context
 * lines can carry a small change over the bound on their own.
 */
export function isTooLarge(entry: FileEntry): boolean {
  return entry.additions + entry.deletions > PER_FILE_LIMIT;
}

/** An untracked file has no `git diff` output; it is a pure addition from line 1. */
export function wholeFileAsAdditions(content: string): NumberedLine[] {
  return splitLines(content).map((text, index) => ({
    kind: 'add' as const,
    old: null,
    new: index + 1,
    text,
  }));
}

function column(value: number | null): string {
  return String(value ?? '.').padStart(COLUMN);
}

function marker(kind: NumberedLine['kind']): string {
  return kind === 'add' ? '+' : kind === 'del' ? '-' : ' ';
}

/**
 * Two fixed-width number columns, side by side, so an agent can read the
 * line number it needs straight off the side it cares about — old or new —
 * without counting characters or lining anything up itself. `column` pads to
 * a shared width so both sides stay aligned down the whole file; the two
 * literal spaces after them separate the columns from the +/- marker, and
 * the one space after the marker separates it from the text, so all three
 * fields (numbers, marker, source line) stay visually distinct at a glance.
 */
function renderLine(line: NumberedLine): string {
  if (line.kind === 'hunk') return line.text;
  return `${column(line.old)}${column(line.new)}  ${marker(line.kind)} ${line.text}`;
}

function counts(entry: FileEntry): string {
  return `+${entry.additions} -${entry.deletions}`;
}

function statusLabel(entry: FileEntry): string {
  // `oldPath` is typed nullable even for a rename because the shared
  // `FileEntry` type makes no promise about who set it; if it were ever
  // missing here we still owe a label, so fall back to the bare status
  // rather than printing "renamed from undefined".
  return entry.status === 'renamed' && entry.oldPath ?
      `renamed from ${entry.oldPath}`
    : entry.status;
}

/**
 * One line naming a file: path, status, and either its change counts or a
 * reason nothing follows. Binary suppresses the size note rather than
 * showing "+0 -0" — git does not track additions/deletions for a binary
 * diff, so those counts would be zero for every binary file regardless of
 * how much actually changed, which is worse than not printing them. `note`
 * is appended as one trailing clause instead of composed as a list because
 * the three cases that use it (too large, omitted, and — implicitly —
 * neither) are mutually exclusive per file: there is never more than one
 * thing to say about why a body is or isn't shown.
 */
function header(entry: FileEntry, note = ''): string {
  const body = entry.binary ? 'binary — not shown' : counts(entry);
  return `== ${entry.path}  ${statusLabel(entry)}  ${body}${note}`;
}

const SHA = /^[0-9a-f]{40}$/;

/**
 * The whole `--prepare` output. Pure: every bound is applied here, and every
 * bound that fires says so on the file it applies to. Nothing is ever
 * withheld silently.
 */
export function renderPrepare(
  range: { base: string; label: string },
  files: PreparedFile[],
): string {
  const base = SHA.test(range.base) ? range.base.slice(0, 7) : range.base;
  const noun = files.length === 1 ? 'file' : 'files';

  const out: string[] = [
    `range: ${range.label} (base ${base})`,
    `${files.length} ${noun} changed`,
    '',
    `${'old'.padStart(COLUMN)}${'new'.padStart(COLUMN)}`,
  ];

  let used = 0;
  for (const { entry, lines } of files) {
    if (lines === null) {
      out.push(header(entry, entry.binary ? '' : '  — too large, truncated; read the file yourself if you need it'));
      continue;
    }
    if (lines.length > PER_FILE_LIMIT) {
      out.push(header(entry, '  — too large, truncated; read the file yourself if you need it'));
      continue;
    }
    if (used + lines.length > TOTAL_LIMIT) {
      out.push(header(entry, '  — omitted, output limit reached'));
      continue;
    }

    out.push(header(entry), ...lines.map(renderLine));
    used += lines.length;
  }

  return `${out.join('\n')}\n`;
}
