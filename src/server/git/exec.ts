import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface GitOptions {
  cwd: string;
}

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly stderr: string,
    readonly code: number,
  ) {
    super(`git ${args.join(' ')} failed (${code}): ${stderr.trim()}`);
    this.name = 'GitError';
  }
}

/** Run git and return stdout. The single place in the codebase that spawns a process. */
export async function git(args: string[], opts: GitOptions): Promise<string> {
  return gitRaw(args, opts).then((out) => out.replace(/\n$/, ''));
}

/** Run git and return stdout untouched, without stripping the trailing newline. */
export async function gitRaw(args: string[], opts: GitOptions): Promise<string> {
  try {
    const { stdout } = await run('git', args, {
      cwd: opts.cwd,
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
    });
    return stdout;
  } catch (error) {
    const e = error as { stderr?: string; code?: number };
    throw new GitError(args, e.stderr ?? '', e.code ?? 1);
  }
}

/** Run git and report success instead of throwing. For existence probes. */
export async function gitOk(args: string[], opts: GitOptions): Promise<boolean> {
  try {
    await git(args, opts);
    return true;
  } catch {
    return false;
  }
}

export async function repoRoot(opts: GitOptions): Promise<string> {
  return git(['rev-parse', '--show-toplevel'], opts);
}

export async function gitDir(opts: GitOptions): Promise<string> {
  return git(['rev-parse', '--absolute-git-dir'], opts);
}
