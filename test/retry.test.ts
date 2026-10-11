import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveSourceIdString } from "../src/core/apiconfig.js";
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_ROUND_TIMEOUT_MS,
  GatewayError,
  MolphaGateway,
  retryDelayMs,
} from "../src/gateway/index.js";
import { parseGatewayInfo } from "../src/gateway/identity.js";
import { ROUND_TICK_MS } from "../src/core/timestamp.js";
import { signedResponseBody } from "./fixtures/gatewayResponse.js";

const OWNER = "9K9FknHzW7j8a88yKTrzxKfDrxnV2QLqSR58ETAVdc8P";
const apiConfig = { url: "http://api", responseParser: "$.price" };
const registry = async () => ({ registryVersion: 1, redundancyBuffer: 2, nodeCount: 3 });
const completed = () => new Response(JSON.stringify(signedResponseBody({})), { status: 200, headers: { "content-type": "application/json" } });
const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const request = { signaturesRequired: 1, apiConfig, subscriptionOwner: OWNER };
/** A `sleep` that returns at once and records what it was asked to wait. */
const recordingSleep = () => {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number) => void delays.push(ms) };
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("retryDelayMs", () => {
  it("a conflict waits one full round tick plus a small jitter, whatever the attempt", () => {
    expect(ROUND_TICK_MS).toBe(100);
    expect(retryDelayMs({ kind: "conflict" }, 1, () => 0)).toBe(100);
    expect(retryDelayMs({ kind: "conflict" }, 1, () => 0.5)).toBe(110);
    for (const failures of [1, 3, 30]) {
      for (const r of [0, 0.5, 0.999]) {
        const delay = retryDelayMs({ kind: "conflict" }, failures, () => r);
        // Never less than a tick: the retry then falls in a later tick whatever the clock offset.
        expect(delay).toBeGreaterThanOrEqual(ROUND_TICK_MS);
        expect(delay).toBeLessThan(ROUND_TICK_MS + 20);
      }
    }
  });

  it("a busy answer waits out Retry-After, or the backoff step when that is longer, plus jitter", () => {
    expect(retryDelayMs({ kind: "busy", retryAfterMs: 3000 }, 1, () => 0)).toBe(3000);
    expect(retryDelayMs({ kind: "busy", retryAfterMs: 3000 }, 1, () => 0.5)).toBe(3125);
    // A Retry-After shorter than the backoff step, or none, waits the step: 250, 500, ... 5000.
    expect(retryDelayMs({ kind: "busy", retryAfterMs: 1 }, 1, () => 0)).toBe(250);
    expect(retryDelayMs({ kind: "busy" }, 1, () => 0)).toBe(250);
    expect(retryDelayMs({ kind: "busy" }, 1, () => 1)).toBe(500);
    expect(retryDelayMs({ kind: "busy" }, 3, () => 0)).toBe(1000);
    expect(retryDelayMs({ kind: "busy" }, 30, () => 0)).toBe(5000);
  });

  it("other failures back off exponentially, capped, with jitter", () => {
    const at = (failures: number, r: number) => retryDelayMs({ kind: "error" }, failures, () => r);
    // 250, 500, 1000, ... capped at 5000, half randomized.
    expect(at(1, 0)).toBe(125);
    expect(at(1, 1)).toBe(250);
    expect(at(2, 1)).toBe(500);
    expect(at(3, 1)).toBe(1000);
    expect(at(10, 1)).toBe(5000);
    expect(at(30, 1)).toBe(5000);
  });

  it("clients that failed together do not retry together", () => {
    for (const cause of [{ kind: "conflict" }, { kind: "busy" }, { kind: "error" }] as const) {
      const delays = new Set<number>();
      for (let i = 0; i < 50; i++) delays.add(retryDelayMs(cause, 5, Math.random));
      expect(delays.size).toBeGreaterThan(10);
    }
  });
});

describe("defaults", () => {
  it("the request timeout exceeds the gateway's default wait, and retries are bounded", () => {
    expect(DEFAULT_ROUND_TIMEOUT_MS).toBeGreaterThan(30_000);
    expect(DEFAULT_MAX_RETRIES).toBeLessThanOrEqual(10);
  });

  it("parseGatewayInfo reads advertised timing and capacity, and ignores nonsense", () => {
    const base = { gatewayAuthority: "A" };
    expect(parseGatewayInfo({ ...base, roundTimeoutSeconds: 30, maxInflightRounds: 200 })).toEqual({
      gatewayAuthority: "A", roundTimeoutSeconds: 30, maxInflightRounds: 200,
    });
    expect(parseGatewayInfo({ ...base, roundTimeoutSeconds: "30", maxInflightRounds: 0 })).toEqual({ gatewayAuthority: "A" });
    expect(parseGatewayInfo(base)).toEqual({ gatewayAuthority: "A" });
  });
});

describe("requestSignedData failure handling", () => {
  it("a success costs exactly one request: no info or node lookups on the happy path", async () => {
    const fetchMock = vi.fn(async () => completed());
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const gw = new MolphaGateway("http://gw", registry, undefined, OWNER);
    await gw.requestSignedData({ ...request, context: { registryVersion: 1, redundancyBuffer: 2, nodeCount: 3 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("403 is terminal: an inactive subscription or spent quota is not retried", async () => {
    const execute = vi.fn(async () => json({ error: "forbidden: subscription or delegate round quota is exhausted" }, 403));
    globalThis.fetch = execute as unknown as typeof fetch;
    const gw = new MolphaGateway("http://gw", registry, undefined, OWNER);
    await expect(gw.requestSignedData({ ...request, maxRetries: 5 })).rejects.toMatchObject({
      name: "GatewayError", status: 403,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("429 and 503 are retried, and a Retry-After is waited out", async () => {
    vi.useFakeTimers();
    const posts: number[] = [];
    globalThis.fetch = (async () => {
      posts.push(Date.now());
      return posts.length === 1 ? json({ error: "gateway at capacity" }, 503, { "retry-after": "3" }) : completed();
    }) as unknown as typeof fetch;
    const gw = new MolphaGateway("http://gw", registry, undefined, { defaultSubscriptionOwner: OWNER, random: () => 0 });
    const promise = gw.requestSignedData({ ...request, maxRetries: 3 });
    await vi.advanceTimersByTimeAsync(2_900);
    expect(posts).toHaveLength(1); // still waiting out the 3 s Retry-After
    await vi.advanceTimersByTimeAsync(300);
    await expect(promise).resolves.toBeTruthy();
    expect(posts).toHaveLength(2);
    expect(posts[1]! - posts[0]!).toBeGreaterThanOrEqual(3000);
  });

  it("429 is treated as a transient busy answer", async () => {
    let n = 0;
    globalThis.fetch = (async () => (++n === 1 ? json({ error: "rate limited" }, 429, { "retry-after": "0" }) : completed())) as unknown as typeof fetch;
    const { sleep, delays } = recordingSleep();
    const gw = new MolphaGateway("http://gw", registry, undefined, { defaultSubscriptionOwner: OWNER, sleep });
    await expect(gw.requestSignedData({ ...request, maxRetries: 3 })).resolves.toBeTruthy();
    expect(n).toBe(2);
    // "Retry-After: 0" does not mean at once: the wait is still the backoff step plus jitter.
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeGreaterThanOrEqual(250);
    expect(delays[0]).toBeLessThanOrEqual(500);
  });

  it("nodes that answer busy surface as 503: retried with backoff, then reported", async () => {
    const execute = vi.fn(async () => json({ error: "nodes busy" }, 503));
    globalThis.fetch = execute as unknown as typeof fetch;
    const { sleep, delays } = recordingSleep();
    const gw = new MolphaGateway("http://gw", registry, undefined, { defaultSubscriptionOwner: OWNER, random: () => 0, sleep });
    await expect(gw.requestSignedData({ ...request, maxRetries: 4 })).rejects.toMatchObject({
      name: "GatewayError", status: 503, message: "Gateway unavailable (503): nodes busy",
    });
    expect(execute).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([250, 500, 1000]);
  });

  it("a stale registry version refreshes the inputs once and retries without spending an attempt", async () => {
    let version = 1;
    const getRegistry = vi.fn(async () => ({ registryVersion: version, redundancyBuffer: 2, nodeCount: 3 }));
    const seen: number[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { registryVersion: number };
      seen.push(body.registryVersion);
      return body.registryVersion === 2 ? completed() : json({ error: "registryVersion: must equal current version 2" }, 400);
    }) as unknown as typeof fetch;
    const gw = new MolphaGateway("http://gw", getRegistry, undefined, OWNER);
    version = 1;
    const promise = gw.requestSignedData({
      ...request, maxRetries: 1, // one attempt only: the refresh must not consume it
      context: { registryVersion: 1, redundancyBuffer: 2, nodeCount: 3 },
    });
    version = 2; // the registry rolled after the caller cached its context
    await expect(promise).resolves.toBeTruthy();
    expect(seen).toEqual([1, 2]);
    expect(getRegistry).toHaveBeenCalledTimes(1);
  });

  it("a registry version that is still wrong after one refresh is terminal", async () => {
    const execute = vi.fn(async () => json({ error: "registryVersion: must equal current version 9" }, 400));
    globalThis.fetch = execute as unknown as typeof fetch;
    const gw = new MolphaGateway("http://gw", registry, undefined, OWNER);
    await expect(gw.requestSignedData({ ...request, maxRetries: 5 })).rejects.toBeInstanceOf(GatewayError);
    expect(execute).toHaveBeenCalledTimes(2); // the original and the one refreshed attempt
  });

  it("other 400s are never treated as a stale version", async () => {
    const execute = vi.fn(async () => json({ error: "apiConfig.url must use an http or https scheme" }, 400));
    globalThis.fetch = execute as unknown as typeof fetch;
    const getRegistry = vi.fn(registry);
    const gw = new MolphaGateway("http://gw", getRegistry, undefined, OWNER);
    await expect(gw.requestSignedData({ ...request, maxRetries: 5 })).rejects.toBeInstanceOf(GatewayError);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(getRegistry).toHaveBeenCalledTimes(1);
  });

  it("a 409 is retried one tick later, without asking the gateway for anything", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return urls.length <= 2 ? json({ error: "duplicate round, retry" }, 409) : completed();
    }) as unknown as typeof fetch;
    const { sleep, delays } = recordingSleep();
    const gw = new MolphaGateway("http://gw", registry, undefined, { defaultSubscriptionOwner: OWNER, sleep });
    await expect(gw.requestSignedData({ ...request, maxRetries: 5 })).resolves.toBeTruthy();
    // Three round requests and nothing else: the tick is a constant, so there is no /v1/info lookup.
    expect(urls).toEqual(Array(3).fill("http://gw/v1/round/execute"));
    expect(delays).toHaveLength(2);
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(100);
      expect(delay).toBeLessThan(120);
    }
  });

  it("the wait after a 409 is a full tick wherever the local clock stands in its own tick", async () => {
    vi.useFakeTimers();
    // The start of a tick, the middle and the last millisecond: no boundary is computed locally.
    for (const startMs of [1_750_000_000_000, 1_750_000_000_050, 1_750_000_000_099, 1_750_000_000_999]) {
      vi.setSystemTime(startMs);
      const posts: number[] = [];
      globalThis.fetch = (async () => {
        posts.push(Date.now());
        return posts.length === 1 ? json({ error: "duplicate round, retry" }, 409) : completed();
      }) as unknown as typeof fetch;
      const gw = new MolphaGateway("http://gw", registry, undefined, { defaultSubscriptionOwner: OWNER, random: () => 0.5 });
      const promise = gw.requestSignedData({ ...request, maxRetries: 2 });
      await vi.advanceTimersByTimeAsync(109);
      expect(posts).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(promise).resolves.toBeTruthy();
      expect(posts[1]! - posts[0]!).toBe(110);
    }
  });

  it("repeated 409s stop at maxRetries and report the conflict", async () => {
    const execute = vi.fn(async () => json({ error: "duplicate round, retry" }, 409));
    globalThis.fetch = execute as unknown as typeof fetch;
    const { sleep, delays } = recordingSleep();
    const gw = new MolphaGateway("http://gw", registry, undefined, { defaultSubscriptionOwner: OWNER, random: () => 0, sleep });
    await expect(gw.requestSignedData({ ...request, maxRetries: 4 })).rejects.toMatchObject({
      name: "GatewayError", status: 409,
    });
    expect(execute).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([100, 100, 100]);
  });

  it("derives the source id as before", () => {
    expect(deriveSourceIdString(apiConfig)).toMatch(/^[0-9a-f]{64}$/);
  });
});
