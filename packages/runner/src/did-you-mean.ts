/** "Did you mean": the nearest real name to a typo. Shared by validate.ts, addons.ts and project.ts. */

/** Edit distance, for "did you mean". */
function distance(a: string, b: string): number {
  // optimal string alignment: insertions, deletions, substitutions and swapped neighbours ("chets") cost 1
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) =>
      i === 0 ? j : j === 0 ? i : 0,
    ),
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  return d[a.length]![b.length]!;
}

/** The candidate closest to `word` when it is close enough to be a typo of it (case and a mod prefix ignored). */
export function didYouMean(
  word: string,
  candidates: Iterable<string>,
): string | undefined {
  const norm = (s: string): string => s.toLowerCase().replace(/^[a-z_]+:/, "");
  const w = norm(word);
  let best: string | undefined;
  let bestScore = Infinity;
  for (const c of candidates) {
    if (c === word) return c;
    const d = Math.min(
      distance(w, norm(c)),
      distance(word.toLowerCase(), c.toLowerCase()),
    );
    if (d < bestScore) {
      bestScore = d;
      best = c;
    }
  }
  if (best === undefined) return undefined;
  const limit = Math.max(1, Math.min(3, Math.floor(w.length / 3)));
  return bestScore <= limit ? best : undefined;
}
