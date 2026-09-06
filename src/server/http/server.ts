import { createServer, type Server } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { handleApi, SubmissionConflictError, type RouteDeps } from './routes.js';
import { serveStatic } from './static.js';
import type { NewComment, SessionPayload, Side, SubmitPayload } from '../../shared/types.js';

export const SERVER_FILE = 'server.json';

export interface ServerRecord {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
}

/**
 * Explicit rather than derived from RouteDeps via Omit<...>: the two interfaces
 * share some field names, but StartOptions describes what a caller supplies to
 * boot the server, while RouteDeps describes what a single request handler
 * needs. Keeping them separate reads more plainly than reconstructing one from
 * the other with utility types.
 */
export interface StartOptions {
  staticRoot: string;
  stateDir: string;
  port: number;
  token: string;
  getSession(): Promise<SessionPayload>;
  getFile(path: string, side: Side): Promise<string | null>;
  /**
   * Called once, with the first accepted submission. Must call
   * `markPersisted()` as soon as the submission has been durably folded into
   * state.json — before that point a failure is safely retryable from
   * scratch, but after it a retry would re-apply the submission on top of
   * the already-updated state and duplicate every new thread and reply, so
   * the guard below refuses every further call once it has fired, even if
   * this function goes on to fail afterwards (e.g. writing result.json).
   */
  onSubmit(
    payload: SubmitPayload,
    markPersisted: () => void,
  ): Promise<{ unanchored: NewComment[] }>;
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
  // Set synchronously (before the first `await` in `submit`) alongside the
  // `submitted`/`submitting` check below, so the guard also covers two
  // concurrent in-flight POSTs, not just two sequential ones.
  let submitting = false;
  const waiters = new Set<(value: boolean) => void>();

  // Hoisted above createServer (and reassigned after listen) so the request
  // handler closure never references a binding before its declaration.
  let port = options.port;

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
      try {
        const deps: RouteDeps = {
          token: options.token,
          port,
          getSession: options.getSession,
          getFile: options.getFile,
          // This server is the single writer for its repository for the lifetime
          // of one review: server.json plus isServerAlive's liveness check are
          // what prevent a second server process from starting concurrently
          // against the same repository. Within this process, the
          // `submitted`/`submitting` guard below is what prevents a second
          // (sequential or concurrent) POST /api/review from re-applying a
          // submission to persisted state — no cross-process locking is needed
          // for either.
          submit: async (payload) => {
            if (submitted || submitting) {
              throw new SubmissionConflictError('a review has already been submitted');
            }
            // Checked and set synchronously, with no `await` in between, so
            // this also wins the race between two concurrent POSTs.
            submitting = true;
            // Set by onSubmit's markPersisted callback the moment the
            // submission is durably folded into state.json. A failure before
            // that point (nothing changed yet) is safely retryable; a
            // failure after it is not, because a retry would re-apply the
            // submission on top of the already-updated state — so the catch
            // below only resets `submitting` when persistence never happened.
            let persisted = false;
            let result: { unanchored: NewComment[] };
            try {
              result = await options.onSubmit(payload, () => {
                persisted = true;
                submitted = true;
              });
            } catch (error) {
              if (!persisted) submitting = false;
              throw error;
            }
            submitting = false;
            submitted = true;
            // A submission has now been fully accepted: this server has
            // nothing further to deliver and is about to shut down (see
            // serveMain in cli.ts). Removing the liveness record here, before
            // the response is sent, closes the window between "submitted"
            // and "actually exited" during which a concurrent CLI invocation
            // could otherwise read server.json, find the process still
            // answering, and take the re-attach path — waiting out its full
            // timeout for a result.json that has already been consumed, then
            // handing back a URL to a server that has since exited.
            await removeServerRecord(options.stateDir);
            for (const waiter of [...waiters]) waiter(true);
            return result;
          },
        };

        if (await handleApi(req, res, deps)) return;

        const response = await serveStatic(
          options.staticRoot,
          new URL(req.url ?? '/', `http://127.0.0.1:${port}`).pathname,
        );
        res.writeHead(response.status, {
          'content-type': response.contentType,
          'content-length': response.body.length,
          'cache-control': 'no-store',
        });
        res.end(response.body);
      } catch {
        // Defence in depth: handleApi already turns its own route errors into
        // a JSON response, but a throw outside that path (e.g. a malformed
        // req.url that `new URL()` cannot parse) would otherwise become an
        // unhandled rejection with no response ever written, hanging the
        // client.
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'text/plain' });
        }
        res.end('internal server error');
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', resolve);
  });

  const address = server.address();
  port = typeof address === 'object' && address ? address.port : options.port;
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
 * A record can outlive its process (a crash, a reboot, a recycled pid). Check
 * the pid is still there, then confirm something is actually answering on the
 * port with the recorded token — both checks, not either.
 */
export async function isServerAlive(record: ServerRecord): Promise<boolean> {
  try {
    process.kill(record.pid, 0);
  } catch {
    return false;
  }

  // Node's fetch always sets Host from the request URL's own authority and
  // silently ignores an explicit override, so there is no point passing one.
  // A timeout matters here: fetch has none by default, so a server that is
  // alive but wedged (pid present, port unresponsive) would hang this check
  // forever — and the re-attach path in cli.ts awaits it before printing
  // anything, so a hang here is silence to the agent, worse than `pending`.
  const response = await fetch(`http://127.0.0.1:${record.port}/api/session`, {
    headers: { 'x-review-token': record.token },
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);

  return response?.ok === true;
}
