/**
 * `timestamp` is unix MILLISECONDS, assigned by the gateway. Chain clocks (Solana `Clock`,
 * EVM `block.timestamp`), epoch windows and `maxAge`/staleness are measured in SECONDS, so
 * anything that compares the two must go through {@link timestampSeconds}.
 */

/** `timestamp` (unix ms) as whole unix seconds, floored. */
export function timestampSeconds(timestamp: number | bigint): number {
  const ms = typeof timestamp === "bigint" ? timestamp : BigInt(timestamp);
  if (ms < 0n) throw new RangeError("timestamp must not be negative");
  return Number(ms / 1000n);
}

/**
 * Age in whole seconds of a timestamp against `nowSeconds`, saturating at 0 so a
 * timestamp slightly ahead of the local clock never goes negative.
 */
export function timestampAgeSeconds(
  timestamp: number | bigint,
  nowSeconds: number,
): number {
  return Math.max(0, nowSeconds - timestampSeconds(timestamp));
}
