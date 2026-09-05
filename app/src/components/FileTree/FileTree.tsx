import { Tree } from 'antd';
import { buildFileTree } from './tree.js';
import type { FileEntry } from '../../../../src/shared/types.js';

interface Props {
  files: FileEntry[];
  commentCounts: Record<string, number>;
  onSelect(path: string): void;
}

export function FileTree({ files, commentCounts, onSelect }: Props) {
  return (
    <Tree
      treeData={buildFileTree(files, commentCounts)}
      defaultExpandAll
      selectable
      onSelect={(keys) => {
        const key = String(keys[0] ?? '');
        if (files.some((file) => file.path === key)) onSelect(key);
      }}
    />
  );
}
