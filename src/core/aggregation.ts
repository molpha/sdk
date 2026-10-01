/**
 * Aggregation (tolerance mode) config validation and canonicalization.
 *
 * `aggregation` is part of the API config and therefore part of `sourceId`. It is OMITTED
 * for exact mode: a config carrying `mode: "exact"` would hash differently from the same
 * config without the key, so it is rejected rather than silently normalized. The node
 * (`new/tolerance.Validate`) is the reference.
 */
import type { AggregationConfig } from "./types.js";

/** Tolerance mode needs at least this many signers (`signaturesRequired >= 3`). */
export const MIN_TOLERANCE_SIGNATURES = 3;

const MAX_U32 = 0xffffffff;
const MAX_U8 = 0xff;

/** Thrown for an unusable `aggregation` config. */
export class AggregationConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AggregationConfigError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate an `aggregation` config and return a fresh object with the canonical key order
 * (`mode`, `rule`, `maxDeviationBps`, `maxAgeMs`, `numeric{type, decimals}`) — the order
 * the source hash and the node's JSON blob use.
 *
 * The result is built field by field: unknown or reordered keys on the input can never
 * reach the hash or the wire. `undefined` / `null` mean exact mode and return `undefined`.
 *
 * @throws {AggregationConfigError} on `mode: "exact"`, an unsupported mode / rule / numeric
 *   type, or an out-of-range number.
 */
export function canonicalizeAggregation(
  aggregation: AggregationConfig | null | undefined,
): AggregationConfig | undefined {
  if (aggregation === undefined || aggregation === null) return undefined;
  if (!isRecord(aggregation)) {
    throw new AggregationConfigError("aggregation must be an object");
  }

  const { mode, rule, maxDeviationBps, maxAgeMs, numeric } = aggregation as unknown as Record<
    string,
    unknown
  >;

  if (mode === "exact") {
    throw new AggregationConfigError(
      'aggregation.mode "exact" is not accepted: omit `aggregation` for exact mode (adding it would change the sourceId)',
    );
  }
  if (mode !== "tolerance") {
    throw new AggregationConfigError(
      `unsupported aggregation.mode ${JSON.stringify(mode)}: only "tolerance" is supported`,
    );
  }
  if (rule !== "median") {
    throw new AggregationConfigError(
      `unsupported aggregation.rule ${JSON.stringify(rule)}: only "median" is supported`,
    );
  }
  if (
    typeof maxDeviationBps !== "number" ||
    !Number.isInteger(maxDeviationBps) ||
    maxDeviationBps < 0 ||
    maxDeviationBps > MAX_U32
  ) {
    throw new AggregationConfigError(
      `aggregation.maxDeviationBps must be an integer in 0..${MAX_U32}, got ${String(maxDeviationBps)}`,
    );
  }
  if (typeof maxAgeMs !== "number" || !Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) {
    throw new AggregationConfigError(
      `aggregation.maxAgeMs must be a positive safe integer (milliseconds), got ${String(maxAgeMs)}`,
    );
  }
  if (!isRecord(numeric)) {
    throw new AggregationConfigError("aggregation.numeric must be an object");
  }
  if (numeric.type !== "int256") {
    throw new AggregationConfigError(
      `unsupported aggregation.numeric.type ${JSON.stringify(numeric.type)}: only "int256" is supported`,
    );
  }
  const decimals = numeric.decimals;
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > MAX_U8) {
    throw new AggregationConfigError(
      `aggregation.numeric.decimals must be an integer in 0..${MAX_U8}, got ${String(decimals)}`,
    );
  }

  return {
    mode: "tolerance",
    rule: "median",
    maxDeviationBps,
    maxAgeMs,
    numeric: { type: "int256", decimals },
  };
}

/**
 * Tolerance mode needs `signaturesRequired >= 3`; the node rejects anything lower.
 * A no-op for exact mode (`aggregation` omitted).
 *
 * @throws {AggregationConfigError}
 */
export function assertAggregationQuorum(
  aggregation: AggregationConfig | null | undefined,
  signaturesRequired: number,
): void {
  if (aggregation === undefined || aggregation === null) return;
  if (signaturesRequired < MIN_TOLERANCE_SIGNATURES) {
    throw new AggregationConfigError(
      `tolerance aggregation requires signaturesRequired >= ${MIN_TOLERANCE_SIGNATURES}, got ${signaturesRequired}`,
    );
  }
}
