import { git, gitOk, type GitOptions } from './exec.js';

/**
 * What to diff. `staged: false` means "compare `base` against the working tree,
 * and include untracked files"; `staged: true` means "compare the index against `base`".
 */
export interface DiffRange {
  base: string;
  label: string;
  staged: boolean;
}

const DEFAULT_BRANCH_CANDIDATES = ['main', 'master', 'develop'];

/** Pick the branch a feature branch was most likely cut from. */
export async function detectDefaultBranch(opts: GitOptions): Promise<string | null> {
  for (const candidate of DEFAULT_BRANCH_CANDIDATES) {
    if (await gitOk(['rev-parse', '--verify', '--quiet', candidate], opts)) return candidate;
  }
  return null;
}

export async function resolveRange(spec: string, opts: GitOptions): Promise<DiffRange> {
  if (spec === 'staged') {
    return { base: 'HEAD', label: 'index vs HEAD', staged: true };
  }

  if (spec === 'HEAD') {
    return { base: 'HEAD', label: 'working tree vs HEAD', staged: false };
  }

  if (spec === 'auto') {
    const base = await branchBase(opts);
    return base ?? { base: 'HEAD', label: 'working tree vs HEAD', staged: false };
  }

  if (!(await gitOk(['rev-parse', '--verify', '--quiet', `${spec}^{commit}`], opts))) {
    throw new Error(`web-review: unknown base ref: ${spec}`);
  }
  const base = await git(['rev-parse', spec], opts);
  return { base, label: `working tree vs ${spec}`, staged: false };
}

/**
 * The whole branch: every commit since it left the default branch, plus
 * whatever is still uncommitted. Uncommitted work does *not* narrow the range
 * to HEAD — a feature branch is reviewed as a unit, the way a pull request is.
 *
 * Null when there is nothing wider than HEAD to show: no default branch, HEAD
 * already on it (or behind it), or histories with no common ancestor.
 */
async function branchBase(opts: GitOptions): Promise<DiffRange | null> {
  const branch = await detectDefaultBranch(opts);
  if (!branch) return null;

  const base = await git(['merge-base', branch, 'HEAD'], opts).catch(() => null);
  if (base === null) return null;

  const head = await git(['rev-parse', 'HEAD'], opts).catch(() => null);
  if (base === head) return null;

  return { base, label: `branch vs ${branch}`, staged: false };
}
