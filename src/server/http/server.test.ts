import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
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

/**
 * Node's fetch forbids overriding the Host header, so the "wrong host" test
 * below goes through node:http directly instead of weakening the assertion.
 */
function requestWithHost(path: string, host: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port: handle.port,
        path,
        method: 'GET',
        headers: { 'x-review-token': token, host },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

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
    const response = await requestWithHost('/api/session', 'evil.example.com');

    expect(response.status).toBe(403);
  });

  it('rejects a malformed submission with a field-named message', async () => {
    const response = await call('/api/review', {
      method: 'POST',
      body: JSON.stringify({ verdict: 'lgtm' }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/verdict/);
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

describe('POST /api/review double-submission guard', () => {
  it('rejects a second sequential submission with 409, onSubmit called exactly once', async () => {
    const first = await call('/api/review', {
      method: 'POST',
      body: JSON.stringify({ verdict: 'approve' }),
    });
    const second = await call('/api/review', {
      method: 'POST',
      body: JSON.stringify({ verdict: 'approve' }),
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(received).toHaveLength(1);
  });

  it('lets exactly one of two concurrent submissions through', async () => {
    const [first, second] = await Promise.all([
      call('/api/review', { method: 'POST', body: JSON.stringify({ verdict: 'approve' }) }),
      call('/api/review', { method: 'POST', body: JSON.stringify({ verdict: 'approve' }) }),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(received).toHaveLength(1);
  });

  it('lets a submission be retried after onSubmit rejects, without locking the user out', async () => {
    let calls = 0;
    const retryDir = await mkdtemp(join(tmpdir(), 'web-review-server-retry-'));
    await writeFile(join(retryDir, 'index.html'), '<html>app</html>', 'utf8');
    const retryReceived: SubmitPayload[] = [];

    const retryHandle = await startServer({
      staticRoot: retryDir,
      stateDir: retryDir,
      port: 0,
      token,
      getSession: async () => session,
      getFile: async () => null,
      onSubmit: async (payload) => {
        calls += 1;
        if (calls === 1) throw new Error('disk full');
        retryReceived.push(payload);
      },
    });

    try {
      const retryCall = (path: string, init: RequestInit = {}) =>
        fetch(`http://127.0.0.1:${retryHandle.port}${path}`, {
          ...init,
          headers: { 'x-review-token': token, ...(init.headers ?? {}) },
        });

      const first = await retryCall('/api/review', {
        method: 'POST',
        body: JSON.stringify({ verdict: 'approve' }),
      });
      const second = await retryCall('/api/review', {
        method: 'POST',
        body: JSON.stringify({ verdict: 'approve' }),
      });

      expect(first.status).toBe(500);
      expect(second.status).toBe(200);
      expect(calls).toBe(2);
      expect(retryReceived).toHaveLength(1);
    } finally {
      await retryHandle.close();
      await rm(retryDir, { recursive: true, force: true });
    }
  });
});
