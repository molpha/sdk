/**
 * `timestamp` is unix MILLISECONDS, assigned by the gateway. Chain clocks (Solana `Clock`,
 * EVM `block.timestamp`), epoch windows and `maxAge`/staleness are measured in SECONDS, so
 * anything that compares the two must go through {@link timestampSeconds}.
 */

/**
 * The round tick in milliseconds: the gateway stamps a round with its clock floored to this grid
 * (`floor(nowMs / ROUND_TICK_MS) * ROUND_TICK_MS`) and nodes reject a round whose timestamp is off
 * it. A feed (source, quorum, registry version) therefore runs at most ten rounds per second, and
 * every selection window (`SELECTION_WINDOW_MS`, one second) holds exactly ten ticks. A
 * protocol constant, the same in every gateway and node: not configuration, and not reported by
 * `GET /v1/info`.
 */
export const ROUND_TICK_MS = 100;

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
