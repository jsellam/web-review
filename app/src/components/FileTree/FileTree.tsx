import { Tree } from 'antd';
import type { DataNode } from 'antd/es/tree';
import { buildFileTree, type FileTreeNode } from './tree.js';
import type { FileEntry, FileStatus } from '../../../../src/shared/types.js';
import styles from './FileTree.module.css';

/** The one-letter badge, VS Code's own letters — A, M, D, R. */
const LETTER: Record<FileStatus, string> = {
  added: 'a',
  modified: 'm',
  deleted: 'd',
  renamed: 'r',
};

interface Props {
  files: FileEntry[];
  commentCounts: Record<string, number>;
  onSelect(path: string): void;
}

function title(node: FileTreeNode) {
  const tone = node.status ? styles[node.status] : undefined;

  return (
    <span className={styles.row}>
      {/* `title` so the full path is still readable once the name ellipsizes. */}
      <span className={`${styles.name} ${tone ?? ''}`} title={node.key}>
        {node.name}
      </span>

      {node.count > 0 ? (
        <span
          className={styles.count}
          title={`${node.count} open comment${node.count === 1 ? '' : 's'}`}
        >
          {node.count}
        </span>
      ) : null}

      {/*
        Last, at the right edge, which is where VS Code puts it — and the only
        place it costs nothing. On the left it needed a column of its own, kept
        empty on every directory so names stayed aligned, and that empty column
        was most of the gap between a folder's expander and its name.
      */}
      {node.status ? (
        <span
          className={`${styles.badge} ${tone}`}
          title={node.status}
          aria-label={node.status}
          role="img"
        >
          {LETTER[node.status]}
        </span>
      ) : null}
    </span>
  );
}

function toDataNodes(nodes: FileTreeNode[]): DataNode[] {
  return nodes.map((node) => ({
    key: node.key,
    title: title(node),
    isLeaf: node.isLeaf,
    ...(node.isLeaf ? {} : { children: toDataNodes(node.children) }),
  }));
}

export function FileTree({ files, commentCounts, onSelect }: Props) {
  return (
    <Tree
      className={styles.tree}
      blockNode
      treeData={toDataNodes(buildFileTree(files, commentCounts))}
      defaultExpandAll
      selectable
      onSelect={(keys) => {
        const key = String(keys[0] ?? '');
        if (files.some((file) => file.path === key)) onSelect(key);
      }}
    />
  );
}
