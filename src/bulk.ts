/**
 * Drive many feeds through the gateway (and optionally on to Solana) without overloading it.
 *
 * The consumer is the party that pushes updates and pays for them, so the cost and the burst
 * behaviour of a large set of feeds is the consumer's to control. {@link requestMany} does the parts
 * that matter at volume:
 *
 *  - the registry inputs are read once and shared by every request, not once per feed;
 *  - concurrency is bounded and adapts: it starts from the gateway's advertised capacity, halves
 *    when the gateway answers busy (503/429) and creeps back up while requests succeed (AIMD);
 *  - request starts are spread over a window by a hash of each feed's source id, so feeds that fall
 *    due together do not arrive together, and the same feed always lands at the same offset;
 *  - submitting to Solana runs on its own, smaller limiter, pipelined behind the requests;
 *  - a failed submit never discards the signed attestation the gateway returned (and quota paid for).
 *
 * Each request still has the single-request retry policy (backoff with jitter, `Retry-After`, a stale
 * registry refreshed once; see {@link retryDelayMs}).
 */
import type { Address } from "@solana/kit";
import type { APIConfig, Attestation } from "./core/types.js";
import { deriveSourceIdString } from "./core/apiconfig.js";
import { GatewayError, type RequestSignedDataOptions } from "./gateway/index.js";
import type { MolphaSDK } from "./index.js";

/** One feed to update. */
export interface BulkFeed {
  apiConfig: APIConfig;
  signaturesRequired: number;
  /** Echoed in the result; for the caller's own bookkeeping. */
  label?: string;
}

export interface BulkOptions {
  /**
   * Most gateway requests in flight. The limit adapts below this ceiling. Default: half the gateway's
   * advertised `maxInflightRounds` (at most 64), or 32 when it advertises none.
   */
  concurrency?: number;
  /**
   * Spread request starts over this many ms by a hash of the feed's source id. Feeds that are due on
   * the same tick otherwise arrive together and queue at the gateway. Default 0 (no spreading).
   */
  spreadMs?: number;
  /** Submit each attestation to Solana after its round. Default true. */
  submit?: boolean;
  /** Most Solana submits in flight. Default 8. */
  submitConcurrency?: number;
  /**
   * Options applied to every request (subscription owner, signer, `maxRetries`, `timeoutMs`, ...).
   * `apiConfig`, `signaturesRequired` and `context` are set per feed.
   */
  request?: Omit<RequestSignedDataOptions, "apiConfig" | "signaturesRequired" | "context">;
  /** Called as each feed finishes, in completion order. */
  onResult?: (result: BulkResult) => void;
  /** Stops starting new feeds; those already started finish. */
  signal?: AbortSignal;
}

export interface BulkResult {
  /** Position in the input array. */
  index: number;
  label?: string;
  /** The gateway round succeeded (submitting is reported separately in `submitError`). */
  ok: boolean;
  /** The signed attestation, whenever the round succeeded, including when the submit failed. */
  attestation?: Attestation;
  /** Transaction signature and feed account, when submitted. */
  signature?: string;
  feedAddress?: Address;
  /** Why the round failed. */
  error?: unknown;
  /** Why submitting failed after a successful round; `attestation` is still valid. */
  submitError?: unknown;
}

const DEFAULT_CONCURRENCY = 32;
const MAX_DEFAULT_CONCURRENCY = 64;
const DEFAULT_SUBMIT_CONCURRENCY = 8;
/** Shortest interval between two halvings, so a burst of busy answers cuts the limit once, not to 1. */
const BACKOFF_COOLDOWN_MS = 1_000;

/**
 * An adaptive concurrency limit: additive increase on success, multiplicative decrease on a busy
 * answer. Waiters are served in arrival order.
 */
export class AdaptiveLimiter {
  private limit_: number;
  private inFlight = 0;
  private successes = 0;
  private lastCut = -Infinity;
  private readonly waiters: Array<() => void> = [];

  constructor(
    initial: number,
    private readonly max: number,
    private readonly now: () => number = Date.now,
  ) {
    this.max = Math.max(1, max);
    this.limit_ = Math.min(Math.max(1, Math.floor(initial)), this.max);
  }

  get limit(): number {
    return this.limit_;
  }

  async acquire(): Promise<void> {
    if (this.inFlight < this.limit_) {
      this.inFlight++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  /** Release a slot. `busy` reports that the gateway answered at capacity. */
  release(outcome: "ok" | "busy" | "other"): void {
    this.inFlight--;
    if (outcome === "busy") {
      this.successes = 0;
      const t = this.now();
      if (t - this.lastCut >= BACKOFF_COOLDOWN_MS) {
        this.limit_ = Math.max(1, Math.floor(this.limit_ / 2));
        this.lastCut = t;
      }
    } else if (outcome === "ok") {
      // One more slot after a full window of successes at the current limit.
      if (++this.successes >= this.limit_ && this.limit_ < this.max) {
        this.limit_++;
        this.successes = 0;
      }
    }
    while (this.waiters.length > 0 && this.inFlight < this.limit_) {
      this.inFlight++;
      this.waiters.shift()!();
    }
  }
}

/** Deterministic start offset for a feed: the same source id always lands at the same point. */
export function spreadOffsetMs(sourceIdHex: string, spreadMs: number): number {
  if (spreadMs <= 0) return 0;
  return Number.parseInt(sourceIdHex.slice(0, 8), 16) % spreadMs;
}

const isBusy = (err: unknown): boolean =>
  err instanceof GatewayError && (err.status === 503 || err.status === 429);

/**
 * Update many feeds. Results are returned in input order; a feed that fails does not stop the others.
 */
export async function requestMany(
  sdk: MolphaSDK,
  feeds: BulkFeed[],
  opts: BulkOptions = {},
): Promise<BulkResult[]> {
  const results = new Array<BulkResult>(feeds.length);
  if (feeds.length === 0) return results;

  // What the gateway advertises is advisory; an old gateway without it just gets the default.
  const advertised = await sdk.gateway
    .fetchGatewayInfo(sdkFirstEndpoint(sdk))
    .catch(() => undefined);
  const ceiling =
    opts.concurrency ??
    (advertised?.maxInflightRounds
      ? Math.min(Math.max(1, Math.floor(advertised.maxInflightRounds / 2)), MAX_DEFAULT_CONCURRENCY)
      : DEFAULT_CONCURRENCY);
  const requests = new AdaptiveLimiter(ceiling, ceiling);
  const submits = new AdaptiveLimiter(
    opts.submitConcurrency ?? DEFAULT_SUBMIT_CONCURRENCY,
    opts.submitConcurrency ?? DEFAULT_SUBMIT_CONCURRENCY,
  );
  // One read of the registry inputs for the whole batch.
  const context = await sdk.gateway.prepareContext();
  const submit = opts.submit ?? true;
  const started = Date.now();

  const one = async (index: number): Promise<void> => {
    const feed = feeds[index]!;
    const result: BulkResult = { index, ok: false, ...(feed.label !== undefined ? { label: feed.label } : {}) };
    results[index] = result;
    try {
      const wait = spreadOffsetMs(deriveSourceIdString(feed.apiConfig), opts.spreadMs ?? 0) - (Date.now() - started);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      if (opts.signal?.aborted) {
        result.error = new Error("aborted before the feed was started");
        return;
      }

      await requests.acquire();
      let outcome: "ok" | "busy" | "other" = "other";
      try {
        result.attestation = await sdk.gateway.requestSignedData({
          ...opts.request,
          apiConfig: feed.apiConfig,
          signaturesRequired: feed.signaturesRequired,
          context,
        });
        result.ok = true;
        outcome = "ok";
      } catch (err) {
        result.error = err;
        outcome = isBusy(err) ? "busy" : "other";
      } finally {
        requests.release(outcome);
      }

      if (result.ok && submit && result.attestation) {
        await submits.acquire();
        try {
          const sent = await sdk.solana.submitAttestation(result.attestation);
          result.signature = sent.signature;
          result.feedAddress = sent.feed;
        } catch (err) {
          result.submitError = err; // the round succeeded: keep the attestation
        } finally {
          submits.release("other");
        }
      }
    } finally {
      opts.onResult?.(result);
    }
  };

  await Promise.all(feeds.map((_, index) => one(index)));
  return results;
}

/** The first configured gateway endpoint (the one `fetchGatewayInfo` should ask). */
function sdkFirstEndpoint(sdk: MolphaSDK): string {
  return sdk.gateway.endpointUrls()[0]!;
}
