import { describe, expect, it } from 'vitest';
import { buildFileTree, countThreadsByFile } from './tree.js';
import type { FileEntry, Thread } from '../../../../src/shared/types.js';

const file = (path: string): FileEntry => ({
  path,
  oldPath: path,
  status: 'modified',
  additions: 1,
  deletions: 0,
  binary: false,
});

const thread = (id: string, filePath: string, status: Thread['status'] = 'open'): Thread => ({
  id,
  file: filePath,
  side: 'new',
  anchor: { line: 1, content: 'x', contextHash: 'h' },
  status,
  messages: [],
});

describe('buildFileTree', () => {
  it('nests files under their directories', () => {
    const nodes = buildFileTree([file('src/a.ts'), file('src/deep/b.ts'), file('top.ts')], {});

    expect(nodes.map((n) => n.key)).toEqual(['src', 'top.ts']);
    const src = nodes[0]!;
    expect(src.children?.map((n) => n.key)).toEqual(['src/deep', 'src/a.ts']);
  });

  it('sorts directories before files, each alphabetically', () => {
    const nodes = buildFileTree([file('z.ts'), file('a/b.ts'), file('a.ts')], {});

    expect(nodes.map((n) => n.key)).toEqual(['a', 'a.ts', 'z.ts']);
  });

  it('marks leaves as leaves so the tree renders no expander', () => {
    const nodes = buildFileTree([file('a.ts')], {});

    expect(nodes[0]?.isLeaf).toBe(true);
  });
});

describe('countThreadsByFile', () => {
  it('counts only open threads, since resolved ones need no attention', () => {
    expect(
      countThreadsByFile([
        thread('t1', 'a.ts'),
        thread('t2', 'a.ts'),
        thread('t3', 'a.ts', 'resolved'),
        thread('t4', 'b.ts', 'outdated'),
      ]),
    ).toEqual({ 'a.ts': 2 });
  });
});
