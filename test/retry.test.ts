import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveSourceIdString } from "../src/core/apiconfig.js";
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_ROUND_TIMEOUT_MS,
  GatewayError,
  MolphaGateway,
  msUntilNextTick,
  retryDelayMs,
} from "../src/gateway/index.js";
import { parseGatewayInfo } from "../src/gateway/identity.js";
import { signedResponseBody } from "./fixtures/gatewayResponse.js";

const OWNER = "9K9FknHzW7j8a88yKTrzxKfDrxnV2QLqSR58ETAVdc8P";
const apiConfig = { url: "http://api", responseParser: "$.price" };
const registry = async () => ({ registryVersion: 1, redundancyBuffer: 2, nodeCount: 3 });
const completed = () => new Response(JSON.stringify(signedResponseBody({})), { status: 200, headers: { "content-type": "application/json" } });
const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const request = { signaturesRequired: 1, apiConfig, subscriptionOwner: OWNER };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("retryDelayMs", () => {
  const tick = 1000;
  const now = 5_000_100; // 100 ms into a tick: 901 ms to the next
  const next = msUntilNextTick(now, tick);

  it("never retries inside the tick that just failed, whatever the cause", () => {
    for (const cause of [{ kind: "conflict" }, { kind: "busy" }, { kind: "error" }] as const) {
      for (const r of [0, 0.5, 0.999]) {
        expect(retryDelayMs(cause, 1, now, tick, () => r)).toBeGreaterThanOrEqual(next);
      }
    }
  });

  it("a conflict waits for the next tick plus up to half a tick of jitter", () => {
    expect(retryDelayMs({ kind: "conflict" }, 1, now, tick, () => 0)).toBe(next);
    expect(retryDelayMs({ kind: "conflict" }, 1, now, tick, () => 0.999)).toBeCloseTo(next + 499.5, 0);
  });

  it("a busy answer honours Retry-After when it is longer than the next tick, and adds jitter", () => {
    expect(retryDelayMs({ kind: "busy", retryAfterMs: 3000 }, 1, now, tick, () => 0)).toBe(3000);
    expect(retryDelayMs({ kind: "busy", retryAfterMs: 3000 }, 1, now, tick, () => 0.5)).toBe(3500);
    // A Retry-After shorter than the next tick still waits for the tick; none given waits a tick.
    expect(retryDelayMs({ kind: "busy", retryAfterMs: 1 }, 1, now, tick, () => 0)).toBe(next);
    expect(retryDelayMs({ kind: "busy" }, 1, now, tick, () => 0)).toBe(Math.max(next, tick));
  });

  it("other failures back off exponentially, capped, with jitter", () => {
    const at = (failures: number, r: number) => retryDelayMs({ kind: "error" }, failures, now, 10, () => r);
    // With a 10 ms tick the backoff dominates: 250, 500, 1000, ... capped at 5000, half randomized.
    expect(at(1, 0)).toBe(125);
    expect(at(1, 1)).toBe(250);
    expect(at(2, 1)).toBe(500);
    expect(at(3, 1)).toBe(1000);
    expect(at(10, 1)).toBe(5000);
    expect(at(30, 1)).toBe(5000);
  });

  it("clients that failed together do not retry together", () => {
    const delays = new Set<number>();
    for (let i = 0; i < 50; i++) delays.add(Math.round(retryDelayMs({ kind: "error" }, 5, now, tick, Math.random)));
    expect(delays.size).toBeGreaterThan(10);
  });
});

describe("defaults", () => {
  it("the request timeout exceeds the gateway's default wait, and retries are bounded", () => {
    expect(DEFAULT_ROUND_TIMEOUT_MS).toBeGreaterThan(30_000);
    expect(DEFAULT_MAX_RETRIES).toBeLessThanOrEqual(10);
  });

  it("parseGatewayInfo reads advertised timing and capacity, and ignores nonsense", () => {
    const base = { gatewayAuthority: "A" };
    expect(parseGatewayInfo({ ...base, tickMs: 500, roundTimeoutSeconds: 30, maxInflightRounds: 200 })).toEqual({
      gatewayAuthority: "A", tickMs: 500, roundTimeoutSeconds: 30, maxInflightRounds: 200,
    });
    expect(parseGatewayInfo({ ...base, tickMs: -1, roundTimeoutSeconds: "30", maxInflightRounds: 0 })).toEqual({ gatewayAuthority: "A" });
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
    await expect(gw.requestSignedData({ ...request, maxRetries: 5, tickMs: 1 })).rejects.toMatchObject({
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
    const promise = gw.requestSignedData({ ...request, maxRetries: 3, tickMs: 100 });
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
    const gw = new MolphaGateway("http://gw", registry, undefined, OWNER);
    await expect(gw.requestSignedData({ ...request, maxRetries: 3, tickMs: 5 })).resolves.toBeTruthy();
    expect(n).toBe(2);
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
    await expect(gw.requestSignedData({ ...request, maxRetries: 5, tickMs: 1 })).rejects.toBeInstanceOf(GatewayError);
    expect(execute).toHaveBeenCalledTimes(2); // the original and the one refreshed attempt
  });

  it("other 400s are never treated as a stale version", async () => {
    const execute = vi.fn(async () => json({ error: "apiConfig.url must use an http or https scheme" }, 400));
    globalThis.fetch = execute as unknown as typeof fetch;
    const getRegistry = vi.fn(registry);
    const gw = new MolphaGateway("http://gw", getRegistry, undefined, OWNER);
    await expect(gw.requestSignedData({ ...request, maxRetries: 5, tickMs: 1 })).rejects.toBeInstanceOf(GatewayError);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(getRegistry).toHaveBeenCalledTimes(1);
  });

  it("the tick grid is learned from the gateway on the first retry, once", async () => {
    let posts = 0;
    const infoCalls = vi.fn();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/info")) {
        infoCalls();
        return json({ status: "ok", data: { gatewayAuthority: "A".repeat(32), tickMs: 20 } }, 200);
      }
      void init;
      posts++;
      return posts <= 2 ? json({ error: "duplicate round" }, 409) : completed();
    }) as unknown as typeof fetch;
    const gw = new MolphaGateway("http://gw", registry, undefined, OWNER);
    await gw.requestSignedData({ ...request, maxRetries: 5 }); // no tickMs given
    expect(posts).toBe(3);
    expect(infoCalls).toHaveBeenCalledTimes(1);
  });

  it("an old gateway without /v1/info still retries, on the default tick", async () => {
    let posts = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/v1/info")) return json({ error: "not found" }, 404);
      return ++posts === 1 ? json({ error: "duplicate round" }, 409) : completed();
    }) as unknown as typeof fetch;
    const gw = new MolphaGateway("http://gw", registry, undefined, OWNER);
    await expect(gw.requestSignedData({ ...request, maxRetries: 3 })).resolves.toBeTruthy();
  });

  it("derives the source id as before", () => {
    expect(deriveSourceIdString(apiConfig)).toMatch(/^[0-9a-f]{64}$/);
  });
});
