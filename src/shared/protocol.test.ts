import { describe, expect, it } from 'vitest';
import { frameResult, parseFramed, RESULT_START, RESULT_END } from './protocol.js';
import type { CliResult } from './types.js';

describe('frameResult', () => {
  it('wraps JSON between the markers on their own lines', () => {
    const result: CliResult = { status: 'pending', url: 'http://127.0.0.1:1/?t=x' };
    const lines = frameResult(result).split('\n');

    expect(lines[0]).toBe(RESULT_START);
    expect(lines.at(-1)).toBe(RESULT_END);
    expect(JSON.parse(lines.slice(1, -1).join('\n'))).toEqual(result);
  });
});

describe('parseFramed', () => {
  it('extracts the result even when surrounded by unrelated output', () => {
    const result: CliResult = { status: 'submitted', verdict: 'approve', round: 2 };
    const noisy = `starting server\n${frameResult(result)}\nserver stopped\n`;

    expect(parseFramed(noisy)).toEqual(result);
  });

  it('reads the last block when several are present', () => {
    const first = frameResult({ status: 'pending' });
    const second = frameResult({ status: 'submitted', verdict: 'comment' });

    expect(parseFramed(`${first}\n${second}`)).toEqual({
      status: 'submitted',
      verdict: 'comment',
    });
  });

  it('throws a named error when no block is present', () => {
    expect(() => parseFramed('nothing here')).toThrow(/no result block/i);
  });

  it('round-trips a result whose comment body contains the literal end marker', () => {
    const result: CliResult = {
      status: 'submitted',
      verdict: 'comment',
      round: 1,
      general: '',
      threads: [
        {
          id: 't1',
          file: 'src/auth.ts',
          side: 'new',
          anchor: { line: 1, content: '', contextHash: 'x' },
          status: 'open',
          messages: [
            {
              author: 'user',
              round: 1,
              body: 'copy-pasted output including WEB_REVIEW_RESULT>>> right here',
              at: '2026-01-01T00:00:00.000Z',
            },
          ],
        },
      ],
    };

    expect(parseFramed(frameResult(result))).toEqual(result);
  });
});
