/**
 * Minimal unified-diff generator.
 *
 * The agent proposes a fix as full replacement text; we turn that into a diff
 * here rather than asking the model to emit diff syntax directly, because
 * models get hunk headers and line counts wrong constantly. Computing the diff
 * ourselves means the line numbers in the UI are always correct.
 */

type Op = { kind: "equal" | "insert" | "delete"; line: string };

/** Longest-common-subsequence table over lines. Fine for files up to a few thousand lines. */
function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;

  // Guard against pathological inputs: the DP table is O(n*m).
  if (n * m > 4_000_000) {
    return [
      ...a.map((line) => ({ kind: "delete" as const, line })),
      ...b.map((line) => ({ kind: "insert" as const, line })),
    ];
  }

  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "equal", line: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ kind: "delete", line: a[i] });
      i++;
    } else {
      ops.push({ kind: "insert", line: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "delete", line: a[i++] });
  while (j < m) ops.push({ kind: "insert", line: b[j++] });

  return ops;
}

export function unifiedDiff(
  path: string,
  before: string,
  after: string,
  context = 3,
): string {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const ops = diffLines(a, b);

  if (!ops.some((op) => op.kind !== "equal")) return "";

  // Group ops into hunks separated by runs of >2*context equal lines.
  const changedIdx: number[] = [];
  ops.forEach((op, idx) => {
    if (op.kind !== "equal") changedIdx.push(idx);
  });

  const ranges: Array<[number, number]> = [];
  for (const idx of changedIdx) {
    const start = Math.max(0, idx - context);
    const end = Math.min(ops.length - 1, idx + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }

  const out: string[] = [`--- a/${path}`, `+++ b/${path}`];

  // Walk once, tracking original/new line numbers as we enter each hunk.
  let aLine = 1;
  let bLine = 1;
  const positions = ops.map((op) => {
    const pos = { a: aLine, b: bLine };
    if (op.kind === "equal") {
      aLine++;
      bLine++;
    } else if (op.kind === "delete") {
      aLine++;
    } else {
      bLine++;
    }
    return pos;
  });

  for (const [start, end] of ranges) {
    let aCount = 0;
    let bCount = 0;
    const body: string[] = [];

    for (let idx = start; idx <= end; idx++) {
      const op = ops[idx];
      if (op.kind === "equal") {
        body.push(` ${op.line}`);
        aCount++;
        bCount++;
      } else if (op.kind === "delete") {
        body.push(`-${op.line}`);
        aCount++;
      } else {
        body.push(`+${op.line}`);
        bCount++;
      }
    }

    const aStart = positions[start].a;
    const bStart = positions[start].b;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    out.push(...body);
  }

  return out.join("\n");
}

/** Apply a full-content replacement, returning the new text. Used after approval. */
export function applyReplacement(before: string, after: string): string {
  return after.endsWith("\n") || !before.endsWith("\n") ? after : `${after}\n`;
}
