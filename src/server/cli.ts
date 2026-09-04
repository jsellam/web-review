import { spawn } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

/**
 * Directory this bundle lives in. `import.meta.dirname` would be simpler but
 * needs Node 20.11+; `fileURLToPath` on `import.meta.url` works down to
 * Node 18, matching the engine floor.
 */
const moduleDir = fileURLToPath(new URL('.', import.meta.url));

/** The detached half: serve until a review is submitted, then write the result and exit. */
async function serveMain(cwd: string, stateDir: string): Promise<void> {
  const session = JSON.parse(await readFile(join(stateDir, SESSION_FILE), 'utf8')) as SessionFile;
  const range: DiffRange = { base: session.base, label: session.label, staged: session.staged };
  const lookup = linesLookup(range, cwd);

  const handle = await startServer({
    staticRoot: join(moduleDir, '..', 'app', 'dist'),
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
    // A previous round's result.json, if any, was already removed by the
    // process that read it (or never existed). What we wait for here is
    // strictly a fresh write from the still-running server, so re-attachment
    // can never return a stale outcome.
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
  // Delete any leftover result.json from a previous round before spawning the
  // new server, so a crash-recovery read of this round can never pick up an
  // outcome that belongs to a round that already finished.
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

/**
 * Only run when this module is the process entry point — i.e. it was invoked
 * as `node cli.js ...`, not imported by a test. `import.meta.url` for an
 * import always differs from `pathToFileURL(process.argv[1])`, so a test
 * importing this module for `parseArgs` never triggers `main()` or installs
 * the signal handlers below.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  /**
   * A cancelled review must never reach the agent as silence, which it could
   * mistake for approval. Print an explicit `aborted` and leave the detached
   * server running so re-running the command re-attaches.
   */
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => emit(abortedResult(), 130));
  }

  main().catch((error: unknown) => {
    emit(errorResult(error instanceof Error ? error.message : 'unexpected error'), 1);
  });
}
