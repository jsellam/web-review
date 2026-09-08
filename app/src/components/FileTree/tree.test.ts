import { describe, expect, it } from 'vitest';
import { buildFileTree, countThreadsByFile } from './tree.js';
import type { FileEntry, Thread } from '../../../../src/shared/types.js';

const file = (path: string, status: FileEntry['status'] = 'modified'): FileEntry => ({
  path,
  oldPath: path,
  status,
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

  it('names each node by its own segment, not by the whole path', () => {
    const nodes = buildFileTree([file('src/deep/b.ts')], {});

    expect(nodes[0]?.name).toBe('src');
    expect(nodes[0]?.children[0]?.children[0]?.name).toBe('b.ts');
  });

  it('carries each file status through to its leaf, and none to a directory', () => {
    const nodes = buildFileTree([file('src/gone.ts', 'deleted'), file('new.ts', 'added')], {});

    expect(nodes[0]?.status).toBeNull();
    expect(nodes[0]?.children[0]?.status).toBe('deleted');
    expect(nodes[1]?.status).toBe('added');
  });

  it('puts the comment count on the node rather than in its name', () => {
    const nodes = buildFileTree([file('a.ts')], { 'a.ts': 3 });

    expect(nodes[0]?.name).toBe('a.ts');
    expect(nodes[0]?.count).toBe(3);
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
