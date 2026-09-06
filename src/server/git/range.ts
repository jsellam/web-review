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

export async function isDirty(opts: GitOptions): Promise<boolean> {
  return (await git(['status', '--porcelain'], opts)).trim().length > 0;
}

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
    if (await isDirty(opts)) {
      return { base: 'HEAD', label: 'working tree vs HEAD', staged: false };
    }
    const branch = await detectDefaultBranch(opts);
    if (!branch) {
      return { base: 'HEAD', label: 'working tree vs HEAD', staged: false };
    }
    const base = await git(['merge-base', branch, 'HEAD'], opts);
    return { base, label: `branch vs ${branch}`, staged: false };
  }

  if (!(await gitOk(['rev-parse', '--verify', '--quiet', `${spec}^{commit}`], opts))) {
    throw new Error(`web-review: unknown base ref: ${spec}`);
  }
  const base = await git(['rev-parse', spec], opts);
  return { base, label: `working tree vs ${spec}`, staged: false };
}
