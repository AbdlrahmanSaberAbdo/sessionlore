/**
 * A unified diff of two texts, line by line, the way `diff -u` prints it.
 * Files habitlore changes are small, so a plain longest-common-subsequence
 * table is fast enough.
 */

const CONTEXT = 3;

type Op = { kind: " " | "-" | "+"; line: string };

/** `before` null means the file doesn't exist yet. Returns "" when nothing changes. */
export function unifiedDiff(path: string, before: string | null, after: string): string {
  const a = splitLines(before ?? "");
  const b = splitLines(after);
  const ops = diffLines(a, b);
  if (ops.every((op) => op.kind === " ")) return "";

  const hunks: string[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i]!.kind === " ") {
      i++;
      continue;
    }
    // A hunk runs from CONTEXT lines before a change to CONTEXT lines after the last change near it.
    const start = Math.max(0, i - CONTEXT);
    let end = i;
    let lastChange = i;
    while (end < ops.length && end - lastChange <= CONTEXT * 2) {
      if (ops[end]!.kind !== " ") lastChange = end;
      end++;
    }
    end = Math.min(ops.length, lastChange + CONTEXT + 1);
    const slice = ops.slice(start, end);
    const oldStart = ops.slice(0, start).filter((op) => op.kind !== "+").length;
    const newStart = ops.slice(0, start).filter((op) => op.kind !== "-").length;
    const oldCount = slice.filter((op) => op.kind !== "+").length;
    const newCount = slice.filter((op) => op.kind !== "-").length;
    hunks.push(
      `@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@\n` + slice.map((op) => `${op.kind}${op.line}\n`).join(""),
    );
    i = end;
  }
  return `--- ${before === null ? "/dev/null" : path}\n+++ ${path}\n${hunks.join("")}`;
}

function range(start: number, count: number): string {
  return `${count === 0 ? start : start + 1},${count}`;
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function diffLines(a: readonly string[], b: readonly string[]): Op[] {
  // lcs[i][j]: length of the longest common subsequence of a[i..] and b[j..].
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", line: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ kind: "-", line: a[i++]! });
    } else {
      ops.push({ kind: "+", line: b[j++]! });
    }
  }
  while (i < a.length) ops.push({ kind: "-", line: a[i++]! });
  while (j < b.length) ops.push({ kind: "+", line: b[j++]! });
  return ops;
}
