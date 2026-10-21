export type DiffLine = { op: "same" | "add" | "del"; line: string };

/** Line diff by longest common subsequence. Rule definitions are small (a few hundred lines at most). */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: "same", line: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ op: "del", line: a[i++]! });
    else out.push({ op: "add", line: b[j++]! });
  }
  while (i < a.length) out.push({ op: "del", line: a[i++]! });
  while (j < b.length) out.push({ op: "add", line: b[j++]! });
  return out;
}
