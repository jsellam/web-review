import { describe, expect, it } from 'vitest';
import { buildExtendData } from './extendData.js';
import type { Draft } from '../../state/draft.js';
import type { Thread } from '../../../../src/shared/types.js';

const thread = (id: string, file: string, side: Thread['side'], line: number): Thread => ({
  id,
  file,
  side,
  anchor: { line, content: 'x', contextHash: 'h' },
  status: 'open',
  messages: [],
});

const draft = (file: string, side: Draft['side'], line: number): Draft => ({
  file,
  side,
  line,
  body: 'note',
});

describe('buildExtendData', () => {
  it('puts each thread on its own side and line', () => {
    const data = buildExtendData(
      [thread('t1', 'a.ts', 'new', 42), thread('t2', 'a.ts', 'old', 7)],
      {},
      'a.ts',
    );

    expect(data.newFile[42]?.data.threads.map((t) => t.id)).toEqual(['t1']);
    expect(data.oldFile[7]?.data.threads.map((t) => t.id)).toEqual(['t2']);
  });

  it('groups two threads on the same line into one entry', () => {
    const data = buildExtendData(
      [thread('t1', 'a.ts', 'new', 42), thread('t2', 'a.ts', 'new', 42)],
      {},
      'a.ts',
    );

    expect(data.newFile[42]?.data.threads.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('creates an entry for a draft on a line with no thread', () => {
    const data = buildExtendData([], { k: draft('a.ts', 'new', 9) }, 'a.ts');

    expect(data.newFile[9]?.data).toEqual({ threads: [], draft: draft('a.ts', 'new', 9) });
  });

  it('attaches a draft to the same entry as an existing thread', () => {
    const data = buildExtendData(
      [thread('t1', 'a.ts', 'new', 42)],
      { k: draft('a.ts', 'new', 42) },
      'a.ts',
    );

    expect(data.newFile[42]?.data.threads).toHaveLength(1);
    expect(data.newFile[42]?.data.draft).not.toBeNull();
  });

  it('ignores threads and drafts belonging to other files', () => {
    const data = buildExtendData(
      [thread('t1', 'other.ts', 'new', 42)],
      { k: draft('other.ts', 'new', 9) },
      'a.ts',
    );

    expect(data.newFile).toEqual({});
    expect(data.oldFile).toEqual({});
  });
});
