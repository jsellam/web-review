import type { FileEntry, FileStatus, Thread } from '../../../../src/shared/types.js';

/**
 * One row of the sidebar tree. Deliberately not antd's `DataNode`: this module
 * stays pure and free of JSX, and `FileTree` turns these into nodes with a
 * rendered title. `status` is null for a directory, which has none.
 */
export interface FileTreeNode {
  key: string;
  name: string;
  isLeaf: boolean;
  status: FileStatus | null;
  count: number;
  children: FileTreeNode[];
}

interface MutableNode {
  key: string;
  name: string;
  isLeaf: boolean;
  status: FileStatus | null;
  children: Map<string, MutableNode>;
}

function emptyNode(key: string, name: string, isLeaf: boolean): MutableNode {
  return { key, name, isLeaf, status: null, children: new Map() };
}

/** Open threads only: resolved and outdated ones do not need the reviewer's attention. */
export function countThreadsByFile(threads: Thread[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const thread of threads) {
    if (thread.status !== 'open') continue;
    counts[thread.file] = (counts[thread.file] ?? 0) + 1;
  }
  return counts;
}

export function buildFileTree(
  files: FileEntry[],
  commentCounts: Record<string, number>,
): FileTreeNode[] {
  const root = emptyNode('', '', false);

  for (const file of files) {
    const segments = file.path.split('/');
    let node = root;
    let prefix = '';

    segments.forEach((segment, index) => {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      const isLeaf = index === segments.length - 1;
      const existing = node.children.get(prefix) ?? emptyNode(prefix, segment, isLeaf);
      if (isLeaf) existing.status = file.status;
      node.children.set(prefix, existing);
      node = existing;
    });
  }

  return freeze(root, commentCounts);
}

function freeze(node: MutableNode, counts: Record<string, number>): FileTreeNode[] {
  const children = [...node.children.values()].sort(compare);

  return children.map((child) => ({
    key: child.key,
    name: child.name,
    isLeaf: child.isLeaf,
    status: child.status,
    count: counts[child.key] ?? 0,
    children: child.isLeaf ? [] : freeze(child, counts),
  }));
}

/** Directories first, then files, each group alphabetical — the GitHub ordering. */
function compare(a: MutableNode, b: MutableNode): number {
  if (a.isLeaf !== b.isLeaf) return a.isLeaf ? 1 : -1;
  return a.name.localeCompare(b.name);
}
