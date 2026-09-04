import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { git, type GitOptions } from './exec.js';
import type { DiffRange } from './range.js';
import type { FileEntry, FileStatus, Side } from '../../shared/types.js';

const NUL = '\u0000';

function diffArgs(range: DiffRange, extra: string[]): string[] {
  return range.staged
    ? ['diff', '--cached', '-M', ...extra, range.base]
    : ['diff', '-M', ...extra, range.base];
}

interface Counts {
  additions: number;
  deletions: number;
  binary: boolean;
}

/** `--numstat` prints "<added>\t<deleted>\t<path>", with "-" for both on binary files. */
function parseNumstat(output: string): Map<string, Counts> {
  const counts = new Map<string, Counts>();
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const [added, deleted, ...rest] = line.split('\t');
    const path = rest.join('\t');
    if (!path || added === undefined || deleted === undefined) continue;
    counts.set(renameTarget(path), {
      additions: added === '-' ? 0 : Number(added),
      deletions: deleted === '-' ? 0 : Number(deleted),
      binary: added === '-' && deleted === '-',
    });
  }
  return counts;
}

/** Rename entries look like "old => new" or "dir/{old => new}". We want the new path. */
function renameTarget(path: string): string {
  const braced = path.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (braced) {
    const [, prefix = '', , to = '', suffix = ''] = braced;
    return `${prefix}${to}${suffix}`.replace(/\/\//g, '/');
  }
  const parts = path.split(' => ');
  return parts.length === 2 ? parts[1]! : path;
}

const STATUS_MAP: Record<string, FileStatus> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'added',
  T: 'modified',
};

export async function listChangedFiles(
  range: DiffRange,
  opts: GitOptions,
): Promise<FileEntry[]> {
  const [numstat, nameStatus] = await Promise.all([
    git(diffArgs(range, ['--numstat']), opts),
    git(diffArgs(range, ['--name-status']), opts),
  ]);

  const counts = parseNumstat(numstat);
  const entries: FileEntry[] = [];

  for (const line of nameStatus.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const code = parts[0]!.charAt(0);
    const status = STATUS_MAP[code] ?? 'modified';

    const isRename = code === 'R' || code === 'C';
    const oldPath = parts[1] ?? '';
    const path = isRename ? (parts[2] ?? oldPath) : oldPath;

    entries.push({
      path,
      oldPath: status === 'added' ? null : oldPath,
      status,
      ...(counts.get(path) ?? { additions: 0, deletions: 0, binary: false }),
    });
  }

  if (!range.staged) entries.push(...(await listUntracked(opts)));

  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/** `git diff` never lists untracked files, so we add them as pure additions. */
async function listUntracked(opts: GitOptions): Promise<FileEntry[]> {
  const output = await git(['ls-files', '--others', '--exclude-standard'], opts);
  const paths = output.split('\n').filter((p) => p.trim().length > 0);

  return Promise.all(
    paths.map(async (path) => {
      const content = await readFile(join(opts.cwd, path), 'utf8').catch(() => null);
      const binary = content === null || content.includes(NUL);
      return {
        path,
        oldPath: null,
        status: 'added' as const,
        additions: binary || content === null ? 0 : countLines(content),
        deletions: 0,
        binary,
      };
    }),
  );
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  const lines = content.split('\n');
  return content.endsWith('\n') ? lines.length - 1 : lines.length;
}

export async function readSide(
  path: string,
  side: Side,
  range: DiffRange,
  opts: GitOptions,
): Promise<string | null> {
  if (side === 'old') {
    return git(['show', `${range.base}:${path}`], opts).then(withTrailingNewline, () => null);
  }

  if (range.staged) {
    return git(['show', `:${path}`], opts).then(withTrailingNewline, () => null);
  }

  const full = join(opts.cwd, path);
  const info = await stat(full).catch(() => null);
  if (!info?.isFile()) return null;
  return readFile(full, 'utf8');
}

/** `git show` strips one trailing newline; restore it so contents round-trip. */
function withTrailingNewline(content: string): string {
  return content.endsWith('\n') || content.length === 0 ? content : `${content}\n`;
}
