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
