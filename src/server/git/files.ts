import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { git, gitRaw, gitOk, type GitOptions } from './exec.js';
import type { DiffRange } from './range.js';
import type { FileEntry, FileStatus, Side } from '../../shared/types.js';

const NUL = '\u0000';

function diffArgs(range: DiffRange, extra: string[]): string[] {
  return range.staged
    ? ['diff', '--cached', '-M', '-z', ...extra, range.base]
    : ['diff', '-M', '-z', ...extra, range.base];
}

interface Counts {
  additions: number;
  deletions: number;
  binary: boolean;
}

/** With `-z`, `--numstat` prints records as "<added>\t<deleted>\t<path>\0", with "-" for both on binary files. */
function parseNumstat(output: string): Map<string, Counts> {
  const counts = new Map<string, Counts>();
  const records = output.split(NUL).filter((r) => r.length > 0);

  for (const record of records) {
    const [added, deleted, path] = record.split('\t');
    if (!path || added === undefined || deleted === undefined) continue;
    counts.set(path, {
      additions: added === '-' ? 0 : Number(added),
      deletions: deleted === '-' ? 0 : Number(deleted),
      binary: added === '-' && deleted === '-',
    });
  }
  return counts;
}

const STATUS_MAP: Record<string, FileStatus> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
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

  // Parse NUL-delimited nameStatus records
  // Format with -z: status\0path\0 for normal, status\0oldpath\0newpath\0 for renames
  const records = nameStatus.split(NUL).filter((r) => r.length > 0);
  let i = 0;
  while (i < records.length) {
    const code = records[i]!.charAt(0);
    const status = STATUS_MAP[code] ?? 'modified';

    const isRename = code === 'R';
    if (isRename) {
      // Rename format: status\0oldpath\0newpath\0
      const oldPath = records[i + 1] ?? '';
      const path = records[i + 2] ?? oldPath;
      entries.push({
        path,
        oldPath,
        status,
        ...(counts.get(path) ?? { additions: 0, deletions: 0, binary: false }),
      });
      i += 3;
    } else {
      // Normal format: status\0path\0
      const path = records[i + 1] ?? '';
      entries.push({
        path,
        oldPath: status === 'added' ? null : path,
        status,
        ...(counts.get(path) ?? { additions: 0, deletions: 0, binary: false }),
      });
      i += 2;
    }
  }

  if (!range.staged) entries.push(...(await listUntracked(opts)));

  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/** `git diff` never lists untracked files, so we add them as pure additions. */
async function listUntracked(opts: GitOptions): Promise<FileEntry[]> {
  const output = await git(['ls-files', '--others', '--exclude-standard', '-z'], opts);
  const paths = output.split(NUL).filter((p) => p.length > 0);

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
    const exists = await gitOk(['cat-file', '-e', `${range.base}:${path}`], opts);
    if (!exists) return null;
    return gitRaw(['show', `${range.base}:${path}`], opts);
  }

  if (range.staged) {
    const exists = await gitOk(['cat-file', '-e', `:${path}`], opts);
    if (!exists) return null;
    return gitRaw(['show', `:${path}`], opts);
  }

  const full = join(opts.cwd, path);
  const info = await stat(full).catch(() => null);
  if (!info?.isFile()) return null;
  return readFile(full, 'utf8');
}
