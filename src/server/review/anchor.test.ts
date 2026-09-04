import { describe, expect, it } from 'vitest';
import { contextHash, makeAnchor, relocate, splitLines } from './anchor.js';

const file = (...lines: string[]) => lines;

describe('splitLines', () => {
  it('drops the empty element a trailing newline produces', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
  });

  it('keeps a final line with no newline', () => {
    expect(splitLines('a\nb')).toEqual(['a', 'b']);
  });

  it('returns an empty array for empty content', () => {
    expect(splitLines('')).toEqual([]);
  });
});

describe('contextHash', () => {
  it('ignores indentation changes around the anchored line', () => {
    const a = contextHash(file('before', '  const x = 1;', 'after'), 1);
    const b = contextHash(file('before', '      const x = 1;', 'after'), 1);

    expect(a).toBe(b);
  });

  it('differs when a neighbour changes', () => {
    const a = contextHash(file('before', 'const x = 1;', 'after'), 1);
    const b = contextHash(file('different', 'const x = 1;', 'after'), 1);

    expect(a).not.toBe(b);
  });

  it('handles the first and last line without running off the array', () => {
    const lines = file('only');

    expect(contextHash(lines, 0)).toHaveLength(12);
  });
});

describe('makeAnchor', () => {
  it('records the 1-based line, its exact content and a context hash', () => {
    const lines = file('a', 'const t = sign(u);', 'c');

    expect(makeAnchor(lines, 2)).toEqual({
      line: 2,
      content: 'const t = sign(u);',
      contextHash: contextHash(lines, 1),
    });
  });

  it('throws when the line is out of range', () => {
    expect(() => makeAnchor(file('a'), 5)).toThrow(/line 5 is out of range/i);
  });
});

describe('relocate', () => {
  const lines = file('one', 'two', 'const t = sign(u);', 'four', 'five');
  const anchor = makeAnchor(lines, 3);

  it('reports unchanged when the line is still where it was', () => {
    expect(relocate(anchor, lines)).toEqual({ line: 3, status: 'unchanged' });
  });

  it('follows the line when it shifts within the search window', () => {
    const shifted = file('new', 'lines', 'one', 'two', 'const t = sign(u);', 'four');

    expect(relocate(anchor, shifted)).toEqual({ line: 5, status: 'moved' });
  });

  it('picks the nearest match when the line shifts and appears twice', () => {
    const shifted = file(
      'const t = sign(u);',
      'one',
      'two',
      'x',
      'const t = sign(u);',
      'four',
    );

    expect(relocate(anchor, shifted)).toEqual({ line: 5, status: 'moved' });
  });

  it('finds the line far outside the window when it is unique', () => {
    const far = [...Array.from({ length: 200 }, (_, i) => `filler ${i}`), 'const t = sign(u);'];

    expect(relocate(anchor, far)).toEqual({ line: 201, status: 'moved' });
  });

  it('disambiguates far duplicates using the context hash', () => {
    const far = [
      ...Array.from({ length: 100 }, (_, i) => `filler ${i}`),
      'const t = sign(u);',
      ...Array.from({ length: 100 }, (_, i) => `more ${i}`),
      'two',
      'const t = sign(u);',
      'four',
    ];

    expect(relocate(anchor, far)).toEqual({ line: 203, status: 'moved' });
  });

  it('goes outdated when the line is gone', () => {
    expect(relocate(anchor, file('one', 'two', 'four'))).toEqual({
      line: null,
      status: 'outdated',
    });
  });

  it('goes outdated when far duplicates cannot be told apart', () => {
    const ambiguous = [
      ...Array.from({ length: 100 }, (_, i) => `filler ${i}`),
      'const t = sign(u);',
      ...Array.from({ length: 100 }, (_, i) => `more ${i}`),
      'const t = sign(u);',
    ];

    expect(relocate(anchor, ambiguous)).toEqual({ line: null, status: 'outdated' });
  });

  it('goes outdated against an empty file', () => {
    expect(relocate(anchor, [])).toEqual({ line: null, status: 'outdated' });
  });
});
