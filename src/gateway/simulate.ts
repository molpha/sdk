/**
 * `POST /v1/source/simulate` (gateway docs/simulate.md): a source evaluated over inputs the caller
 * supplies, with the nodes' own evaluator. Nothing is fetched, signed or charged, so a source's logic,
 * a policy's fallback included, can be checked against any data, a failure included.
 */

import { deriveSourceIdHex } from "../core/source.js";

/** One decoded field of an input. */
export interface SimulatedField {
  type: "decimal" | "string" | "bool" | "bytes" | "null";
  value: string;
}

/**
 * What one input returned, exactly one of:
 *  - `body`: an http response body, decoded with the source's own decode block (`bodyHex` for hex);
 *  - `fields`: the decoded fields; a chain input also gives the `block` (or slot) it was read at;
 *  - `error`: the input failed (`fetch`) or did not decode (`decode`).
 */
export type SimulatedInput =
  | { body: string; bodyHex?: boolean }
  | { fields: Record<string, SimulatedField>; block?: number }
  | { error: "fetch" | "decode" };

export interface SimulateOptions {
  /** The round timestamp to evaluate at (unix ms on the 100 ms grid); the gateway's clock when absent. */
  timestampMs?: number;
  /** Abort after this many ms. */
  timeoutMs?: number;
  /** A fetch implementation (tests, older runtimes). */
  fetch?: typeof fetch;
}

/** A policy's outcome on the simulated inputs (node-client docs/policy.md). */
export interface SimulatedPolicy {
  candidates: {
    name: string;
    qualified: boolean;
    /** Index of the first rule that was false. */
    rule?: number;
    /** `fetch` or `eval` when an error disqualified the candidate. */
    error?: "fetch" | "eval";
    errorMessage?: string;
    value?: string;
  }[];
  n: number;
  agg?: string;
  /** Absent when the policy refused before reaching an outcome. */
  outcome?: "conclusive" | "inconclusive";
  reason?: string;
  /** The outcome was inconclusive and the policy's fallback is `value`. */
  signed: boolean;
}

export interface SimulationResult {
  /** keccak256 of the canonical source, hex without 0x; checked against the source that was sent. */
  sourceId: string;
  /** The round timestamp the source was evaluated at (unix ms); absent from older gateways. */
  timestampMs?: number;
  /** The source in canonical form. */
  source: unknown;
  inputs: {
    name: string;
    kind: "http" | "evm" | "starknet" | "svm";
    block?: number;
    error?: "fetch" | "decode";
    fields: { name: string; type: SimulatedField["type"]; value: string }[];
  }[];
  /** What nodes would sign over these inputs; absent when the source refused. */
  value?: { encoded: string; display: string; type: string; decimals: number; preimage?: string };
  /** Where the source refused; absent when it gave a value. */
  error?: { stage: string; input?: string; message: string };
  policy?: SimulatedPolicy;
}

/** A refusal of the simulation itself: a malformed request (400), a private source (422), a limit (429, 503). */
export class SimulateError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The gateway's `Retry-After`, in ms, for 429 and 503. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "SimulateError";
  }
}

/**
 * Evaluates `source` over `inputs` on a gateway, without fetching or signing anything. `source` is a
 * source document (as built by `defineSource`, or a parsed source's `doc`); `inputs` gives what every
 * one of its inputs returned. A source that refuses at a stage resolves with `error`, not a rejection.
 *
 * ```ts
 * const sim = await simulateSource(gatewayUrl, source, {
 *   venueA: { body: '{"price": 65000.12}' },
 *   venueB: { error: "fetch" },
 * });
 * sim.policy?.outcome; // "inconclusive" when one venue is not enough
 * ```
 */
export async function simulateSource(
  gatewayUrl: string,
  source: unknown,
  inputs: Record<string, SimulatedInput>,
  opts: SimulateOptions = {},
): Promise<SimulationResult> {
  // A source that does not parse is still sent: the gateway's 400 says why.
  let sentId = "";
  try {
    sentId = deriveSourceIdHex(source as object);
  } catch {
    sentId = "";
  }
  const doFetch = opts.fetch ?? fetch;
  const controller = opts.timeoutMs !== undefined ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), opts.timeoutMs) : undefined;
  try {
    const res = await doFetch(`${gatewayUrl.replace(/\/+$/, "")}/v1/source/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source,
        inputs,
        ...(opts.timestampMs !== undefined ? { timestampMs: opts.timestampMs } : {}),
      }),
      ...(controller ? { signal: controller.signal } : {}),
    });
    const body = (await res.json().catch(() => undefined)) as
      | { status?: string; data?: SimulationResult; error?: string; message?: string }
      | undefined;
    if (!res.ok) {
      const retry = Number(res.headers.get("Retry-After"));
      throw new SimulateError(
        body?.error ?? body?.message ?? `POST /v1/source/simulate failed (${res.status})`,
        res.status,
        Number.isFinite(retry) && retry > 0 ? retry * 1000 : undefined,
      );
    }
    if (!body?.data || typeof body.data.sourceId !== "string" || !Array.isArray(body.data.inputs)) {
      throw new SimulateError("POST /v1/source/simulate answered without a simulation", res.status);
    }
    // The answer must be about the source that was sent, not another one the gateway evaluated.
    const strip = (h: string) => (h.startsWith("0x") ? h.slice(2) : h).toLowerCase();
    if (sentId === "") {
      throw new SimulateError("this SDK cannot derive the sent source's ID, so the simulation cannot be checked", res.status);
    }
    if (strip(body.data.sourceId) !== strip(sentId)) {
      throw new SimulateError(
        `POST /v1/source/simulate answered for source ${body.data.sourceId}, not the source sent (${strip(sentId)})`,
        res.status,
      );
    }
    return body.data;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
