import { describe, expect, it, vi } from "vitest";
import { deriveSourceIdString } from "../src/core/apiconfig.js";
import type { APIConfig, Attestation } from "../src/core/types.js";
import { GatewayError } from "../src/gateway/index.js";
import { AdaptiveLimiter, requestMany, spreadOffsetMs, type BulkFeed } from "../src/bulk.js";
import type { MolphaSDK } from "../src/index.js";

const feedsOf = (n: number): BulkFeed[] =>
  Array.from({ length: n }, (_, i) => ({
    apiConfig: { url: `http://api/feed/${i}`, responseParser: "$.price" } as APIConfig,
    signaturesRequired: 3,
    label: `f${i}`,
  }));

const att = (i: number) => ({ value: String(i), payload: { sourceId: `src${i}` } }) as unknown as Attestation;

interface FakeOptions {
  info?: { maxInflightRounds?: number } | Error;
  request?: (apiConfig: APIConfig, call: number) => Promise<Attestation>;
  submit?: (a: Attestation) => Promise<{ signature: string; feed: string }>;
}

function fakeSdk(o: FakeOptions = {}) {
  const calls = { prepare: 0, request: 0, submit: 0, contexts: [] as unknown[], inFlight: 0, peak: 0 };
  const sdk = {
    gateway: {
      endpointUrls: () => ["http://gw"],
      fetchGatewayInfo: vi.fn(async () => {
        if (o.info instanceof Error) throw o.info;
        return { gatewayAuthority: "A", ...(o.info ?? {}) };
      }),
      prepareContext: vi.fn(async () => {
        calls.prepare++;
        return { registryVersion: 7, redundancyBuffer: 1, nodeCount: 4, nodes: [] };
      }),
      requestSignedData: vi.fn(async (req: { apiConfig: APIConfig; context: unknown }) => {
        const call = ++calls.request;
        calls.contexts.push(req.context);
        calls.inFlight++;
        calls.peak = Math.max(calls.peak, calls.inFlight);
        try {
          await new Promise((r) => setTimeout(r, 5));
          return o.request ? await o.request(req.apiConfig, call) : att(call);
        } finally {
          calls.inFlight--;
        }
      }),
    },
    solana: {
      submitAttestation: vi.fn(async (a: Attestation) => {
        calls.submit++;
        return o.submit ? o.submit(a) : { signature: `sig-${(a as { value: string }).value}`, feed: "feed" };
      }),
    },
  };
  return { sdk: sdk as unknown as MolphaSDK, calls, mock: sdk };
}

describe("requestMany", () => {
  it("returns one result per feed, in input order, submitting each", async () => {
    const { sdk, calls } = fakeSdk();
    const results = await requestMany(sdk, feedsOf(12), { concurrency: 4 });
    expect(results.map((r) => r.index)).toEqual([...Array(12).keys()]);
    expect(results.map((r) => r.label)).toEqual(feedsOf(12).map((f) => f.label));
    expect(results.every((r) => r.ok && r.signature?.startsWith("sig-"))).toBe(true);
    expect(calls.request).toBe(12);
    expect(calls.submit).toBe(12);
  });

  it("reads the registry inputs once and shares them with every request", async () => {
    const { sdk, calls } = fakeSdk();
    await requestMany(sdk, feedsOf(20), { concurrency: 10 });
    expect(calls.prepare).toBe(1);
    expect(new Set(calls.contexts).size).toBe(1);
  });

  it("never exceeds the concurrency ceiling", async () => {
    const { sdk, calls } = fakeSdk();
    await requestMany(sdk, feedsOf(60), { concurrency: 5 });
    expect(calls.peak).toBeLessThanOrEqual(5);
    expect(calls.peak).toBeGreaterThan(1);
  });

  it("starts from half the gateway's advertised capacity, and from a default when none is advertised", async () => {
    const a = fakeSdk({ info: { maxInflightRounds: 20 } });
    await requestMany(a.sdk, feedsOf(80));
    expect(a.calls.peak).toBeLessThanOrEqual(10);

    const b = fakeSdk({ info: new Error("no /v1/info on this gateway") });
    await requestMany(b.sdk, feedsOf(80));
    expect(b.calls.peak).toBeLessThanOrEqual(32);
    expect(b.calls.peak).toBeGreaterThan(10);

    const huge = fakeSdk({ info: { maxInflightRounds: 100_000 } });
    await requestMany(huge.sdk, feedsOf(200));
    expect(huge.calls.peak).toBeLessThanOrEqual(64);
  });

  it("a failed feed does not stop the others", async () => {
    const { sdk } = fakeSdk({
      request: async (cfg, call) => {
        if (cfg.url.endsWith("/3")) throw new GatewayError("rejected (400)", 400);
        return att(call);
      },
    });
    const results = await requestMany(sdk, feedsOf(8), { concurrency: 3 });
    expect(results.filter((r) => r.ok)).toHaveLength(7);
    const bad = results[3]!;
    expect(bad.ok).toBe(false);
    expect(bad.error).toBeInstanceOf(GatewayError);
    expect(bad.signature).toBeUndefined();
  });

  it("keeps the signed attestation when the submit fails", async () => {
    const { sdk } = fakeSdk({ submit: async () => { throw new Error("blockhash not found"); } });
    const [r] = await requestMany(sdk, feedsOf(1));
    expect(r!.ok).toBe(true);
    expect(r!.attestation).toBeDefined();
    expect((r!.submitError as Error).message).toContain("blockhash");
    expect(r!.signature).toBeUndefined();
  });

  it("does not submit when asked not to", async () => {
    const { sdk, calls } = fakeSdk();
    const results = await requestMany(sdk, feedsOf(5), { submit: false });
    expect(calls.submit).toBe(0);
    expect(results.every((r) => r.ok && r.attestation && !r.signature)).toBe(true);
  });

  it("reports each feed as it finishes", async () => {
    const { sdk } = fakeSdk();
    const seen: number[] = [];
    await requestMany(sdk, feedsOf(6), { concurrency: 2, onResult: (r) => seen.push(r.index) });
    expect(seen.sort()).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("bounds how many submits run at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const { sdk } = fakeSdk({
      submit: async (a) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return { signature: `s${(a as { value: string }).value}`, feed: "f" };
      },
    });
    await requestMany(sdk, feedsOf(30), { concurrency: 30, submitConcurrency: 3 });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("stops starting new feeds once aborted", async () => {
    const { sdk, calls } = fakeSdk();
    const abort = new AbortController();
    abort.abort();
    const results = await requestMany(sdk, feedsOf(5), { signal: abort.signal });
    expect(calls.request).toBe(0);
    expect(results.every((r) => !r.ok && r.error instanceof Error)).toBe(true);
  });

  it("handles an empty batch without touching the network", async () => {
    const { sdk, mock } = fakeSdk();
    expect(await requestMany(sdk, [])).toEqual([]);
    expect(mock.gateway.prepareContext).not.toHaveBeenCalled();
  });
});

describe("spreading", () => {
  it("places a feed at the same offset every time, within the window", () => {
    const id = deriveSourceIdString({ url: "http://api/x", responseParser: "$.p" });
    expect(spreadOffsetMs(id, 1000)).toBe(spreadOffsetMs(id, 1000));
    for (const f of feedsOf(200)) {
      const o = spreadOffsetMs(deriveSourceIdString(f.apiConfig), 1000);
      expect(o).toBeGreaterThanOrEqual(0);
      expect(o).toBeLessThan(1000);
    }
    expect(spreadOffsetMs(id, 0)).toBe(0);
  });

  it("spreads many feeds across the window instead of stacking them", () => {
    const buckets = new Array(10).fill(0);
    for (const f of feedsOf(1000)) buckets[Math.floor(spreadOffsetMs(deriveSourceIdString(f.apiConfig), 1000) / 100)]++;
    // 1,000 feeds over 10 buckets of 100 ms: no bucket holds a burst.
    expect(Math.max(...buckets)).toBeLessThan(160);
    expect(Math.min(...buckets)).toBeGreaterThan(50);
  });

  it("delays request starts by the feed's offset", async () => {
    const { sdk, calls } = fakeSdk();
    const t0 = Date.now();
    const starts: number[] = [];
    (sdk as unknown as { gateway: { requestSignedData: (r: unknown) => unknown } }).gateway.requestSignedData = vi.fn(async () => {
      starts.push(Date.now() - t0);
      return att(++calls.request);
    });
    await requestMany(sdk, feedsOf(10), { spreadMs: 200, concurrency: 10, submit: false });
    expect(Math.max(...starts) - Math.min(...starts)).toBeGreaterThan(40);
    expect(Math.max(...starts)).toBeLessThan(400);
  });
});

describe("AdaptiveLimiter", () => {
  it("halves on a busy answer, once per cooldown, and never below one", () => {
    let t = 0;
    const l = new AdaptiveLimiter(16, 16, () => t);
    l.acquire();
    l.release("busy");
    expect(l.limit).toBe(8);
    l.acquire();
    l.release("busy"); // inside the cooldown: the same burst, not a second cut
    expect(l.limit).toBe(8);
    t += 1500;
    l.acquire();
    l.release("busy");
    expect(l.limit).toBe(4);
    for (let i = 0; i < 6; i++) {
      t += 1500;
      l.acquire();
      l.release("busy");
    }
    expect(l.limit).toBe(1);
  });

  it("creeps back up one slot per window of successes, up to its ceiling", () => {
    const l = new AdaptiveLimiter(4, 6);
    for (let i = 0; i < 4; i++) { l.acquire(); l.release("ok"); }
    expect(l.limit).toBe(5);
    for (let i = 0; i < 5; i++) { l.acquire(); l.release("ok"); }
    expect(l.limit).toBe(6);
    for (let i = 0; i < 50; i++) { l.acquire(); l.release("ok"); }
    expect(l.limit).toBe(6);
  });

  it("serves waiters in arrival order and never exceeds its limit", async () => {
    const l = new AdaptiveLimiter(1, 1);
    await l.acquire();
    const order: number[] = [];
    const waiting = [1, 2, 3].map((n) => l.acquire().then(() => { order.push(n); }));
    l.release("other");
    await waiting[0];
    expect(order).toEqual([1]);
    l.release("other");
    await waiting[1];
    l.release("other");
    await waiting[2];
    expect(order).toEqual([1, 2, 3]);
  });

  it("a busy answer lowers the limit for requests that were already waiting", async () => {
    const l = new AdaptiveLimiter(4, 4, () => 0);
    await Promise.all([l.acquire(), l.acquire(), l.acquire(), l.acquire()]);
    const waiter = l.acquire(); // fifth: waits
    l.release("busy"); // limit 4 -> 2, and 3 are still in flight: the waiter must not be admitted
    let admitted = false;
    void waiter.then(() => { admitted = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(admitted).toBe(false);
    l.release("other");
    l.release("other");
    await waiter;
    expect(admitted).toBe(true);
  });
});

describe("busy answers slow a batch down instead of failing it", () => {
  it("halves the limit after a 503, then finishes every feed", async () => {
    let busyLeft = 3;
    const { sdk, calls } = fakeSdk({
      request: async (_cfg, call) => {
        if (busyLeft > 0) { busyLeft--; throw new GatewayError("Gateway unavailable (503)", 503); }
        return att(call);
      },
    });
    const results = await requestMany(sdk, feedsOf(40), { concurrency: 16, submit: false, request: { maxRetries: 1 } });
    expect(results.filter((r) => !r.ok)).toHaveLength(3); // the three that were told busy; each fails its single attempt
    expect(results.filter((r) => r.ok)).toHaveLength(37);
    expect(calls.request).toBe(40);
  });
});
