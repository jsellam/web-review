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
    }).then((r) => r.json() as Promise<any>);

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
    }).then((r) => r.json() as Promise<any>);

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
