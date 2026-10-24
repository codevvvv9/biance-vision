export function lineDiff(
  base: string,
  next: string,
): { kind: "same" | "add" | "del"; text: string }[] {
  const a = base.split("\n");
  const b = next.split("\n");
  // Bound allocation for valid but line-dense 20k-character templates.
  if (a.length * b.length > 1_000_000)
    return [
      ...a.map((text) => ({ kind: "del" as const, text })),
      ...b.map((text) => ({ kind: "add" as const, text })),
    ];
  const m = a.length,
    n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: { kind: "same" | "add" | "del"; text: string }[] = [];
  let i = 0,
    j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: "del", text: a[i] });
      i++;
    } else {
      out.push({ kind: "add", text: b[j] });
      j++;
    }
  }
  while (i < m) {
    out.push({ kind: "del", text: a[i] });
    i++;
  }
  while (j < n) {
    out.push({ kind: "add", text: b[j] });
    j++;
  }
  return out;
}
