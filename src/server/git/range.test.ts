import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRepo, type TestRepo } from '../test-helpers/repo.js';
import { resolveRange } from './range.js';
import { git, GitError } from './exec.js';

let repo: TestRepo;

beforeEach(async () => {
  repo = await createRepo();
  await repo.write('a.txt', 'one\n');
  await repo.commit('initial');
});

afterEach(async () => {
  await repo.cleanup();
});

describe('git', () => {
  it('returns stdout without the trailing newline', async () => {
    expect(await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo.dir }))
      .toBe('main');
  });

  it('throws GitError carrying stderr and the failing args', async () => {
    await expect(git(['cat-file', '-p', 'nope'], { cwd: repo.dir }))
      .rejects.toBeInstanceOf(GitError);
  });
});

describe('resolveRange', () => {
  it('auto picks HEAD when the working tree is dirty', async () => {
    await repo.write('a.txt', 'two\n');

    expect(await resolveRange('auto', { cwd: repo.dir }))
      .toEqual({ base: 'HEAD', label: 'working tree vs HEAD', staged: false });
  });

  it('auto picks the merge base with the default branch when clean', async () => {
    await repo.run('checkout', '-b', 'feature');
    await repo.write('b.txt', 'new\n');
    await repo.commit('add b');

    const range = await resolveRange('auto', { cwd: repo.dir });
    const mergeBase = await git(['merge-base', 'main', 'HEAD'], { cwd: repo.dir });

    expect(range.base).toBe(mergeBase);
    expect(range.staged).toBe(false);
    expect(range.label).toBe('branch vs main');
  });

  it('staged compares the index against HEAD', async () => {
    await repo.write('a.txt', 'two\n');
    await repo.run('add', 'a.txt');

    expect(await resolveRange('staged', { cwd: repo.dir }))
      .toEqual({ base: 'HEAD', label: 'index vs HEAD', staged: true });
  });

  it('an explicit ref is resolved to a sha and compared against the working tree', async () => {
    await repo.write('a.txt', 'two\n');
    await repo.commit('second');

    const range = await resolveRange('HEAD~1', { cwd: repo.dir });
    const sha = await git(['rev-parse', 'HEAD~1'], { cwd: repo.dir });

    expect(range).toEqual({ base: sha, label: 'working tree vs HEAD~1', staged: false });
  });

  it('rejects an unknown ref with a readable message', async () => {
    await expect(resolveRange('no-such-ref', { cwd: repo.dir }))
      .rejects.toThrow(/unknown base ref: no-such-ref/i);
  });
});
