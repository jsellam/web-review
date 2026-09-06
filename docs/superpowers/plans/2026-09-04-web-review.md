# web-review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local, GitHub-shaped code review UI that a coding agent opens after editing, and that hands the human's line-anchored comments back to the agent as structured JSON.

**Architecture:** A re-entrant blocking CLI starts a detached `node:http` server on loopback and long-polls it; the server shells out to `git` and serves a pre-built React bundle; all diff rendering, highlighting and layout happen in the browser. Review state persists in `.git/web-review/` so comment threads survive across rounds.

**Tech Stack:** TypeScript 5, Node >= 18.17, esbuild (server bundle), Vite + React 19 (app), Ant Design 5, `@git-diff-view/react` 0.1.7, zustand, Vitest 3 + React Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-04-web-review-design.md`

## Global Constraints

- Node engine floor: `>=18.17`. The server bundle targets `node18`.
- The server bundle has **zero runtime dependencies**: everything is inlined by esbuild. No `node_modules` at the user's site, no network, no install step.
- `@git-diff-view/react` is pinned to the **exact** version `0.1.7` (no `^`, no `~`) and is imported in exactly one directory: `app/src/components/DiffPane/`.
- All committed prose — code comments, docs, CLI output, UI copy — is in **English**. This is a public open-source repo.
- Review state and agent input live under `.git/web-review/`, never at the repo root, so they never appear as untracked files inside the diff under review.
- The server binds `127.0.0.1` only. Every `/api/*` request is checked for both a valid `X-Review-Token` header and a `Host` header matching `127.0.0.1:<port>` or `localhost:<port>`.
- Default foreground timeout is `540` seconds.
- Files with more than `1000` diff lines collapse by default.
- Build artifacts `dist/` and `app/dist/` are committed and must be in sync with source; CI enforces this.

---

## File Structure

**Server** (bundled by esbuild into `dist/web-review.mjs`):

| File | Responsibility |
|---|---|
| `src/shared/types.ts` | The JSON contract. Imported by server *and* app. Types only. |
| `src/shared/protocol.ts` | stdout framing markers, `frameResult`, `parseFramed`. Pure. |
| `src/server/git/exec.ts` | The only place that spawns `git`. `GitError`. |
| `src/server/git/range.ts` | Resolve `auto` / `HEAD` / `staged` / `<ref>` into a `DiffRange`. |
| `src/server/git/files.ts` | Enumerate changed files (incl. untracked), read either side of a file. |
| `src/server/review/request.ts` | Read and validate `.git/web-review/request.json`. Pure validator. |
| `src/server/review/anchor.ts` | Create and relocate thread anchors. Pure. The hard algorithm. |
| `src/server/review/state.ts` | Read/write `.git/web-review/state.json`; merge a submission. |
| `src/server/review/result.ts` | Build the `CliResult` payloads. Pure. |
| `src/server/http/security.ts` | Token generation, token check, Host check. Pure. |
| `src/server/http/static.ts` | Serve `app/dist` with content types and index fallback. |
| `src/server/http/routes.ts` | The four `/api` routes. |
| `src/server/http/server.ts` | `node:http` lifecycle, waiter registry, `server.json` record. |
| `src/server/cli.ts` | Flags, detach, re-attach, timeout, browser launch, stdout. |

**App** (bundled by Vite into `app/dist/`):

| File | Responsibility |
|---|---|
| `app/src/api/client.ts` | Typed client for the four endpoints. |
| `app/src/state/draft.ts` | Draft comments, replies, resolve toggles (zustand). |
| `app/src/theme.ts` | AntD algorithm selection + design tokens -> CSS variables. |
| `app/src/components/DiffPane/` | The only importer of `@git-diff-view/react`. |
| `app/src/components/FileTree/` | AntD `Tree` of changed files with comment badges. |
| `app/src/components/FileSection/` | Per-file collapsible card, stats, Viewed checkbox. |
| `app/src/components/SummaryPanel/` | The agent's markdown summary. |
| `app/src/components/CommentThread/` | Thread rendering: messages, status, resolve. |
| `app/src/components/CommentComposer/` | New comment / reply textarea. |
| `app/src/components/SubmitDrawer/` | General comment, verdict radio, submit. |
| `app/src/App.tsx` | Layout, session loading, view mode, wiring. |

**Docs:** `README.md`, `SKILL.md`, `AGENTS.md`, `CLAUDE.md`.

---

### Task 1: Scaffolding, build pipeline, and the stdout protocol

Sets up the repo so every later task has a test runner and a build. Proven by a real unit under test: the stdout framing both the CLI and its tests depend on.

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.app.json`, `vitest.config.ts`, `scripts/build-server.mjs`, `app/vite.config.ts`, `app/index.html`, `app/src/main.tsx`, `app/src/test-setup.ts`, `.gitignore`, `.gitattributes`, `.github/workflows/ci.yml`
- Create: `src/shared/types.ts`, `src/shared/protocol.ts`, `src/server/cli.ts` (stub)
- Test: `src/shared/protocol.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: every type in `src/shared/types.ts` (Step 3 — later tasks import from here); `RESULT_START`, `RESULT_END`, `frameResult(result: CliResult): string`, `parseFramed(text: string): CliResult`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "web-review",
  "version": "0.1.0",
  "license": "MIT",
  "type": "module",
  "engines": { "node": ">=18.17" },
  "scripts": {
    "build": "npm run build:app && npm run build:server",
    "build:app": "vite build --config app/vite.config.ts",
    "build:server": "node scripts/build-server.mjs",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.app.json --noEmit"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.6.3",
    "@testing-library/react": "^16.1.0",
    "@testing-library/user-event": "^14.5.2",
    "@types/node": "^22.10.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.4",
    "esbuild": "^0.24.0",
    "jsdom": "^25.0.1",
    "typescript": "^5.7.0",
    "vite": "^6.0.0",
    "vitest": "^3.0.0"
  },
  "dependencies": {
    "@ant-design/icons": "^5.5.0",
    "@git-diff-view/react": "0.1.7",
    "antd": "^5.22.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "zustand": "^5.0.0"
  }
}
```

Note: `dependencies` are build-time only. They are bundled into `app/dist`; the shipped tool never installs them.

- [ ] **Step 2: Create the TypeScript and test configs**

`tsconfig.json` (server + shared):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "noEmit": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src/**/*", "scripts/**/*"]
}
```

`tsconfig.app.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "noEmit": true,
    "verbatimModuleSyntax": true
  },
  "include": ["app/src/**/*", "src/shared/**/*"]
}
```

`vitest.config.ts` — two projects, matching the spec's split:

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'server',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'app',
          environment: 'jsdom',
          include: ['app/src/**/*.test.{ts,tsx}'],
          setupFiles: ['app/src/test-setup.ts'],
        },
      },
    ],
  },
});
```

`app/src/test-setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';
```

- [ ] **Step 3: Create `src/shared/types.ts`**

This is the whole JSON contract. Every later task imports from here; do not redefine these shapes locally.

```ts
export type Side = 'old' | 'new';
export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';
export type ThreadStatus = 'open' | 'resolved' | 'outdated';
export type Author = 'user' | 'agent';
export type Verdict = 'approve' | 'request_changes' | 'comment';
export type ResultStatus =
  | 'submitted' | 'pending' | 'no_changes' | 'aborted' | 'error';

/** One changed file. `path` is the new path, or the old path for deletions. */
export interface FileEntry {
  path: string;
  oldPath: string | null;
  status: FileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}

/** Where a thread is pinned. `content` and `contextHash` let us find it again after edits. */
export interface Anchor {
  line: number;
  content: string;
  contextHash: string;
}

export interface Message {
  author: Author;
  round: number;
  body: string;
  at: string;
}

export interface Thread {
  id: string;
  file: string;
  side: Side;
  anchor: Anchor;
  status: ThreadStatus;
  messages: Message[];
}

export interface ReviewState {
  version: 1;
  round: number;
  threads: Thread[];
}

/** An inline note the agent leaves before the review opens. */
export interface Annotation {
  file: string;
  line: number;
  side: Side;
  body: string;
}

/** `.git/web-review/request.json`, written by the agent. All fields optional on disk. */
export interface ReviewRequest {
  summary: string;
  base: string;
  annotations: Annotation[];
}

export interface SessionPayload {
  round: number;
  base: string;
  baseLabel: string;
  summary: string;
  files: FileEntry[];
  threads: Thread[];
}

export interface NewComment {
  file: string;
  side: Side;
  line: number;
  body: string;
}

export interface Reply {
  threadId: string;
  body: string;
}

/**
 * What the browser POSTs. The client never computes anchors — it sends line
 * numbers, and the server anchors them, because only the server has file contents.
 */
export interface SubmitPayload {
  verdict: Verdict;
  general: string;
  newComments: NewComment[];
  replies: Reply[];
  resolved: string[];
  reopened: string[];
}

export interface CliResult {
  status: ResultStatus;
  verdict?: Verdict;
  round?: number;
  general?: string;
  threads?: Thread[];
  url?: string;
  message?: string;
}
```

- [ ] **Step 4: Write the failing test for the stdout protocol**

`src/shared/protocol.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { frameResult, parseFramed, RESULT_START, RESULT_END } from './protocol.js';
import type { CliResult } from './types.js';

describe('frameResult', () => {
  it('wraps JSON between the markers on their own lines', () => {
    const result: CliResult = { status: 'pending', url: 'http://127.0.0.1:1/?t=x' };
    const lines = frameResult(result).split('\n');

    expect(lines[0]).toBe(RESULT_START);
    expect(lines.at(-1)).toBe(RESULT_END);
    expect(JSON.parse(lines.slice(1, -1).join('\n'))).toEqual(result);
  });
});

describe('parseFramed', () => {
  it('extracts the result even when surrounded by unrelated output', () => {
    const result: CliResult = { status: 'submitted', verdict: 'approve', round: 2 };
    const noisy = `starting server\n${frameResult(result)}\nserver stopped\n`;

    expect(parseFramed(noisy)).toEqual(result);
  });

  it('reads the last block when several are present', () => {
    const first = frameResult({ status: 'pending' });
    const second = frameResult({ status: 'submitted', verdict: 'comment' });

    expect(parseFramed(`${first}\n${second}`)).toEqual({
      status: 'submitted',
      verdict: 'comment',
    });
  });

  it('throws a named error when no block is present', () => {
    expect(() => parseFramed('nothing here')).toThrow(/no result block/i);
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npx vitest run src/shared/protocol.test.ts`
Expected: FAIL — `Failed to resolve import "./protocol.js"`.

- [ ] **Step 6: Implement `src/shared/protocol.ts`**

```ts
import type { CliResult } from './types.js';

export const RESULT_START = '<<<WEB_REVIEW_RESULT';
export const RESULT_END = 'WEB_REVIEW_RESULT>>>';

/** Wrap a result in markers so it survives any incidental logging around it. */
export function frameResult(result: CliResult): string {
  return `${RESULT_START}\n${JSON.stringify(result, null, 2)}\n${RESULT_END}`;
}

/**
 * Pull the last framed result out of arbitrary text. Exported so both our tests
 * and any agent-side helper parse the stream the same way.
 */
export function parseFramed(text: string): CliResult {
  const start = text.lastIndexOf(RESULT_START);
  if (start === -1) throw new Error('web-review: no result block found in output');

  const end = text.indexOf(RESULT_END, start);
  if (end === -1) throw new Error('web-review: result block is not terminated');

  return JSON.parse(text.slice(start + RESULT_START.length, end)) as CliResult;
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run src/shared/protocol.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 8: Create the server build script**

`scripts/build-server.mjs`:

```js
import { build } from 'esbuild';

await build({
  entryPoints: ['src/server/cli.ts'],
  outfile: 'dist/web-review.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  minify: false,
  sourcemap: false,
  banner: { js: '#!/usr/bin/env node' },
});

console.log('built dist/web-review.mjs');
```

Not minified on purpose: the shipped file is what a security-minded user reads before running it.

- [ ] **Step 9: Create the Vite config and app entry**

`app/vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
});
```

`app/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>web-review</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`app/src/main.tsx` — a placeholder; Task 10 replaces it:

```tsx
import { createRoot } from 'react-dom/client';

createRoot(document.getElementById('root')!).render(<p>web-review</p>);
```

- [ ] **Step 10: Create a stub `src/server/cli.ts` so the build has an entry point**

Task 9 replaces this file entirely.

```ts
import { frameResult } from '../shared/protocol.js';

process.stdout.write(`${frameResult({ status: 'error', message: 'not implemented' })}\n`);
process.exit(1);
```

- [ ] **Step 11: Create `.gitignore` and `.gitattributes`**

`.gitignore`:

```
node_modules/
*.log
.DS_Store
```

`dist/` and `app/dist/` are deliberately **not** ignored — they ship.

`.gitattributes`:

```
dist/** -diff -merge=ours linguist-generated
app/dist/** -diff -merge=ours linguist-generated
```

- [ ] **Step 12: Run the build to verify both artifacts appear**

Run: `npm install && npm run build`
Expected: `dist/web-review.mjs` and `app/dist/index.html` exist.
Then run: `node dist/web-review.mjs`
Expected: a framed `error` block on stdout, exit code 1.

- [ ] **Step 13: Create the CI workflow**

`.github/workflows/ci.yml`:

```yaml
name: CI
on: [push, pull_request]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
      - name: Committed bundles must match source
        run: git diff --exit-code dist app/dist
```

That last step is the guard against a stale committed bundle — the classic failure of this distribution model.

- [ ] **Step 14: Commit**

```bash
git add -A
git commit -m "feat: scaffold build, test harness, and stdout protocol"
```

---

### Task 2: Git execution and base-ref resolution

**Files:**
- Create: `src/server/git/exec.ts`, `src/server/git/range.ts`, `src/server/test-helpers/repo.ts`
- Test: `src/server/git/range.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface GitOptions { cwd: string }`
  - `git(args: string[], opts: GitOptions): Promise<string>` — stdout with one trailing newline stripped; throws `GitError`.
  - `gitOk(args: string[], opts: GitOptions): Promise<boolean>`
  - `class GitError extends Error { args: string[]; stderr: string; code: number }`
  - `repoRoot(opts: GitOptions): Promise<string>`, `gitDir(opts: GitOptions): Promise<string>`
  - `interface DiffRange { base: string; label: string; staged: boolean }` — `staged: false` means "compare `base` against the working tree, and include untracked files".
  - `resolveRange(spec: string, opts: GitOptions): Promise<DiffRange>`
  - Test helper `createRepo(): Promise<TestRepo>` with `{ dir, write, run, commit, cleanup }`.

- [ ] **Step 1: Write the test-repo helper**

`src/server/test-helpers/repo.ts` — every server test builds a real repository. There is no git mocking anywhere in this plan.

```ts
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface TestRepo {
  dir: string;
  write(path: string, content: string): Promise<void>;
  run(...args: string[]): Promise<string>;
  commit(message: string): Promise<void>;
  cleanup(): Promise<void>;
}

export async function createRepo(): Promise<TestRepo> {
  const dir = await mkdtemp(join(tmpdir(), 'web-review-'));

  const git = async (...args: string[]) => {
    const { stdout } = await run('git', args, { cwd: dir });
    return stdout;
  };

  await git('init', '-b', 'main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test');
  await git('config', 'commit.gpgsign', 'false');

  return {
    dir,
    run: git,
    async write(path, content) {
      const full = join(dir, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content, 'utf8');
    },
    async commit(message) {
      await git('add', '-A');
      await git('commit', '-m', message);
    },
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
```

- [ ] **Step 2: Write the failing tests for range resolution**

`src/server/git/range.test.ts`:

```ts
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/server/git/range.test.ts`
Expected: FAIL — cannot resolve `./range.js` and `./exec.js`.

- [ ] **Step 4: Implement `src/server/git/exec.ts`**

```ts
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
  try {
    const { stdout } = await run('git', args, {
      cwd: opts.cwd,
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
    });
    return stdout.replace(/\n$/, '');
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
```

- [ ] **Step 5: Implement `src/server/git/range.ts`**

```ts
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
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/server/git/range.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 7: Commit**

```bash
git add src/server/git src/server/test-helpers
git commit -m "feat(git): add exec wrapper and base-ref resolution"
```

---

### Task 3: Changed-file enumeration and file-side reading

**Files:**
- Create: `src/server/git/files.ts`
- Test: `src/server/git/files.test.ts`

**Interfaces:**
- Consumes: `git`, `GitOptions` from `git/exec.ts`; `DiffRange` from `git/range.ts`; `FileEntry`, `FileStatus`, `Side` from `shared/types.ts`.
- Produces:
  - `listChangedFiles(range: DiffRange, opts: GitOptions): Promise<FileEntry[]>` — sorted by path; untracked files included when `range.staged` is false.
  - `readSide(path: string, side: Side, range: DiffRange, opts: GitOptions): Promise<string | null>` — `null` when the file does not exist on that side.

- [ ] **Step 1: Write the failing tests**

`src/server/git/files.test.ts`. Note `NUL` — binary fixtures are written with an explicit escape rather than a literal control character.

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRepo, type TestRepo } from '../test-helpers/repo.js';
import { resolveRange } from './range.js';
import { listChangedFiles, readSide } from './files.js';

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
});

describe('readSide', () => {
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
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/server/git/files.test.ts`
Expected: FAIL — cannot resolve `./files.js`.

- [ ] **Step 3: Implement `src/server/git/files.ts`**

`--numstat` and `--name-status` are read together: the first gives counts, the second gives statuses and rename pairs. Untracked files are appended, because `git diff` never lists them.

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/server/git/files.test.ts`
Expected: PASS, 9 tests.

If the rename test fails because git did not pair the delete with the add, confirm `-M` is present in `diffArgs`.

- [ ] **Step 5: Commit**

```bash
git add src/server/git/files.ts src/server/git/files.test.ts
git commit -m "feat(git): enumerate changed files and read either side"
```

---

### Task 4: Reading and validating the agent's request

**Files:**
- Create: `src/server/review/request.ts`
- Modify: `src/shared/types.ts` (add `replies` to `ReviewRequest`)
- Test: `src/server/review/request.test.ts`

**Spec refinement:** the spec describes `request.json` as carrying a summary,
a base and annotations. Round 2 also needs a way for the agent to answer a
thread, so `ReviewRequest` gains a `replies` field using the `Reply` type that
already exists for submissions. Everything else is unchanged.

**Interfaces:**
- Consumes: `ReviewRequest`, `Annotation`, `Reply`, `Side` from `shared/types.ts`.
- Produces:
  - `REQUEST_FILE = 'request.json'`
  - `validateRequest(raw: unknown): ReviewRequest` — throws `RequestError` naming the offending field.
  - `class RequestError extends Error`
  - `readRequest(stateDir: string): Promise<ReviewRequest>` — returns defaults when the file is absent, throws `RequestError` when it is present but malformed.
  - `consumeRequest(stateDir: string): Promise<ReviewRequest>` — reads then deletes the file, so a stale request never leaks into a later round.

- [ ] **Step 1: Add `replies` to `ReviewRequest` in `src/shared/types.ts`**

```ts
/** `.git/web-review/request.json`, written by the agent. All fields optional on disk. */
export interface ReviewRequest {
  summary: string;
  base: string;
  annotations: Annotation[];
  replies: Reply[];
}
```

`Reply` is already declared below in the same file; move the `Reply` and
`Annotation` declarations above `ReviewRequest` so the file reads top-down.

- [ ] **Step 2: Write the failing tests**

`src/server/review/request.test.ts`:

```ts
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { consumeRequest, readRequest, RequestError, validateRequest } from './request.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'web-review-req-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('validateRequest', () => {
  it('fills every field from a complete request', () => {
    expect(
      validateRequest({
        summary: 'Add JWT refresh.',
        base: 'HEAD',
        annotations: [{ file: 'a.ts', line: 3, side: 'new', body: 'hard-coded' }],
        replies: [{ threadId: 't1', body: 'done' }],
      }),
    ).toEqual({
      summary: 'Add JWT refresh.',
      base: 'HEAD',
      annotations: [{ file: 'a.ts', line: 3, side: 'new', body: 'hard-coded' }],
      replies: [{ threadId: 't1', body: 'done' }],
    });
  });

  it('applies defaults for every omitted field', () => {
    expect(validateRequest({})).toEqual({
      summary: '',
      base: 'auto',
      annotations: [],
      replies: [],
    });
  });

  it('rejects a non-object payload', () => {
    expect(() => validateRequest([])).toThrow(RequestError);
    expect(() => validateRequest(null)).toThrow(/must be a JSON object/i);
  });

  it('names the offending field on a bad annotation', () => {
    expect(() =>
      validateRequest({ annotations: [{ file: 'a.ts', line: 0, side: 'new', body: 'x' }] }),
    ).toThrow(/annotations\[0\]\.line/);
  });

  it('rejects an unknown side', () => {
    expect(() =>
      validateRequest({ annotations: [{ file: 'a.ts', line: 1, side: 'both', body: 'x' }] }),
    ).toThrow(/annotations\[0\]\.side/);
  });

  it('rejects a reply without a thread id', () => {
    expect(() => validateRequest({ replies: [{ body: 'done' }] }))
      .toThrow(/replies\[0\]\.threadId/);
  });
});

describe('readRequest', () => {
  it('returns defaults when the file is absent', async () => {
    expect(await readRequest(dir)).toEqual({
      summary: '',
      base: 'auto',
      annotations: [],
      replies: [],
    });
  });

  it('throws a readable error on malformed JSON', async () => {
    await writeFile(join(dir, 'request.json'), '{ not json', 'utf8');

    await expect(readRequest(dir)).rejects.toThrow(/request\.json is not valid JSON/i);
  });
});

describe('consumeRequest', () => {
  it('reads the request and deletes the file', async () => {
    await writeFile(join(dir, 'request.json'), JSON.stringify({ summary: 'hi' }), 'utf8');

    expect((await consumeRequest(dir)).summary).toBe('hi');
    await expect(access(join(dir, 'request.json'))).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/server/review/request.test.ts`
Expected: FAIL — cannot resolve `./request.js`.

- [ ] **Step 4: Implement `src/server/review/request.ts`**

```ts
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Annotation, Reply, ReviewRequest, Side } from '../../shared/types.js';

export const REQUEST_FILE = 'request.json';

export class RequestError extends Error {
  constructor(message: string) {
    super(`web-review: ${message}`);
    this.name = 'RequestError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, field: string, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string') throw new RequestError(`${field} must be a string`);
  return value;
}

function asSide(value: unknown, field: string): Side {
  if (value !== 'old' && value !== 'new') {
    throw new RequestError(`${field} must be "old" or "new"`);
  }
  return value;
}

function asArray(value: unknown, field: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new RequestError(`${field} must be an array`);
  return value;
}

function toAnnotation(raw: unknown, index: number): Annotation {
  const field = `annotations[${index}]`;
  if (!isRecord(raw)) throw new RequestError(`${field} must be a JSON object`);

  const line = raw['line'];
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
    throw new RequestError(`${field}.line must be an integer >= 1`);
  }

  return {
    file: asString(raw['file'], `${field}.file`),
    line,
    side: asSide(raw['side'], `${field}.side`),
    body: asString(raw['body'], `${field}.body`),
  };
}

function toReply(raw: unknown, index: number): Reply {
  const field = `replies[${index}]`;
  if (!isRecord(raw)) throw new RequestError(`${field} must be a JSON object`);

  return {
    threadId: asString(raw['threadId'], `${field}.threadId`),
    body: asString(raw['body'], `${field}.body`),
  };
}

/** Validate a parsed request.json. Every field is optional; every error names its field. */
export function validateRequest(raw: unknown): ReviewRequest {
  if (!isRecord(raw)) throw new RequestError('request.json must be a JSON object');

  return {
    summary: asString(raw['summary'], 'summary', ''),
    base: asString(raw['base'], 'base', 'auto'),
    annotations: asArray(raw['annotations'], 'annotations').map(toAnnotation),
    replies: asArray(raw['replies'], 'replies').map(toReply),
  };
}

const EMPTY: ReviewRequest = { summary: '', base: 'auto', annotations: [], replies: [] };

export async function readRequest(stateDir: string): Promise<ReviewRequest> {
  const raw = await readFile(join(stateDir, REQUEST_FILE), 'utf8').catch(() => null);
  if (raw === null) return { ...EMPTY };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RequestError('request.json is not valid JSON');
  }
  return validateRequest(parsed);
}

/** Read then delete, so a request from a previous round never reappears. */
export async function consumeRequest(stateDir: string): Promise<ReviewRequest> {
  const request = await readRequest(stateDir);
  await rm(join(stateDir, REQUEST_FILE), { force: true });
  return request;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/server/review/request.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/server/review/request.ts src/server/review/request.test.ts
git commit -m "feat(review): read and validate the agent request file"
```

---

### Task 5: Thread anchoring and relocation

The core algorithm of the whole tool: a comment made in round 1 must find its
line again in round 2 after the agent has edited the file. Pure functions, no
I/O, and the densest test suite in the repo.

**Files:**
- Create: `src/server/review/anchor.ts`
- Test: `src/server/review/anchor.test.ts`

**Interfaces:**
- Consumes: `Anchor` from `shared/types.ts`.
- Produces:
  - `SEARCH_WINDOW = 25`
  - `splitLines(content: string): string[]` — drops the trailing empty element produced by a final newline.
  - `contextHash(lines: string[], index: number): string` — 12 hex chars over the trimmed line and its two neighbours; `index` is 0-based.
  - `makeAnchor(lines: string[], line: number): Anchor` — `line` is 1-based.
  - `type RelocationStatus = 'unchanged' | 'moved' | 'outdated'`
  - `interface Relocation { line: number | null; status: RelocationStatus }`
  - `relocate(anchor: Anchor, lines: string[]): Relocation`

- [ ] **Step 1: Write the failing tests**

`src/server/review/anchor.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { contextHash, makeAnchor, relocate, splitLines } from './anchor.js';

const file = (...lines: string[]) => lines;

describe('splitLines', () => {
  it('drops the empty element a trailing newline produces', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
  });

  it('keeps a final line with no newline', () => {
    expect(splitLines('a\nb')).toEqual(['a', 'b']);
  });

  it('returns an empty array for empty content', () => {
    expect(splitLines('')).toEqual([]);
  });
});

describe('contextHash', () => {
  it('ignores indentation changes around the anchored line', () => {
    const a = contextHash(file('before', '  const x = 1;', 'after'), 1);
    const b = contextHash(file('before', '      const x = 1;', 'after'), 1);

    expect(a).toBe(b);
  });

  it('differs when a neighbour changes', () => {
    const a = contextHash(file('before', 'const x = 1;', 'after'), 1);
    const b = contextHash(file('different', 'const x = 1;', 'after'), 1);

    expect(a).not.toBe(b);
  });

  it('handles the first and last line without running off the array', () => {
    const lines = file('only');

    expect(contextHash(lines, 0)).toHaveLength(12);
  });
});

describe('makeAnchor', () => {
  it('records the 1-based line, its exact content and a context hash', () => {
    const lines = file('a', 'const t = sign(u);', 'c');

    expect(makeAnchor(lines, 2)).toEqual({
      line: 2,
      content: 'const t = sign(u);',
      contextHash: contextHash(lines, 1),
    });
  });

  it('throws when the line is out of range', () => {
    expect(() => makeAnchor(file('a'), 5)).toThrow(/line 5 is out of range/i);
  });
});

describe('relocate', () => {
  const lines = file('one', 'two', 'const t = sign(u);', 'four', 'five');
  const anchor = makeAnchor(lines, 3);

  it('reports unchanged when the line is still where it was', () => {
    expect(relocate(anchor, lines)).toEqual({ line: 3, status: 'unchanged' });
  });

  it('follows the line when it shifts within the search window', () => {
    const shifted = file('new', 'lines', 'one', 'two', 'const t = sign(u);', 'four');

    expect(relocate(anchor, shifted)).toEqual({ line: 5, status: 'moved' });
  });

  it('picks the nearest match when the line shifts and appears twice', () => {
    const shifted = file(
      'const t = sign(u);',
      'one',
      'two',
      'x',
      'const t = sign(u);',
      'four',
    );

    expect(relocate(anchor, shifted)).toEqual({ line: 5, status: 'moved' });
  });

  it('finds the line far outside the window when it is unique', () => {
    const far = [...Array.from({ length: 200 }, (_, i) => `filler ${i}`), 'const t = sign(u);'];

    expect(relocate(anchor, far)).toEqual({ line: 201, status: 'moved' });
  });

  it('disambiguates far duplicates using the context hash', () => {
    const far = [
      ...Array.from({ length: 100 }, (_, i) => `filler ${i}`),
      'const t = sign(u);',
      ...Array.from({ length: 100 }, (_, i) => `more ${i}`),
      'two',
      'const t = sign(u);',
      'four',
    ];

    expect(relocate(anchor, far)).toEqual({ line: 203, status: 'moved' });
  });

  it('goes outdated when the line is gone', () => {
    expect(relocate(anchor, file('one', 'two', 'four'))).toEqual({
      line: null,
      status: 'outdated',
    });
  });

  it('goes outdated when far duplicates cannot be told apart', () => {
    const ambiguous = [
      ...Array.from({ length: 100 }, (_, i) => `filler ${i}`),
      'const t = sign(u);',
      ...Array.from({ length: 100 }, (_, i) => `more ${i}`),
      'const t = sign(u);',
    ];

    expect(relocate(anchor, ambiguous)).toEqual({ line: null, status: 'outdated' });
  });

  it('goes outdated against an empty file', () => {
    expect(relocate(anchor, [])).toEqual({ line: null, status: 'outdated' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/server/review/anchor.test.ts`
Expected: FAIL — cannot resolve `./anchor.js`.

- [ ] **Step 3: Implement `src/server/review/anchor.ts`**

The four rules from the spec, in order: same line, nearby, unique elsewhere,
give up. Whitespace is ignored only in the context hash — the anchored line
itself must match exactly, so a reformatted line correctly reads as outdated.

```ts
import { createHash } from 'node:crypto';
import type { Anchor } from '../../shared/types.js';

/** How far from the recorded line we still call a match a simple shift. */
export const SEARCH_WINDOW = 25;

export type RelocationStatus = 'unchanged' | 'moved' | 'outdated';

export interface Relocation {
  line: number | null;
  status: RelocationStatus;
}

export function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/**
 * A fingerprint of the anchored line plus its two neighbours, indentation
 * ignored. Used only to tell duplicate lines apart, never to match on its own.
 */
export function contextHash(lines: string[], index: number): string {
  const window = [lines[index - 1] ?? '', lines[index] ?? '', lines[index + 1] ?? ''];
  const normalised = window.map((line) => line.trim()).join('\n');
  return createHash('sha1').update(normalised).digest('hex').slice(0, 12);
}

/** `line` is 1-based, matching every line number the UI and git speak. */
export function makeAnchor(lines: string[], line: number): Anchor {
  const content = lines[line - 1];
  if (content === undefined) {
    throw new Error(`web-review: line ${line} is out of range (${lines.length} lines)`);
  }
  return { line, content, contextHash: contextHash(lines, line - 1) };
}

export function relocate(anchor: Anchor, lines: string[]): Relocation {
  if (lines[anchor.line - 1] === anchor.content) {
    return { line: anchor.line, status: 'unchanged' };
  }

  const matches: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] === anchor.content) matches.push(i + 1);
  }
  if (matches.length === 0) return { line: null, status: 'outdated' };

  const near = nearest(matches, anchor.line, SEARCH_WINDOW);
  if (near !== null) return { line: near, status: 'moved' };

  if (matches.length === 1) return { line: matches[0]!, status: 'moved' };

  const byContext = matches.filter((line) => contextHash(lines, line - 1) === anchor.contextHash);
  if (byContext.length === 1) return { line: byContext[0]!, status: 'moved' };

  return { line: null, status: 'outdated' };
}

/** The candidate closest to `target`, if any lies within `window` lines of it. */
function nearest(candidates: number[], target: number, window: number): number | null {
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const distance = Math.abs(candidate - target);
    if (distance <= window && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/server/review/anchor.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/review/anchor.ts src/server/review/anchor.test.ts
git commit -m "feat(review): anchor comment threads and relocate them across rounds"
```

---

### Task 6: Review state, round transitions, and result payloads

Where the round machinery lives: opening a round relocates every thread and
folds in the agent's replies; submitting folds in the human's. Both are async
only because they need file contents, which arrive through an injected lookup —
so the tests never touch git.

**Files:**
- Create: `src/server/review/state.ts`, `src/server/review/result.ts`
- Test: `src/server/review/state.test.ts`, `src/server/review/result.test.ts`

**Interfaces:**
- Consumes: `makeAnchor`, `relocate`, `contextHash` from `review/anchor.ts`; `ReviewState`, `ReviewRequest`, `SubmitPayload`, `Thread`, `Side`, `Verdict`, `CliResult` from `shared/types.ts`.
- Produces:
  - `STATE_FILE = 'state.json'`, `stateDirFor(gitDir: string): string`
  - `emptyState(): ReviewState`
  - `readState(stateDir: string): Promise<ReviewState>`, `writeState(stateDir: string, state: ReviewState): Promise<void>`
  - `type LinesLookup = (file: string, side: Side) => Promise<string[] | null>`
  - `openRound(state: ReviewState, request: ReviewRequest, lookup: LinesLookup, now?: () => string): Promise<ReviewState>`
  - `applySubmission(state: ReviewState, payload: SubmitPayload, lookup: LinesLookup, now?: () => string): Promise<ReviewState>`
  - From `result.ts`: `submittedResult`, `pendingResult`, `noChangesResult`, `abortedResult`, `errorResult` — all returning `CliResult`.

- [ ] **Step 1: Write the failing tests for state**

`src/server/review/state.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applySubmission,
  emptyState,
  openRound,
  readState,
  stateDirFor,
  writeState,
  type LinesLookup,
} from './state.js';
import type { ReviewRequest, ReviewState, SubmitPayload } from '../../shared/types.js';

const AT = '2026-09-04T10:00:00.000Z';
const now = () => AT;

const request = (over: Partial<ReviewRequest> = {}): ReviewRequest => ({
  summary: '',
  base: 'auto',
  annotations: [],
  replies: [],
  ...over,
});

const submission = (over: Partial<SubmitPayload> = {}): SubmitPayload => ({
  verdict: 'request_changes',
  general: '',
  newComments: [],
  replies: [],
  resolved: [],
  reopened: [],
  ...over,
});

const lookupOf = (files: Record<string, string[]>): LinesLookup =>
  async (file) => files[file] ?? null;

describe('stateDirFor', () => {
  it('places state inside .git so it never shows up in the diff under review', () => {
    expect(stateDirFor('/repo/.git')).toBe(join('/repo/.git', 'web-review'));
  });
});

describe('readState / writeState', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'web-review-state-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns an empty state when nothing has been written', async () => {
    expect(await readState(dir)).toEqual({ version: 1, round: 0, threads: [] });
  });

  it('round-trips a state through disk, creating the directory', async () => {
    const state: ReviewState = {
      version: 1,
      round: 2,
      threads: [
        {
          id: 't1',
          file: 'a.ts',
          side: 'new',
          anchor: { line: 1, content: 'x', contextHash: 'abc' },
          status: 'open',
          messages: [{ author: 'user', round: 1, body: 'hi', at: AT }],
        },
      ],
    };

    await writeState(join(dir, 'nested'), state);

    expect(await readState(join(dir, 'nested'))).toEqual(state);
  });

  it('falls back to an empty state when the file is corrupt', async () => {
    await writeState(dir, emptyState());
    await rm(join(dir, 'state.json'));

    expect(await readState(dir)).toEqual(emptyState());
  });
});

describe('openRound', () => {
  const lookup = lookupOf({ 'a.ts': ['one', 'two', 'three'] });

  it('bumps the round counter', async () => {
    expect((await openRound(emptyState(), request(), lookup, now)).round).toBe(1);
  });

  it('turns agent annotations into threads authored by the agent', async () => {
    const next = await openRound(
      emptyState(),
      request({ annotations: [{ file: 'a.ts', line: 2, side: 'new', body: 'unsure' }] }),
      lookup,
      now,
    );

    expect(next.threads).toEqual([
      {
        id: 't1',
        file: 'a.ts',
        side: 'new',
        anchor: { line: 2, content: 'two', contextHash: expect.any(String) },
        status: 'open',
        messages: [{ author: 'agent', round: 1, body: 'unsure', at: AT }],
      },
    ]);
  });

  it('drops an annotation pointing at a line that does not exist', async () => {
    const next = await openRound(
      emptyState(),
      request({ annotations: [{ file: 'a.ts', line: 99, side: 'new', body: 'x' }] }),
      lookup,
      now,
    );

    expect(next.threads).toEqual([]);
  });

  it('appends agent replies to existing threads', async () => {
    const first = await openRound(
      emptyState(),
      request({ annotations: [{ file: 'a.ts', line: 1, side: 'new', body: 'q' }] }),
      lookup,
      now,
    );

    const second = await openRound(first, request({ replies: [{ threadId: 't1', body: 'done' }] }), lookup, now);

    expect(second.threads[0]?.messages).toEqual([
      { author: 'agent', round: 1, body: 'q', at: AT },
      { author: 'agent', round: 2, body: 'done', at: AT },
    ]);
  });

  it('follows a thread whose line moved', async () => {
    const first = await openRound(
      emptyState(),
      request({ annotations: [{ file: 'a.ts', line: 2, side: 'new', body: 'q' }] }),
      lookup,
      now,
    );

    const second = await openRound(
      first,
      request(),
      lookupOf({ 'a.ts': ['inserted', 'one', 'two', 'three'] }),
      now,
    );

    expect(second.threads[0]?.anchor.line).toBe(3);
    expect(second.threads[0]?.status).toBe('open');
  });

  it('marks a thread outdated when its line is gone, without deleting it', async () => {
    const first = await openRound(
      emptyState(),
      request({ annotations: [{ file: 'a.ts', line: 2, side: 'new', body: 'q' }] }),
      lookup,
      now,
    );

    const second = await openRound(first, request(), lookupOf({ 'a.ts': ['one', 'three'] }), now);

    expect(second.threads).toHaveLength(1);
    expect(second.threads[0]?.status).toBe('outdated');
  });

  it('marks a thread outdated when its file disappeared entirely', async () => {
    const first = await openRound(
      emptyState(),
      request({ annotations: [{ file: 'a.ts', line: 1, side: 'new', body: 'q' }] }),
      lookup,
      now,
    );

    const second = await openRound(first, request(), lookupOf({}), now);

    expect(second.threads[0]?.status).toBe('outdated');
  });

  it('leaves resolved threads resolved when they relocate cleanly', async () => {
    const first = await openRound(
      emptyState(),
      request({ annotations: [{ file: 'a.ts', line: 1, side: 'new', body: 'q' }] }),
      lookup,
      now,
    );
    const resolved = await applySubmission(first, submission({ resolved: ['t1'] }), lookup, now);

    const second = await openRound(resolved, request(), lookup, now);

    expect(second.threads[0]?.status).toBe('resolved');
  });
});

describe('applySubmission', () => {
  const lookup = lookupOf({ 'a.ts': ['one', 'two', 'three'] });

  it('anchors a new comment against the current file contents', async () => {
    const state = await openRound(emptyState(), request(), lookup, now);

    const next = await applySubmission(
      state,
      submission({
        newComments: [{ file: 'a.ts', side: 'new', line: 3, body: 'rename this' }],
      }),
      lookup,
      now,
    );

    expect(next.threads).toEqual([
      {
        id: 't1',
        file: 'a.ts',
        side: 'new',
        anchor: { line: 3, content: 'three', contextHash: expect.any(String) },
        status: 'open',
        messages: [{ author: 'user', round: 1, body: 'rename this', at: AT }],
      },
    ]);
  });

  it('appends a human reply to an existing thread', async () => {
    const state = await openRound(
      emptyState(),
      request({ annotations: [{ file: 'a.ts', line: 1, side: 'new', body: 'q' }] }),
      lookup,
      now,
    );

    const next = await applySubmission(
      state,
      submission({ replies: [{ threadId: 't1', body: 'no, keep it' }] }),
      lookup,
      now,
    );

    expect(next.threads[0]?.messages.at(-1)).toEqual({
      author: 'user',
      round: 1,
      body: 'no, keep it',
      at: AT,
    });
  });

  it('resolves and reopens threads by id', async () => {
    const state = await openRound(
      emptyState(),
      request({ annotations: [{ file: 'a.ts', line: 1, side: 'new', body: 'q' }] }),
      lookup,
      now,
    );

    const resolved = await applySubmission(state, submission({ resolved: ['t1'] }), lookup, now);
    expect(resolved.threads[0]?.status).toBe('resolved');

    const reopened = await applySubmission(resolved, submission({ reopened: ['t1'] }), lookup, now);
    expect(reopened.threads[0]?.status).toBe('open');
  });

  it('ignores a new comment on a line that no longer exists', async () => {
    const state = await openRound(emptyState(), request(), lookup, now);

    const next = await applySubmission(
      state,
      submission({ newComments: [{ file: 'a.ts', side: 'new', line: 99, body: 'x' }] }),
      lookup,
      now,
    );

    expect(next.threads).toEqual([]);
  });

  it('gives every new thread a distinct id', async () => {
    const state = await openRound(emptyState(), request(), lookup, now);

    const next = await applySubmission(
      state,
      submission({
        newComments: [
          { file: 'a.ts', side: 'new', line: 1, body: 'a' },
          { file: 'a.ts', side: 'new', line: 2, body: 'b' },
        ],
      }),
      lookup,
      now,
    );

    expect(next.threads.map((t) => t.id)).toEqual(['t1', 't2']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/server/review/state.test.ts`
Expected: FAIL — cannot resolve `./state.js`.

- [ ] **Step 3: Implement `src/server/review/state.ts`**

```ts
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { contextHash, makeAnchor, relocate } from './anchor.js';
import type {
  Message,
  ReviewRequest,
  ReviewState,
  Side,
  SubmitPayload,
  Thread,
} from '../../shared/types.js';

export const STATE_FILE = 'state.json';

/** All review state lives inside .git, never in the working tree. */
export function stateDirFor(gitDir: string): string {
  return join(gitDir, 'web-review');
}

export function emptyState(): ReviewState {
  return { version: 1, round: 0, threads: [] };
}

/** Supplies the current lines of one side of one file. Injected so the pure logic stays testable. */
export type LinesLookup = (file: string, side: Side) => Promise<string[] | null>;

export async function readState(stateDir: string): Promise<ReviewState> {
  const raw = await readFile(join(stateDir, STATE_FILE), 'utf8').catch(() => null);
  if (raw === null) return emptyState();

  try {
    const parsed = JSON.parse(raw) as ReviewState;
    if (parsed.version !== 1 || !Array.isArray(parsed.threads)) return emptyState();
    return parsed;
  } catch {
    return emptyState();
  }
}

export async function writeState(stateDir: string, state: ReviewState): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const target = join(stateDir, STATE_FILE);
  const temp = `${target}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temp, target);
}

function nextId(threads: Thread[]): string {
  const highest = threads.reduce((max, thread) => {
    const n = Number.parseInt(thread.id.slice(1), 10);
    return Number.isNaN(n) ? max : Math.max(max, n);
  }, 0);
  return `t${highest + 1}`;
}

const nowIso = () => new Date().toISOString();

/**
 * Start a new round: bump the counter, relocate every thread against the
 * current file contents, then fold in the agent's replies and annotations.
 */
export async function openRound(
  state: ReviewState,
  request: ReviewRequest,
  lookup: LinesLookup,
  now: () => string = nowIso,
): Promise<ReviewState> {
  const round = state.round + 1;
  const threads: Thread[] = [];

  for (const thread of state.threads) {
    const lines = await lookup(thread.file, thread.side);
    if (lines === null) {
      threads.push({ ...thread, status: 'outdated' });
      continue;
    }

    const moved = relocate(thread.anchor, lines);
    if (moved.line === null) {
      threads.push({ ...thread, status: 'outdated' });
      continue;
    }

    threads.push({
      ...thread,
      status: thread.status === 'outdated' ? 'open' : thread.status,
      anchor: {
        ...thread.anchor,
        line: moved.line,
        contextHash: contextHash(lines, moved.line - 1),
      },
    });
  }

  for (const reply of request.replies) {
    const thread = threads.find((t) => t.id === reply.threadId);
    if (thread) thread.messages = [...thread.messages, message('agent', round, reply.body, now)];
  }

  for (const annotation of request.annotations) {
    const lines = await lookup(annotation.file, annotation.side);
    if (!lines || lines[annotation.line - 1] === undefined) continue;

    threads.push({
      id: nextId(threads),
      file: annotation.file,
      side: annotation.side,
      anchor: makeAnchor(lines, annotation.line),
      status: 'open',
      messages: [message('agent', round, annotation.body, now)],
    });
  }

  return { version: 1, round, threads };
}

/** Fold the human's submission into the state. New comments are anchored here. */
export async function applySubmission(
  state: ReviewState,
  payload: SubmitPayload,
  lookup: LinesLookup,
  now: () => string = nowIso,
): Promise<ReviewState> {
  const threads = state.threads.map((thread) => ({ ...thread }));

  for (const reply of payload.replies) {
    const thread = threads.find((t) => t.id === reply.threadId);
    if (thread) {
      thread.messages = [...thread.messages, message('user', state.round, reply.body, now)];
    }
  }

  for (const id of payload.resolved) {
    const thread = threads.find((t) => t.id === id);
    if (thread) thread.status = 'resolved';
  }

  for (const id of payload.reopened) {
    const thread = threads.find((t) => t.id === id);
    if (thread) thread.status = 'open';
  }

  for (const comment of payload.newComments) {
    const lines = await lookup(comment.file, comment.side);
    if (!lines || lines[comment.line - 1] === undefined) continue;

    threads.push({
      id: nextId(threads),
      file: comment.file,
      side: comment.side,
      anchor: makeAnchor(lines, comment.line),
      status: 'open',
      messages: [message('user', state.round, comment.body, now)],
    });
  }

  return { ...state, threads };
}

function message(
  author: Message['author'],
  round: number,
  body: string,
  now: () => string,
): Message {
  return { author, round, body, at: now() };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/server/review/state.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Write the failing tests for result payloads**

`src/server/review/result.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  abortedResult,
  errorResult,
  noChangesResult,
  pendingResult,
  submittedResult,
} from './result.js';
import type { ReviewState } from '../../shared/types.js';

const state: ReviewState = {
  version: 1,
  round: 2,
  threads: [
    {
      id: 't1',
      file: 'a.ts',
      side: 'new',
      anchor: { line: 1, content: 'x', contextHash: 'abc' },
      status: 'open',
      messages: [{ author: 'user', round: 1, body: 'fix', at: '2026-09-04T10:00:00.000Z' }],
    },
  ],
};

describe('submittedResult', () => {
  it('carries the verdict, round, general comment and every thread', () => {
    expect(submittedResult(state, 'request_changes', 'two things')).toEqual({
      status: 'submitted',
      verdict: 'request_changes',
      round: 2,
      general: 'two things',
      threads: state.threads,
    });
  });

  it('includes outdated and resolved threads, so the agent sees the whole picture', () => {
    const mixed: ReviewState = {
      ...state,
      threads: [
        { ...state.threads[0]!, id: 't1', status: 'outdated' },
        { ...state.threads[0]!, id: 't2', status: 'resolved' },
      ],
    };

    expect(submittedResult(mixed, 'approve', '').threads).toHaveLength(2);
  });
});

describe('the non-submitted results', () => {
  it('pending carries the URL to reopen', () => {
    expect(pendingResult('http://127.0.0.1:1/?t=x')).toEqual({
      status: 'pending',
      url: 'http://127.0.0.1:1/?t=x',
    });
  });

  it('no_changes needs no other field', () => {
    expect(noChangesResult()).toEqual({ status: 'no_changes' });
  });

  it('aborted is distinct from approval', () => {
    expect(abortedResult().status).toBe('aborted');
    expect(abortedResult().verdict).toBeUndefined();
  });

  it('error carries a message', () => {
    expect(errorResult('not a git repository')).toEqual({
      status: 'error',
      message: 'not a git repository',
    });
  });
});
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `npx vitest run src/server/review/result.test.ts`
Expected: FAIL — cannot resolve `./result.js`.

- [ ] **Step 7: Implement `src/server/review/result.ts`**

```ts
import type { CliResult, ReviewState, Verdict } from '../../shared/types.js';

/**
 * Every thread is returned, including resolved and outdated ones: the agent
 * needs the whole conversation, not just what is actionable this round.
 */
export function submittedResult(
  state: ReviewState,
  verdict: Verdict,
  general: string,
): CliResult {
  return {
    status: 'submitted',
    verdict,
    round: state.round,
    general,
    threads: state.threads,
  };
}

/** The foreground timed out; the server is still up and the agent should run again. */
export function pendingResult(url: string): CliResult {
  return { status: 'pending', url };
}

export function noChangesResult(): CliResult {
  return { status: 'no_changes' };
}

/** Deliberately carries no verdict: a cancelled review must never read as approval. */
export function abortedResult(): CliResult {
  return { status: 'aborted' };
}

export function errorResult(message: string): CliResult {
  return { status: 'error', message };
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run src/server/review/result.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 9: Commit**

```bash
git add src/server/review
git commit -m "feat(review): add round state machine and CLI result payloads"
```

---

### Task 7: Loopback security and static file serving

Small, but the two pieces that decide whether a stranger's web page can read
this repository. Both are pure enough to test without a socket.

**Files:**
- Create: `src/server/http/security.ts`, `src/server/http/static.ts`
- Test: `src/server/http/security.test.ts`, `src/server/http/static.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `TOKEN_HEADER = 'x-review-token'`, `TOKEN_QUERY = 't'`
  - `makeToken(): string` — 32 lowercase hex characters.
  - `isHostAllowed(host: string | undefined, port: number): boolean`
  - `isTokenValid(provided: string | null | undefined, expected: string): boolean` — constant-time.
  - `resolveStaticPath(root: string, urlPath: string): string | null` — `null` when the path escapes `root`.
  - `contentTypeFor(path: string): string`
  - `serveStatic(root: string, urlPath: string): Promise<{ status: number; body: Buffer; contentType: string }>` — falls back to `index.html` so the SPA survives a reload.

- [ ] **Step 1: Write the failing tests for security**

`src/server/http/security.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isHostAllowed, isTokenValid, makeToken } from './security.js';

describe('makeToken', () => {
  it('returns 32 hex characters', () => {
    expect(makeToken()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('does not repeat itself', () => {
    expect(makeToken()).not.toBe(makeToken());
  });
});

describe('isHostAllowed', () => {
  it('accepts loopback hosts on the right port', () => {
    expect(isHostAllowed('127.0.0.1:4711', 4711)).toBe(true);
    expect(isHostAllowed('localhost:4711', 4711)).toBe(true);
  });

  it('rejects a loopback host on a different port', () => {
    expect(isHostAllowed('127.0.0.1:80', 4711)).toBe(false);
  });

  it('rejects any other host, which is what stops DNS rebinding', () => {
    expect(isHostAllowed('evil.example.com:4711', 4711)).toBe(false);
    expect(isHostAllowed('192.168.1.10:4711', 4711)).toBe(false);
  });

  it('rejects a missing Host header', () => {
    expect(isHostAllowed(undefined, 4711)).toBe(false);
  });
});

describe('isTokenValid', () => {
  const token = makeToken();

  it('accepts the exact token', () => {
    expect(isTokenValid(token, token)).toBe(true);
  });

  it('rejects a wrong token of the same length', () => {
    expect(isTokenValid(`${token.slice(0, -1)}0`, token)).toBe(false);
  });

  it('rejects a token of a different length without throwing', () => {
    expect(isTokenValid('short', token)).toBe(false);
  });

  it('rejects a missing token', () => {
    expect(isTokenValid(null, token)).toBe(false);
    expect(isTokenValid(undefined, token)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/server/http/security.test.ts`
Expected: FAIL — cannot resolve `./security.js`.

- [ ] **Step 3: Implement `src/server/http/security.ts`**

```ts
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const TOKEN_HEADER = 'x-review-token';
export const TOKEN_QUERY = 't';

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

export function makeToken(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Without this check any website open in the same browser could resolve its own
 * domain to 127.0.0.1 and read this repository through our own API.
 */
export function isHostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false;
  return LOOPBACK_HOSTS.some((allowed) => host === `${allowed}:${port}`);
}

export function isTokenValid(
  provided: string | null | undefined,
  expected: string,
): boolean {
  if (!provided || provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/server/http/security.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Write the failing tests for static serving**

`src/server/http/static.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contentTypeFor, resolveStaticPath, serveStatic } from './static.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'web-review-static-'));
  await writeFile(join(root, 'index.html'), '<html>app</html>', 'utf8');
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(join(root, 'assets', 'app.js'), 'console.log(1)', 'utf8');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('resolveStaticPath', () => {
  it('resolves a normal path inside the root', () => {
    expect(resolveStaticPath('/srv/app', '/assets/app.js')).toBe(join('/srv/app', 'assets/app.js'));
  });

  it('refuses to escape the root', () => {
    expect(resolveStaticPath('/srv/app', '/../../etc/passwd')).toBeNull();
    expect(resolveStaticPath('/srv/app', '/assets/../../etc/passwd')).toBeNull();
  });

  it('decodes percent-encoded traversal too', () => {
    expect(resolveStaticPath('/srv/app', '/%2e%2e/%2e%2e/etc/passwd')).toBeNull();
  });
});

describe('contentTypeFor', () => {
  it('maps the types the bundle actually emits', () => {
    expect(contentTypeFor('index.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('app.js')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeFor('app.css')).toBe('text/css; charset=utf-8');
    expect(contentTypeFor('logo.svg')).toBe('image/svg+xml');
  });

  it('falls back to a safe default', () => {
    expect(contentTypeFor('unknown.xyz')).toBe('application/octet-stream');
  });
});

describe('serveStatic', () => {
  it('serves a real asset', async () => {
    const response = await serveStatic(root, '/assets/app.js');

    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe('console.log(1)');
    expect(response.contentType).toBe('text/javascript; charset=utf-8');
  });

  it('serves index.html at the root', async () => {
    expect((await serveStatic(root, '/')).body.toString()).toBe('<html>app</html>');
  });

  it('falls back to index.html for an unknown route, so reloads work', async () => {
    const response = await serveStatic(root, '/some/deep/route');

    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe('<html>app</html>');
  });

  it('returns 403 for a traversal attempt', async () => {
    expect((await serveStatic(root, '/../secret')).status).toBe(403);
  });
});
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `npx vitest run src/server/http/static.test.ts`
Expected: FAIL — cannot resolve `./static.js`.

- [ ] **Step 7: Implement `src/server/http/static.ts`**

```ts
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/** Returns null when the requested path would escape the served root. */
export function resolveStaticPath(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }

  const relative = normalize(decoded).replace(/^[/\\]+/, '');
  const full = resolve(root, relative);
  const rootResolved = resolve(root);

  if (full !== rootResolved && !full.startsWith(rootResolved + sep)) return null;
  return full;
}

export interface StaticResponse {
  status: number;
  body: Buffer;
  contentType: string;
}

export async function serveStatic(root: string, urlPath: string): Promise<StaticResponse> {
  const path = resolveStaticPath(root, urlPath === '/' ? '/index.html' : urlPath);
  if (path === null) {
    return { status: 403, body: Buffer.from('forbidden'), contentType: 'text/plain' };
  }

  const body = await readFile(path).catch(() => null);
  if (body) return { status: 200, body, contentType: contentTypeFor(path) };

  // Unknown route: hand back the SPA shell so a browser reload still works.
  const shell = await readFile(join(root, 'index.html')).catch(() => null);
  if (shell) {
    return { status: 200, body: shell, contentType: CONTENT_TYPES['.html']! };
  }

  return { status: 404, body: Buffer.from('not found'), contentType: 'text/plain' };
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run src/server/http/static.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 9: Commit**

```bash
git add src/server/http
git commit -m "feat(http): add loopback security checks and static serving"
```

---

### Task 8: The HTTP routes and the server lifecycle

**Files:**
- Create: `src/server/http/routes.ts`, `src/server/http/server.ts`
- Modify: `src/server/review/request.ts` (add `validateSubmit`)
- Test: `src/server/review/request.test.ts` (extend), `src/server/http/server.test.ts`

**Interfaces:**
- Consumes: `isHostAllowed`, `isTokenValid`, `TOKEN_HEADER` from `http/security.ts`; `serveStatic` from `http/static.ts`; `SessionPayload`, `SubmitPayload`, `Side` from `shared/types.ts`.
- Produces:
  - From `request.ts`: `validateSubmit(raw: unknown): SubmitPayload` — same `RequestError` style, every message naming its field.
  - From `routes.ts`: `interface RouteDeps { token; port; getSession; getFile; submit; waitForSubmission }` and `handleApi(req, res, deps): Promise<boolean>` — resolves `false` when the URL is not an `/api/` route, so the caller falls through to static serving.
  - From `server.ts`: `SERVER_FILE = 'server.json'`, `interface ServerRecord { pid; port; token; startedAt }`, `readServerRecord`, `writeServerRecord`, `removeServerRecord`, `isServerAlive`, `interface StartOptions`, `interface ServerHandle { port; url; close(); waitForSubmission(ms) }`, `startServer(options: StartOptions): Promise<ServerHandle>`.

- [ ] **Step 1: Write the failing test for `validateSubmit`**

Append to `src/server/review/request.test.ts`:

```ts
import { validateSubmit } from './request.js';

describe('validateSubmit', () => {
  it('accepts a complete submission', () => {
    const payload = {
      verdict: 'request_changes',
      general: 'two things',
      newComments: [{ file: 'a.ts', side: 'new', line: 4, body: 'rename' }],
      replies: [{ threadId: 't1', body: 'ok' }],
      resolved: ['t2'],
      reopened: ['t3'],
    };

    expect(validateSubmit(payload)).toEqual(payload);
  });

  it('defaults every list and the general comment', () => {
    expect(validateSubmit({ verdict: 'approve' })).toEqual({
      verdict: 'approve',
      general: '',
      newComments: [],
      replies: [],
      resolved: [],
      reopened: [],
    });
  });

  it('rejects an unknown verdict', () => {
    expect(() => validateSubmit({ verdict: 'lgtm' })).toThrow(/verdict/);
  });

  it('names the offending field on a bad comment', () => {
    expect(() =>
      validateSubmit({ verdict: 'comment', newComments: [{ file: 'a.ts', side: 'new', line: -1, body: 'x' }] }),
    ).toThrow(/newComments\[0\]\.line/);
  });

  it('rejects a non-string thread id in resolved', () => {
    expect(() => validateSubmit({ verdict: 'comment', resolved: [7] }))
      .toThrow(/resolved\[0\]/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/server/review/request.test.ts`
Expected: FAIL — `validateSubmit` is not exported.

- [ ] **Step 3: Add `validateSubmit` to `src/server/review/request.ts`**

Reuses the helpers already in the file. Append below `validateRequest`:

```ts
import type { NewComment, SubmitPayload, Verdict } from '../../shared/types.js';

const VERDICTS: Verdict[] = ['approve', 'request_changes', 'comment'];

function asVerdict(value: unknown): Verdict {
  if (typeof value !== 'string' || !VERDICTS.includes(value as Verdict)) {
    throw new RequestError(`verdict must be one of: ${VERDICTS.join(', ')}`);
  }
  return value as Verdict;
}

function asIdList(value: unknown, field: string): string[] {
  return asArray(value, field).map((id, index) => {
    if (typeof id !== 'string') throw new RequestError(`${field}[${index}] must be a string`);
    return id;
  });
}

function toNewComment(raw: unknown, index: number): NewComment {
  const field = `newComments[${index}]`;
  if (!isRecord(raw)) throw new RequestError(`${field} must be a JSON object`);

  const line = raw['line'];
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
    throw new RequestError(`${field}.line must be an integer >= 1`);
  }

  return {
    file: asString(raw['file'], `${field}.file`),
    line,
    side: asSide(raw['side'], `${field}.side`),
    body: asString(raw['body'], `${field}.body`),
  };
}

/** Validate what the browser POSTs. Same shape of errors as validateRequest. */
export function validateSubmit(raw: unknown): SubmitPayload {
  if (!isRecord(raw)) throw new RequestError('submission must be a JSON object');

  return {
    verdict: asVerdict(raw['verdict']),
    general: asString(raw['general'], 'general', ''),
    newComments: asArray(raw['newComments'], 'newComments').map(toNewComment),
    replies: asArray(raw['replies'], 'replies').map(toReply),
    resolved: asIdList(raw['resolved'], 'resolved'),
    reopened: asIdList(raw['reopened'], 'reopened'),
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/server/review/request.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Implement `src/server/http/routes.ts`**

No test of its own — Step 8's integration test drives every route through a real
socket, which is the only way to exercise the header checks honestly.

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isHostAllowed, isTokenValid, TOKEN_HEADER } from './security.js';
import { validateSubmit } from '../review/request.js';
import { RequestError } from '../review/request.js';
import type { SessionPayload, Side, SubmitPayload } from '../../shared/types.js';

export interface RouteDeps {
  token: string;
  port: number;
  getSession(): Promise<SessionPayload>;
  getFile(path: string, side: Side): Promise<string | null>;
  submit(payload: SubmitPayload): Promise<void>;
  waitForSubmission(timeoutMs: number): Promise<boolean>;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new RequestError('submission is too large');
    chunks.push(chunk as Buffer);
  }

  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RequestError('submission is not valid JSON');
  }
}

/** Returns false when the request is not for /api, so the caller serves static files. */
export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RouteDeps,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${deps.port}`);
  if (!url.pathname.startsWith('/api/')) return false;

  if (!isHostAllowed(req.headers.host, deps.port)) {
    sendJson(res, 403, { error: 'forbidden host' });
    return true;
  }

  const header = req.headers[TOKEN_HEADER];
  const provided = Array.isArray(header) ? header[0] : header;
  if (!isTokenValid(provided, deps.token)) {
    sendJson(res, 401, { error: 'invalid token' });
    return true;
  }

  try {
    if (req.method === 'GET' && url.pathname === '/api/session') {
      sendJson(res, 200, await deps.getSession());
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/file') {
      const path = url.searchParams.get('path');
      const side = url.searchParams.get('side');
      if (!path || (side !== 'old' && side !== 'new')) {
        sendJson(res, 400, { error: 'path and side=old|new are required' });
        return true;
      }

      const content = await deps.getFile(path, side);
      if (content === null) {
        res.writeHead(204).end();
        return true;
      }
      sendJson(res, 200, { content });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/wait') {
      const seconds = Number(url.searchParams.get('timeout') ?? '30');
      const bounded = Number.isFinite(seconds) ? Math.min(Math.max(seconds, 1), 600) : 30;
      sendJson(res, 200, { submitted: await deps.waitForSubmission(bounded * 1000) });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/review') {
      const payload = validateSubmit(await readBody(req));
      await deps.submit(payload);
      sendJson(res, 200, { ok: true });
      return true;
    }

    sendJson(res, 404, { error: 'unknown endpoint' });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unexpected error';
    sendJson(res, error instanceof RequestError ? 400 : 500, { error: message });
    return true;
  }
}
```

- [ ] **Step 6: Implement `src/server/http/server.ts`**

```ts
import { createServer, type Server } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { handleApi, type RouteDeps } from './routes.js';
import { serveStatic } from './static.js';

export const SERVER_FILE = 'server.json';

export interface ServerRecord {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
}

export interface StartOptions extends Omit<RouteDeps, 'port' | 'waitForSubmission' | 'submit'> {
  staticRoot: string;
  stateDir: string;
  port: number;
  /** Called once, with the first accepted submission. */
  onSubmit(payload: Parameters<RouteDeps['submit']>[0]): Promise<void>;
}

export interface ServerHandle {
  port: number;
  url: string;
  close(): Promise<void>;
  /** Resolves true if a submission arrives within the timeout, false otherwise. */
  waitForSubmission(timeoutMs: number): Promise<boolean>;
}

export async function startServer(options: StartOptions): Promise<ServerHandle> {
  let submitted = false;
  const waiters = new Set<(value: boolean) => void>();

  const waitForSubmission = (timeoutMs: number): Promise<boolean> =>
    new Promise((resolve) => {
      if (submitted) return resolve(true);

      const settle = (value: boolean) => {
        clearTimeout(timer);
        waiters.delete(settle);
        resolve(value);
      };
      const timer = setTimeout(() => settle(false), timeoutMs);
      timer.unref?.();
      waiters.add(settle);
    });

  const server: Server = createServer((req, res) => {
    void (async () => {
      const deps: RouteDeps = {
        token: options.token,
        port,
        getSession: options.getSession,
        getFile: options.getFile,
        waitForSubmission,
        submit: async (payload) => {
          await options.onSubmit(payload);
          submitted = true;
          for (const waiter of [...waiters]) waiter(true);
        },
      };

      if (await handleApi(req, res, deps)) return;

      const response = await serveStatic(options.staticRoot, new URL(
        req.url ?? '/',
        `http://127.0.0.1:${port}`,
      ).pathname);
      res.writeHead(response.status, {
        'content-type': response.contentType,
        'content-length': response.body.length,
        'cache-control': 'no-store',
      });
      res.end(response.body);
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', resolve);
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  const url = `http://127.0.0.1:${port}/?t=${options.token}`;

  await writeServerRecord(options.stateDir, {
    pid: process.pid,
    port,
    token: options.token,
    startedAt: new Date().toISOString(),
  });

  return {
    port,
    url,
    waitForSubmission,
    async close() {
      await removeServerRecord(options.stateDir);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function writeServerRecord(stateDir: string, record: ServerRecord): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, SERVER_FILE), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

export async function readServerRecord(stateDir: string): Promise<ServerRecord | null> {
  const raw = await readFile(join(stateDir, SERVER_FILE), 'utf8').catch(() => null);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as ServerRecord;
  } catch {
    return null;
  }
}

export async function removeServerRecord(stateDir: string): Promise<void> {
  await rm(join(stateDir, SERVER_FILE), { force: true });
}

/**
 * A record can outlive its process (a crash, a reboot). Check the pid is still
 * there, then confirm something is actually answering on the port.
 */
export async function isServerAlive(record: ServerRecord): Promise<boolean> {
  try {
    process.kill(record.pid, 0);
  } catch {
    return false;
  }

  const response = await fetch(`http://127.0.0.1:${record.port}/api/session`, {
    headers: { 'x-review-token': record.token, host: `127.0.0.1:${record.port}` },
  }).catch(() => null);

  return response?.ok === true;
}
```

Note the ordering hazard: `port` is referenced inside the request handler before
its `const` is initialised. That is safe because no request can arrive before
`listen` resolves, but if the implementer prefers, hoist `let port = options.port`
above `createServer` and reassign after listening.

- [ ] **Step 7: Write the failing integration test**

`src/server/http/server.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isServerAlive, readServerRecord, startServer, type ServerHandle } from './server.js';
import { makeToken } from './security.js';
import type { SessionPayload, SubmitPayload } from '../../shared/types.js';

const token = makeToken();
const session: SessionPayload = {
  round: 1,
  base: 'HEAD',
  baseLabel: 'working tree vs HEAD',
  summary: 'Add JWT refresh.',
  files: [],
  threads: [],
};

let dir: string;
let handle: ServerHandle;
let received: SubmitPayload[];

const call = (path: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${handle.port}${path}`, {
    ...init,
    headers: { 'x-review-token': token, ...(init.headers ?? {}) },
  });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'web-review-server-'));
  await writeFile(join(dir, 'index.html'), '<html>app</html>', 'utf8');
  received = [];

  handle = await startServer({
    staticRoot: dir,
    stateDir: dir,
    port: 0,
    token,
    getSession: async () => session,
    getFile: async (path) => (path === 'a.ts' ? 'one\ntwo\n' : null),
    onSubmit: async (payload) => {
      received.push(payload);
    },
  });
});

afterEach(async () => {
  await handle.close();
  await rm(dir, { recursive: true, force: true });
});

describe('startServer', () => {
  it('listens on an OS-assigned loopback port and records itself', async () => {
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.url).toBe(`http://127.0.0.1:${handle.port}/?t=${token}`);

    const record = await readServerRecord(dir);
    expect(record).toMatchObject({ pid: process.pid, port: handle.port, token });
    expect(await isServerAlive(record!)).toBe(true);
  });

  it('serves the session', async () => {
    expect(await (await call('/api/session')).json()).toEqual(session);
  });

  it('serves file contents and 204s for a missing side', async () => {
    expect(await (await call('/api/file?path=a.ts&side=new')).json())
      .toEqual({ content: 'one\ntwo\n' });
    expect((await call('/api/file?path=b.ts&side=old')).status).toBe(204);
  });

  it('rejects a request with no token', async () => {
    const response = await fetch(`http://127.0.0.1:${handle.port}/api/session`);

    expect(response.status).toBe(401);
  });

  it('rejects a request whose Host header is not loopback', async () => {
    const response = await call('/api/session', { headers: { host: 'evil.example.com' } });

    expect(response.status).toBe(403);
  });

  it('rejects a malformed submission with a field-named message', async () => {
    const response = await call('/api/review', {
      method: 'POST',
      body: JSON.stringify({ verdict: 'lgtm' }),
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/verdict/);
  });

  it('serves the app shell for a non-API route', async () => {
    const response = await fetch(`http://127.0.0.1:${handle.port}/anything`);

    expect(await response.text()).toBe('<html>app</html>');
  });
});

describe('waitForSubmission', () => {
  it('resolves false when nothing is submitted in time', async () => {
    expect(await handle.waitForSubmission(50)).toBe(false);
  });

  it('resolves true as soon as a review is posted', async () => {
    const waiting = handle.waitForSubmission(5000);

    const response = await call('/api/review', {
      method: 'POST',
      body: JSON.stringify({ verdict: 'request_changes', general: 'two things' }),
    });

    expect(response.status).toBe(200);
    expect(await waiting).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]?.general).toBe('two things');
  });

  it('resolves immediately once a submission has already happened', async () => {
    await call('/api/review', { method: 'POST', body: JSON.stringify({ verdict: 'approve' }) });

    expect(await handle.waitForSubmission(50)).toBe(true);
  });
});
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run src/server/http/server.test.ts`
Expected: PASS, 10 tests.

If the Host-header test fails with a fetch error, note that Node's `fetch`
forbids overriding `host` in some versions; in that case use `node:http`'s
`request` directly for that one test.

- [ ] **Step 9: Commit**

```bash
git add src/server/http src/server/review/request.ts src/server/review/request.test.ts
git commit -m "feat(http): add API routes, server lifecycle, and submission waiting"
```

---

### Task 9: The CLI — flags, detachment, re-attachment, and the end-to-end loop

The task that makes the tool real. It ends with a test that runs the actual
built artifact against a real repository and drives a complete review round.

**Files:**
- Replace: `src/server/cli.ts` (the Task 1 stub)
- Test: `src/server/cli.test.ts` (flag parsing), `src/server/cli.e2e.test.ts` (the built CLI)

**Implementation detail beyond the spec:** the state directory holds five files.
`request.json` (agent to tool), `state.json` (threads across rounds),
`session.json` (parent process to detached server), `server.json` (liveness
record), `result.json` (server back to whichever CLI invocation is waiting).
`result.json` is what makes re-attachment and crash recovery work: the waiting
process reads the outcome from disk rather than from the socket.

**Interfaces:**
- Consumes: everything built so far.
- Produces:
  - `interface CliOptions { base: string; timeoutSeconds: number; port: number; open: boolean; stop: boolean; serveInternal: boolean }`
  - `parseArgs(argv: string[]): CliOptions`
  - `RESULT_FILE = 'result.json'`, `SESSION_FILE = 'session.json'`

- [ ] **Step 1: Write the failing tests for flag parsing**

`src/server/cli.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseArgs } from './cli.js';

const defaults = {
  base: 'auto',
  timeoutSeconds: 540,
  port: 0,
  open: true,
  stop: false,
  serveInternal: false,
};

describe('parseArgs', () => {
  it('defaults to auto base, a 540s timeout and an OS-assigned port', () => {
    expect(parseArgs([])).toEqual(defaults);
  });

  it('takes a bare ref as the base', () => {
    expect(parseArgs(['HEAD~3'])).toEqual({ ...defaults, base: 'HEAD~3' });
  });

  it('accepts --base, --timeout and --port', () => {
    expect(parseArgs(['--base', 'main', '--timeout', '30', '--port', '4711'])).toEqual({
      ...defaults,
      base: 'main',
      timeoutSeconds: 30,
      port: 4711,
    });
  });

  it('accepts --staged as a shorthand for --base staged', () => {
    expect(parseArgs(['--staged'])).toEqual({ ...defaults, base: 'staged' });
  });

  it('turns off the browser with --no-open', () => {
    expect(parseArgs(['--no-open'])).toEqual({ ...defaults, open: false });
  });

  it('recognises --stop', () => {
    expect(parseArgs(['--stop'])).toEqual({ ...defaults, stop: true });
  });

  it('rejects a non-numeric timeout', () => {
    expect(() => parseArgs(['--timeout', 'soon'])).toThrow(/--timeout/);
  });

  it('rejects an unknown flag', () => {
    expect(() => parseArgs(['--wat'])).toThrow(/unknown option: --wat/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/server/cli.test.ts`
Expected: FAIL — `parseArgs` is not exported.

- [ ] **Step 3: Implement `src/server/cli.ts`**

```ts
import { spawn } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { frameResult } from '../shared/protocol.js';
import { gitDir as resolveGitDir, repoRoot } from './git/exec.js';
import { resolveRange, type DiffRange } from './git/range.js';
import { listChangedFiles, readSide } from './git/files.js';
import { consumeRequest } from './review/request.js';
import { splitLines } from './review/anchor.js';
import {
  applySubmission,
  openRound,
  readState,
  stateDirFor,
  writeState,
  type LinesLookup,
} from './review/state.js';
import {
  abortedResult,
  errorResult,
  noChangesResult,
  pendingResult,
  submittedResult,
} from './review/result.js';
import { makeToken } from './http/security.js';
import {
  isServerAlive,
  readServerRecord,
  removeServerRecord,
  startServer,
} from './http/server.js';
import type { CliResult, SessionPayload } from '../shared/types.js';

export const RESULT_FILE = 'result.json';
export const SESSION_FILE = 'session.json';

export interface CliOptions {
  base: string;
  timeoutSeconds: number;
  port: number;
  open: boolean;
  stop: boolean;
  serveInternal: boolean;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    base: 'auto',
    timeoutSeconds: 540,
    port: 0,
    open: true,
    stop: false,
    serveInternal: false,
  };

  const number = (raw: string | undefined, flag: string): number => {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`web-review: ${flag} needs a number`);
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--base') options.base = argv[++i] ?? 'auto';
    else if (arg === '--staged') options.base = 'staged';
    else if (arg === '--timeout') options.timeoutSeconds = number(argv[++i], '--timeout');
    else if (arg === '--port') options.port = number(argv[++i], '--port');
    else if (arg === '--no-open') options.open = false;
    else if (arg === '--stop') options.stop = true;
    else if (arg === '--__serve') options.serveInternal = true;
    else if (arg.startsWith('-')) throw new Error(`web-review: unknown option: ${arg}`);
    else options.base = arg;
  }

  return options;
}

interface SessionFile {
  base: string;
  label: string;
  staged: boolean;
  summary: string;
  token: string;
  port: number;
}

function linesLookup(range: DiffRange, cwd: string): LinesLookup {
  return async (file, side) => {
    const content = await readSide(file, side, range, { cwd });
    return content === null ? null : splitLines(content);
  };
}

function emit(result: CliResult, code = 0): never {
  process.stdout.write(`${frameResult(result)}\n`);
  process.exit(code);
}

/**
 * A cancelled review must never reach the agent as silence, which it could
 * mistake for approval. Print an explicit `aborted` and leave the detached
 * server running so re-running the command re-attaches.
 */
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => emit(abortedResult(), 130));
}

function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd'
    : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];

  try {
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // A missing browser opener is not a reason to fail the review.
  }
}

/** The detached half: serve until a review is submitted, then write the result and exit. */
async function serveMain(cwd: string, stateDir: string): Promise<void> {
  const session = JSON.parse(await readFile(join(stateDir, SESSION_FILE), 'utf8')) as SessionFile;
  const range: DiffRange = { base: session.base, label: session.label, staged: session.staged };
  const lookup = linesLookup(range, cwd);

  const handle = await startServer({
    staticRoot: join(import.meta.dirname, '..', 'app', 'dist'),
    stateDir,
    port: session.port,
    token: session.token,
    getSession: async (): Promise<SessionPayload> => {
      const state = await readState(stateDir);
      return {
        round: state.round,
        base: range.base,
        baseLabel: range.label,
        summary: session.summary,
        files: await listChangedFiles(range, { cwd }),
        threads: state.threads,
      };
    },
    getFile: async (path, side) => readSide(path, side, range, { cwd }),
    onSubmit: async (payload) => {
      const state = await readState(stateDir);
      const next = await applySubmission(state, payload, lookup);
      await writeState(stateDir, next);
      await writeFile(
        join(stateDir, RESULT_FILE),
        JSON.stringify(submittedResult(next, payload.verdict, payload.general), null, 2),
        'utf8',
      );
    },
  });

  await handle.waitForSubmission(24 * 60 * 60 * 1000);
  setTimeout(() => void handle.close().then(() => process.exit(0)), 250).unref();
}

/** Wait for a result to appear, either from this process's server or another's. */
async function waitForResult(stateDir: string, timeoutSeconds: number): Promise<CliResult | null> {
  const deadline = Date.now() + timeoutSeconds * 1000;

  while (Date.now() < deadline) {
    const raw = await readFile(join(stateDir, RESULT_FILE), 'utf8').catch(() => null);
    if (raw !== null) {
      await rm(join(stateDir, RESULT_FILE), { force: true });
      return JSON.parse(raw) as CliResult;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return null;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();

  const root = await repoRoot({ cwd }).catch(() => null);
  if (root === null) emit(errorResult('not a git repository'), 1);

  const gitDir = await resolveGitDir({ cwd: root });
  const stateDir = stateDirFor(gitDir);

  if (options.serveInternal) {
    await serveMain(root, stateDir);
    return;
  }

  if (options.stop) {
    const record = await readServerRecord(stateDir);
    if (record) {
      try {
        process.kill(record.pid);
      } catch {
        // Already gone.
      }
      await removeServerRecord(stateDir);
    }
    emit({ ...abortedResult(), message: 'server stopped' });
  }

  const existing = await readServerRecord(stateDir);
  if (existing && (await isServerAlive(existing))) {
    const result = await waitForResult(stateDir, options.timeoutSeconds);
    emit(result ?? pendingResult(`http://127.0.0.1:${existing.port}/?t=${existing.token}`));
  }
  await removeServerRecord(stateDir);

  const request = await consumeRequest(stateDir);
  const range = await resolveRange(options.base === 'auto' ? request.base : options.base, { cwd: root });

  const files = await listChangedFiles(range, { cwd: root });
  if (files.length === 0) emit(noChangesResult());

  const state = await openRound(await readState(stateDir), request, linesLookup(range, root));
  await writeState(stateDir, state);
  await rm(join(stateDir, RESULT_FILE), { force: true });

  const token = makeToken();
  const session: SessionFile = {
    base: range.base,
    label: range.label,
    staged: range.staged,
    summary: request.summary,
    token,
    port: options.port,
  };
  await writeFile(join(stateDir, SESSION_FILE), JSON.stringify(session, null, 2), 'utf8');

  spawn(process.execPath, [process.argv[1]!, '--__serve'], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
  }).unref();

  const record = await waitForRecord(stateDir);
  if (!record) emit(errorResult('the review server failed to start'), 1);

  const url = `http://127.0.0.1:${record.port}/?t=${record.token}`;
  if (options.open) openBrowser(url);

  const result = await waitForResult(stateDir, options.timeoutSeconds);
  emit(result ?? pendingResult(url));
}

async function waitForRecord(stateDir: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const record = await readServerRecord(stateDir);
    if (record) return record;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

main().catch((error: unknown) => {
  emit(errorResult(error instanceof Error ? error.message : 'unexpected error'), 1);
});
```

- [ ] **Step 4: Run the flag tests to verify they pass**

Run: `npx vitest run src/server/cli.test.ts`
Expected: PASS, 8 tests.

The test file imports `cli.js`, which calls `main()` on import. Guard it so the
tests do not launch a server: wrap the final call as

```ts
if (!process.env['WEB_REVIEW_NO_MAIN']) {
  main().catch(/* ... */);
}
```

and set `WEB_REVIEW_NO_MAIN=1` at the top of `cli.test.ts` via
`vi.stubEnv('WEB_REVIEW_NO_MAIN', '1')` before the import, or simply move
`parseArgs` into its own module if that proves awkward.

- [ ] **Step 5: Write the failing end-to-end test**

`src/server/cli.e2e.test.ts` — this drives the real built artifact.

```ts
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRepo, type TestRepo } from './test-helpers/repo.js';
import { parseFramed } from '../shared/protocol.js';
import type { CliResult } from '../shared/types.js';

const run = promisify(execFile);
const CLI = resolve('dist/web-review.mjs');

let repo: TestRepo;

async function cli(args: string[]): Promise<CliResult> {
  const { stdout } = await run(process.execPath, [CLI, ...args], { cwd: repo.dir })
    .catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '' }));
  return parseFramed(stdout);
}

beforeAll(async () => {
  await run(process.execPath, ['scripts/build-server.mjs']);
}, 60_000);

beforeEach(async () => {
  repo = await createRepo();
  await repo.write('src/auth.ts', 'export function sign() {\n  return 1;\n}\n');
  await repo.commit('initial');
});

afterEach(async () => {
  await cli(['--stop']).catch(() => undefined);
  await repo.cleanup();
});

describe('the CLI', () => {
  it('reports no_changes and never opens a browser on a clean tree', async () => {
    expect(await cli(['--no-open'])).toEqual({ status: 'no_changes' });
  });

  it('errors outside a git repository', async () => {
    const { stdout } = await run(process.execPath, [CLI], { cwd: '/tmp' })
      .catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '' }));

    expect(parseFramed(stdout)).toEqual({ status: 'error', message: 'not a git repository' });
  });

  it('returns pending with a URL when the reviewer takes too long', async () => {
    await repo.write('src/auth.ts', 'export function sign() {\n  return 2;\n}\n');

    const result = await cli(['--no-open', '--timeout', '2']);

    expect(result.status).toBe('pending');
    expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{32}$/);
  }, 20_000);

  it('carries the agent summary and annotations into the session', async () => {
    await repo.write('src/auth.ts', 'export function sign() {\n  return 2;\n}\n');
    const stateDir = join(repo.dir, '.git', 'web-review');
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, 'request.json'),
      JSON.stringify({
        summary: 'Change the return value.',
        annotations: [{ file: 'src/auth.ts', line: 2, side: 'new', body: 'why 2?' }],
      }),
      'utf8',
    );

    const pending = await cli(['--no-open', '--timeout', '2']);
    const url = new URL(pending.url!);
    const token = url.searchParams.get('t')!;

    const session = await fetch(`${url.origin}/api/session`, {
      headers: { 'x-review-token': token },
    }).then((r) => r.json());

    expect(session.summary).toBe('Change the return value.');
    expect(session.round).toBe(1);
    expect(session.files.map((f: { path: string }) => f.path)).toEqual(['src/auth.ts']);
    expect(session.threads[0].messages[0]).toMatchObject({ author: 'agent', body: 'why 2?' });

    // The request file is consumed, so it cannot leak into a later round.
    await expect(readFile(join(stateDir, 'request.json'), 'utf8')).rejects.toThrow();
  }, 20_000);

  it('completes a full round: pending, submit, then re-attach returns the review', async () => {
    await repo.write('src/auth.ts', 'export function sign() {\n  return 2;\n}\n');

    const pending = await cli(['--no-open', '--timeout', '2']);
    const url = new URL(pending.url!);
    const token = url.searchParams.get('t')!;

    const posted = await fetch(`${url.origin}/api/review`, {
      method: 'POST',
      headers: { 'x-review-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({
        verdict: 'request_changes',
        general: 'One thing.',
        newComments: [{ file: 'src/auth.ts', side: 'new', line: 2, body: 'return a token' }],
      }),
    });
    expect(posted.status).toBe(200);

    const submitted = await cli(['--no-open', '--timeout', '10']);

    expect(submitted.status).toBe('submitted');
    expect(submitted.verdict).toBe('request_changes');
    expect(submitted.general).toBe('One thing.');
    expect(submitted.threads).toHaveLength(1);
    expect(submitted.threads![0]).toMatchObject({
      file: 'src/auth.ts',
      side: 'new',
      status: 'open',
      anchor: { line: 2, content: '  return 2;' },
    });
    expect(submitted.threads![0]!.messages[0]).toMatchObject({
      author: 'user',
      body: 'return a token',
    });
  }, 30_000);

  it('carries a thread into round 2 and follows the line when it moves', async () => {
    await repo.write('src/auth.ts', 'export function sign() {\n  return 2;\n}\n');

    const pending = await cli(['--no-open', '--timeout', '2']);
    const url = new URL(pending.url!);
    const token = url.searchParams.get('t')!;

    await fetch(`${url.origin}/api/review`, {
      method: 'POST',
      headers: { 'x-review-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({
        verdict: 'request_changes',
        newComments: [{ file: 'src/auth.ts', side: 'new', line: 2, body: 'return a token' }],
      }),
    });
    await cli(['--no-open', '--timeout', '10']);

    // The agent "fixes" the file by inserting a line above the commented one.
    await repo.write('src/auth.ts', 'export function sign() {\n  // fixed\n  return 2;\n}\n');
    const stateDir = join(repo.dir, '.git', 'web-review');
    await writeFile(
      join(stateDir, 'request.json'),
      JSON.stringify({ replies: [{ threadId: 't1', body: 'Added a note.' }] }),
      'utf8',
    );

    const round2 = await cli(['--no-open', '--timeout', '2']);
    const url2 = new URL(round2.url!);
    const session = await fetch(`${url2.origin}/api/session`, {
      headers: { 'x-review-token': url2.searchParams.get('t')! },
    }).then((r) => r.json());

    expect(session.round).toBe(2);
    expect(session.threads[0].anchor.line).toBe(3);
    expect(session.threads[0].status).toBe('open');
    expect(session.threads[0].messages).toHaveLength(2);
    expect(session.threads[0].messages[1]).toMatchObject({
      author: 'agent',
      round: 2,
      body: 'Added a note.',
    });
  }, 30_000);
});
```

- [ ] **Step 6: Run the end-to-end test**

Run: `npx vitest run src/server/cli.e2e.test.ts`
Expected: PASS, 6 tests.

This is the test that proves the whole server half: detachment, re-attachment,
the pending/submitted protocol, request consumption, anchoring, and round
transitions. If it passes, the CLI contract from the spec is met.

- [ ] **Step 7: Run the whole suite and build**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/server/cli.ts src/server/cli.test.ts src/server/cli.e2e.test.ts dist
git commit -m "feat(cli): add re-entrant blocking CLI with detached review server"
```

---

### Task 10: The API client and the draft store

The two pieces of app logic that carry no markup, so they can be tested outright
before any component exists.

**Files:**
- Create: `app/src/api/client.ts`, `app/src/state/draft.ts`
- Test: `app/src/api/client.test.ts`, `app/src/state/draft.test.ts`

**Interfaces:**
- Consumes: `SessionPayload`, `SubmitPayload`, `Side`, `Verdict` from `src/shared/types.ts` (imported with a relative path; both tsconfigs include `src/shared`).
- Produces:
  - `class ApiError extends Error { status: number }`
  - `readToken(search: string): string` — throws when the `t` parameter is missing.
  - `interface ReviewApi { getSession; getFile; submit }`
  - `createApi(token: string, fetchImpl?: typeof fetch): ReviewApi`
  - `draftKey(file: string, side: Side, line: number): string`
  - `useDraftStore` (zustand) with state `{ comments, replies, resolved, general, viewed }` and actions `setComment`, `removeComment`, `setReply`, `setResolved`, `setGeneral`, `setViewed`, `reset`.
  - `pendingCount(state: DraftState): number`
  - `buildSubmit(state: DraftState, verdict: Verdict): SubmitPayload`

- [ ] **Step 1: Write the failing tests for the API client**

`app/src/api/client.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApi, readToken } from './client.js';

const ok = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('readToken', () => {
  it('reads the token from the query string', () => {
    expect(readToken('?t=abc123')).toBe('abc123');
  });

  it('throws a readable error when it is missing', () => {
    expect(() => readToken('')).toThrow(/missing review token/i);
  });
});

describe('createApi', () => {
  it('sends the token header on every call', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ round: 1 }));

    await createApi('tok', fetchImpl as unknown as typeof fetch).getSession();

    expect(fetchImpl).toHaveBeenCalledWith('/api/session', {
      headers: { 'x-review-token': 'tok' },
    });
  });

  it('returns null for a 204 file response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

    expect(await createApi('tok', fetchImpl as unknown as typeof fetch).getFile('a.ts', 'old'))
      .toBeNull();
  });

  it('encodes the file path', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ content: 'x' }));

    await createApi('tok', fetchImpl as unknown as typeof fetch).getFile('src/a b.ts', 'new');

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/file?path=src%2Fa%20b.ts&side=new');
  });

  it('POSTs a submission as JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ ok: true }));
    const payload = {
      verdict: 'approve' as const,
      general: '',
      newComments: [],
      replies: [],
      resolved: [],
      reopened: [],
    };

    await createApi('tok', fetchImpl as unknown as typeof fetch).submit(payload);

    expect(fetchImpl).toHaveBeenCalledWith('/api/review', {
      method: 'POST',
      headers: { 'x-review-token': 'tok', 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  });

  it('throws ApiError carrying the status and the server message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ error: 'verdict must be one of' }, 400));

    await expect(createApi('tok', fetchImpl as unknown as typeof fetch).getSession())
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/verdict/) });
    expect(ApiError).toBeDefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run app/src/api/client.test.ts`
Expected: FAIL — cannot resolve `./client.js`.

- [ ] **Step 3: Implement `app/src/api/client.ts`**

```ts
import type { SessionPayload, Side, SubmitPayload } from '../../../src/shared/types.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The server hands the browser its token in the URL; without it nothing is reachable. */
export function readToken(search: string): string {
  const token = new URLSearchParams(search).get('t');
  if (!token) throw new Error('web-review: missing review token in the URL');
  return token;
}

export interface ReviewApi {
  getSession(): Promise<SessionPayload>;
  getFile(path: string, side: Side): Promise<string | null>;
  submit(payload: SubmitPayload): Promise<void>;
}

async function unwrap(response: Response): Promise<unknown> {
  if (response.ok) return response.status === 204 ? null : response.json();

  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  throw new ApiError(response.status, body?.error ?? `request failed (${response.status})`);
}

export function createApi(token: string, fetchImpl: typeof fetch = fetch): ReviewApi {
  const headers = { 'x-review-token': token };

  return {
    async getSession() {
      return (await unwrap(await fetchImpl('/api/session', { headers }))) as SessionPayload;
    },

    async getFile(path, side) {
      const query = `path=${encodeURIComponent(path)}&side=${side}`;
      const body = (await unwrap(await fetchImpl(`/api/file?${query}`, { headers }))) as
        | { content: string }
        | null;
      return body?.content ?? null;
    },

    async submit(payload) {
      await unwrap(
        await fetchImpl('/api/review', {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }),
      );
    },
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run app/src/api/client.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write the failing tests for the draft store**

`app/src/state/draft.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { buildSubmit, draftKey, pendingCount, useDraftStore } from './draft.js';

beforeEach(() => {
  useDraftStore.getState().reset();
});

describe('draftKey', () => {
  it('identifies a comment position uniquely', () => {
    expect(draftKey('src/a.ts', 'new', 12)).toBe('src/a.ts:new:12');
    expect(draftKey('src/a.ts', 'old', 12)).not.toBe(draftKey('src/a.ts', 'new', 12));
  });
});

describe('the draft store', () => {
  it('adds, edits and removes a comment', () => {
    const store = useDraftStore.getState();

    store.setComment('src/a.ts', 'new', 12, 'first');
    expect(useDraftStore.getState().comments[draftKey('src/a.ts', 'new', 12)]?.body).toBe('first');

    useDraftStore.getState().setComment('src/a.ts', 'new', 12, 'second');
    expect(useDraftStore.getState().comments[draftKey('src/a.ts', 'new', 12)]?.body).toBe('second');

    useDraftStore.getState().removeComment(draftKey('src/a.ts', 'new', 12));
    expect(useDraftStore.getState().comments).toEqual({});
  });

  it('drops a comment set to an empty body, so a cleared box is not submitted', () => {
    useDraftStore.getState().setComment('src/a.ts', 'new', 12, 'x');
    useDraftStore.getState().setComment('src/a.ts', 'new', 12, '   ');

    expect(useDraftStore.getState().comments).toEqual({});
  });

  it('tracks replies and resolve toggles per thread', () => {
    useDraftStore.getState().setReply('t1', 'agreed');
    useDraftStore.getState().setResolved('t2', true);
    useDraftStore.getState().setResolved('t3', false);

    const state = useDraftStore.getState();
    expect(state.replies).toEqual({ t1: 'agreed' });
    expect(state.resolved).toEqual({ t2: true, t3: false });
  });

  it('remembers which files have been marked viewed', () => {
    useDraftStore.getState().setViewed('src/a.ts', true);

    expect(useDraftStore.getState().viewed['src/a.ts']).toBe(true);
  });
});

describe('pendingCount', () => {
  it('counts comments, replies and resolve toggles together', () => {
    useDraftStore.getState().setComment('src/a.ts', 'new', 1, 'a');
    useDraftStore.getState().setReply('t1', 'b');
    useDraftStore.getState().setResolved('t2', true);

    expect(pendingCount(useDraftStore.getState())).toBe(3);
  });

  it('ignores the general comment and viewed flags', () => {
    useDraftStore.getState().setGeneral('looks fine');
    useDraftStore.getState().setViewed('src/a.ts', true);

    expect(pendingCount(useDraftStore.getState())).toBe(0);
  });
});

describe('buildSubmit', () => {
  it('turns the store into the payload the server expects', () => {
    const store = useDraftStore.getState();
    store.setComment('src/a.ts', 'new', 12, 'rename this');
    useDraftStore.getState().setReply('t1', 'agreed');
    useDraftStore.getState().setResolved('t2', true);
    useDraftStore.getState().setResolved('t3', false);
    useDraftStore.getState().setGeneral('Two things.');

    expect(buildSubmit(useDraftStore.getState(), 'request_changes')).toEqual({
      verdict: 'request_changes',
      general: 'Two things.',
      newComments: [{ file: 'src/a.ts', side: 'new', line: 12, body: 'rename this' }],
      replies: [{ threadId: 't1', body: 'agreed' }],
      resolved: ['t2'],
      reopened: ['t3'],
    });
  });

  it('produces an empty payload when nothing was drafted', () => {
    expect(buildSubmit(useDraftStore.getState(), 'approve')).toEqual({
      verdict: 'approve',
      general: '',
      newComments: [],
      replies: [],
      resolved: [],
      reopened: [],
    });
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run app/src/state/draft.test.ts`
Expected: FAIL — cannot resolve `./draft.js`.

- [ ] **Step 7: Implement `app/src/state/draft.ts`**

```ts
import { create } from 'zustand';
import type { Side, SubmitPayload, Verdict } from '../../../src/shared/types.js';

export interface Draft {
  file: string;
  side: Side;
  line: number;
  body: string;
}

export interface DraftState {
  comments: Record<string, Draft>;
  replies: Record<string, string>;
  /** true = resolve on submit, false = reopen on submit. */
  resolved: Record<string, boolean>;
  general: string;
  viewed: Record<string, boolean>;
  setComment(file: string, side: Side, line: number, body: string): void;
  removeComment(key: string): void;
  setReply(threadId: string, body: string): void;
  setResolved(threadId: string, value: boolean): void;
  setGeneral(body: string): void;
  setViewed(file: string, value: boolean): void;
  reset(): void;
}

export function draftKey(file: string, side: Side, line: number): string {
  return `${file}:${side}:${line}`;
}

const EMPTY = {
  comments: {} as Record<string, Draft>,
  replies: {} as Record<string, string>,
  resolved: {} as Record<string, boolean>,
  general: '',
  viewed: {} as Record<string, boolean>,
};

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

export const useDraftStore = create<DraftState>((set) => ({
  ...EMPTY,

  setComment(file, side, line, body) {
    const key = draftKey(file, side, line);
    set((state) =>
      body.trim().length === 0
        ? { comments: withoutKey(state.comments, key) }
        : { comments: { ...state.comments, [key]: { file, side, line, body } } },
    );
  },

  removeComment(key) {
    set((state) => ({ comments: withoutKey(state.comments, key) }));
  },

  setReply(threadId, body) {
    set((state) =>
      body.trim().length === 0
        ? { replies: withoutKey(state.replies, threadId) }
        : { replies: { ...state.replies, [threadId]: body } },
    );
  },

  setResolved(threadId, value) {
    set((state) => ({ resolved: { ...state.resolved, [threadId]: value } }));
  },

  setGeneral(general) {
    set({ general });
  },

  setViewed(file, value) {
    set((state) => ({ viewed: { ...state.viewed, [file]: value } }));
  },

  reset() {
    set({ ...EMPTY });
  },
}));

/** What the "Review (n)" badge shows: everything that would be sent right now. */
export function pendingCount(state: DraftState): number {
  return (
    Object.keys(state.comments).length +
    Object.keys(state.replies).length +
    Object.keys(state.resolved).length
  );
}

export function buildSubmit(state: DraftState, verdict: Verdict): SubmitPayload {
  return {
    verdict,
    general: state.general,
    newComments: Object.values(state.comments).map(({ file, side, line, body }) => ({
      file,
      side,
      line,
      body,
    })),
    replies: Object.entries(state.replies).map(([threadId, body]) => ({ threadId, body })),
    resolved: Object.entries(state.resolved).filter(([, v]) => v).map(([id]) => id),
    reopened: Object.entries(state.resolved).filter(([, v]) => !v).map(([id]) => id),
  };
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `npx vitest run app/src/state/draft.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 9: Commit**

```bash
git add app/src/api app/src/state
git commit -m "feat(app): add the API client and the draft comment store"
```

---

### Task 11: The app shell — theme, layout, file tree, summary, file sections

Everything around the diff. The diff body itself arrives in Task 12; here
`FileSection` simply renders whatever children it is given, so the shell can be
finished and tested on its own.

**New dependency:** add `"react-markdown": "^9.0.1"` to `dependencies`. The
agent's summary is markdown per the spec, and hand-rolling a renderer is worse
than one small bundled library.

**Files:**
- Create: `app/src/theme.ts`, `app/src/components/SummaryPanel/SummaryPanel.tsx`, `app/src/components/FileTree/tree.ts`, `app/src/components/FileTree/FileTree.tsx`, `app/src/components/FileSection/FileSection.tsx`, `app/src/App.tsx`
- Replace: `app/src/main.tsx`
- Modify: `package.json`
- Test: `app/src/components/FileTree/tree.test.ts`, `app/src/components/FileSection/FileSection.test.tsx`, `app/src/App.test.tsx`

**Interfaces:**
- Consumes: `createApi`, `readToken`, `ReviewApi` from `api/client.ts`; `useDraftStore`, `pendingCount` from `state/draft.ts`; `FileEntry`, `SessionPayload`, `Thread` from `src/shared/types.ts`.
- Produces:
  - `useIsDark(): boolean`
  - `buildFileTree(files: FileEntry[], commentCounts: Record<string, number>): DataNode[]`
  - `countThreadsByFile(threads: Thread[]): Record<string, number>`
  - `<SummaryPanel summary={string} threadCount={number} />`
  - `<FileTree files activeFile onSelect commentCounts />`
  - `<FileSection file={FileEntry} viewed onViewedChange defaultCollapsed>{children}</FileSection>`
  - `<App api={ReviewApi} />` — the api is a prop so tests inject a fake.

- [ ] **Step 1: Write the failing test for the tree builder**

`app/src/components/FileTree/tree.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildFileTree, countThreadsByFile } from './tree.js';
import type { FileEntry, Thread } from '../../../../src/shared/types.js';

const file = (path: string): FileEntry => ({
  path,
  oldPath: path,
  status: 'modified',
  additions: 1,
  deletions: 0,
  binary: false,
});

const thread = (id: string, filePath: string, status: Thread['status'] = 'open'): Thread => ({
  id,
  file: filePath,
  side: 'new',
  anchor: { line: 1, content: 'x', contextHash: 'h' },
  status,
  messages: [],
});

describe('buildFileTree', () => {
  it('nests files under their directories', () => {
    const nodes = buildFileTree([file('src/a.ts'), file('src/deep/b.ts'), file('top.ts')], {});

    expect(nodes.map((n) => n.key)).toEqual(['src', 'top.ts']);
    const src = nodes[0]!;
    expect(src.children?.map((n) => n.key)).toEqual(['src/deep', 'src/a.ts']);
  });

  it('sorts directories before files, each alphabetically', () => {
    const nodes = buildFileTree([file('z.ts'), file('a/b.ts'), file('a.ts')], {});

    expect(nodes.map((n) => n.key)).toEqual(['a', 'a.ts', 'z.ts']);
  });

  it('marks leaves as leaves so the tree renders no expander', () => {
    const nodes = buildFileTree([file('a.ts')], {});

    expect(nodes[0]?.isLeaf).toBe(true);
  });
});

describe('countThreadsByFile', () => {
  it('counts only open threads, since resolved ones need no attention', () => {
    expect(
      countThreadsByFile([
        thread('t1', 'a.ts'),
        thread('t2', 'a.ts'),
        thread('t3', 'a.ts', 'resolved'),
        thread('t4', 'b.ts', 'outdated'),
      ]),
    ).toEqual({ 'a.ts': 2 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run app/src/components/FileTree/tree.test.ts`
Expected: FAIL — cannot resolve `./tree.js`.

- [ ] **Step 3: Implement `app/src/components/FileTree/tree.ts`**

```ts
import type { DataNode } from 'antd/es/tree';
import type { FileEntry, Thread } from '../../../../src/shared/types.js';

interface MutableNode {
  key: string;
  title: string;
  isLeaf: boolean;
  children: Map<string, MutableNode>;
}

function emptyNode(key: string, title: string, isLeaf: boolean): MutableNode {
  return { key, title, isLeaf, children: new Map() };
}

/** Open threads only: resolved and outdated ones do not need the reviewer's attention. */
export function countThreadsByFile(threads: Thread[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const thread of threads) {
    if (thread.status !== 'open') continue;
    counts[thread.file] = (counts[thread.file] ?? 0) + 1;
  }
  return counts;
}

export function buildFileTree(
  files: FileEntry[],
  commentCounts: Record<string, number>,
): DataNode[] {
  const root = emptyNode('', '', false);

  for (const file of files) {
    const segments = file.path.split('/');
    let node = root;
    let prefix = '';

    segments.forEach((segment, index) => {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      const isLeaf = index === segments.length - 1;
      const existing = node.children.get(prefix) ?? emptyNode(prefix, segment, isLeaf);
      node.children.set(prefix, existing);
      node = existing;
    });
  }

  return toDataNodes(root, commentCounts);
}

function toDataNodes(node: MutableNode, counts: Record<string, number>): DataNode[] {
  const children = [...node.children.values()].sort(compare);

  return children.map((child) => {
    const count = counts[child.key] ?? 0;
    return {
      key: child.key,
      title: count > 0 ? `${child.title} (${count})` : child.title,
      isLeaf: child.isLeaf,
      ...(child.isLeaf ? {} : { children: toDataNodes(child, counts) }),
    } satisfies DataNode;
  });
}

/** Directories first, then files, each group alphabetical — the GitHub ordering. */
function compare(a: MutableNode, b: MutableNode): number {
  if (a.isLeaf !== b.isLeaf) return a.isLeaf ? 1 : -1;
  return a.title.localeCompare(b.title);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run app/src/components/FileTree/tree.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Implement the theme helper**

`app/src/theme.ts`:

```ts
import { useEffect, useState } from 'react';
import type { GlobalToken } from 'antd';

const QUERY = '(prefers-color-scheme: dark)';

export function useIsDark(): boolean {
  const [isDark, setIsDark] = useState(() => window.matchMedia?.(QUERY).matches ?? false);

  useEffect(() => {
    const media = window.matchMedia?.(QUERY);
    if (!media) return;

    const listener = (event: MediaQueryListEvent) => setIsDark(event.matches);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, []);

  return isDark;
}

/**
 * Feed the AntD palette to the diff component's CSS variables, so diff greens
 * and reds belong to the same design system as the rest of the shell.
 */
export function applyDiffTokens(token: GlobalToken): void {
  const root = document.documentElement.style;
  root.setProperty('--diff-add-bg', token.colorSuccessBg);
  root.setProperty('--diff-add-border', token.colorSuccessBorder);
  root.setProperty('--diff-del-bg', token.colorErrorBg);
  root.setProperty('--diff-del-border', token.colorErrorBorder);
  root.setProperty('--diff-gutter-bg', token.colorFillQuaternary);
  root.setProperty('--diff-text', token.colorText);
  root.setProperty('--diff-border', token.colorBorderSecondary);
}
```

- [ ] **Step 6: Implement `SummaryPanel`**

`app/src/components/SummaryPanel/SummaryPanel.tsx`:

```tsx
import { Alert, Card, Typography } from 'antd';
import Markdown from 'react-markdown';

interface Props {
  summary: string;
  threadCount: number;
}

export function SummaryPanel({ summary, threadCount }: Props) {
  if (!summary && threadCount === 0) return null;

  return (
    <Card size="small" style={{ marginBottom: 16 }}>
      {summary ? (
        <Typography>
          <Markdown>{summary}</Markdown>
        </Typography>
      ) : null}

      {threadCount > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={`${threadCount} point${threadCount === 1 ? '' : 's'} to confirm`}
          style={{ marginTop: summary ? 12 : 0 }}
        />
      ) : null}
    </Card>
  );
}
```

- [ ] **Step 7: Write the failing test for `FileSection`**

`app/src/components/FileSection/FileSection.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FileSection } from './FileSection.js';
import type { FileEntry } from '../../../../src/shared/types.js';

const file: FileEntry = {
  path: 'src/auth.ts',
  oldPath: 'src/auth.ts',
  status: 'modified',
  additions: 48,
  deletions: 12,
  binary: false,
};

describe('FileSection', () => {
  it('shows the path and the line counts', () => {
    render(<FileSection file={file} viewed={false} onViewedChange={vi.fn()}>body</FileSection>);

    expect(screen.getByText('src/auth.ts')).toBeInTheDocument();
    expect(screen.getByText('+48')).toBeInTheDocument();
    expect(screen.getByText('-12')).toBeInTheDocument();
  });

  it('renders its children when expanded', () => {
    render(<FileSection file={file} viewed={false} onViewedChange={vi.fn()}>diff body</FileSection>);

    expect(screen.getByText('diff body')).toBeInTheDocument();
  });

  it('hides the body once marked viewed', async () => {
    const onViewedChange = vi.fn();
    const { rerender } = render(
      <FileSection file={file} viewed={false} onViewedChange={onViewedChange}>diff body</FileSection>,
    );

    await userEvent.click(screen.getByRole('checkbox', { name: /viewed/i }));
    expect(onViewedChange).toHaveBeenCalledWith(true);

    rerender(
      <FileSection file={file} viewed onViewedChange={onViewedChange}>diff body</FileSection>,
    );
    expect(screen.queryByText('diff body')).not.toBeInTheDocument();
  });

  it('starts collapsed for a very large file', () => {
    const big: FileEntry = { ...file, additions: 900, deletions: 200 };

    render(<FileSection file={big} viewed={false} onViewedChange={vi.fn()}>diff body</FileSection>);

    expect(screen.queryByText('diff body')).not.toBeInTheDocument();
  });

  it('says so instead of rendering a diff for a binary file', () => {
    render(
      <FileSection file={{ ...file, binary: true }} viewed={false} onViewedChange={vi.fn()}>
        diff body
      </FileSection>,
    );

    expect(screen.getByText(/binary file not shown/i)).toBeInTheDocument();
    expect(screen.queryByText('diff body')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 8: Run it to verify it fails**

Run: `npx vitest run app/src/components/FileSection/FileSection.test.tsx`
Expected: FAIL — cannot resolve `./FileSection.js`.

- [ ] **Step 9: Implement `FileSection`**

`app/src/components/FileSection/FileSection.tsx`:

```tsx
import { useState, type ReactNode } from 'react';
import { Card, Checkbox, Empty, Space, Tag, Typography } from 'antd';
import { DownOutlined, RightOutlined } from '@ant-design/icons';
import type { FileEntry } from '../../../../src/shared/types.js';

/** Above this many changed lines a file starts collapsed, per the spec. */
const LARGE_FILE_LINES = 1000;

interface Props {
  file: FileEntry;
  viewed: boolean;
  onViewedChange(value: boolean): void;
  children: ReactNode;
}

export function FileSection({ file, viewed, onViewedChange, children }: Props) {
  const isLarge = file.additions + file.deletions > LARGE_FILE_LINES;
  const [collapsed, setCollapsed] = useState(isLarge);
  const open = !viewed && !collapsed;

  return (
    <Card
      size="small"
      style={{ marginBottom: 16, opacity: viewed ? 0.6 : 1 }}
      title={
        <Space>
          <span
            role="button"
            tabIndex={0}
            aria-label={collapsed ? 'Expand file' : 'Collapse file'}
            onClick={() => setCollapsed((value) => !value)}
            onKeyDown={(event) => event.key === 'Enter' && setCollapsed((value) => !value)}
          >
            {collapsed ? <RightOutlined /> : <DownOutlined />}
          </span>
          <Typography.Text strong>{file.path}</Typography.Text>
          {file.status === 'renamed' && file.oldPath ? (
            <Tag>renamed from {file.oldPath}</Tag>
          ) : null}
        </Space>
      }
      extra={
        <Space>
          <Typography.Text type="success">+{file.additions}</Typography.Text>
          <Typography.Text type="danger">-{file.deletions}</Typography.Text>
          <Checkbox checked={viewed} onChange={(e) => onViewedChange(e.target.checked)}>
            Viewed
          </Checkbox>
        </Space>
      }
    >
      {open
        ? file.binary
          ? <Empty description="Binary file not shown" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          : children
        : null}
    </Card>
  );
}
```

The body renders `null` rather than being hidden with CSS: the test asserts the
children are absent from the document, and an unmounted diff also costs nothing
to keep collapsed.

- [ ] **Step 10: Run it to verify it passes**

Run: `npx vitest run app/src/components/FileSection/FileSection.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 11: Implement `FileTree` and `App`**

`app/src/components/FileTree/FileTree.tsx`:

```tsx
import { Tree } from 'antd';
import { buildFileTree } from './tree.js';
import type { FileEntry } from '../../../../src/shared/types.js';

interface Props {
  files: FileEntry[];
  commentCounts: Record<string, number>;
  onSelect(path: string): void;
}

export function FileTree({ files, commentCounts, onSelect }: Props) {
  return (
    <Tree
      treeData={buildFileTree(files, commentCounts)}
      defaultExpandAll
      selectable
      onSelect={(keys) => {
        const key = String(keys[0] ?? '');
        if (files.some((file) => file.path === key)) onSelect(key);
      }}
    />
  );
}
```

`app/src/App.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Alert, ConfigProvider, Layout, Segmented, Space, Spin, Typography, theme } from 'antd';
import { useIsDark } from './theme.js';
import { FileTree } from './components/FileTree/FileTree.js';
import { countThreadsByFile } from './components/FileTree/tree.js';
import { FileSection } from './components/FileSection/FileSection.js';
import { SummaryPanel } from './components/SummaryPanel/SummaryPanel.js';
import { useDraftStore } from './state/draft.js';
import type { ReviewApi } from './api/client.js';
import type { SessionPayload } from '../../src/shared/types.js';

export type ViewMode = 'split' | 'unified';

interface Props {
  api: ReviewApi;
}

export function App({ api }: Props) {
  const isDark = useIsDark();
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>('split');
  const viewed = useDraftStore((state) => state.viewed);
  const setViewed = useDraftStore((state) => state.setViewed);

  useEffect(() => {
    api.getSession().then(setSession, (e: Error) => setError(e.message));
  }, [api]);

  return (
    <ConfigProvider
      theme={{ algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm }}
    >
      <Layout style={{ minHeight: '100vh' }}>
        <Layout.Header style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <Typography.Text strong style={{ color: '#fff' }}>web-review</Typography.Text>
          {session ? (
            <Space>
              <Typography.Text style={{ color: '#fff' }}>{session.baseLabel}</Typography.Text>
              <Typography.Text style={{ color: '#fff' }}>
                {session.files.length} files
              </Typography.Text>
            </Space>
          ) : null}
          <Segmented
            value={mode}
            onChange={(value) => setMode(value as ViewMode)}
            options={[
              { label: 'Split', value: 'split' },
              { label: 'Unified', value: 'unified' },
            ]}
          />
        </Layout.Header>

        <Layout>
          <Layout.Sider width={280} theme="light" style={{ padding: 12, overflow: 'auto' }}>
            {session ? (
              <FileTree
                files={session.files}
                commentCounts={countThreadsByFile(session.threads)}
                onSelect={(path) =>
                  document.getElementById(`file-${path}`)?.scrollIntoView({ behavior: 'smooth' })
                }
              />
            ) : null}
          </Layout.Sider>

          <Layout.Content style={{ padding: 16 }}>
            {error ? <Alert type="error" message={error} showIcon /> : null}
            {!session && !error ? <Spin /> : null}

            {session ? (
              <>
                <SummaryPanel
                  summary={session.summary}
                  threadCount={session.threads.filter((t) => t.status === 'open').length}
                />
                {session.files.map((file) => (
                  <div id={`file-${file.path}`} key={file.path}>
                    <FileSection
                      file={file}
                      viewed={viewed[file.path] ?? false}
                      onViewedChange={(value) => setViewed(file.path, value)}
                    >
                      {/* Task 12 replaces this with the diff body. */}
                      <Typography.Text type="secondary">diff</Typography.Text>
                    </FileSection>
                  </div>
                ))}
              </>
            ) : null}
          </Layout.Content>
        </Layout>
      </Layout>
    </ConfigProvider>
  );
}
```

`app/src/main.tsx`:

```tsx
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { createApi, readToken } from './api/client.js';

const root = createRoot(document.getElementById('root')!);

try {
  root.render(<App api={createApi(readToken(window.location.search))} />);
} catch (error) {
  root.render(<p>{error instanceof Error ? error.message : 'failed to start'}</p>);
}
```

- [ ] **Step 12: Write and run the App test**

`app/src/App.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import type { ReviewApi } from './api/client.js';
import type { SessionPayload } from '../../src/shared/types.js';

const session: SessionPayload = {
  round: 1,
  base: 'HEAD',
  baseLabel: 'working tree vs HEAD',
  summary: 'Add **JWT** refresh.',
  files: [
    { path: 'src/auth.ts', oldPath: 'src/auth.ts', status: 'modified',
      additions: 48, deletions: 12, binary: false },
  ],
  threads: [
    { id: 't1', file: 'src/auth.ts', side: 'new',
      anchor: { line: 2, content: 'x', contextHash: 'h' },
      status: 'open', messages: [] },
  ],
};

const api: ReviewApi = {
  getSession: vi.fn().mockResolvedValue(session),
  getFile: vi.fn().mockResolvedValue(null),
  submit: vi.fn().mockResolvedValue(undefined),
};

beforeAll(() => {
  // jsdom has no matchMedia; AntD and useIsDark both call it.
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as unknown as typeof window.matchMedia;
});

describe('App', () => {
  it('renders the base label, the summary and the file list', async () => {
    render(<App api={api} />);

    expect(await screen.findByText('working tree vs HEAD')).toBeInTheDocument();
    expect(screen.getByText('JWT')).toBeInTheDocument();
    expect(screen.getByText('src/auth.ts')).toBeInTheDocument();
    expect(screen.getByText('1 point to confirm')).toBeInTheDocument();
  });

  it('shows the open-thread count next to the file in the tree', async () => {
    render(<App api={api} />);

    expect(await screen.findByText('auth.ts (1)')).toBeInTheDocument();
  });

  it('surfaces a session failure instead of spinning forever', async () => {
    const failing: ReviewApi = { ...api, getSession: vi.fn().mockRejectedValue(new Error('invalid token')) };

    render(<App api={failing} />);

    expect(await screen.findByText('invalid token')).toBeInTheDocument();
  });
});
```

Run: `npx vitest run app/src` and `npm run build`
Expected: all app tests pass; the Vite build succeeds.

- [ ] **Step 13: Commit**

```bash
git add app package.json package-lock.json
git commit -m "feat(app): add the shell, file tree, summary panel and file sections"
```

---

### Task 12: The diff body

The single directory that imports `@git-diff-view/react`. Everything else in the
app talks to `DiffPane` through its props, so a breaking change in a `0.x`
dependency stays contained here.

**Files:**
- Create: `app/src/components/DiffPane/useFileContents.ts`, `app/src/components/DiffPane/DiffPane.tsx`, `app/src/components/DiffPane/index.ts`
- Modify: `app/src/App.tsx` (render `DiffPane` instead of the placeholder)
- Test: `app/src/components/DiffPane/useFileContents.test.tsx`

**Interfaces:**
- Consumes: `ReviewApi` from `api/client.ts`; `FileEntry`, `Side` from `src/shared/types.ts`; `ViewMode` from `App.tsx`.
- Produces:
  - `useFileContents(api: ReviewApi, file: FileEntry, enabled: boolean): { old: string | null; next: string | null; loading: boolean; error: string | null }`
  - `<DiffPane api file mode enabled />`
  - `index.ts` re-exports `DiffPane` only — nothing else imports from inside the directory.

- [ ] **Step 1: Verify the library's API before writing against it**

`@git-diff-view/react` is at `0.1.7` and its API is not covered by semver. Read
the shipped types first and write the component against what is actually there:

Run: `cat node_modules/@git-diff-view/react/README.md` and
`sed -n '1,200p' node_modules/@git-diff-view/react/dist/index.d.ts`

Confirm, and note the exact names in a comment at the top of `DiffPane.tsx`:

1. The component that renders a diff (expected: `DiffView`) and its props for
   view mode (expected: `diffViewMode` with a `DiffModeEnum` of `Split` /
   `Unified`), line numbers, and highlighting (expected: `diffViewHighlight`).
2. How a diff is constructed from two file contents (expected:
   `generateDiffFile(oldFileName, oldContent, newFileName, newContent, oldLang, newLang)`
   returning a `DiffFile`, then `diffFile.init()` and
   `diffFile.buildSplitDiffLines()` / `buildUnifiedDiffLines()`).
3. How syntax highlighting is registered (expected: `diffFile.initSyntax()`,
   using the bundled lowlight engine — **do not** add Shiki; per the Global
   Constraints the bundle ships one highlighter).
4. The widget and extend-data props used in Task 13: `onAddWidgetClick`,
   `renderWidgetLine`, `extendData`, `renderExtendLine`.

If a name differs, use the real one and keep the prop names of `DiffPane`
unchanged — the rest of the app must not notice.

- [ ] **Step 2: Write the failing test for lazy content loading**

`app/src/components/DiffPane/useFileContents.test.tsx`:

```tsx
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useFileContents } from './useFileContents.js';
import type { ReviewApi } from '../../api/client.js';
import type { FileEntry } from '../../../../src/shared/types.js';

const file: FileEntry = {
  path: 'src/auth.ts',
  oldPath: 'src/auth.ts',
  status: 'modified',
  additions: 1,
  deletions: 1,
  binary: false,
};

const apiWith = (impl: ReviewApi['getFile']): ReviewApi => ({
  getSession: vi.fn(),
  getFile: impl,
  submit: vi.fn(),
});

describe('useFileContents', () => {
  it('fetches nothing while disabled, so collapsed files cost nothing', () => {
    const getFile = vi.fn();

    renderHook(() => useFileContents(apiWith(getFile), file, false));

    expect(getFile).not.toHaveBeenCalled();
  });

  it('fetches both sides once enabled', async () => {
    const getFile = vi.fn(async (_path: string, side: string) =>
      side === 'old' ? 'one\n' : 'two\n',
    );

    const { result } = renderHook(() => useFileContents(apiWith(getFile), file, true));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.old).toBe('one\n');
    expect(result.current.next).toBe('two\n');
    expect(getFile).toHaveBeenCalledTimes(2);
  });

  it('uses the old path when the file was renamed', async () => {
    const getFile = vi.fn(async () => 'x\n');
    const renamed: FileEntry = { ...file, path: 'src/new.ts', oldPath: 'src/old.ts', status: 'renamed' };

    const { result } = renderHook(() => useFileContents(apiWith(getFile), renamed, true));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getFile).toHaveBeenCalledWith('src/old.ts', 'old');
    expect(getFile).toHaveBeenCalledWith('src/new.ts', 'new');
  });

  it('treats a missing side as empty, which is how added files render', async () => {
    const getFile = vi.fn(async (_path: string, side: string) => (side === 'old' ? null : 'new\n'));
    const added: FileEntry = { ...file, oldPath: null, status: 'added' };

    const { result } = renderHook(() => useFileContents(apiWith(getFile), added, true));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.old).toBe('');
    expect(result.current.next).toBe('new\n');
  });

  it('reports an error instead of hanging', async () => {
    const getFile = vi.fn().mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() => useFileContents(apiWith(getFile), file, true));

    await waitFor(() => expect(result.current.error).toBe('boom'));
    expect(result.current.loading).toBe(false);
  });

  it('does not refetch when re-rendered with the same file', async () => {
    const getFile = vi.fn(async () => 'x\n');

    const { result, rerender } = renderHook(() => useFileContents(apiWith(getFile), file, true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender();

    expect(getFile).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run app/src/components/DiffPane/useFileContents.test.tsx`
Expected: FAIL — cannot resolve `./useFileContents.js`.

- [ ] **Step 4: Implement `useFileContents`**

```ts
import { useEffect, useState } from 'react';
import type { ReviewApi } from '../../api/client.js';
import type { FileEntry } from '../../../../src/shared/types.js';

export interface FileContents {
  old: string | null;
  next: string | null;
  loading: boolean;
  error: string | null;
}

const IDLE: FileContents = { old: null, next: null, loading: false, error: null };

/**
 * Fetches both sides of one file, and only once the section is open. A 500-file
 * review therefore loads instantly and pays for content only where you look.
 */
export function useFileContents(
  api: ReviewApi,
  file: FileEntry,
  enabled: boolean,
): FileContents {
  const [state, setState] = useState<FileContents>(IDLE);
  const oldPath = file.oldPath ?? file.path;

  useEffect(() => {
    if (!enabled) {
      setState(IDLE);
      return;
    }

    let cancelled = false;
    setState({ ...IDLE, loading: true });

    Promise.all([api.getFile(oldPath, 'old'), api.getFile(file.path, 'new')])
      .then(([older, newer]) => {
        if (cancelled) return;
        setState({ old: older ?? '', next: newer ?? '', loading: false, error: null });
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setState({ ...IDLE, error: error.message });
      });

    return () => {
      cancelled = true;
    };
  }, [api, enabled, file.path, oldPath]);

  return state;
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run app/src/components/DiffPane/useFileContents.test.tsx`
Expected: PASS, 6 tests.

- [ ] **Step 6: Implement `DiffPane`**

Adjust the imported names to whatever Step 1 confirmed.

```tsx
// Uses @git-diff-view/react 0.1.7. The names below were verified against
// node_modules/@git-diff-view/react/dist/index.d.ts — see Task 12, Step 1.
import { useMemo } from 'react';
import { Alert, Skeleton } from 'antd';
import { DiffModeEnum, DiffView, generateDiffFile } from '@git-diff-view/react';
import '@git-diff-view/react/styles/diff-view.css';
import { useFileContents } from './useFileContents.js';
import type { ReviewApi } from '../../api/client.js';
import type { FileEntry } from '../../../../src/shared/types.js';

export type ViewMode = 'split' | 'unified';

interface Props {
  api: ReviewApi;
  file: FileEntry;
  mode: ViewMode;
  enabled: boolean;
}

/** Language hint for the highlighter, derived from the extension. */
function languageOf(path: string): string {
  return path.split('.').pop()?.toLowerCase() ?? 'text';
}

export function DiffPane({ api, file, mode, enabled }: Props) {
  const { old: older, next: newer, loading, error } = useFileContents(api, file, enabled);

  const diffFile = useMemo(() => {
    if (older === null || newer === null) return null;

    const language = languageOf(file.path);
    const instance = generateDiffFile(
      file.oldPath ?? file.path,
      older,
      file.path,
      newer,
      language,
      language,
    );
    instance.initSyntax();
    instance.init();
    instance.buildSplitDiffLines();
    instance.buildUnifiedDiffLines();
    return instance;
  }, [file.oldPath, file.path, older, newer]);

  if (error) return <Alert type="error" message={error} showIcon />;
  if (loading || !diffFile) return <Skeleton active paragraph={{ rows: 4 }} />;

  return (
    <DiffView
      diffFile={diffFile}
      diffViewHighlight
      diffViewWrap={false}
      diffViewMode={mode === 'split' ? DiffModeEnum.Split : DiffModeEnum.Unified}
    />
  );
}
```

`app/src/components/DiffPane/index.ts`:

```ts
export { DiffPane, type ViewMode } from './DiffPane.js';
```

- [ ] **Step 7: Wire it into `App.tsx`**

Replace the placeholder inside `FileSection`:

```tsx
                    <FileSection
                      file={file}
                      viewed={viewed[file.path] ?? false}
                      onViewedChange={(value) => setViewed(file.path, value)}
                    >
                      <DiffPane
                        api={api}
                        file={file}
                        mode={mode}
                        enabled={!(viewed[file.path] ?? false)}
                      />
                    </FileSection>
```

Import `DiffPane` from `./components/DiffPane/index.js`, and move the `ViewMode`
type import there too so `App.tsx` no longer declares it.

- [ ] **Step 8: Verify against a real repository**

Run: `npm run build`, then from any dirty git repository run
`node <path>/dist/web-review.mjs --timeout 600`.

Confirm by eye: line numbers in both gutters, syntax colouring, the Split/Unified
toggle switching layout, a large file collapsed by default, a binary file showing
its placeholder, and the diff colours matching the AntD palette in both light and
dark system themes.

- [ ] **Step 9: Commit**

```bash
git add app/src/components/DiffPane app/src/App.tsx
git commit -m "feat(app): render the diff body with lazy per-file loading"
```

---

### Task 13: Comment threads and the composer

Where the review becomes a conversation: existing threads render under their
line, a click on the gutter opens a composer, and threads that could not be
relocated collect in an "Outdated" section instead of vanishing.

**Files:**
- Create: `app/src/components/CommentThread/CommentThread.tsx`, `app/src/components/CommentComposer/CommentComposer.tsx`, `app/src/components/CommentThread/OutdatedThreads.tsx`
- Modify: `app/src/components/DiffPane/DiffPane.tsx`, `app/src/App.tsx`
- Test: `app/src/components/CommentThread/CommentThread.test.tsx`, `app/src/components/CommentComposer/CommentComposer.test.tsx`

**Interfaces:**
- Consumes: `Thread`, `Side` from `src/shared/types.ts`; `useDraftStore` from `state/draft.ts`.
- Produces:
  - `<CommentComposer initialValue placeholder onSubmit onCancel submitLabel />`
  - `<CommentThread thread={Thread} />` — reads and writes the draft store itself, so no prop drilling.
  - `<OutdatedThreads threads={Thread[]} />`
  - `DiffPane` gains props `threads: Thread[]` (already relocated by the server for this file).

- [ ] **Step 1: Write the failing tests for the composer**

`app/src/components/CommentComposer/CommentComposer.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CommentComposer } from './CommentComposer.js';

describe('CommentComposer', () => {
  it('submits the typed text', async () => {
    const onSubmit = vi.fn();
    render(<CommentComposer onSubmit={onSubmit} onCancel={vi.fn()} />);

    await userEvent.type(screen.getByRole('textbox'), 'extract a hook');
    await userEvent.click(screen.getByRole('button', { name: /add comment/i }));

    expect(onSubmit).toHaveBeenCalledWith('extract a hook');
  });

  it('will not submit an empty comment', async () => {
    const onSubmit = vi.fn();
    render(<CommentComposer onSubmit={onSubmit} onCancel={vi.fn()} />);

    expect(screen.getByRole('button', { name: /add comment/i })).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox'), '   ');
    expect(screen.getByRole('button', { name: /add comment/i })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('starts from an existing draft so editing keeps the text', () => {
    render(<CommentComposer initialValue="earlier draft" onSubmit={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByRole('textbox')).toHaveValue('earlier draft');
  });

  it('cancels', async () => {
    const onCancel = vi.fn();
    render(<CommentComposer onSubmit={vi.fn()} onCancel={onCancel} />);

    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(onCancel).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails, then implement the composer**

Run: `npx vitest run app/src/components/CommentComposer/CommentComposer.test.tsx`
Expected: FAIL — cannot resolve `./CommentComposer.js`.

`app/src/components/CommentComposer/CommentComposer.tsx`:

```tsx
import { useState } from 'react';
import { Button, Input, Space } from 'antd';

interface Props {
  initialValue?: string;
  placeholder?: string;
  submitLabel?: string;
  onSubmit(body: string): void;
  onCancel(): void;
}

export function CommentComposer({
  initialValue = '',
  placeholder = 'Leave a comment',
  submitLabel = 'Add comment',
  onSubmit,
  onCancel,
}: Props) {
  const [value, setValue] = useState(initialValue);
  const empty = value.trim().length === 0;

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={8}>
      <Input.TextArea
        autoFocus
        rows={3}
        value={value}
        placeholder={placeholder}
        onChange={(event) => setValue(event.target.value)}
      />
      <Space>
        <Button type="primary" size="small" disabled={empty} onClick={() => onSubmit(value)}>
          {submitLabel}
        </Button>
        <Button size="small" onClick={onCancel}>
          Cancel
        </Button>
      </Space>
    </Space>
  );
}
```

Run the test again. Expected: PASS, 4 tests.

- [ ] **Step 3: Write the failing tests for the thread**

`app/src/components/CommentThread/CommentThread.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { CommentThread } from './CommentThread.js';
import { useDraftStore } from '../../state/draft.js';
import type { Thread } from '../../../../src/shared/types.js';

const thread: Thread = {
  id: 't1',
  file: 'src/auth.ts',
  side: 'new',
  anchor: { line: 42, content: 'const t = sign(u);', contextHash: 'h' },
  status: 'open',
  messages: [
    { author: 'user', round: 1, body: 'Extract into a hook.', at: '2026-09-04T10:00:00.000Z' },
    { author: 'agent', round: 2, body: 'Done: useAuthToken().', at: '2026-09-04T10:05:00.000Z' },
  ],
};

beforeEach(() => {
  useDraftStore.getState().reset();
});

describe('CommentThread', () => {
  it('shows every message with its author and round', () => {
    render(<CommentThread thread={thread} />);

    expect(screen.getByText('Extract into a hook.')).toBeInTheDocument();
    expect(screen.getByText('Done: useAuthToken().')).toBeInTheDocument();
    expect(screen.getByText(/you · round 1/i)).toBeInTheDocument();
    expect(screen.getByText(/agent · round 2/i)).toBeInTheDocument();
  });

  it('stages a reply in the draft store', async () => {
    render(<CommentThread thread={thread} />);

    await userEvent.click(screen.getByRole('button', { name: /reply/i }));
    await userEvent.type(screen.getByRole('textbox'), 'no, keep it');
    await userEvent.click(screen.getByRole('button', { name: /add reply/i }));

    expect(useDraftStore.getState().replies['t1']).toBe('no, keep it');
  });

  it('stages a resolve without mutating the thread', async () => {
    render(<CommentThread thread={thread} />);

    await userEvent.click(screen.getByRole('button', { name: /^resolve$/i }));

    expect(useDraftStore.getState().resolved['t1']).toBe(true);
    expect(screen.getByText(/will be resolved/i)).toBeInTheDocument();
  });

  it('offers reopen on an already-resolved thread', async () => {
    render(<CommentThread thread={{ ...thread, status: 'resolved' }} />);

    await userEvent.click(screen.getByRole('button', { name: /reopen/i }));

    expect(useDraftStore.getState().resolved['t1']).toBe(false);
  });

  it('marks an outdated thread and still shows its messages', () => {
    render(<CommentThread thread={{ ...thread, status: 'outdated' }} />);

    expect(screen.getByText(/outdated/i)).toBeInTheDocument();
    expect(screen.getByText('Extract into a hook.')).toBeInTheDocument();
  });
});
```

- [ ] **Step 4: Run it to verify it fails, then implement the thread**

Run: `npx vitest run app/src/components/CommentThread/CommentThread.test.tsx`
Expected: FAIL — cannot resolve `./CommentThread.js`.

`app/src/components/CommentThread/CommentThread.tsx`:

```tsx
import { useState } from 'react';
import { Avatar, Button, Card, List, Space, Tag, Typography } from 'antd';
import { RobotOutlined, UserOutlined } from '@ant-design/icons';
import { CommentComposer } from '../CommentComposer/CommentComposer.js';
import { useDraftStore } from '../../state/draft.js';
import type { Thread } from '../../../../src/shared/types.js';

interface Props {
  thread: Thread;
}

export function CommentThread({ thread }: Props) {
  const [replying, setReplying] = useState(false);
  const stagedReply = useDraftStore((state) => state.replies[thread.id]);
  const stagedResolve = useDraftStore((state) => state.resolved[thread.id]);
  const setReply = useDraftStore((state) => state.setReply);
  const setResolved = useDraftStore((state) => state.setResolved);

  const resolved = stagedResolve ?? thread.status === 'resolved';

  return (
    <Card size="small" style={{ margin: '8px 0' }}>
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Space>
          {thread.status === 'outdated' ? <Tag color="orange">Outdated</Tag> : null}
          {thread.status === 'resolved' ? <Tag color="green">Resolved</Tag> : null}
          {stagedResolve === true ? <Tag color="blue">Will be resolved</Tag> : null}
          {stagedResolve === false ? <Tag color="blue">Will be reopened</Tag> : null}
        </Space>

        <List
          size="small"
          dataSource={thread.messages}
          renderItem={(message) => (
            <List.Item>
              <List.Item.Meta
                avatar={
                  <Avatar
                    size="small"
                    icon={message.author === 'agent' ? <RobotOutlined /> : <UserOutlined />}
                  />
                }
                title={
                  <Typography.Text type="secondary">
                    {message.author === 'agent' ? 'agent' : 'you'} · round {message.round}
                  </Typography.Text>
                }
                description={<Typography.Paragraph>{message.body}</Typography.Paragraph>}
              />
            </List.Item>
          )}
        />

        {stagedReply ? (
          <Card size="small" type="inner" title="Your reply (not sent yet)">
            <Typography.Paragraph>{stagedReply}</Typography.Paragraph>
          </Card>
        ) : null}

        {replying ? (
          <CommentComposer
            initialValue={stagedReply ?? ''}
            submitLabel="Add reply"
            placeholder="Reply to this thread"
            onSubmit={(body) => {
              setReply(thread.id, body);
              setReplying(false);
            }}
            onCancel={() => setReplying(false)}
          />
        ) : (
          <Space>
            <Button size="small" onClick={() => setReplying(true)}>
              Reply
            </Button>
            <Button size="small" onClick={() => setResolved(thread.id, !resolved)}>
              {resolved ? 'Reopen' : 'Resolve'}
            </Button>
          </Space>
        )}
      </Space>
    </Card>
  );
}
```

Run the test again. Expected: PASS, 5 tests.

- [ ] **Step 5: Implement `OutdatedThreads`**

A thread whose line could not be found has nowhere to render inside the diff, so
it collects at the bottom of its file rather than being dropped.

`app/src/components/CommentThread/OutdatedThreads.tsx`:

```tsx
import { Collapse } from 'antd';
import { CommentThread } from './CommentThread.js';
import type { Thread } from '../../../../src/shared/types.js';

interface Props {
  threads: Thread[];
}

export function OutdatedThreads({ threads }: Props) {
  if (threads.length === 0) return null;

  return (
    <Collapse
      size="small"
      style={{ marginTop: 12 }}
      items={[
        {
          key: 'outdated',
          label: `${threads.length} outdated comment${threads.length === 1 ? '' : 's'}`,
          children: threads.map((thread) => (
            <CommentThread key={thread.id} thread={thread} />
          )),
        },
      ]}
    />
  );
}
```

- [ ] **Step 6: Wire threads and the composer into `DiffPane`**

Add a `threads: Thread[]` prop. Split them: `outdated` renders below the diff,
the rest render under their line through the library's extend-data mechanism,
and the gutter button opens a composer through the widget mechanism. Use the
exact prop names confirmed in Task 12, Step 1.

```tsx
  const [widget, setWidget] = useState<{ side: Side; line: number } | null>(null);
  const setComment = useDraftStore((state) => state.setComment);
  const drafts = useDraftStore((state) => state.comments);

  const positioned = threads.filter((thread) => thread.status !== 'outdated');
  const outdated = threads.filter((thread) => thread.status === 'outdated');

  // One entry per line that has either a thread or a draft, in the shape the
  // library expects: { oldFile: { lines: { <line>: { data } } }, newFile: {...} }.
  const extendData = useMemo(
    () => buildExtendData(positioned, drafts, file.path),
    [positioned, drafts, file.path],
  );
```

and on the `DiffView`:

```tsx
      extendData={extendData}
      renderExtendLine={({ data }) => (
        <div style={{ padding: '0 16px' }}>
          {data.threads.map((thread: Thread) => (
            <CommentThread key={thread.id} thread={thread} />
          ))}
          {data.draft ? (
            <CommentComposer
              initialValue={data.draft.body}
              submitLabel="Update comment"
              onSubmit={(body) => setComment(file.path, data.draft.side, data.draft.line, body)}
              onCancel={() => removeComment(draftKey(file.path, data.draft.side, data.draft.line))}
            />
          ) : null}
        </div>
      )}
      onAddWidgetClick={({ side, lineNumber }) =>
        setWidget({ side: side === 'old' ? 'old' : 'new', line: lineNumber })
      }
      renderWidgetLine={({ side, lineNumber, onClose }) => (
        <div style={{ padding: '0 16px' }}>
          <CommentComposer
            onSubmit={(body) => {
              setComment(file.path, side === 'old' ? 'old' : 'new', lineNumber, body);
              onClose();
            }}
            onCancel={onClose}
          />
        </div>
      )}
```

`DiffPane` needs these extra imports for the snippet above: `useState`,
`useDraftStore`, `draftKey`, `CommentThread`, `CommentComposer`, `OutdatedThreads`,
`buildExtendData`, and the `Side` and `Thread` types. Render `<OutdatedThreads
threads={outdated} />` directly after `<DiffView>`.

`buildExtendData` is the one piece of this wiring worth testing without the
library in the loop, so it lives on its own as a pure function.

`app/src/components/DiffPane/extendData.ts`:

```ts
import type { Draft } from '../../state/draft.js';
import type { Side, Thread } from '../../../../src/shared/types.js';

export interface LineData {
  threads: Thread[];
  draft: Draft | null;
}

export interface ExtendData {
  oldFile: { lines: Record<number, { data: LineData }> };
  newFile: { lines: Record<number, { data: LineData }> };
}

/**
 * Group everything that should render under a line — existing threads and any
 * unsent draft — into the per-side, per-line shape the diff component expects.
 */
export function buildExtendData(
  threads: Thread[],
  drafts: Record<string, Draft>,
  filePath: string,
): ExtendData {
  const data: ExtendData = { oldFile: { lines: {} }, newFile: { lines: {} } };

  const at = (side: Side, line: number): LineData => {
    const lines = side === 'old' ? data.oldFile.lines : data.newFile.lines;
    const existing = lines[line];
    if (existing) return existing.data;

    const fresh: LineData = { threads: [], draft: null };
    lines[line] = { data: fresh };
    return fresh;
  };

  for (const thread of threads) {
    if (thread.file !== filePath) continue;
    at(thread.side, thread.anchor.line).threads.push(thread);
  }

  for (const draft of Object.values(drafts)) {
    if (draft.file !== filePath) continue;
    at(draft.side, draft.line).draft = draft;
  }

  return data;
}
```

`app/src/components/DiffPane/extendData.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildExtendData } from './extendData.js';
import type { Draft } from '../../state/draft.js';
import type { Thread } from '../../../../src/shared/types.js';

const thread = (id: string, file: string, side: Thread['side'], line: number): Thread => ({
  id,
  file,
  side,
  anchor: { line, content: 'x', contextHash: 'h' },
  status: 'open',
  messages: [],
});

const draft = (file: string, side: Draft['side'], line: number): Draft => ({
  file,
  side,
  line,
  body: 'note',
});

describe('buildExtendData', () => {
  it('puts each thread on its own side and line', () => {
    const data = buildExtendData(
      [thread('t1', 'a.ts', 'new', 42), thread('t2', 'a.ts', 'old', 7)],
      {},
      'a.ts',
    );

    expect(data.newFile.lines[42]?.data.threads.map((t) => t.id)).toEqual(['t1']);
    expect(data.oldFile.lines[7]?.data.threads.map((t) => t.id)).toEqual(['t2']);
  });

  it('groups two threads on the same line into one entry', () => {
    const data = buildExtendData(
      [thread('t1', 'a.ts', 'new', 42), thread('t2', 'a.ts', 'new', 42)],
      {},
      'a.ts',
    );

    expect(data.newFile.lines[42]?.data.threads.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('creates an entry for a draft on a line with no thread', () => {
    const data = buildExtendData([], { k: draft('a.ts', 'new', 9) }, 'a.ts');

    expect(data.newFile.lines[9]?.data).toEqual({ threads: [], draft: draft('a.ts', 'new', 9) });
  });

  it('attaches a draft to the same entry as an existing thread', () => {
    const data = buildExtendData(
      [thread('t1', 'a.ts', 'new', 42)],
      { k: draft('a.ts', 'new', 42) },
      'a.ts',
    );

    expect(data.newFile.lines[42]?.data.threads).toHaveLength(1);
    expect(data.newFile.lines[42]?.data.draft).not.toBeNull();
  });

  it('ignores threads and drafts belonging to other files', () => {
    const data = buildExtendData(
      [thread('t1', 'other.ts', 'new', 42)],
      { k: draft('other.ts', 'new', 9) },
      'a.ts',
    );

    expect(data.newFile.lines).toEqual({});
    expect(data.oldFile.lines).toEqual({});
  });
});
```

Run: `npx vitest run app/src/components/DiffPane/extendData.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 7: Pass threads down from `App.tsx`**

```tsx
                      <DiffPane
                        api={api}
                        file={file}
                        mode={mode}
                        enabled={!(viewed[file.path] ?? false)}
                        threads={session.threads.filter((t) => t.file === file.path)}
                      />
```

- [ ] **Step 8: Run the app suite and check by hand**

Run: `npx vitest run app/src`
Expected: all app tests pass.

Then `npm run build` and open a real review: confirm the gutter "+" opens a
composer, a submitted draft shows under the line, an existing thread renders with
both avatars, and outdated threads appear in the collapsed section.

- [ ] **Step 9: Commit**

```bash
git add app/src/components
git commit -m "feat(app): add comment threads, the composer, and outdated threads"
```

---

### Task 14: Submitting the review

The last piece of the loop: drafts accumulate, one button sends everything with
a verdict, and the page ends in a terminal state because the server shuts down
behind it.

**Files:**
- Create: `app/src/components/SubmitDrawer/SubmitDrawer.tsx`
- Modify: `app/src/App.tsx`
- Test: `app/src/components/SubmitDrawer/SubmitDrawer.test.tsx`

**Interfaces:**
- Consumes: `ReviewApi` from `api/client.ts`; `useDraftStore`, `buildSubmit`, `pendingCount` from `state/draft.ts`.
- Produces: `<SubmitDrawer api open onClose onSubmitted />`.

- [ ] **Step 1: Write the failing tests**

`app/src/components/SubmitDrawer/SubmitDrawer.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SubmitDrawer } from './SubmitDrawer.js';
import { useDraftStore } from '../../state/draft.js';
import type { ReviewApi } from '../../api/client.js';

const apiWith = (submit: ReviewApi['submit']): ReviewApi => ({
  getSession: vi.fn(),
  getFile: vi.fn(),
  submit,
});

beforeEach(() => {
  useDraftStore.getState().reset();
});

describe('SubmitDrawer', () => {
  it('sends the drafted comments with the chosen verdict', async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    useDraftStore.getState().setComment('src/a.ts', 'new', 12, 'rename this');

    render(<SubmitDrawer api={apiWith(submit)} open onClose={vi.fn()} onSubmitted={vi.fn()} />);

    await userEvent.click(screen.getByRole('radio', { name: /request changes/i }));
    await userEvent.type(screen.getByPlaceholderText(/overall comment/i), 'Two things.');
    await userEvent.click(screen.getByRole('button', { name: /submit review/i }));

    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith({
        verdict: 'request_changes',
        general: 'Two things.',
        newComments: [{ file: 'src/a.ts', side: 'new', line: 12, body: 'rename this' }],
        replies: [],
        resolved: [],
        reopened: [],
      }),
    );
  });

  it('defaults to comment and can approve with nothing drafted', async () => {
    const submit = vi.fn().mockResolvedValue(undefined);

    render(<SubmitDrawer api={apiWith(submit)} open onClose={vi.fn()} onSubmitted={vi.fn()} />);

    await userEvent.click(screen.getByRole('radio', { name: /approve/i }));
    await userEvent.click(screen.getByRole('button', { name: /submit review/i }));

    await waitFor(() => expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: 'approve', newComments: [] }),
    ));
  });

  it('summarises what is about to be sent', () => {
    useDraftStore.getState().setComment('src/a.ts', 'new', 12, 'x');
    useDraftStore.getState().setReply('t1', 'y');

    render(<SubmitDrawer api={apiWith(vi.fn())} open onClose={vi.fn()} onSubmitted={vi.fn()} />);

    expect(screen.getByText(/1 comment, 1 reply/i)).toBeInTheDocument();
  });

  it('reports a failed submission and keeps the drafts', async () => {
    const submit = vi.fn().mockRejectedValue(new Error('invalid token'));
    useDraftStore.getState().setComment('src/a.ts', 'new', 12, 'x');

    render(<SubmitDrawer api={apiWith(submit)} open onClose={vi.fn()} onSubmitted={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /submit review/i }));

    expect(await screen.findByText('invalid token')).toBeInTheDocument();
    expect(useDraftStore.getState().comments).not.toEqual({});
  });

  it('tells the parent once the review is through', async () => {
    const onSubmitted = vi.fn();

    render(
      <SubmitDrawer
        api={apiWith(vi.fn().mockResolvedValue(undefined))}
        open
        onClose={vi.fn()}
        onSubmitted={onSubmitted}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /submit review/i }));

    await waitFor(() => expect(onSubmitted).toHaveBeenCalled());
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run app/src/components/SubmitDrawer/SubmitDrawer.test.tsx`
Expected: FAIL — cannot resolve `./SubmitDrawer.js`.

- [ ] **Step 3: Implement `SubmitDrawer`**

```tsx
import { useState } from 'react';
import { Alert, Button, Drawer, Input, Radio, Space, Typography } from 'antd';
import { buildSubmit, useDraftStore } from '../../state/draft.js';
import type { ReviewApi } from '../../api/client.js';
import type { Verdict } from '../../../../src/shared/types.js';

interface Props {
  api: ReviewApi;
  open: boolean;
  onClose(): void;
  onSubmitted(): void;
}

function describeDrafts(comments: number, replies: number, toggles: number): string {
  const parts = [
    comments > 0 ? `${comments} comment${comments === 1 ? '' : 's'}` : null,
    replies > 0 ? `${replies} repl${replies === 1 ? 'y' : 'ies'}` : null,
    toggles > 0 ? `${toggles} thread update${toggles === 1 ? '' : 's'}` : null,
  ].filter(Boolean);

  return parts.length === 0 ? 'No pending comments' : parts.join(', ');
}

export function SubmitDrawer({ api, open, onClose, onSubmitted }: Props) {
  const [verdict, setVerdict] = useState<Verdict>('comment');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const general = useDraftStore((state) => state.general);
  const setGeneral = useDraftStore((state) => state.setGeneral);
  const comments = useDraftStore((state) => state.comments);
  const replies = useDraftStore((state) => state.replies);
  const resolved = useDraftStore((state) => state.resolved);

  const send = async () => {
    setSending(true);
    setError(null);
    try {
      await api.submit(buildSubmit(useDraftStore.getState(), verdict));
      onSubmitted();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'submission failed');
    } finally {
      setSending(false);
    }
  };

  return (
    <Drawer title="Submit review" open={open} onClose={onClose} width={420}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Typography.Text type="secondary">
          {describeDrafts(
            Object.keys(comments).length,
            Object.keys(replies).length,
            Object.keys(resolved).length,
          )}
        </Typography.Text>

        <Input.TextArea
          rows={4}
          value={general}
          placeholder="Overall comment (optional)"
          onChange={(event) => setGeneral(event.target.value)}
        />

        <Radio.Group value={verdict} onChange={(event) => setVerdict(event.target.value)}>
          <Space direction="vertical">
            <Radio value="approve">Approve</Radio>
            <Radio value="request_changes">Request changes</Radio>
            <Radio value="comment">Comment</Radio>
          </Space>
        </Radio.Group>

        {error ? <Alert type="error" message={error} showIcon /> : null}

        <Button type="primary" loading={sending} onClick={() => void send()}>
          Submit review
        </Button>
      </Space>
    </Drawer>
  );
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run app/src/components/SubmitDrawer/SubmitDrawer.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 5: Wire the drawer and the header button into `App.tsx`**

Add to the header, after the Segmented control:

```tsx
          <Badge count={pending}>
            <Button type="primary" onClick={() => setDrawerOpen(true)}>
              Review
            </Button>
          </Badge>
```

with, in the component body:

```tsx
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [done, setDone] = useState(false);
  const pending = useDraftStore(pendingCount);
```

and, wrapping the content, the terminal state — the server exits after a
submission, so the page cannot usefully do anything else:

```tsx
  if (done) {
    return (
      <ConfigProvider theme={{ algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm }}>
        <Result
          status="success"
          title="Review submitted"
          subTitle="The agent has your feedback. You can close this tab."
        />
      </ConfigProvider>
    );
  }
```

and, at the end of the layout:

```tsx
        <SubmitDrawer
          api={api}
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          onSubmitted={() => {
            setDrawerOpen(false);
            setDone(true);
          }}
        />
```

- [ ] **Step 6: Add the App-level test for the badge and the terminal state**

Append to `app/src/App.test.tsx`, adding these imports at the top of that file:

```tsx
import userEvent from '@testing-library/user-event';
import { useDraftStore } from './state/draft.js';
```


```tsx
  it('counts pending drafts on the Review button and ends on a success screen', async () => {
    useDraftStore.getState().reset();
    useDraftStore.getState().setComment('src/auth.ts', 'new', 2, 'rename this');

    render(<App api={api} />);

    expect(await screen.findByTitle('1')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^review$/i }));
    await userEvent.click(screen.getByRole('button', { name: /submit review/i }));

    expect(await screen.findByText('Review submitted')).toBeInTheDocument();
  });
```

Run: `npx vitest run app/src`
Expected: all app tests pass.

- [ ] **Step 7: Verify the whole loop by hand**

Run `npm run build`, then in a dirty repository:

```bash
node <path>/dist/web-review.mjs --timeout 600
```

Leave a comment, submit with "Request changes", and confirm the terminal prints
a framed `submitted` result carrying the thread. Then re-run the command and
confirm the thread comes back in round 2.

- [ ] **Step 8: Commit**

```bash
git add app/src dist app/dist
git commit -m "feat(app): submit the review with a verdict and end the session"
```

---

### Task 15: Documentation and release readiness

Four documents, two audiences: agents that **use** the tool, and people who
**contribute** to it. All in English.

**Files:**
- Create: `README.md`, `SKILL.md`, `AGENTS.md`, `CLAUDE.md`
- Modify: `.github/workflows/ci.yml` if any script name changed

- [ ] **Step 1: Write `SKILL.md`**

This is the operational contract. Keep it short enough that an agent reads all
of it, and make the three rules that matter impossible to miss.

```markdown
---
name: web-review
description: Open a local GitHub-style review of the current changes in the browser, wait for the human's line-anchored comments, and act on them. Use after finishing a batch of edits, when the user asks to review changes, or before committing.
---

# web-review

Run a human code review of your own changes and act on the result.

## Steps

1. Write `.git/web-review/request.json` describing what you did:

   ```json
   {
     "summary": "Markdown. What changed and why.",
     "annotations": [
       { "file": "src/auth.ts", "line": 88, "side": "new",
         "body": "Hard-coded delay; I found no existing config. OK?" }
     ]
   }
   ```

   Annotations are for genuine uncertainty — hesitations, assumed debt, things
   worth a second pair of eyes. Do not annotate lines you are confident about.

2. Run the command from the repository root:

   ```bash
   node <skill path>/dist/web-review.mjs
   ```

3. Read the JSON printed between `<<<WEB_REVIEW_RESULT` and `WEB_REVIEW_RESULT>>>`.

## What each status means

- `pending` — the reviewer is still reading. **Run the command again.** Do not
  treat this as a result and do not start editing.
- `submitted` — act on `verdict` and `threads`.
- `approve` — **stop.** Do not commit, push, or open a pull request unless the
  user asks separately.
- `no_changes` — there was nothing to review.
- `aborted` — the review was cancelled. This is **not** approval.
- `error` — read `message`.

## Acting on `request_changes`

Evaluate each comment on its merits. Apply what is right. Where you disagree,
say so instead of complying silently: put your reasoning in a reply and let the
human decide.

```json
{
  "replies": [
    { "threadId": "t3",
      "body": "Kept the inline version: extracting it would need the request context, which the hook cannot reach." }
  ]
}
```

Write that to `.git/web-review/request.json` together with a `summary` of what
you changed, then run the command again to open the next round. Threads carry
across rounds, so the human sees your reply next to their original comment.

Threads with `"status": "outdated"` were anchored to lines that no longer exist.
Read them for intent; do not try to apply them literally.
```

- [ ] **Step 2: Write `AGENTS.md`**

Same content as `SKILL.md`, minus the YAML frontmatter, with a first line saying
what it is:

```markdown
# web-review — instructions for coding agents

This file is the harness-agnostic version of `SKILL.md`. Copy it into your
agent's instruction file (`AGENTS.md`, `.cursorrules`, a system prompt) or point
your agent at it.
```

Keep the two files in sync; a divergence between them is a bug.

- [ ] **Step 3: Write `README.md`**

For a human landing on the repository. Cover, in this order:

1. **What it is** — one paragraph and a screenshot: after your agent edits code,
   review the diff in a real GitHub-style UI and hand structured feedback back.
2. **Why not just read `git diff`** — line-anchored comments, threads that
   survive across rounds, and no copy-pasting file paths into a chat box.
3. **Install** — `git clone <repo> ~/.claude/skills/web-review`. State plainly
   that there is no `npm install`: the bundles are committed, and the server is
   a single dependency-free `.mjs` file.
4. **Use** — the agent-driven flow, plus standalone use (`node dist/web-review.mjs`
   in any repository, no agent involved).
5. **Flags** — the table from the spec: `[ref]`/`--base`, `--timeout`,
   `--port`, `--no-open`, `--stop`.
6. **The JSON contract** — `request.json` in, framed result out, with the status
   table. Note the re-entrant `pending` behaviour and why it exists (harness
   timeouts).
7. **What lives in `.git/web-review/`** — the five files and their roles.
8. **Security** — loopback-only, random port, URL token, `Host` validation.
   Say what this protects against.
9. **Development** — `npm install`, `npm test`, `npm run build`, and the rule
   that `dist/` and `app/dist/` are committed and CI fails if they are stale.
10. **Prior art** — link difit, diffx, diffity and revu, and say in one sentence
    what this does differently: the agent writes the summary and its own
    annotations, threads persist across rounds, and there is no npm install.
11. **License** — MIT.

- [ ] **Step 4: Write `CLAUDE.md`**

For an agent working **on** this repository, not with it. Short and factual:

```markdown
# Contributing to web-review

## Commands

- `npm test` — Vitest, two projects: `server` (node) and `app` (jsdom).
- `npm run typecheck` — both tsconfigs.
- `npm run build` — Vite builds `app/dist`, esbuild bundles `dist/web-review.mjs`.

## Architecture

The server is deliberately thin: it shells out to `git`, serves `app/dist`, and
exposes four JSON endpoints. Diff rendering, highlighting and layout all live in
the browser bundle.

- `src/shared/` — the JSON contract, imported by both halves.
- `src/server/git/` — the only code that runs `git`.
- `src/server/review/` — round state, thread anchoring, result payloads. Pure.
- `src/server/http/` — routes, server lifecycle, loopback security.
- `app/src/components/DiffPane/` — the only importer of `@git-diff-view/react`.

## Rules

- `dist/` and `app/dist/` are committed. Run `npm run build` before committing
  any source change, or CI will fail on `git diff --exit-code`.
- `@git-diff-view/react` is pinned to an exact version and must stay confined to
  `DiffPane/`. It is `0.x`; a minor bump can break the API.
- Review state belongs in `.git/web-review/`, never in the working tree — a file
  at the repo root would show up inside the diff being reviewed.
- Anything hard should be a pure function. Side effects live in `git/exec.ts`,
  `review/state.ts`, and `http/server.ts`.
- All prose is in English.
```

- [ ] **Step 5: Verify the documented flow against the real tool**

Follow `SKILL.md` literally in a scratch repository: write a `request.json` with
a summary and one annotation, run the command, comment, submit with
`request_changes`, write a reply, run again, confirm round 2 shows the reply.
Fix any step in the docs that does not match what actually happens.

- [ ] **Step 6: Run everything**

Run: `npm run typecheck && npm test && npm run build && git diff --exit-code dist app/dist`
Expected: all green, no diff.

- [ ] **Step 7: Commit**

```bash
git add README.md SKILL.md AGENTS.md CLAUDE.md
git commit -m "docs: add README, agent instructions, and contributor guide"
```
