import { describe, expect, it } from 'vitest';
import { unifiedDiff } from './diff.ts';

const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${String(i + 1)}`);

describe('unifiedDiff', () => {
  it('is empty for the same text', () => {
    expect(unifiedDiff('a\nb\n', 'a\nb\n')).toBe('');
  });

  it('shows a one-line change with three lines of context', () => {
    const before = numbered(10).join('\n');
    const after = before.replace('line 5', 'line five');
    expect(unifiedDiff(before, after)).toBe(
      [
        '@@ -2,7 +2,7 @@',
        ' line 2',
        ' line 3',
        ' line 4',
        '-line 5',
        '+line five',
        ' line 6',
        ' line 7',
        ' line 8',
      ].join('\n'),
    );
  });

  it('keeps far-apart changes in separate hunks with the right line numbers', () => {
    const lines = numbered(30);
    const after = [...lines];
    after[1] = 'two';
    after.splice(25, 0, 'inserted');
    const diff = unifiedDiff(lines.join('\n'), after.join('\n'));
    const headers = diff.split('\n').filter((l) => l.startsWith('@@'));
    expect(headers).toEqual(['@@ -1,5 +1,5 @@', '@@ -23,6 +23,7 @@']);
    expect(diff).toContain('-line 2\n+two');
    expect(diff).toContain(' line 25\n+inserted\n line 26');
  });

  it('shows a new file as added lines, and a removed one as removed lines', () => {
    expect(unifiedDiff('', 'a\nb\n')).toBe('@@ -0,0 +1,2 @@\n+a\n+b');
    expect(unifiedDiff('a\nb\n', '')).toBe('@@ -1,2 +0,0 @@\n-a\n-b');
  });

  it('falls back to removed-then-added for a middle too large to diff', () => {
    const before = numbered(3000).join('\n');
    const after = numbered(3000)
      .map((l) => `${l}!`)
      .join('\n');
    const diff = unifiedDiff(before, after);
    expect(diff.split('\n').filter((l) => l.startsWith('-'))).toHaveLength(3000);
    expect(diff.split('\n').filter((l) => l.startsWith('+'))).toHaveLength(3000);
  });
});
