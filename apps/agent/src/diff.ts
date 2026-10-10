/**
 * A unified diff of two texts, for change previews. Common leading and trailing lines are
 * trimmed first (most edits are small), then the middle is diffed by longest common
 * subsequence. A middle too large to diff is shown as removed, then added.
 */

type Op = { kind: ' ' | '-' | '+'; line: string };

const MAX_CELLS = 4_000_000;

function lines(text: string): string[] {
  if (text === '') return [];
  const out = text.split('\n');
  if (out.at(-1) === '') out.pop();
  return out;
}

function middleOps(a: readonly string[], b: readonly string[]): Op[] {
  if (a.length * b.length > MAX_CELLS) {
    return [
      ...a.map((line) => ({ kind: '-' as const, line })),
      ...b.map((line) => ({ kind: '+' as const, line })),
    ];
  }
  // lcs[i][j]: the longest common subsequence of a[i..] and b[j..].
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i] ?? '' });
      i++;
      j++;
    } else if ((lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0)) {
      ops.push({ kind: '-', line: a[i] ?? '' });
      i++;
    } else {
      ops.push({ kind: '+', line: b[j] ?? '' });
      j++;
    }
  }
  while (i < a.length) ops.push({ kind: '-', line: a[i++] ?? '' });
  while (j < b.length) ops.push({ kind: '+', line: b[j++] ?? '' });
  return ops;
}

/** The hunks of a unified diff (no file headers), or '' when the texts are the same. */
export function unifiedDiff(before: string, after: string, context = 3): string {
  const a = lines(before);
  const b = lines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  if (start === endA && start === endB) return '';

  const ops: Op[] = [
    ...a.slice(0, start).map((line) => ({ kind: ' ' as const, line })),
    ...middleOps(a.slice(start, endA), b.slice(start, endB)),
    ...a.slice(endA).map((line) => ({ kind: ' ' as const, line })),
  ];

  // Group changes with `context` lines around them into hunks.
  const out: string[] = [];
  let k = 0;
  let lineA = 1;
  let lineB = 1;
  while (k < ops.length) {
    const firstChange = ops.findIndex((op, idx) => idx >= k && op.kind !== ' ');
    if (firstChange === -1) break;
    const from = Math.max(k, firstChange - context);
    for (let s = k; s < from; s++) {
      lineA++;
      lineB++;
    }
    let to = firstChange;
    let quiet = 0;
    while (to < ops.length && quiet <= context * 2) {
      quiet = ops[to]?.kind === ' ' ? quiet + 1 : 0;
      to++;
    }
    const end = Math.min(ops.length, to - Math.max(0, quiet - context));
    const hunk = ops.slice(from, end);
    const countA = hunk.filter((op) => op.kind !== '+').length;
    const countB = hunk.filter((op) => op.kind !== '-').length;
    out.push(
      `@@ -${String(countA === 0 ? lineA - 1 : lineA)},${String(countA)} +${String(countB === 0 ? lineB - 1 : lineB)},${String(countB)} @@`,
    );
    for (const op of hunk) out.push(`${op.kind}${op.line}`);
    lineA += countA;
    lineB += countB;
    k = end;
  }
  return out.join('\n');
}
