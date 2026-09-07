import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRepo, type TestRepo } from './test-helpers/repo.js';
import { parseFramed } from '../shared/protocol.js';
import type { CliResult, SessionPayload } from '../shared/types.js';
import { readServerRecord } from './http/server.js';

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Polls until the given pid has actually exited, rather than sleeping a
 * fixed guess-and-hope duration. Bounded so a hung process cannot hang the
 * test suite.
 */
async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isPidAlive(pid)) {
    if (Date.now() > deadline) {
      throw new Error(`pid ${pid} did not exit within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const run = promisify(execFile);
const CLI = resolve('dist/web-review.mjs');

let repo: TestRepo;

async function cli(args: string[]): Promise<CliResult> {
  const { stdout } = await run(process.execPath, [CLI, ...args], { cwd: repo.dir })
    .catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '' }));
  return parseFramed(stdout);
}

async function prepare(args: string[] = []): Promise<{ stdout: string; stderr: string }> {
  return run(process.execPath, [CLI, '--prepare', ...args], { cwd: repo.dir }).catch(
    (error: { stdout?: string; stderr?: string }) => ({
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    }),
  );
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

  it('leaves request.json in place on a no_changes exit, so the agent can retry', async () => {
    const stateDir = join(repo.dir, '.git', 'web-review');
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, 'request.json'),
      JSON.stringify({ summary: 'a summary the agent must not lose' }),
      'utf8',
    );

    expect(await cli(['--no-open'])).toEqual({ status: 'no_changes' });

    const survived = JSON.parse(await readFile(join(stateDir, 'request.json'), 'utf8')) as {
      summary: string;
    };
    expect(survived.summary).toBe('a summary the agent must not lose');
  });

  it('leaves request.json in place when the base ref cannot be resolved', async () => {
    await repo.write('src/auth.ts', 'export function sign() {\n  return 2;\n}\n');
    const stateDir = join(repo.dir, '.git', 'web-review');
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, 'request.json'),
      JSON.stringify({ summary: 'keep me', base: 'nosuchref' }),
      'utf8',
    );

    const result = await cli(['--no-open']);
    expect(result.status).toBe('error');

    const survived = JSON.parse(await readFile(join(stateDir, 'request.json'), 'utf8')) as {
      summary: string;
    };
    expect(survived.summary).toBe('keep me');
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

  it('prints the URL to stderr under --no-open, per README, instead of staying silent', async () => {
    await repo.write('src/auth.ts', 'export function sign() {\n  return 2;\n}\n');

    const { stdout, stderr } = await run(process.execPath, [CLI, '--no-open', '--timeout', '2'], {
      cwd: repo.dir,
    });

    const result = parseFramed(stdout);
    expect(result.status).toBe('pending');
    // Printed to stderr, never stdout, so it can never be mistaken for part
    // of the framed JSON contract an agent parses from stdout.
    expect(stderr.trim()).toBe(result.url);
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
    }).then((r) => r.json() as Promise<SessionPayload>);

    expect(session.summary).toBe('Change the return value.');
    expect(session.round).toBe(1);
    expect(session.files.map((f: { path: string }) => f.path)).toEqual(['src/auth.ts']);
    expect(session.threads[0]!.messages[0]).toMatchObject({ author: 'agent', body: 'why 2?' });

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

  it('keeps an old-side comment on a renamed file instead of dropping it', async () => {
    // The old-side content lives at the pre-rename path in the base commit —
    // `src/auth.ts` never existed at `src/renamed-auth.ts` there. A comment
    // on the old side must still resolve through the rename, not vanish.
    await repo.run('mv', 'src/auth.ts', 'src/renamed-auth.ts');
    await repo.commit('rename auth.ts');
    await repo.write('src/renamed-auth.ts', 'export function sign() {\n  return 2;\n}\n');

    const pending = await cli(['--no-open', '--timeout', '2', '--base', 'HEAD~1']);
    const url = new URL(pending.url!);
    const token = url.searchParams.get('t')!;

    const posted = await fetch(`${url.origin}/api/review`, {
      method: 'POST',
      headers: { 'x-review-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({
        verdict: 'comment',
        general: '',
        newComments: [
          { file: 'src/renamed-auth.ts', side: 'old', line: 1, body: 'why did this return 1?' },
        ],
      }),
    });
    expect(posted.status).toBe(200);
    expect(((await posted.json()) as { unanchored: unknown[] }).unanchored).toEqual([]);

    const submitted = await cli(['--no-open', '--timeout', '10']);

    expect(submitted.status).toBe('submitted');
    expect(submitted.threads).toHaveLength(1);
    expect(submitted.threads![0]).toMatchObject({
      file: 'src/renamed-auth.ts',
      side: 'old',
      status: 'open',
      anchor: { line: 1, content: 'export function sign() {' },
    });
    expect(submitted.threads![0]!.messages[0]).toMatchObject({
      author: 'user',
      body: 'why did this return 1?',
    });
  }, 30_000);

  it('reports a new comment that cannot be anchored instead of dropping it silently', async () => {
    await repo.write('src/auth.ts', 'export function sign() {\n  return 2;\n}\n');

    const pending = await cli(['--no-open', '--timeout', '2']);
    const url = new URL(pending.url!);
    const token = url.searchParams.get('t')!;

    const posted = await fetch(`${url.origin}/api/review`, {
      method: 'POST',
      headers: { 'x-review-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({
        verdict: 'comment',
        general: '',
        // Line 99 does not exist on either side: this can never be anchored.
        newComments: [{ file: 'src/auth.ts', side: 'new', line: 99, body: 'orphaned comment' }],
      }),
    });
    expect(posted.status).toBe(200);
    const body = (await posted.json()) as { unanchored: { file: string; body: string }[] };
    expect(body.unanchored).toEqual([
      { file: 'src/auth.ts', side: 'new', line: 99, body: 'orphaned comment' },
    ]);

    const submitted = await cli(['--no-open', '--timeout', '10']);

    expect(submitted.status).toBe('submitted');
    expect(submitted.threads).toEqual([]);
    expect(submitted.unanchored).toEqual([
      { file: 'src/auth.ts', side: 'new', line: 99, body: 'orphaned comment' },
    ]);
  }, 30_000);

  it('delivers a review submitted after the CLI already returned pending and exited', async () => {
    await repo.write('src/auth.ts', 'export function sign() {\n  return 2;\n}\n');
    const stateDir = join(repo.dir, '.git', 'web-review');

    const pending = await cli(['--no-open', '--timeout', '2']);
    const url = new URL(pending.url!);
    const token = url.searchParams.get('t')!;

    const record = await readServerRecord(stateDir);
    expect(record).not.toBeNull();

    const posted = await fetch(`${url.origin}/api/review`, {
      method: 'POST',
      headers: { 'x-review-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'approve', general: '', newComments: [] }),
    });
    expect(posted.status).toBe(200);

    // The server writes result.json and then exits about 250ms later, with
    // no process left waiting on the submission by the time it does. Wait
    // for the actual exit rather than a fixed sleep, so this reproduces the
    // real race instead of hoping to land inside or outside the window.
    await waitForExit(record!.pid, 10_000);

    // The agent, following SKILL.md, re-runs the CLI exactly as instructed
    // after a `pending` result. The submitted review must not be discarded.
    const result = await cli(['--no-open', '--timeout', '2']);

    expect(result.status).toBe('submitted');
    expect(result.verdict).toBe('approve');
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
    }).then((r) => r.json() as Promise<SessionPayload>);

    expect(session.round).toBe(2);
    expect(session.threads[0]!.anchor.line).toBe(3);
    expect(session.threads[0]!.status).toBe('open');
    expect(session.threads[0]!.messages).toHaveLength(2);
    expect(session.threads[0]!.messages[1]).toMatchObject({
      author: 'agent',
      round: 2,
      body: 'Added a note.',
    });
  }, 30_000);

  it('delivers a large result through a pipe without truncation', async () => {
    await repo.write('src/auth.ts', 'export function sign() {\n  return 2;\n}\n');

    const pending = await cli(['--no-open', '--timeout', '2']);
    const url = new URL(pending.url!);
    const token = url.searchParams.get('t')!;

    // Comfortably past a pipe's kernel buffer (64-128KiB on common
    // platforms) so a truncated write would be observable, with a marker at
    // the very end so a partial delivery is caught rather than merely a
    // shortened-but-still-valid-looking body.
    const marker = 'END-OF-LARGE-BODY-MARKER';
    const bigBody = 'x'.repeat(300_000) + marker;

    const posted = await fetch(`${url.origin}/api/review`, {
      method: 'POST',
      headers: { 'x-review-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({
        verdict: 'comment',
        general: '',
        newComments: [{ file: 'src/auth.ts', side: 'new', line: 2, body: bigBody }],
      }),
    });
    expect(posted.status).toBe(200);

    const submitted = await cli(['--no-open', '--timeout', '10']);

    expect(submitted.status).toBe('submitted');
    expect(submitted.threads).toHaveLength(1);
    const body = submitted.threads![0]!.messages[0]!.body;
    expect(body).toHaveLength(bigBody.length);
    expect(body.endsWith(marker)).toBe(true);
  }, 30_000);

  it('does not spawn a second server when a fresh lock is already held', async () => {
    await repo.write('src/auth.ts', 'export function sign() {\n  return 2;\n}\n');
    const stateDir = join(repo.dir, '.git', 'web-review');
    await mkdir(stateDir, { recursive: true });

    // Simulate another invocation that is mid-spawn: a lock naming a pid
    // that is genuinely alive (this test process itself) and a timestamp
    // from just now.
    await writeFile(
      join(stateDir, 'server.lock'),
      JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
      'utf8',
    );

    const result = await cli(['--no-open', '--timeout', '2']);

    // With no real server ever spawned by either "invocation", this one must
    // give up waiting for server.json rather than start its own — proving it
    // deferred to the lock instead of racing past it.
    expect(result).toEqual({ status: 'error', message: 'the review server failed to start' });
    await expect(readFile(join(stateDir, 'server.json'), 'utf8')).rejects.toThrow();
  }, 20_000);

  it('still delivers a result when the platform has no browser opener', async () => {
    await repo.write('src/auth.ts', 'export function sign() {\n  return 2;\n}\n');

    // Force a PATH containing only `git` (as a symlink to the real binary),
    // so the browser-opener spawn (`open`/`xdg-open`) genuinely cannot find
    // its executable, without breaking anything else the CLI shells out to.
    const { stdout: gitPath } = await run('which', ['git']);
    const binDir = await mkdtemp(join(tmpdir(), 'web-review-bin-'));
    await symlink(gitPath.trim(), join(binDir, 'git'));

    try {
      // Deliberately omit --no-open: this exercises the real openBrowser()
      // path, which previously crashed the whole process before any result
      // was printed when the opener binary was missing.
      const { stdout } = await run(process.execPath, [CLI, '--timeout', '2'], {
        cwd: repo.dir,
        env: { ...process.env, PATH: binDir },
      }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '' }));

      expect(parseFramed(stdout).status).toBe('pending');
    } finally {
      await rm(binDir, { recursive: true, force: true });
    }
  }, 20_000);

  it('runs when invoked through a symlinked path, as a linked skill directory is', async () => {
    // A skill directory is routinely a symlink (~/.claude/skills/web-review ->
    // ~/.agents/skills/web-review). Node resolves import.meta.url to the
    // realpath but leaves process.argv[1] symlinked, so an entry-point guard
    // comparing the two never fires and the process exits 0 having done
    // nothing at all: no server, no browser, no framed result. The detached
    // half is spawned with the same argv[1], so it must survive this too.
    await repo.write('src/auth.ts', 'export function sign() {\n  return 2;\n}\n');

    const linkParent = await mkdtemp(join(tmpdir(), 'web-review-link-'));
    const link = join(linkParent, 'dist');
    await symlink(dirname(CLI), link);

    try {
      const { stdout } = await run(
        process.execPath,
        [join(link, 'web-review.mjs'), '--no-open', '--timeout', '2'],
        { cwd: repo.dir },
      ).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '' }));

      expect(parseFramed(stdout).status).toBe('pending');
    } finally {
      await rm(linkParent, { recursive: true, force: true });
    }
  }, 20_000);

  it('reviews from inside a git worktree, where .git is a file, not a directory', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'web-review-wt-'));
    const worktree = join(parent, 'feature');
    await repo.run('worktree', 'add', '-b', 'feature', worktree);
    await writeFile(
      join(worktree, 'src/auth.ts'),
      'export function sign() {\n  return 2;\n}\n',
      'utf8',
    );

    try {
      const { stdout } = await run(process.execPath, [CLI, '--no-open', '--timeout', '2'], {
        cwd: worktree,
      }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '' }));

      expect(parseFramed(stdout).status).toBe('pending');

      // State belongs to the worktree's own git dir — .git/worktrees/feature
      // in the main checkout — never to a `.git` directory under the
      // worktree root, which does not exist, and never to the main
      // checkout's own state, which belongs to a different set of changes.
      const { stdout: gitDir } = await run('git', ['rev-parse', '--absolute-git-dir'], {
        cwd: worktree,
      });
      const stateDir = join(gitDir.trim(), 'web-review');
      const state = JSON.parse(await readFile(join(stateDir, 'state.json'), 'utf8')) as {
        round: number;
      };
      expect(state.round).toBe(1);
      await expect(readFile(join(repo.dir, '.git', 'web-review', 'state.json'), 'utf8')).rejects.toThrow();
    } finally {
      await run(process.execPath, [CLI, '--stop'], { cwd: worktree }).catch(() => undefined);
      await rm(parent, { recursive: true, force: true });
    }
  }, 20_000);

  it('does not bank a request.json written before a re-attach into the next round', async () => {
    // The agent is told to run the command again when it gets `pending`, and
    // it may well rewrite request.json before doing so. That re-run only
    // re-attaches to the round already open — which already contains those
    // annotations — so a request.json left on disk is not "unconsumed input"
    // waiting for its turn: it is a duplicate of the current round, and
    // folding it into the next one makes every agent annotation appear a
    // second time next to the reviewer's fresh comments.
    await repo.write('src/auth.ts', 'export function sign() {\n  return 2;\n}\n');
    const stateDir = join(repo.dir, '.git', 'web-review');
    const request = join(stateDir, 'request.json');
    const body = JSON.stringify({
      summary: 'Change the return value.',
      annotations: [{ file: 'src/auth.ts', line: 2, side: 'new', body: 'why 2?' }],
    });

    await mkdir(stateDir, { recursive: true });
    await writeFile(request, body, 'utf8');
    expect((await cli(['--no-open', '--timeout', '2'])).status).toBe('pending');

    // Round 1 is open and holds the annotation. The agent re-runs, rewriting
    // the same request.json as it goes.
    await writeFile(request, body, 'utf8');
    const reattached = await cli(['--no-open', '--timeout', '2']);
    expect(reattached.status).toBe('pending');
    await expect(readFile(request, 'utf8')).rejects.toThrow();

    // Open the next round with nothing new to say, and the annotation must
    // still be there exactly once.
    await cli(['--stop']);
    expect((await cli(['--no-open', '--timeout', '2'])).status).toBe('pending');

    const state = JSON.parse(await readFile(join(stateDir, 'state.json'), 'utf8')) as {
      round: number;
      threads: { messages: { body: string }[] }[];
    };
    expect(state.round).toBe(2);
    const said = state.threads.flatMap((t) => t.messages).filter((m) => m.body === 'why 2?');
    expect(said).toHaveLength(1);
  }, 30_000);

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
});
