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
    const fetchImpl = vi.fn().mockResolvedValue(ok({ ok: true, unanchored: [] }));
    const payload = {
      verdict: 'approve' as const,
      general: '',
      newComments: [],
      replies: [],
      resolved: [],
      reopened: [],
      deletions: [],
    };

    await createApi('tok', fetchImpl as unknown as typeof fetch).submit(payload);

    expect(fetchImpl).toHaveBeenCalledWith('/api/review', {
      method: 'POST',
      headers: { 'x-review-token': 'tok', 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  });

  it('surfaces comments the server could not anchor, instead of discarding them', async () => {
    const unanchored = [{ file: 'a.ts', side: 'new' as const, line: 5, body: 'orphaned' }];
    const fetchImpl = vi.fn().mockResolvedValue(ok({ ok: true, unanchored }));
    const payload = {
      verdict: 'approve' as const,
      general: '',
      newComments: [],
      replies: [],
      resolved: [],
      reopened: [],
      deletions: [],
    };

    const result = await createApi('tok', fetchImpl as unknown as typeof fetch).submit(payload);

    expect(result).toEqual({ unanchored });
  });

  it('throws ApiError carrying the status and the server message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ error: 'verdict must be one of' }, 400));

    await expect(createApi('tok', fetchImpl as unknown as typeof fetch).getSession())
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/verdict/) });
    expect(ApiError).toBeDefined();
  });
});
