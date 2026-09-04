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
