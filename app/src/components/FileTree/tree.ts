import type { DataNode } from 'antd/es/tree';
import type { FileEntry, Thread } from '../../../../src/shared/types.js';

interface MutableNode {
  key: string;
  title: string;
  isLeaf: boolean;
  children: Map<string, MutableNode>;
}

function emptyNode(key: string, title: string, isLeaf: boolean): MutableNode {
  return { key, title, isLeaf, children: new Map() };
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
): DataNode[] {
  const root = emptyNode('', '', false);

  for (const file of files) {
    const segments = file.path.split('/');
    let node = root;
    let prefix = '';

    segments.forEach((segment, index) => {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      const isLeaf = index === segments.length - 1;
      const existing = node.children.get(prefix) ?? emptyNode(prefix, segment, isLeaf);
      node.children.set(prefix, existing);
      node = existing;
    });
  }

  return toDataNodes(root, commentCounts);
}

function toDataNodes(node: MutableNode, counts: Record<string, number>): DataNode[] {
  const children = [...node.children.values()].sort(compare);

  return children.map((child) => {
    const count = counts[child.key] ?? 0;
    return {
      key: child.key,
      title: count > 0 ? `${child.title} (${count})` : child.title,
      isLeaf: child.isLeaf,
      ...(child.isLeaf ? {} : { children: toDataNodes(child, counts) }),
    } satisfies DataNode;
  });
}

/** Directories first, then files, each group alphabetical — the GitHub ordering. */
function compare(a: MutableNode, b: MutableNode): number {
  if (a.isLeaf !== b.isLeaf) return a.isLeaf ? 1 : -1;
  return a.title.localeCompare(b.title);
}
