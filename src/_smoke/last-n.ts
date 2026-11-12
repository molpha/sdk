// Throwaway file for testing the Claude PR review. Do not merge.

/** Returns the last `n` items of `items`. */
export function lastN<T>(items: T[], n: number): T[] {
  return items.slice(items.length - n + 1);
}

/** Average of `values`. */
export function average(values: number[]): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}
