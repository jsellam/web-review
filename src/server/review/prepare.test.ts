import { describe, expect, it } from 'vitest';
import type { NumberedLine } from '../git/diff.js';
import type { FileEntry } from '../../shared/types.js';
import {
  PER_FILE_LIMIT,
  TOTAL_LIMIT,
  isTooLarge,
  renderPrepare,
  wholeFileAsAdditions,
  type PreparedFile,
} from './prepare.js';

function entry(over: Partial<FileEntry> = {}): FileEntry {
  return {
    path: 'src/cli.ts',
    oldPath: 'src/cli.ts',
    status: 'modified',
    additions: 2,
    deletions: 1,
    binary: false,
    ...over,
  };
}

const HEADER = { base: 'HEAD', label: 'working tree vs HEAD' };

const SAMPLE: NumberedLine[] = [
  { kind: 'hunk', old: null, new: null, text: '@@ -44,4 +44,5 @@' },
  { kind: 'context', old: 44, new: 44, text: 'port: number;' },
  { kind: 'del', old: 46, new: null, text: 'stop: boolean;' },
  { kind: 'add', old: null, new: 46, text: 'stop: boolean;' },
  { kind: 'context', old: 47, new: 48, text: 'serveInternal: boolean;' },
];

function body(lines: NumberedLine[], n = 1): NumberedLine[] {
  return Array.from({ length: n }, (_, i) => lines[i % lines.length]!);
}

describe('renderPrepare', () => {
  it('renders two number columns, the marker, and the line verbatim', () => {
    const out = renderPrepare(HEADER, [{ entry: entry(), lines: SAMPLE }]);

    expect(out).toBe(
      [
        'range: working tree vs HEAD (base HEAD)',
        '1 file changed',
        '',
        '  old  new',
        '== src/cli.ts  modified  +2 -1',
        '@@ -44,4 +44,5 @@',
        '   44   44    port: number;',
        '   46    .  - stop: boolean;',
        '    .   46  + stop: boolean;',
        '   47   48    serveInternal: boolean;',
        '',
      ].join('\n'),
    );
  });

  it('shortens a full sha in the range line but leaves a symbolic ref alone', () => {
    const sha = '3f2a1c9b8e7d6c5b4a3928170615243342516273';
    expect(
      renderPrepare({ base: sha, label: 'branch vs main' }, [{ entry: entry(), lines: SAMPLE }]),
    ).toContain('range: branch vs main (base 3f2a1c9)');
  });

  it('names the old path of a rename in the header', () => {
    const out = renderPrepare(HEADER, [
      { entry: entry({ path: 'src/new.ts', oldPath: 'src/old.ts', status: 'renamed' }), lines: SAMPLE },
    ]);
    expect(out).toContain('== src/new.ts  renamed from src/old.ts  +2 -1');
  });

  it('shows a binary file as a header only and says so', () => {
    const out = renderPrepare(HEADER, [
      { entry: entry({ path: 'logo.png', binary: true, additions: 0, deletions: 0 }), lines: null },
    ]);
    expect(out).toContain('== logo.png  modified  binary — not shown');
    expect(out).not.toContain('@@');
  });

  it('truncates an oversized file and announces it instead of dropping it silently', () => {
    const out = renderPrepare(HEADER, [
      { entry: entry({ path: 'dist/index.js', additions: 4200, deletions: 3800 }), lines: null },
    ]);
    expect(out).toContain(
      '== dist/index.js  modified  +4200 -3800  — too large, truncated; read the file yourself if you need it',
    );
  });

  it('truncates a file whose context lines push it over the per-file bound', () => {
    const out = renderPrepare(HEADER, [
      { entry: entry({ additions: 1, deletions: 0 }), lines: body(SAMPLE, PER_FILE_LIMIT + 1) },
    ]);
    expect(out).toContain('— too large, truncated');
    expect(out).not.toContain('@@');
  });

  it('omits the files that no longer fit the total bound, naming each one', () => {
    const big = Math.floor(TOTAL_LIMIT / PER_FILE_LIMIT) + 1;
    const files: PreparedFile[] = Array.from({ length: big + 1 }, (_, i) => ({
      entry: entry({ path: `src/f${i}.ts` }),
      lines: body(SAMPLE, PER_FILE_LIMIT),
    }));

    const out = renderPrepare(HEADER, files);
    expect(out).toContain(`== src/f${big}.ts  modified  +2 -1  — omitted, output limit reached`);
    expect(out).toContain('== src/f0.ts  modified  +2 -1\n@@');
  });

  it('pluralises the file count', () => {
    const two = renderPrepare(HEADER, [
      { entry: entry({ path: 'a.ts' }), lines: SAMPLE },
      { entry: entry({ path: 'b.ts' }), lines: SAMPLE },
    ]);
    expect(two).toContain('2 files changed');
  });
});

describe('isTooLarge', () => {
  it('is the sum of both sides against the per-file bound', () => {
    expect(isTooLarge(entry({ additions: PER_FILE_LIMIT, deletions: 0 }))).toBe(false);
    expect(isTooLarge(entry({ additions: PER_FILE_LIMIT, deletions: 1 }))).toBe(true);
  });
});

describe('wholeFileAsAdditions', () => {
  it('numbers an untracked file from 1', () => {
    expect(wholeFileAsAdditions('a\nb\n')).toEqual([
      { kind: 'add', old: null, new: 1, text: 'a' },
      { kind: 'add', old: null, new: 2, text: 'b' },
    ]);
  });

  it('returns nothing for an empty file', () => {
    expect(wholeFileAsAdditions('')).toEqual([]);
  });
});
