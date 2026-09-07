# `--prepare` Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only `--prepare` mode to the `web-review` CLI that prints the resolved diff range and a two-column line-numbered diff, so an agent can write `request.json` from one command instead of grepping every changed file.

**Architecture:** One impure function per changed file (`git diff -M -U3 <base> -- <path>`) in `src/server/git/diff.ts`, one pure numbering function beside it, and one pure renderer in `src/server/review/prepare.ts` that owns every output bound. `cli.ts` wires them and writes plain text to stdout, branching out of `main()` before any state, lock or server code runs.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node 18+, Vitest (`server` project, node environment), esbuild bundle to `dist/web-review.mjs`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-07-prepare-mode-design.md`. Read it first.
- All prose, comments and commit messages in English.
- Import specifiers inside `src/` end in `.js`, even for `.ts` files (ESM + `moduleResolution: nodenext`).
- Only `src/server/git/` may run `git`. Everything hard is a pure function.
- Never write to the working tree; `--prepare` writes nothing at all.
- `npm run typecheck` and `npm test` must pass before every commit.
- `dist/` and `app/dist/` are committed. `npm run build` runs before the final commit or CI fails on `git diff --exit-code dist app/dist`.
- Tests are colocated: `foo.ts` is tested by `foo.test.ts` in the same directory.
- Bounds, exact values: `PER_FILE_LIMIT = 400`, `TOTAL_LIMIT = 2000`.

---

### Task 1: Per-file diff reading and hunk numbering

**Files:**
- Create: `src/server/git/diff.ts`
- Test: `src/server/git/diff.test.ts`

**Interfaces:**
- Consumes: `gitRaw`, `GitOptions` from `./exec.js`; `DiffRange` from `./range.js`; `FileEntry` from `../../shared/types.js`.
- Produces:
  - `export type LineKind = 'hunk' | 'context' | 'add' | 'del'`
  - `export interface NumberedLine { kind: LineKind; old: number | null; new: number | null; text: string }`
  - `export function numberHunks(text: string): NumberedLine[]`
  - `export function readFileDiff(entry: FileEntry, range: DiffRange, opts: GitOptions): Promise<string>`

- [ ] **Step 1: Write the failing test**

Create `src/server/git/diff.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run --project server src/server/git/diff.test.ts`
Expected: FAIL — `Failed to resolve import "./diff.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/server/git/diff.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run --project server src/server/git/diff.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/server/git/diff.ts src/server/git/diff.test.ts
git commit -m "feat: read and number a single file's diff

Per-file rather than one combined diff: it keeps git's own path quoting
out of the parser, and lets a caller skip an oversized file before doing
the work rather than after."
```

---

### Task 2: The renderer and its bounds

**Files:**
- Create: `src/server/review/prepare.ts`
- Test: `src/server/review/prepare.test.ts`

**Interfaces:**
- Consumes: `NumberedLine` from `../git/diff.js`; `splitLines` from `./anchor.js`; `FileEntry` from `../../shared/types.js`.
- Produces:
  - `export const PER_FILE_LIMIT = 400`
  - `export const TOTAL_LIMIT = 2000`
  - `export interface PreparedFile { entry: FileEntry; lines: NumberedLine[] | null }`
  - `export function isTooLarge(entry: FileEntry): boolean`
  - `export function wholeFileAsAdditions(content: string): NumberedLine[]`
  - `export function renderPrepare(range: { base: string; label: string }, files: PreparedFile[]): string`

`lines: null` means the body was never fetched — the file is binary, or `isTooLarge` said so.

- [ ] **Step 1: Write the failing test**

Create `src/server/review/prepare.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { NumberedLine } from '../git/diff.js';
import type { FileEntry } from '../../shared/types.js';
import {
  PER_FILE_LIMIT,
  TOTAL_LIMIT,
  isTooLarge,
  renderPrepare,
  wholeFileAsAdditions,
  type PreparedFile,
} from './prepare.js';

function entry(over: Partial<FileEntry> = {}): FileEntry {
  return {
    path: 'src/cli.ts',
    oldPath: 'src/cli.ts',
    status: 'modified',
    additions: 2,
    deletions: 1,
    binary: false,
    ...over,
  };
}

const HEADER = { base: 'HEAD', label: 'working tree vs HEAD' };

const SAMPLE: NumberedLine[] = [
  { kind: 'hunk', old: null, new: null, text: '@@ -44,4 +44,5 @@' },
  { kind: 'context', old: 44, new: 44, text: 'port: number;' },
  { kind: 'del', old: 46, new: null, text: 'stop: boolean;' },
  { kind: 'add', old: null, new: 46, text: 'stop: boolean;' },
  { kind: 'context', old: 47, new: 48, text: 'serveInternal: boolean;' },
];

function body(lines: NumberedLine[], n = 1): NumberedLine[] {
  return Array.from({ length: n }, (_, i) => lines[i % lines.length]!);
}

describe('renderPrepare', () => {
  it('renders two number columns, the marker, and the line verbatim', () => {
    const out = renderPrepare(HEADER, [{ entry: entry(), lines: SAMPLE }]);

    expect(out).toBe(
      [
        'range: working tree vs HEAD (base HEAD)',
        '1 file changed',
        '',
        '  old  new',
        '== src/cli.ts  modified  +2 -1',
        '@@ -44,4 +44,5 @@',
        '   44   44    port: number;',
        '   46    .  - stop: boolean;',
        '    .   46  + stop: boolean;',
        '   47   48    serveInternal: boolean;',
        '',
      ].join('\n'),
    );
  });

  it('shortens a full sha in the range line but leaves a symbolic ref alone', () => {
    const sha = '3f2a1c9b8e7d6c5b4a3928170615243342516273';
    expect(
      renderPrepare({ base: sha, label: 'branch vs main' }, [{ entry: entry(), lines: SAMPLE }]),
    ).toContain('range: branch vs main (base 3f2a1c9)');
  });

  it('names the old path of a rename in the header', () => {
    const out = renderPrepare(HEADER, [
      { entry: entry({ path: 'src/new.ts', oldPath: 'src/old.ts', status: 'renamed' }), lines: SAMPLE },
    ]);
    expect(out).toContain('== src/new.ts  renamed from src/old.ts  +2 -1');
  });

  it('shows a binary file as a header only and says so', () => {
    const out = renderPrepare(HEADER, [
      { entry: entry({ path: 'logo.png', binary: true, additions: 0, deletions: 0 }), lines: null },
    ]);
    expect(out).toContain('== logo.png  modified  binary — not shown');
    expect(out).not.toContain('@@');
  });

  it('truncates an oversized file and announces it instead of dropping it silently', () => {
    const out = renderPrepare(HEADER, [
      { entry: entry({ path: 'dist/index.js', additions: 4200, deletions: 3800 }), lines: null },
    ]);
    expect(out).toContain(
      '== dist/index.js  modified  +4200 -3800  — too large, truncated; read the file yourself if you need it',
    );
  });

  it('truncates a file whose context lines push it over the per-file bound', () => {
    const out = renderPrepare(HEADER, [
      { entry: entry({ additions: 1, deletions: 0 }), lines: body(SAMPLE, PER_FILE_LIMIT + 1) },
    ]);
    expect(out).toContain('— too large, truncated');
    expect(out).not.toContain('@@');
  });

  it('omits the files that no longer fit the total bound, naming each one', () => {
    const big = Math.floor(TOTAL_LIMIT / PER_FILE_LIMIT) + 1;
    const files: PreparedFile[] = Array.from({ length: big + 1 }, (_, i) => ({
      entry: entry({ path: `src/f${i}.ts` }),
      lines: body(SAMPLE, PER_FILE_LIMIT),
    }));

    const out = renderPrepare(HEADER, files);
    expect(out).toContain(`== src/f${big}.ts  modified  +2 -1  — omitted, output limit reached`);
    expect(out).toContain('== src/f0.ts  modified  +2 -1\n@@');
  });

  it('pluralises the file count', () => {
    const two = renderPrepare(HEADER, [
      { entry: entry({ path: 'a.ts' }), lines: SAMPLE },
      { entry: entry({ path: 'b.ts' }), lines: SAMPLE },
    ]);
    expect(two).toContain('2 files changed');
  });
});

describe('isTooLarge', () => {
  it('is the sum of both sides against the per-file bound', () => {
    expect(isTooLarge(entry({ additions: PER_FILE_LIMIT, deletions: 0 }))).toBe(false);
    expect(isTooLarge(entry({ additions: PER_FILE_LIMIT, deletions: 1 }))).toBe(true);
  });
});

describe('wholeFileAsAdditions', () => {
  it('numbers an untracked file from 1', () => {
    expect(wholeFileAsAdditions('a\nb\n')).toEqual([
      { kind: 'add', old: null, new: 1, text: 'a' },
      { kind: 'add', old: null, new: 2, text: 'b' },
    ]);
  });

  it('returns nothing for an empty file', () => {
    expect(wholeFileAsAdditions('')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run --project server src/server/review/prepare.test.ts`
Expected: FAIL — `Failed to resolve import "./prepare.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/server/review/prepare.ts`:

```ts
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

function renderLine(line: NumberedLine): string {
  if (line.kind === 'hunk') return line.text;
  return `${column(line.old)}${column(line.new)}  ${marker(line.kind)} ${line.text}`;
}

function counts(entry: FileEntry): string {
  return `+${entry.additions} -${entry.deletions}`;
}

function statusLabel(entry: FileEntry): string {
  return entry.status === 'renamed' && entry.oldPath ?
      `renamed from ${entry.oldPath}`
    : entry.status;
}

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
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run --project server src/server/review/prepare.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/server/review/prepare.ts src/server/review/prepare.test.ts
git commit -m "feat: render a bounded, two-column numbered diff

Both bounds live here, and each one announces itself on the file it
applies to — the committed bundles must never be able to make this mode
cost more than the greps it replaces, and must never disappear silently."
```

---

### Task 3: Wire `--prepare` into the CLI

**Files:**
- Modify: `src/server/cli.ts`
- Test: `src/server/cli.test.ts`, `src/server/cli.e2e.test.ts`

**Interfaces:**
- Consumes: everything produced by Tasks 1 and 2, plus the existing `resolveRange`, `listChangedFiles`, `repoRoot`.
- Produces: `CliOptions` gains `prepare: boolean`.

- [ ] **Step 1: Write the failing unit test**

In `src/server/cli.test.ts`, add `prepare: false` to the shared `defaults` object, then add inside `describe('parseArgs', …)`:

```ts
  it('recognises --prepare', () => {
    expect(parseArgs(['--prepare'])).toEqual({ ...defaults, prepare: true });
  });

  it('combines --prepare with a base', () => {
    expect(parseArgs(['--prepare', '--staged'])).toEqual({
      ...defaults,
      prepare: true,
      base: 'staged',
    });
  });
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npx vitest run --project server src/server/cli.test.ts`
Expected: FAIL — the existing default cases fail on the new `prepare` key, and the two new cases fail too.

- [ ] **Step 3: Implement `parseArgs`**

In `src/server/cli.ts`, add `prepare: boolean;` to the `CliOptions` interface, `prepare: false,` to the defaults in `parseArgs`, and this branch above the `arg.startsWith('-')` catch-all:

```ts
    else if (arg === '--prepare') options.prepare = true;
```

- [ ] **Step 4: Run it and verify it passes**

Run: `npx vitest run --project server src/server/cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement the mode**

In `src/server/cli.ts`, add the imports:

```ts
import { numberHunks, readFileDiff } from './git/diff.js';
import {
  isTooLarge,
  renderPrepare,
  wholeFileAsAdditions,
  type PreparedFile,
} from './review/prepare.js';
```

Add this beside `emit`, reusing the same flush-before-exit reasoning documented on it:

```ts
/** `emit`'s plain-text twin, for `--prepare`, which produces no `CliResult` to frame. */
function emitText(text: string, code = 0, stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(text, () => process.exit(code));
}
```

Add this function above `main`:

```ts
/**
 * `--prepare`: print the range and a line-numbered diff, and nothing else.
 *
 * Strictly read-only. It never reads or consumes request.json, never touches
 * state.json, never takes the spawn lock and never starts a server, so it is
 * safe to run at any point — including while a round is open.
 */
async function prepareMain(root: string, options: CliOptions): Promise<void> {
  const range = await resolveRange(options.base, { cwd: root });
  const files = await listChangedFiles(range, { cwd: root });
  if (files.length === 0) {
    emitText('no changes\n');
    return;
  }

  const prepared: PreparedFile[] = [];
  for (const entry of files) {
    if (entry.binary || isTooLarge(entry)) {
      prepared.push({ entry, lines: null });
      continue;
    }

    const lines = numberHunks(await readFileDiff(entry, range, { cwd: root }));

    // `git diff` never lists an untracked file, so an added file with no
    // hunks is one git has never seen. Read it off disk instead; an added
    // file that really is empty renders as nothing either way.
    if (lines.length === 0 && entry.status === 'added') {
      const content = await readSide(entry.path, 'new', range, { cwd: root });
      prepared.push({ entry, lines: wholeFileAsAdditions(content ?? '') });
      continue;
    }

    prepared.push({ entry, lines });
  }

  emitText(renderPrepare(range, prepared));
}
```

Then, inside `main`, immediately after the `root === null` check and **before** `resolveGitDir` (the mode needs no state directory), insert:

```ts
  if (options.prepare) {
    // Plain text end to end, including failures: this mode never emits a
    // framed CliResult, so an agent parsing it must not have to handle two
    // output shapes from one command.
    try {
      await prepareMain(root, options);
    } catch (error) {
      emitText(
        `web-review: ${error instanceof Error ? error.message : 'unexpected error'}\n`,
        1,
        process.stderr,
      );
    }
    return;
  }
```

Finally, change the `root === null` branch so it too stays plain text under `--prepare`:

```ts
  if (root === null) {
    if (options.prepare) {
      emitText('web-review: not a git repository\n', 1, process.stderr);
      return;
    }
    emit(errorResult('not a git repository'), 1);
    return;
  }
```

- [ ] **Step 6: Write the failing end-to-end test**

In `src/server/cli.e2e.test.ts`, add a plain-text runner beside the existing `cli` helper:

```ts
async function prepare(args: string[] = []): Promise<{ stdout: string; stderr: string }> {
  return run(process.execPath, [CLI, '--prepare', ...args], { cwd: repo.dir }).catch(
    (error: { stdout?: string; stderr?: string }) => ({
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    }),
  );
}
```

and, inside `describe('the CLI', …)`:

```ts
  it('prepares a numbered diff without opening a round or a server', async () => {
    await repo.write('src/auth.ts', 'export function sign() {\n  return 2;\n}\n');

    const { stdout } = await prepare();

    expect(stdout).toContain('range: working tree vs HEAD');
    expect(stdout).toContain('  old  new');
    expect(stdout).toContain('== src/auth.ts  modified');
    expect(stdout).toContain('    .    2  +   return 2;');

    const stateDir = join((await run('git', ['rev-parse', '--absolute-git-dir'], { cwd: repo.dir })).stdout.trim(), 'web-review');
    expect(await readFile(join(stateDir, 'state.json'), 'utf8').catch(() => null)).toBeNull();
    expect(await readServerRecord(stateDir)).toBeNull();
  });

  it('leaves request.json untouched, so a later round still carries it', async () => {
    await repo.write('src/auth.ts', 'export function sign() {\n  return 2;\n}\n');
    const stateDir = join((await run('git', ['rev-parse', '--absolute-git-dir'], { cwd: repo.dir })).stdout.trim(), 'web-review');
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'request.json'), JSON.stringify({ summary: 'kept' }), 'utf8');

    await prepare();

    expect(await readFile(join(stateDir, 'request.json'), 'utf8')).toContain('kept');
  });

  it('numbers an untracked file from 1, which git diff never lists', async () => {
    await repo.write('src/fresh.ts', 'const a = 1;\nconst b = 2;\n');

    const { stdout } = await prepare();

    expect(stdout).toContain('== src/fresh.ts  added');
    expect(stdout).toContain('    .    1  + const a = 1;');
  });

  it('says so in plain text, never framed JSON, when the base ref is unknown', async () => {
    await repo.write('src/auth.ts', 'export function sign() {\n  return 2;\n}\n');

    const { stdout, stderr } = await prepare(['--base', 'no-such-ref']);

    expect(stderr).toContain('web-review: unknown base ref: no-such-ref');
    expect(stdout).not.toContain('<<<WEB_REVIEW_RESULT');
  });

  it('reports an empty range as plain text', async () => {
    const { stdout } = await prepare();
    expect(stdout.trim()).toBe('no changes');
  });
```

- [ ] **Step 7: Run the whole suite and verify it passes**

Run: `npm test`
Expected: PASS. The e2e project rebuilds `dist/web-review.mjs` in its `beforeAll`, so the new mode is exercised through the real bundle.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/server/cli.ts src/server/cli.test.ts src/server/cli.e2e.test.ts
git commit -m "feat: add the --prepare CLI mode

Read-only and idempotent: it branches out before any state, lock or
server code, so it can be run at any point, including while a round is
already open."
```

---

### Task 4: Document the mode and rebuild

**Files:**
- Modify: `SKILL.md`, `AGENTS.md`
- Modify (generated): `dist/web-review.mjs`

`SKILL.md` and `AGENTS.md` carry the same body text today and must keep doing so. `AGENTS.md` has a short preamble of its own above it; leave that alone.

- [ ] **Step 1: Add the new step to both files**

In both `SKILL.md` and `AGENTS.md`, insert this as a new step **before** the current step 1, and renumber the three existing steps to 2, 3 and 4:

````markdown
1. Get the changed files and their line numbers in one call, from the
   repository root:

   ```bash
   node <skill path>/dist/web-review.mjs --prepare
   ```

   It prints the diff with the line number each line has on each side:

   ```
     old  new
   == src/auth.ts  modified  +2 -1
   @@ -86,4 +86,5 @@
      86   86    const token = sign(user);
      88    .  - await wait(500);
       .   88  + await wait(delay);
      89   90    return token;
   ```

   Read the number off the column matching the `side` you want to annotate:
   the `new` column for `side: "new"`, the `old` column for `side: "old"`.
   Do not count lines yourself, and do not grep for them.

   This is read-only: it opens no review and can be run at any time. A file
   that is binary or very large is shown as a header only, and says so —
   read that one yourself if you need it.
````

- [ ] **Step 2: Point the annotation step at those numbers**

In the step that describes `request.json` (now step 2 in both files), replace the sentence:

> Annotations are for genuine uncertainty — hesitations, assumed debt, things
> worth a second pair of eyes. Do not annotate lines you are confident about.

with:

> Annotations are for genuine uncertainty — hesitations, assumed debt, things
> worth a second pair of eyes. Do not annotate lines you are confident about.
> Take every `line` from the columns printed in step 1; a line number that does
> not exist is an error, not a near miss.

- [ ] **Step 3: Verify the two files still agree**

Run:

```bash
diff <(sed -n '/^# web-review$/,$p' SKILL.md) <(sed -n '/^# web-review$/,$p' AGENTS.md)
```

Expected: no output.

- [ ] **Step 4: Rebuild the committed bundle**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 5: Verify the tree is clean against the build**

Run: `npm test && npm run typecheck && git diff --exit-code app/dist`
Expected: tests pass, typecheck passes, and `app/dist` is unchanged — this task touches no browser code. `dist/web-review.mjs` *will* differ; that is the point.

- [ ] **Step 6: Commit**

```bash
git add SKILL.md AGENTS.md dist
git commit -m "docs: tell the agent to start from --prepare

Without this the mode is dead code: nothing in the agent's instructions
would ever cause it to be run."
```
