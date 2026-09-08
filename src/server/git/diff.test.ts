import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRepo, type TestRepo } from '../test-helpers/repo.js';
import { resolveRange } from './range.js';
import { listChangedFiles } from './files.js';
import { numberHunks, readFileDiff } from './diff.js';

describe('numberHunks', () => {
  it('numbers context, additions and deletions from the hunk header', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      'index 1111111..2222222 100644',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -44,4 +44,5 @@',
      ' port: number;',
      '-stop: boolean;',
      '+stop: boolean;',
      '+prepare: boolean;',
      ' serveInternal: boolean;',
      '',
    ].join('\n');

    expect(numberHunks(diff)).toEqual([
      { kind: 'hunk', old: null, new: null, text: '@@ -44,4 +44,5 @@' },
      { kind: 'context', old: 44, new: 44, text: 'port: number;' },
      { kind: 'del', old: 45, new: null, text: 'stop: boolean;' },
      { kind: 'add', old: null, new: 45, text: 'stop: boolean;' },
      { kind: 'add', old: null, new: 46, text: 'prepare: boolean;' },
      { kind: 'context', old: 46, new: 47, text: 'serveInternal: boolean;' },
    ]);
  });

  it('keeps counters independent across several hunks', () => {
    const diff = [
      '@@ -1,2 +1,2 @@',
      '-one',
      '+ONE',
      ' two',
      '@@ -20,1 +20,2 @@',
      ' twenty',
      '+twenty-one',
      '',
    ].join('\n');

    expect(numberHunks(diff).filter((l) => l.kind !== 'hunk')).toEqual([
      { kind: 'del', old: 1, new: null, text: 'one' },
      { kind: 'add', old: null, new: 1, text: 'ONE' },
      { kind: 'context', old: 2, new: 2, text: 'two' },
      { kind: 'context', old: 20, new: 20, text: 'twenty' },
      { kind: 'add', old: null, new: 21, text: 'twenty-one' },
    ]);
  });

  it('accepts a hunk header without a line count', () => {
    const diff = ['@@ -7 +7 @@', '-old', '+new', ''].join('\n');

    expect(numberHunks(diff).filter((l) => l.kind !== 'hunk')).toEqual([
      { kind: 'del', old: 7, new: null, text: 'old' },
      { kind: 'add', old: null, new: 7, text: 'new' },
    ]);
  });

  it('keeps an empty context line, which git writes as a single space', () => {
    const diff = ['@@ -1,3 +1,3 @@', ' a', ' ', '-b', '+B', ''].join('\n');

    expect(numberHunks(diff).filter((l) => l.kind === 'context')).toEqual([
      { kind: 'context', old: 1, new: 1, text: 'a' },
      { kind: 'context', old: 2, new: 2, text: '' },
    ]);
  });

  it('drops the no-newline marker, which is not a reviewable line', () => {
    const diff = ['@@ -1 +1 @@', '-a', '\\ No newline at end of file', '+a', ''].join('\n');

    expect(numberHunks(diff).map((l) => l.kind)).toEqual(['hunk', 'del', 'add']);
  });

  it('returns nothing for a diff with no hunks', () => {
    expect(numberHunks('')).toEqual([]);
    expect(numberHunks('diff --git a/x b/x\nindex 111..222\n')).toEqual([]);
  });
});

describe('readFileDiff', () => {
  let repo: TestRepo;

  beforeEach(async () => {
    repo = await createRepo();
    await repo.write('src/keep.ts', 'const a = 1;\nconst b = 2;\n');
    await repo.commit('initial');
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('reads one file and ignores the others', async () => {
    await repo.write('src/keep.ts', 'const a = 1;\nconst b = 3;\n');
    await repo.write('src/other.ts', 'const c = 4;\n');
    await repo.commit('touch two files');

    const range = await resolveRange('HEAD~1', { cwd: repo.dir });
    const files = await listChangedFiles(range, { cwd: repo.dir });
    const keep = files.find((f) => f.path === 'src/keep.ts')!;

    const numbered = numberHunks(await readFileDiff(keep, range, { cwd: repo.dir }));
    expect(numbered.some((l) => l.text.includes('const c = 4;'))).toBe(false);
    expect(numbered).toContainEqual({ kind: 'add', old: null, new: 2, text: 'const b = 3;' });
  });

  it('still sees a rename as a rename when limited to one file', async () => {
    await repo.run('mv', 'src/keep.ts', 'src/moved.ts');
    await repo.write('src/moved.ts', 'const a = 1;\nconst b = 9;\n');
    await repo.commit('rename and edit');

    const range = await resolveRange('HEAD~1', { cwd: repo.dir });
    const files = await listChangedFiles(range, { cwd: repo.dir });
    const moved = files.find((f) => f.path === 'src/moved.ts')!;
    expect(moved.status).toBe('renamed');

    const numbered = numberHunks(await readFileDiff(moved, range, { cwd: repo.dir }));
    expect(numbered).toContainEqual({ kind: 'add', old: null, new: 2, text: 'const b = 9;' });
    expect(numbered.filter((l) => l.kind === 'add')).toHaveLength(1);
  });

  it('returns an empty diff for an untracked file, which git diff never lists', async () => {
    await repo.write('src/fresh.ts', 'const d = 4;\n');

    const range = await resolveRange('HEAD', { cwd: repo.dir });
    const files = await listChangedFiles(range, { cwd: repo.dir });
    const fresh = files.find((f) => f.path === 'src/fresh.ts')!;

    expect(numberHunks(await readFileDiff(fresh, range, { cwd: repo.dir }))).toEqual([]);
  });

  it('reads the index rather than the working tree for a staged range', async () => {
    await repo.write('src/keep.ts', 'const a = 1;\nconst b = 7;\n');
    await repo.run('add', 'src/keep.ts');
    await repo.write('src/keep.ts', 'const a = 1;\nconst b = 8;\n');

    const range = await resolveRange('staged', { cwd: repo.dir });
    const files = await listChangedFiles(range, { cwd: repo.dir });
    const keep = files.find((f) => f.path === 'src/keep.ts')!;

    const numbered = numberHunks(await readFileDiff(keep, range, { cwd: repo.dir }));
    expect(numbered).toContainEqual({ kind: 'add', old: null, new: 2, text: 'const b = 7;' });
  });

  it('numbers correctly regardless of the user\'s ~/.gitconfig', async () => {
    // `readFileDiff` parses git's human-readable text, not `-z` porcelain, so
    // it inherits whatever the invoking user's config says. Three settings
    // are each independently capable of corrupting it: `color.ui=always`
    // ANSI-wraps the `@@` header so the HUNK regex misses it; `diff.external`
    // replaces the whole diff engine, so there is no unified-diff text at
    // all; `diff.suppressBlankEmpty=true` turns a blank context line's
    // leading space into an empty string, which is indistinguishable from
    // `split('\n')`'s trailing artefact and silently desyncs every line
    // number after it. All three are set at once here, because a real
    // `~/.gitconfig` in the wild often carries more than one of them.
    await repo.run('config', 'color.ui', 'always');
    await repo.run('config', 'diff.external', 'echo');
    await repo.run('config', 'diff.suppressBlankEmpty', 'true');

    // A blank context line (line 2) is the specific case suppressBlankEmpty
    // corrupts: only a genuinely empty line reveals the difference between
    // "git wrote a single space" and "git wrote nothing at all".
    await repo.write('src/blank.ts', 'const a = 1;\n\nconst b = 2;\nconst c = 3;\n');
    await repo.commit('add blank.ts');
    await repo.write('src/blank.ts', 'const a = 1;\n\nconst b = 2;\nconst c = 4;\n');
    await repo.commit('change c');

    const range = await resolveRange('HEAD~1', { cwd: repo.dir });
    const files = await listChangedFiles(range, { cwd: repo.dir });
    const blank = files.find((f) => f.path === 'src/blank.ts')!;

    const numbered = numberHunks(await readFileDiff(blank, range, { cwd: repo.dir }));
    expect(numbered).toEqual([
      { kind: 'hunk', old: null, new: null, text: '@@ -1,4 +1,4 @@' },
      { kind: 'context', old: 1, new: 1, text: 'const a = 1;' },
      { kind: 'context', old: 2, new: 2, text: '' },
      { kind: 'context', old: 3, new: 3, text: 'const b = 2;' },
      { kind: 'del', old: 4, new: null, text: 'const c = 3;' },
      { kind: 'add', old: null, new: 4, text: 'const c = 4;' },
    ]);
  });
});
