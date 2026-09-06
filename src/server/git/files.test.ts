import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRepo, type TestRepo } from '../test-helpers/repo.js';
import { resolveRange } from './range.js';
import { listChangedFiles, readSide, renameMap } from './files.js';

const NUL = '\u0000';
let repo: TestRepo;

beforeEach(async () => {
  repo = await createRepo();
  await repo.write('src/keep.ts', 'const a = 1;\n');
  await repo.write('src/gone.ts', 'const b = 2;\n');
  await repo.commit('initial');
});

afterEach(async () => {
  await repo.cleanup();
});

describe('listChangedFiles', () => {
  it('reports modified, deleted and untracked files with line counts', async () => {
    await repo.write('src/keep.ts', 'const a = 1;\nconst c = 3;\n');
    await repo.run('rm', 'src/gone.ts');
    await repo.write('src/fresh.ts', 'const d = 4;\n');

    const range = await resolveRange('HEAD', { cwd: repo.dir });

    expect(await listChangedFiles(range, { cwd: repo.dir })).toEqual([
      { path: 'src/fresh.ts', oldPath: null, status: 'added',
        additions: 1, deletions: 0, binary: false },
      { path: 'src/gone.ts', oldPath: 'src/gone.ts', status: 'deleted',
        additions: 0, deletions: 1, binary: false },
      { path: 'src/keep.ts', oldPath: 'src/keep.ts', status: 'modified',
        additions: 1, deletions: 0, binary: false },
    ]);
  });

  it('detects renames and keeps the old path', async () => {
    await repo.run('mv', 'src/keep.ts', 'src/renamed.ts');

    const range = await resolveRange('HEAD', { cwd: repo.dir });
    const files = await listChangedFiles(range, { cwd: repo.dir });
    const renamed = files.find((f) => f.path === 'src/renamed.ts');

    expect(renamed?.status).toBe('renamed');
    expect(renamed?.oldPath).toBe('src/keep.ts');
  });

  it('reports line counts for renamed files', async () => {
    await repo.run('mv', 'src/keep.ts', 'src/renamed.ts');
    await repo.write('src/renamed.ts', 'const a = 1;\nconst c = 3;\n');

    const range = await resolveRange('HEAD', { cwd: repo.dir });
    const files = await listChangedFiles(range, { cwd: repo.dir });
    const renamed = files.find((f) => f.path === 'src/renamed.ts');

    expect(renamed?.status).toBe('renamed');
    expect(renamed?.oldPath).toBe('src/keep.ts');
    expect(renamed?.additions).toBe(1);
    expect(renamed?.deletions).toBe(0);
  });

  it('marks untracked binary files instead of counting lines', async () => {
    await repo.write('logo.png', `${NUL}PNG${NUL}data`);

    const range = await resolveRange('HEAD', { cwd: repo.dir });
    const files = await listChangedFiles(range, { cwd: repo.dir });

    expect(files.find((f) => f.path === 'logo.png')?.binary).toBe(true);
  });

  it('omits untracked files in staged mode', async () => {
    await repo.write('src/keep.ts', 'const a = 9;\n');
    await repo.run('add', 'src/keep.ts');
    await repo.write('src/untracked.ts', 'const e = 5;\n');

    const range = await resolveRange('staged', { cwd: repo.dir });

    expect((await listChangedFiles(range, { cwd: repo.dir })).map((f) => f.path))
      .toEqual(['src/keep.ts']);
  });

  it('respects .gitignore for untracked files', async () => {
    await repo.write('.gitignore', 'ignored/\n');
    await repo.commit('add gitignore');
    await repo.write('ignored/secret.txt', 'nope\n');

    const range = await resolveRange('HEAD', { cwd: repo.dir });

    expect((await listChangedFiles(range, { cwd: repo.dir })).map((f) => f.path))
      .not.toContain('ignored/secret.txt');
  });

  it('returns the real path for a file with a non-ASCII name', async () => {
    await repo.write('src/café.ts', 'const x = 1;\n');

    const range = await resolveRange('HEAD', { cwd: repo.dir });
    const files = await listChangedFiles(range, { cwd: repo.dir });

    expect(files.find((f) => f.path === 'src/café.ts')).toBeDefined();
    expect(files.find((f) => f.path.includes('caf\\3'))).toBeUndefined();
  });
});

describe('renameMap', () => {
  it('maps a renamed file to its old path', () => {
    const files = [
      { path: 'src/renamed.ts', oldPath: 'src/keep.ts', status: 'renamed' as const,
        additions: 0, deletions: 0, binary: false },
      { path: 'src/other.ts', oldPath: 'src/other.ts', status: 'modified' as const,
        additions: 0, deletions: 0, binary: false },
    ];

    const map = renameMap(files);
    expect(map.get('src/renamed.ts')).toBe('src/keep.ts');
    expect(map.has('src/other.ts')).toBe(false);
  });
});

describe('readSide', () => {
  it('rejects a path that resolves outside the repository root', async () => {
    const range = await resolveRange('HEAD', { cwd: repo.dir });

    // Compute the exact traversal from repo.dir to a real file outside it,
    // rather than guessing a fixed number of `..` segments — the right count
    // depends on how deep the OS puts temp directories, which varies by platform.
    const outside = join(tmpdir(), `web-review-outside-${process.pid}.txt`);
    await writeFile(outside, 'secret\n', 'utf8');
    try {
      const traversal = relative(repo.dir, outside);
      expect(await readSide(traversal, 'new', range, { cwd: repo.dir })).toBeNull();
    } finally {
      await rm(outside, { force: true });
    }
  });


  it('reads the old side from the base commit', async () => {
    await repo.write('src/keep.ts', 'changed\n');
    const range = await resolveRange('HEAD', { cwd: repo.dir });

    expect(await readSide('src/keep.ts', 'old', range, { cwd: repo.dir }))
      .toBe('const a = 1;\n');
  });

  it('reads the new side from the working tree', async () => {
    await repo.write('src/keep.ts', 'changed\n');
    const range = await resolveRange('HEAD', { cwd: repo.dir });

    expect(await readSide('src/keep.ts', 'new', range, { cwd: repo.dir }))
      .toBe('changed\n');
  });

  it('returns null for a side where the file does not exist', async () => {
    const range = await resolveRange('HEAD', { cwd: repo.dir });

    expect(await readSide('src/fresh.ts', 'old', range, { cwd: repo.dir })).toBeNull();
    expect(await readSide('src/nope.ts', 'new', range, { cwd: repo.dir })).toBeNull();
  });

  it('reads the new side from the index in staged mode', async () => {
    await repo.write('src/keep.ts', 'staged\n');
    await repo.run('add', 'src/keep.ts');
    await repo.write('src/keep.ts', 'working tree only\n');

    const range = await resolveRange('staged', { cwd: repo.dir });

    expect(await readSide('src/keep.ts', 'new', range, { cwd: repo.dir })).toBe('staged\n');
  });

  it('round-trips a file with no trailing newline on the old side', async () => {
    await repo.write('src/keep.ts', 'no newline at end');
    await repo.run('add', 'src/keep.ts');
    await repo.commit('file without newline');
    await repo.write('src/keep.ts', 'changed\n');

    const range = await resolveRange('HEAD', { cwd: repo.dir });

    expect(await readSide('src/keep.ts', 'old', range, { cwd: repo.dir }))
      .toBe('no newline at end');
  });

  it('round-trips a file with no trailing newline on the staged new side', async () => {
    await repo.write('src/keep.ts', 'staged no newline');
    await repo.run('add', 'src/keep.ts');

    const range = await resolveRange('staged', { cwd: repo.dir });

    expect(await readSide('src/keep.ts', 'new', range, { cwd: repo.dir }))
      .toBe('staged no newline');
  });

  it('reads a file with a non-ASCII name from both sides', async () => {
    await repo.write('src/café.ts', 'const a = 1;\n');
    await repo.commit('add café');
    await repo.write('src/café.ts', 'const a = 2;\n');

    const range = await resolveRange('HEAD', { cwd: repo.dir });

    expect(await readSide('src/café.ts', 'old', range, { cwd: repo.dir }))
      .toBe('const a = 1;\n');
    expect(await readSide('src/café.ts', 'new', range, { cwd: repo.dir }))
      .toBe('const a = 2;\n');
  });

  it('throws for a bad ref, distinguishing from a missing file', async () => {
    const range = await resolveRange('HEAD', { cwd: repo.dir });

    // Create a range with a bad ref
    const badRange = { ...range, base: 'nonexistent-ref' };

    // Should throw because the ref is bad
    await expect(readSide('src/keep.ts', 'old', badRange, { cwd: repo.dir }))
      .rejects.toThrow();

    // Should return null because the file doesn't exist on the valid ref
    const missingFile = await readSide('nonexistent.ts', 'old', range, { cwd: repo.dir });
    expect(missingFile).toBeNull();
  });
});
