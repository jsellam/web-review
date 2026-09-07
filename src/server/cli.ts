import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { frameResult } from '../shared/protocol.js';
import { gitDir as resolveGitDir, repoRoot } from './git/exec.js';
import { resolveRange, type DiffRange } from './git/range.js';
import { listChangedFiles, readSide, renameMap } from './git/files.js';
import { numberHunks, readFileDiff } from './git/diff.js';
import {
  isTooLarge,
  renderPrepare,
  wholeFileAsAdditions,
  type PreparedFile,
} from './review/prepare.js';
import { isENOENT, readRequest, REQUEST_FILE } from './review/request.js';
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
import type { CliResult, FileEntry, SessionPayload } from '../shared/types.js';

export const RESULT_FILE = 'result.json';
export const SESSION_FILE = 'session.json';

export interface CliOptions {
  base: string;
  timeoutSeconds: number;
  port: number;
  open: boolean;
  stop: boolean;
  serveInternal: boolean;
  prepare: boolean;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    base: 'auto',
    timeoutSeconds: 540,
    port: 0,
    open: true,
    stop: false,
    serveInternal: false,
    prepare: false,
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
    else if (arg === '--prepare') options.prepare = true;
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

/**
 * `Thread.file` (and `NewComment.file`) always store a file's NEW path, even
 * for an old-side comment — the browser has no other way to key a thread
 * that must keep rendering under the same file across rounds (see
 * `extendData.ts`'s `thread.file !== filePath` filter). An old-side lookup
 * therefore has to translate through `renames` before asking git for the
 * content: the file never existed at the new path in `range.base`.
 */
function linesLookup(range: DiffRange, cwd: string, files: FileEntry[] = []): LinesLookup {
  const renames = renameMap(files);
  return async (file, side) => {
    const path = side === 'old' ? (renames.get(file) ?? file) : file;
    const content = await readSide(path, side, range, { cwd });
    return content === null ? null : splitLines(content);
  };
}


/**
 * Write the framed result and exit only once it has actually been flushed.
 * Pipes are asynchronous on POSIX (unlike files and TTYs): calling
 * `process.exit()` right after `process.stdout.write()` can terminate the
 * process before the write reaches the reader, truncating the JSON an agent
 * is piping in — the exact way this tool's output is normally consumed.
 * The callback form waits for the flush before exiting.
 *
 * This does not return `never`: it merely schedules the exit, so every call
 * site must follow it with an explicit `return` to stop the rest of the
 * function from running in the meantime.
 */
function emit(result: CliResult, code = 0): void {
  process.stdout.write(`${frameResult(result)}\n`, () => process.exit(code));
}

/** `emit`'s plain-text twin, for `--prepare`, which produces no `CliResult` to frame. */
function emitText(text: string, code = 0, stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(text, () => process.exit(code));
}

function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd'
    : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];

  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    // spawn() reports a missing executable asynchronously, via an 'error'
    // event on the child — never as a synchronous throw. Without a listener,
    // that event has no handler and Node's default behaviour kills this
    // whole process before any result is ever printed. A missing browser
    // opener must never be more than a silent no-op.
    child.on('error', () => {});
    child.unref();
  } catch {
    // Defence in depth for any synchronous failure from spawn() itself.
  }
}

/**
 * This bundle's own path, and the directory holding it. `import.meta.filename`
 * and `import.meta.dirname` would be simpler but need Node 20.11+;
 * `fileURLToPath` on `import.meta.url` works down to Node 18, matching the
 * engine floor.
 *
 * Deriving both from `import.meta.url` rather than from `process.argv[1]`
 * matters: Node resolves a module URL through symlinks, so this stays the
 * real file even when the process was addressed through a linked skill
 * directory (`~/.claude/skills/web-review` -> `~/.agents/skills/web-review`).
 */
const modulePath = fileURLToPath(import.meta.url);
const moduleDir = dirname(modulePath);

/** The detached half: serve until a review is submitted, then write the result and exit. */
async function serveMain(cwd: string, stateDir: string): Promise<void> {
  const session = JSON.parse(await readFile(join(stateDir, SESSION_FILE), 'utf8')) as SessionFile;
  const range: DiffRange = { base: session.base, label: session.label, staged: session.staged };

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
    onSubmit: async (payload, markPersisted) => {
      const files = await listChangedFiles(range, { cwd });
      const lookup = linesLookup(range, cwd, files);
      const state = await readState(stateDir);
      const { state: next, unanchored } = await applySubmission(state, payload, lookup);
      const result = submittedResult(next, payload.verdict, payload.general, unanchored);

      // Stage the result's content on disk before touching state.json at
      // all: writing content (not a rename) is the step that can actually
      // fail — a full disk, a killed process mid-write — so doing it first
      // means such a failure leaves nothing changed, and the browser's retry
      // can safely re-run the whole submission from scratch.
      const resultTemp = join(stateDir, `${RESULT_FILE}.tmp`);
      await writeFile(resultTemp, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

      await writeState(stateDir, next);
      // The submission is now durable. From this point on a retry must never
      // be allowed to re-run it — even if the rename just below somehow
      // fails — because that would re-apply it on top of the state just
      // written and duplicate every new thread and reply.
      markPersisted();
      await rename(resultTemp, join(stateDir, RESULT_FILE));

      return { unanchored };
    },
  });

  await handle.waitForSubmission(24 * 60 * 60 * 1000);
  // server.json is already gone by now — startServer's submit handler
  // removes it the instant a submission is accepted, not here at close.
  // This delay exists only to give the HTTP response time to actually reach
  // the browser before the process exits; it is not a liveness window.
  setTimeout(() => void handle.close().then(() => process.exit(0)), 250).unref();
}

/** Wait for a result to appear, either from this process's server or another's. */
async function waitForResult(stateDir: string, timeoutSeconds: number): Promise<CliResult | null> {
  const deadline = Date.now() + timeoutSeconds * 1000;

  while (Date.now() < deadline) {
    const raw = await readFile(join(stateDir, RESULT_FILE), 'utf8').catch(() => null);
    if (raw !== null) {
      // Parse before deleting: result.json is now written via temp-plus-rename,
      // so a torn read should not happen, but a reader must still never lose
      // the file to a parse failure it could otherwise recover from by retrying.
      const parsed = JSON.parse(raw) as CliResult;
      await rm(join(stateDir, RESULT_FILE), { force: true });
      return parsed;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return null;
}

const LOCK_FILE = 'server.lock';
/** How long a lock is trusted before it's treated as abandoned by a dead invocation. */
const LOCK_STALE_MS = 10_000;

interface SpawnLock {
  pid: number;
  at: string;
}

function isEExist(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'EEXIST';
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reading server.json and deciding to spawn a detached server is not one
 * atomic step, so two near-simultaneous invocations can both decide to
 * spawn — the loser's process then has no server.json pointing at it and
 * leaks until the machine restarts. `wx` is an exclusive create: the
 * filesystem itself guarantees only one caller can create this file when
 * several race to do so, which is what makes the decision atomic.
 *
 * Returns true if this invocation won the race and should spawn the server;
 * false if another invocation already holds a fresh lock and is doing it.
 */
async function acquireSpawnLock(stateDir: string): Promise<boolean> {
  const lockPath = join(stateDir, LOCK_FILE);
  const mine: SpawnLock = { pid: process.pid, at: new Date().toISOString() };

  try {
    await writeFile(lockPath, JSON.stringify(mine), { flag: 'wx' });
    return true;
  } catch (error) {
    if (!isEExist(error)) throw error;
  }

  const raw = await readFile(lockPath, 'utf8').catch(() => null);
  if (raw === null) {
    // The holder released it between our failed create and this read.
    return acquireSpawnLock(stateDir);
  }

  let other: Partial<SpawnLock> | null;
  try {
    other = JSON.parse(raw) as Partial<SpawnLock>;
  } catch {
    other = null;
  }

  const fresh = typeof other?.at === 'string' && Date.now() - Date.parse(other.at) < LOCK_STALE_MS;
  const alive = typeof other?.pid === 'number' && isPidAlive(other.pid);
  if (fresh && alive) return false;

  // Stale or unreadable: the invocation that made it is gone or long past
  // any reasonable spawn time. Take over rather than wait on it forever.
  await rm(lockPath, { force: true });
  return acquireSpawnLock(stateDir);
}

/** Only ever called by the invocation that acquired the lock — never by a loser waiting on it. */
async function releaseSpawnLock(stateDir: string): Promise<void> {
  await rm(join(stateDir, LOCK_FILE), { force: true });
}

/**
 * Delete request.json, reporting whether there was one to delete. `rm` with
 * `force` cannot tell "removed" from "was never there", and the caller has to
 * say which happened.
 */
async function discardRequest(stateDir: string): Promise<boolean> {
  try {
    await unlink(join(stateDir, REQUEST_FILE));
    return true;
  } catch (error) {
    if (isENOENT(error)) return false;
    throw error;
  }
}

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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();

  const root = await repoRoot({ cwd }).catch(() => null);
  if (root === null) {
    if (options.prepare) {
      emitText('web-review: not a git repository\n', 1, process.stderr);
      return;
    }
    emit(errorResult('not a git repository'), 1);
    return;
  }

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

  const gitDir = await resolveGitDir({ cwd: root });
  const stateDir = stateDirFor(gitDir);

  if (options.serveInternal) {
    await serveMain(root, stateDir);
    return;
  }

  if (options.stop) {
    const record = await readServerRecord(stateDir);
    // A record can outlive its process (a crash, a reboot, a recycled pid).
    // Reuse the same token-authenticated liveness check the re-attach path
    // uses below, rather than signalling a bare pid: an unchecked
    // `process.kill(record.pid)` could hit an unrelated process that
    // happens to have reused that pid since the record was written.
    const alive = record !== null && (await isServerAlive(record));

    if (alive) {
      try {
        process.kill(record.pid);
      } catch {
        // Already gone.
      }
      await removeServerRecord(stateDir);
      emit({ ...abortedResult(), message: 'server stopped' });
      return;
    }

    // Nothing alive to stop. Clear a stale record if one was left behind,
    // and say so truthfully instead of claiming a stop that did not happen.
    if (record) await removeServerRecord(stateDir);
    emit({ ...abortedResult(), message: 'no server was running' });
    return;
  }

  const existing = await readServerRecord(stateDir);
  if (existing && (await isServerAlive(existing))) {
    // A round is already open, and its state already holds everything the
    // agent wrote for it. `pending` tells the agent to run the command
    // again, and rewriting request.json first is a natural way to do that —
    // so a request.json sitting here describes the round already under
    // review, not a new one. Leaving it on disk would bank it for the NEXT
    // round, where every annotation in it reappears a second time beside the
    // reviewer's fresh comments. Consume it here instead.
    //
    // The `unconsumed result` branch below deliberately does the opposite
    // and keeps the file: no round is open there, so a request.json really
    // is input still waiting for its turn.
    const discarded = await discardRequest(stateDir);

    // A previous round's result.json, if any, was already removed by the
    // process that read it (or never existed). What we wait for here is
    // strictly a fresh write from the still-running server, so re-attachment
    // can never return a stale outcome.
    const result = await waitForResult(stateDir, options.timeoutSeconds);
    if (result) {
      emit(result);
      return;
    }

    // Say that the request was dropped rather than dropping it silently —
    // the same principle `unanchored` follows for a comment that could not
    // be placed.
    const pending = pendingResult(`http://127.0.0.1:${existing.port}/?t=${existing.token}`);
    emit(
      discarded ?
        {
          ...pending,
          message: `a review was already open, so ${REQUEST_FILE} described that round and was consumed rather than held for the next one. Re-run the command as-is; there is no need to write it again.`,
        }
      : pending,
    );
    return;
  }
  await removeServerRecord(stateDir);

  // The server that handled the previous round may have received a
  // submission, written result.json, and exited before this invocation ever
  // started — the CLI is re-entrant, so nothing was left waiting for it.
  // `waitForResult` deletes the file the moment it delivers it to an
  // invocation, so its mere presence here reliably means "submitted but
  // never yet delivered", never a stale leftover. Delivering it must happen
  // before `openRound` below touches state.json, or this round's own result
  // is lost and a fresh round gets opened (and the round counter advanced)
  // for a review that had already finished.
  const unconsumed = await readFile(join(stateDir, RESULT_FILE), 'utf8').catch(() => null);
  if (unconsumed !== null) {
    // Parse before deleting: losing the file to a parse failure would throw
    // away a submission that already fully landed, with no way to recover it.
    const parsed = JSON.parse(unconsumed) as CliResult;
    await rm(join(stateDir, RESULT_FILE), { force: true });
    emit(parsed);
    return;
  }

  // Read but do not yet delete request.json: everything between here and the
  // writeState call below can fail (a bad --base, resolveRange, an empty
  // diff) and end the invocation before the round is durable. Deleting only
  // after writeState succeeds means every one of those earlier failures
  // leaves the agent's summary and annotations in place to retry — a
  // malformed request.json is already left in place by readRequest itself
  // (it throws before returning), so this keeps both cases consistent.
  const request = await readRequest(stateDir);
  const range = await resolveRange(options.base === 'auto' ? request.base : options.base, { cwd: root });

  const files = await listChangedFiles(range, { cwd: root });
  if (files.length === 0) {
    emit(noChangesResult());
    return;
  }

  const state = await openRound(await readState(stateDir), request, linesLookup(range, root, files));
  await writeState(stateDir, state);
  // request.json has now been durably folded into state.json: only past this
  // point is it safe to consume, so a crash or bad exit before here can never
  // lose it.
  await rm(join(stateDir, REQUEST_FILE), { force: true });
  // Delete any leftover result.json from a previous round before spawning the
  // new server, so a crash-recovery read of this round can never pick up an
  // outcome that belongs to a round that already finished. (Any genuinely
  // unconsumed result was already delivered and returned above, before
  // reaching this point.)
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

  const shouldSpawn = await acquireSpawnLock(stateDir);
  let serverRecord: Awaited<ReturnType<typeof readServerRecord>>;
  if (shouldSpawn) {
    try {
      // Spawn this module by its own resolved path, not by `process.argv[1]`:
      // the child re-runs the entry-point check below, and handing it the
      // path the parent happened to be addressed by makes that check depend
      // on how the caller spelled it.
      spawn(process.execPath, [modulePath, '--__serve'], {
        cwd: root,
        detached: true,
        stdio: 'ignore',
      }).unref();
      serverRecord = await waitForRecord(stateDir);
    } finally {
      // Release unconditionally: a server that started successfully has
      // already announced itself via server.json, and one that failed to
      // start must not leave the lock behind for every later invocation to
      // trip over.
      await releaseSpawnLock(stateDir);
    }
  } else {
    // Someone else is already spawning. Wait for the server.json they are
    // about to write; their lock is theirs to release, not ours.
    serverRecord = await waitForRecord(stateDir);
  }

  if (!serverRecord) {
    emit(errorResult('the review server failed to start'), 1);
    return;
  }

  const url = `http://127.0.0.1:${serverRecord.port}/?t=${serverRecord.token}`;
  if (options.open) {
    openBrowser(url);
  } else {
    // README.md documents --no-open as printing the URL instead of opening a
    // browser. Without this, the URL would only ever appear once --timeout
    // elapses and this prints a `pending` result — stderr, not stdout, so it
    // never mixes with the framed JSON contract an agent parses from stdout.
    process.stderr.write(`${url}\n`);
  }

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
 * as `node cli.js ...`, not imported by a test. A test importing this module
 * for `parseArgs` runs under a different entry point, so it never triggers
 * `main()` or installs the signal handlers below.
 *
 * Comparing `import.meta.url` against `pathToFileURL(process.argv[1])`
 * directly would be wrong: Node resolves a module URL through symlinks but
 * leaves `process.argv[1]` exactly as the caller spelled it. A skill
 * directory is routinely a symlink, and the two then never match — `main()`
 * never runs, and the process exits 0 having printed nothing at all, which
 * an agent reads as a silent success. Compare real paths instead, on both
 * sides, so the check also holds under `--preserve-symlinks-main` (which
 * leaves `import.meta.url` symlinked rather than the other way round).
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(modulePath);
  } catch {
    // `argv[1]` names nothing we can resolve on disk, so it is not this file.
    return false;
  }
}

if (isEntryPoint()) {
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
