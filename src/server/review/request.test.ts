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
