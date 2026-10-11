import { afterEach, describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { getAddressDecoder } from "@solana/kit";
import { deriveSourceIdString } from "../src/core/apiconfig.js";
import { MOLPHA_PROGRAM_ID } from "../src/core/constants.js";
import { bytesToHex, hexToBytes } from "../src/core/encoding.js";
import { hashRequestAuth } from "../src/gateway/auth.js";
import { addressToBytes, deriveGatewayPda } from "../src/gateway/identity.js";
import { MolphaGateway } from "../src/gateway/index.js";
import { signedResponseBody, type SignedResponseFields } from "./fixtures/gatewayResponse.js";

const SUBSCRIPTION_OWNER = "9K9FknHzW7j8a88yKTrzxKfDrxnV2QLqSR58ETAVdc8P";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const authorityFromSeed = (seed: number): string =>
  getAddressDecoder().decode(new Uint8Array(32).fill(seed));
const GATEWAY_AUTHORITY_1 = authorityFromSeed(0x51);
const GATEWAY_AUTHORITY_2 = authorityFromSeed(0x52);
const PROGRAM_ID_BYTES = addressToBytes(MOLPHA_PROGRAM_ID);

const nodes = [
  { index: 0, peerId: "a", address: "n0", signingKey: "02".padEnd(66, "0") },
  { index: 1, peerId: "b", address: "n1", signingKey: "03".padEnd(66, "0") },
  { index: 2, peerId: "c", address: "n2", signingKey: "02".padEnd(66, "1") },
];
const apiConfig = { url: "http://api", responseParser: "$.price" };
const SOURCE_ID = deriveSourceIdString(apiConfig);
const privateApiConfig = {
  url: "http://api/{{secret.token}}",
  responseParser: "$.price",
};
const privateApiEncrypt = { secrets: { token: "secret-token" } };
const encryptedNodes = [0, 1, 2].map((index) => ({
  index,
  peerId: `p${index}`,
  address: `n${index}`,
  signingKey: bytesToHex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)),
}));

const registry = async () => ({ registryVersion: 1, redundancyBuffer: 2 });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface MockRoutes {
  execute: (url: string, body: Record<string, unknown>) => Response | Promise<Response>;
  /** `/v1/info` handler by endpoint origin; unmatched origins throw like a dead host. */
  info?: (url: string, init?: RequestInit) => Response | Promise<Response>;
}

/** Routes GETs to nodes/health (+ optional info) and lets the test control each /execute POST. */
function mockFetch(routes: MockRoutes) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST" && url.endsWith("/execute")) {
      return routes.execute(url, JSON.parse(String(init.body)) as Record<string, unknown>);
    }
    if (url.endsWith("/v1/info")) {
      if (!routes.info) throw new Error(`unexpected fetch: ${url}`);
      return routes.info(url, init);
    }
    if (url.endsWith("/nodes")) return jsonResponse({ status: "ok", data: { nodes } });
    if (url.endsWith("/health")) return jsonResponse({ ok: true });
    throw new Error(`unexpected fetch: ${url}`);
  });
}

const completed = (extra: SignedResponseFields = {}) => jsonResponse(signedResponseBody(extra));

const baseRequest = {
  signaturesRequired: 1,
  apiConfig,
  subscriptionOwner: SUBSCRIPTION_OWNER,
};

function ed25519Signer() {
  const secret = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(secret);
  return { publicKey, signer: async (msg: Uint8Array) => ed25519.sign(msg, secret) };
}

/** Does `body.authSig` verify for the RequestAuth the gateway at `gatewayAuthority` rebuilds? */
async function expectedAuthSig(
  publicKey: Uint8Array,
  body: Record<string, unknown>,
  gatewayAuthority: string,
): Promise<boolean> {
  const message = hashRequestAuth({
    programId: PROGRAM_ID_BYTES,
    gateway: await deriveGatewayPda(gatewayAuthority, MOLPHA_PROGRAM_ID),
    sourceId: body.sourceId as string,
    signaturesRequired: body.signaturesRequired as number,
    authTimestamp: body.authTimestamp as number,
  });
  return ed25519.verify(hexToBytes(body.authSig as string), message, publicKey);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MolphaGateway.requestSignedData failover", () => {
  it("returns the result when a gateway completes", async () => {
    globalThis.fetch = mockFetch({
      execute: () =>
        completed({
          sourceId: SOURCE_ID,
          value: "100",
          signaturesRequired: 1,
        }),
    }) as unknown as typeof fetch;

    const gw = new MolphaGateway("http://gw1", registry);
    const result = await gw.requestSignedData(baseRequest);
    expect(result.value).toBe("100");
    expect(result.payload.sourceId).toBe(SOURCE_ID);
    expect(result.signature.commitmentAddr).toBe("bb".repeat(20));
  });

  it("parses the gateway's nested `attestation` body (current AttestationResponse)", async () => {
    globalThis.fetch = mockFetch({
      execute: () =>
        jsonResponse({
          status: "completed",
          data: {
            attestation: {
              payload: {
                value: "00".repeat(31) + "64",
                sourceId: SOURCE_ID,
                registryVersion: 4,
                signaturesRequired: 1,
                timestamp: 1_700_000_123,
              },
              signature: {
                signature: "aa".repeat(32),
                commitment: "bb".repeat(20),
                signersBitmap: "00".repeat(31) + "0e",
              },
            },
            value: "100",
            fresh: true,
            configHash: SOURCE_ID,
          },
        }),
    }) as unknown as typeof fetch;

    const gw = new MolphaGateway("http://gw1", registry);
    const result = await gw.requestSignedData(baseRequest);

    expect(result.value).toBe("100");
    expect(result.fresh).toBe(true);
    expect(result.payload).toEqual({
      sourceId: SOURCE_ID,
      value: "00".repeat(31) + "64",
      timestamp: 1_700_000_123,
      registryVersion: 4,
      signaturesRequired: 1,
    });
    expect(result.signature).toEqual({
      s: "aa".repeat(32),
      commitmentAddr: "bb".repeat(20),
      signersBitmap: "00".repeat(31) + "0e",
    });
  });

  it("rejects a nested attestation for a different source", async () => {
    globalThis.fetch = mockFetch({
      execute: () =>
        jsonResponse({
          status: "completed",
          data: {
            attestation: {
              payload: { value: "00".repeat(32), sourceId: "cd".repeat(32), signaturesRequired: 1 },
              signature: { signature: "aa".repeat(32), commitment: "bb".repeat(20), signersBitmap: "01" },
            },
            value: "1",
            fresh: true,
          },
        }),
    }) as unknown as typeof fetch;

    const gw = new MolphaGateway("http://gw1", registry);
    await expect(gw.requestSignedData({ ...baseRequest, maxRetries: 1 })).rejects.toThrow(/sourceId/);
  });

  it("derives sourceId from apiConfig and posts it (no feedId)", async () => {
    let postedBody: Record<string, unknown> | undefined;
    globalThis.fetch = mockFetch({
      execute: (_url, body) => {
        postedBody = body;
        return completed();
      },
    }) as unknown as typeof fetch;

    const gw = new MolphaGateway("http://gw1", registry);
    await gw.requestSignedData(baseRequest);
    expect(postedBody?.sourceId).toBe(SOURCE_ID);
    expect(postedBody).not.toHaveProperty("feedId");
    expect(postedBody?.apiConfig).toEqual({
      url: "http://api",
      method: "GET",
      headers: {},
      responseParser: "$.price",
      valueTransform: "",
    });
    expect(postedBody?.authSig).toBe("0x" + "00".repeat(64)); // no signer → dev zero sig
  });

  it("throws when subscriptionOwner is missing", async () => {
    const gw = new MolphaGateway("http://gw1", registry);
    await expect(
      gw.requestSignedData({ signaturesRequired: 1, apiConfig }),
    ).rejects.toThrow("subscriptionOwner is required");
  });

  it("rejects signaturesRequired outside 1..255", async () => {
    const gw = new MolphaGateway("http://gw1", registry);
    await expect(gw.requestSignedData({ ...baseRequest, signaturesRequired: 0 })).rejects.toThrow(
      /1\.\.255/,
    );
    await expect(
      gw.requestSignedData({ ...baseRequest, signaturesRequired: 256 }),
    ).rejects.toThrow(/1\.\.255/);
  });

  it("throws immediately on 400 without trying the next endpoint", async () => {
    const handler = vi.fn(() => jsonResponse({ error: "bad" }, 400));
    globalThis.fetch = mockFetch({ execute: handler }) as unknown as typeof fetch;

    const gw = new MolphaGateway(["http://gw1", "http://gw2"], registry);
    await expect(
      gw.requestSignedData({ ...baseRequest, maxRetries: 3 }),
    ).rejects.toMatchObject({
      name: "GatewayError",
      status: 400,
      message: "Gateway rejected request (400): bad",
    });
    expect(handler).toHaveBeenCalledTimes(1); // did not fall through
  });

  it("falls through 503 to the next endpoint", async () => {
    const handler = vi.fn((url: string) =>
      url.startsWith("http://gw1")
        ? jsonResponse({ error: "busy" }, 503)
        : completed({ value: "7" }),
    );
    globalThis.fetch = mockFetch({ execute: handler }) as unknown as typeof fetch;

    const gw = new MolphaGateway(["http://gw1", "http://gw2"], registry);
    const result = await gw.requestSignedData(baseRequest);
    expect(result.value).toBe("7");
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("returns 503 details when all endpoints fail", async () => {
    globalThis.fetch = mockFetch({
      execute: () => jsonResponse({ error: "group size 4 exceeds total node count 3" }, 503),
    }) as unknown as typeof fetch;

    const gw = new MolphaGateway("http://gw1", registry);
    await expect(
      gw.requestSignedData({ ...baseRequest, maxRetries: 1 }),
    ).rejects.toMatchObject({
      name: "GatewayError",
      status: 503,
      message: "Gateway unavailable (503): group size 4 exceeds total node count 3",
    });
  });
});

describe("MolphaGateway request auth", () => {
  it("signs RequestAuth with defaultSigner over the program id and the endpoint's Gateway PDA", async () => {
    const defaultSigner = vi.fn(async (_msg: Uint8Array) => new Uint8Array(64).fill(0xab));
    let postedBody: Record<string, unknown> | undefined;
    globalThis.fetch = mockFetch({
      execute: (_url, body) => {
        postedBody = body;
        return completed();
      },
    }) as unknown as typeof fetch;

    const gw = new MolphaGateway(
      { url: "http://gw1", gatewayAuthority: GATEWAY_AUTHORITY_1 },
      registry,
      defaultSigner,
      SUBSCRIPTION_OWNER,
    );
    await gw.requestSignedData({ signaturesRequired: 1, apiConfig });

    expect(defaultSigner).toHaveBeenCalledTimes(1);
    expect(postedBody?.authSig).toBe("0x" + "ab".repeat(64));
    expect(postedBody?.subscriptionOwner).toBe(SUBSCRIPTION_OWNER);
    expect(postedBody?.consumerAuthority).toBe(SUBSCRIPTION_OWNER);
    expect(defaultSigner.mock.calls[0]?.[0]).toEqual(
      hashRequestAuth({
        programId: PROGRAM_ID_BYTES,
        gateway: await deriveGatewayPda(GATEWAY_AUTHORITY_1, MOLPHA_PROGRAM_ID),
        sourceId: SOURCE_ID,
        signaturesRequired: 1,
        authTimestamp: postedBody!.authTimestamp as number,
      }),
    );
  });

  it("posts authSig and authTimestamp but no round timestamp", async () => {
    const { signer } = ed25519Signer();
    let postedBody: Record<string, unknown> | undefined;
    globalThis.fetch = mockFetch({
      execute: (_url, body) => {
        postedBody = body;
        return completed();
      },
    }) as unknown as typeof fetch;

    const gw = new MolphaGateway(
      { url: "http://gw1", gatewayAuthority: GATEWAY_AUTHORITY_1 },
      registry,
      signer,
      SUBSCRIPTION_OWNER,
    );
    await gw.requestSignedData({ signaturesRequired: 1, apiConfig });

    expect(postedBody).toHaveProperty("authSig");
    expect(postedBody).toHaveProperty("authTimestamp");
    expect(postedBody).not.toHaveProperty("timestamp");
    expect(postedBody?.consumerAuthority).toBe(SUBSCRIPTION_OWNER);
    expect(postedBody?.subscriptionOwner).toBe(SUBSCRIPTION_OWNER);
  });

  it("authTimestamp is unix seconds from the SDK clock and fresh for every attempt", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(1_750_000_000_900));
      const { publicKey, signer } = ed25519Signer();
      const bodies: Record<string, unknown>[] = [];
      globalThis.fetch = mockFetch({
        execute: (_url, body) => {
          bodies.push(body);
          // A 409 (same tick); the next attempt happens 5 s of local clock later.
          if (bodies.length === 1) {
            vi.setSystemTime(new Date(1_750_000_005_900));
            return jsonResponse({ error: "duplicate round" }, 409);
          }
          return completed();
        },
      }) as unknown as typeof fetch;

      const gw = new MolphaGateway(
        { url: "http://gw1", gatewayAuthority: GATEWAY_AUTHORITY_1 },
        registry,
        signer,
        SUBSCRIPTION_OWNER,
      );
      // Only Date is faked: the wait after a 409 is one real tick (about 100 ms).
      await gw.requestSignedData({ signaturesRequired: 1, apiConfig, maxRetries: 2 });

      expect(bodies).toHaveLength(2);
      // Seconds, not milliseconds: floor(ms / 1000).
      expect(bodies[0]!.authTimestamp).toBe(1_750_000_000);
      expect(bodies[1]!.authTimestamp).toBe(1_750_000_005);
      expect(bodies[0]!.authSig).not.toBe(bodies[1]!.authSig);
      for (const body of bodies) {
        expect(body).not.toHaveProperty("timestamp");
        expect(await expectedAuthSig(publicKey, body, GATEWAY_AUTHORITY_1)).toBe(true);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("prefers per-call signer over defaultSigner", async () => {
    const defaultSigner = vi.fn(async (_msg: Uint8Array) => new Uint8Array(64).fill(0xab));
    const overrideSigner = vi.fn(async (_msg: Uint8Array) => new Uint8Array(64).fill(0xcd));
    let postedBody: Record<string, unknown> | undefined;
    globalThis.fetch = mockFetch({
      execute: (_url, body) => {
        postedBody = body;
        return completed();
      },
    }) as unknown as typeof fetch;

    const gw = new MolphaGateway(
      { url: "http://gw1", gatewayAuthority: GATEWAY_AUTHORITY_1 },
      registry,
      defaultSigner,
      SUBSCRIPTION_OWNER,
    );
    await gw.requestSignedData({ signaturesRequired: 1, apiConfig, signer: overrideSigner });

    expect(defaultSigner).not.toHaveBeenCalled();
    expect(overrideSigner).toHaveBeenCalledTimes(1);
    expect(postedBody?.authSig).toBe("0x" + "cd".repeat(64));
  });

  it("discovers the gateway authority from /v1/info once per endpoint", async () => {
    const { publicKey, signer } = ed25519Signer();
    const info = vi.fn(() =>
      jsonResponse({
        status: "ok",
        data: { gatewayAuthority: GATEWAY_AUTHORITY_1, programId: MOLPHA_PROGRAM_ID },
      }),
    );
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = mockFetch({
      info,
      execute: (_url, body) => {
        bodies.push(body);
        return completed();
      },
    }) as unknown as typeof fetch;

    const gw = new MolphaGateway("http://gw1", registry, signer, SUBSCRIPTION_OWNER);
    await gw.requestSignedData({ signaturesRequired: 2, apiConfig });
    await gw.requestSignedData({ signaturesRequired: 2, apiConfig });

    expect(info).toHaveBeenCalledTimes(1);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(await expectedAuthSig(publicKey, body, GATEWAY_AUTHORITY_1)).toBe(true);
    }
  });

  it("signs separately for each endpoint's Gateway PDA on failover", async () => {
    const { publicKey, signer } = ed25519Signer();
    const bodies = new Map<string, Record<string, unknown>>();
    globalThis.fetch = mockFetch({
      execute: (url, body) => {
        bodies.set(new URL(url).origin, body);
        return url.startsWith("http://gw1")
          ? jsonResponse({ error: "busy" }, 503)
          : completed({ value: "7" });
      },
    }) as unknown as typeof fetch;

    const gw = new MolphaGateway(
      [
        { url: "http://gw1", gatewayAuthority: GATEWAY_AUTHORITY_1 },
        { url: "http://gw2", gatewayAuthority: GATEWAY_AUTHORITY_2 },
      ],
      registry,
      signer,
      SUBSCRIPTION_OWNER,
    );
    const result = await gw.requestSignedData({ signaturesRequired: 1, apiConfig });
    expect(result.value).toBe("7");

    const body1 = bodies.get("http://gw1")!;
    const body2 = bodies.get("http://gw2")!;
    expect(body1.authSig).not.toBe(body2.authSig);
    expect(await expectedAuthSig(publicKey, body1, GATEWAY_AUTHORITY_1)).toBe(true);
    expect(await expectedAuthSig(publicKey, body2, GATEWAY_AUTHORITY_2)).toBe(true);
    // A signature for gw1 must not verify against gw2's PDA.
    expect(await expectedAuthSig(publicKey, body1, GATEWAY_AUTHORITY_2)).toBe(false);
  });

  it("rejects a gateway that settles against a different program", async () => {
    const { signer } = ed25519Signer();
    const execute = vi.fn(() => completed());
    globalThis.fetch = mockFetch({
      info: () =>
        jsonResponse({
          status: "ok",
          data: { gatewayAuthority: GATEWAY_AUTHORITY_1, programId: SYSTEM_PROGRAM },
        }),
      execute,
    }) as unknown as typeof fetch;

    const gw = new MolphaGateway("http://gw1", registry, signer, SUBSCRIPTION_OWNER);
    await expect(
      gw.requestSignedData({ signaturesRequired: 1, apiConfig, maxRetries: 1 }),
    ).rejects.toThrow(/settles against program/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails over when an endpoint's identity cannot be resolved", async () => {
    const { publicKey, signer } = ed25519Signer();
    let postedBody: Record<string, unknown> | undefined;
    globalThis.fetch = mockFetch({
      info: (url) => {
        if (url.startsWith("http://gw1")) throw new Error("connection refused");
        return jsonResponse({ status: "ok", data: { gatewayAuthority: GATEWAY_AUTHORITY_2 } });
      },
      execute: (_url, body) => {
        postedBody = body;
        return completed({ value: "9" });
      },
    }) as unknown as typeof fetch;

    const gw = new MolphaGateway(["http://gw1", "http://gw2"], registry, signer, SUBSCRIPTION_OWNER);
    const result = await gw.requestSignedData({ signaturesRequired: 1, apiConfig });
    expect(result.value).toBe("9");
    expect(await expectedAuthSig(publicKey, postedBody!, GATEWAY_AUTHORITY_2)).toBe(true);
  });

  it("treats a 401 as terminal", async () => {
    const { signer } = ed25519Signer();
    const execute = vi.fn(() => jsonResponse({ error: "authSig does not verify" }, 401));
    globalThis.fetch = mockFetch({ execute }) as unknown as typeof fetch;

    const gw = new MolphaGateway(
      { url: "http://gw1", gatewayAuthority: GATEWAY_AUTHORITY_1 },
      registry,
      signer,
      SUBSCRIPTION_OWNER,
    );
    await expect(gw.requestSignedData({ signaturesRequired: 1, apiConfig })).rejects.toMatchObject({
      status: 401,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("without a signer, sends an all-zero authSig and never contacts /v1/info", async () => {
    const fetchSpy = mockFetch({ execute: () => completed() });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const gw = new MolphaGateway("http://gw1", registry);
    await gw.requestSignedData(baseRequest);
    const fetched = fetchSpy.mock.calls.map(([input]) => String(input));
    expect(fetched.some((url) => url.endsWith("/v1/info"))).toBe(false);
    const posted = JSON.parse(
      String(fetchSpy.mock.calls.find(([, init]) => init?.method === "POST")?.[1]?.body),
    );
    expect(posted.authSig).toBe("0x" + "00".repeat(64));
    expect(posted).toHaveProperty("authTimestamp");
  });
});

describe("MolphaGateway round timestamp", () => {
  it("takes the timestamp and signer bitmap from the response", async () => {
    globalThis.fetch = mockFetch({
      execute: () => completed({ timestamp: 1_750_000_123_000, signersBitmap: "00".repeat(31) + "05" }),
    }) as unknown as typeof fetch;

    const result = await new MolphaGateway("http://gw1", registry, undefined, SUBSCRIPTION_OWNER).requestSignedData({
      signaturesRequired: 1,
      apiConfig,
    });
    expect(result.payload.timestamp).toBe(1_750_000_123_000);
    expect(result.signature.signersBitmap).toBe("00".repeat(31) + "05");
  });

  it("returns the timestamp exactly as the gateway gave it, without checking it against a grid", async () => {
    // The grid is the gateway's to stamp and the nodes' to enforce; the verifiers do not read it.
    // The SDK neither rounds nor refuses a timestamp: it hands on what was signed.
    for (const timestamp of [1_750_000_123_400, 1_750_000_123_456, 1_750_000_123_999]) {
      globalThis.fetch = mockFetch({ execute: () => completed({ timestamp }) }) as unknown as typeof fetch;
      const result = await new MolphaGateway("http://gw1", registry, undefined, SUBSCRIPTION_OWNER).requestSignedData({
        signaturesRequired: 1,
        apiConfig,
        maxRetries: 1,
      });
      expect(result.payload.timestamp).toBe(timestamp);
    }
  });

  it("refuses a response without the assigned timestamp or the signers", async () => {
    for (const missing of ["timestamp", "signersBitmap"] as const) {
      globalThis.fetch = mockFetch({
        execute: () => completed({ [missing]: undefined }),
      }) as unknown as typeof fetch;
      await expect(
        new MolphaGateway("http://gw1", registry, undefined, SUBSCRIPTION_OWNER).requestSignedData({
          signaturesRequired: 1,
          apiConfig,
          maxRetries: 1,
        }),
      ).rejects.toThrow(new RegExp(`missing ${missing}`));
    }
  });

  it("a second request in the same tick (409) is retried one tick later, as a new request", async () => {
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = mockFetch({
      execute: (_url, body) => {
        bodies.push(body);
        return bodies.length === 1 ? jsonResponse({ error: "duplicate round, retry" }, 409) : completed();
      },
    }) as unknown as typeof fetch;

    const delays: number[] = [];
    const gw = new MolphaGateway("http://gw1", registry, undefined, {
      defaultSubscriptionOwner: SUBSCRIPTION_OWNER,
      sleep: async (ms) => void delays.push(ms),
    });
    const result = await gw.requestSignedData({ signaturesRequired: 1, apiConfig, maxRetries: 3 });
    expect(result.value).toBe("1");
    expect(bodies).toHaveLength(2);
    // One wait of a tick, and the retry names no round: the gateway stamps it afresh.
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeGreaterThanOrEqual(100);
    expect(delays[0]).toBeLessThan(120);
    for (const body of bodies) expect(body).not.toHaveProperty("timestamp");
  });

  it("checks a gateway's program with fetchGatewayInfo, not on every request", async () => {
    globalThis.fetch = mockFetch({
      info: () =>
        jsonResponse({
          status: "ok",
          data: { gatewayAuthority: GATEWAY_AUTHORITY_1, programId: SYSTEM_PROGRAM },
        }),
      execute: () => completed(),
    }) as unknown as typeof fetch;

    const gw = new MolphaGateway("http://gw1", registry, undefined, SUBSCRIPTION_OWNER);
    await expect(gw.fetchGatewayInfo("http://gw1")).rejects.toThrow(/settles against program/);
  });
});

describe("MolphaGateway node count", () => {
  it("skips the node fetch when the registry read reports nodeCount", async () => {
    const fetchSpy = mockFetch({ execute: () => completed({ value: "42" }) });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const getRegistrySelectionConfig = vi.fn(async () => ({
      registryVersion: 3,
      redundancyBuffer: 2,
      nodeCount: 3,
    }));

    const gw = new MolphaGateway("http://gw1", getRegistrySelectionConfig);
    const result = await gw.requestSignedData(baseRequest);
    expect(result.value).toBe("42");
    expect(fetchSpy.mock.calls.map(([input]) => String(input))).toEqual([
      "http://gw1/v1/round/execute",
    ]);
  });

  it("throws when the cached node list disagrees with nodeCount", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const gw = new MolphaGateway("http://gw1", registry);
    await expect(
      gw.requestSignedData({
        ...baseRequest,
        context: { registryVersion: 1, redundancyBuffer: 2, nodeCount: 5, nodes },
      }),
    ).rejects.toThrow(/node_count 5/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("authenticates and encrypts for every registry node, not a selection", async () => {
    const verifyNodeKeys = vi.fn(async (_args: unknown) => undefined);
    globalThis.fetch = mockFetch({ execute: () => completed() }) as unknown as typeof fetch;

    const gw = new MolphaGateway("http://gw1", registry, undefined, {
      verifyNodeKeys,
      defaultSubscriptionOwner: SUBSCRIPTION_OWNER,
    });
    await gw.requestSignedData({
      signaturesRequired: 3,
      apiConfig: privateApiConfig,
      encrypt: privateApiEncrypt,
      context: { registryVersion: 1, redundancyBuffer: 5, nodeCount: 3, nodes: encryptedNodes },
    });
    // The committee depends on the gateway-assigned timestamp, so it is unknown here: every node of
    // the registry is a recipient.
    expect((verifyNodeKeys.mock.calls[0]?.[0] as { nodeIndexes: number[] }).nodeIndexes).toEqual([0, 1, 2]);
  });
});

describe("MolphaGateway response validation", () => {
  it("rejects a response whose sourceId differs from the request", async () => {
    globalThis.fetch = mockFetch({
      execute: () => completed({ sourceId: "ff".repeat(32) }),
    }) as unknown as typeof fetch;

    const gw = new MolphaGateway("http://gw1", registry);
    await expect(
      gw.requestSignedData({ ...baseRequest, maxRetries: 1 }),
    ).rejects.toThrow(/sourceId .* does not match/);
  });

  it("rejects a response whose signaturesRequired differs from the request", async () => {
    globalThis.fetch = mockFetch({
      execute: () => completed({ signaturesRequired: 2 }),
    }) as unknown as typeof fetch;

    const gw = new MolphaGateway("http://gw1", registry);
    await expect(
      gw.requestSignedData({ ...baseRequest, maxRetries: 1 }),
    ).rejects.toThrow(/signaturesRequired 2 does not match/);
  });

  it("keeps a cached attestation's earlier timestamp and registry version", async () => {
    globalThis.fetch = mockFetch({
      execute: () =>
        completed({
          sourceId: `0x${SOURCE_ID}`,
          timestamp: 5,
          registryVersion: 0,
          signersBitmap: "00".repeat(31) + "02",
          fresh: false,
        }),
    }) as unknown as typeof fetch;

    const gw = new MolphaGateway("http://gw1", registry);
    const result = await gw.requestSignedData(baseRequest);
    expect(result).toMatchObject({
      payload: {
        sourceId: SOURCE_ID,
        timestamp: 5,
        registryVersion: 0,
      },
      signature: { signersBitmap: "00".repeat(31) + "02" },
      fresh: false,
    });
  });
});

describe("MolphaGateway.requestSignedData cached context (short flow)", () => {
  it("skips the prelude fetches when a full context is supplied", async () => {
    const fetchSpy = mockFetch({ execute: () => completed({ value: "42", registryVersion: 7 }) });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const getRegistrySelectionConfig = vi.fn(async () => ({ registryVersion: 1, redundancyBuffer: 2 }));

    const gw = new MolphaGateway("http://gw1", getRegistrySelectionConfig);
    const result = await gw.requestSignedData({
      ...baseRequest,
      context: { registryVersion: 7, redundancyBuffer: 2, nodes },
    });

    expect(result.value).toBe("42");
    expect(result.payload.registryVersion).toBe(7);
    // No on-chain registry read, and the only fetch is the /execute POST.
    expect(getRegistrySelectionConfig).not.toHaveBeenCalled();
    const fetched = fetchSpy.mock.calls.map(([input]) => String(input));
    expect(fetched).toEqual(["http://gw1/v1/round/execute"]);
  });

  it("fetches only the fields missing from a partial context", async () => {
    const fetchSpy = mockFetch({ execute: () => completed({ value: "9" }) });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const getRegistrySelectionConfig = vi.fn(async () => ({ registryVersion: 3, redundancyBuffer: 2 }));

    const gw = new MolphaGateway("http://gw1", getRegistrySelectionConfig);
    const result = await gw.requestSignedData({
      ...baseRequest,
      // nodes cached; registry selection config still fetched.
      context: { nodes },
    });

    expect(result.value).toBe("9");
    expect(getRegistrySelectionConfig).toHaveBeenCalledTimes(1);
    const fetched = fetchSpy.mock.calls.map(([input]) => String(input));
    expect(fetched).not.toContain("http://gw1/v1/nodes");
  });

  it("prepareContext fetches all inputs once for reuse", async () => {
    globalThis.fetch = mockFetch({ execute: () => completed() }) as unknown as typeof fetch;
    const getRegistrySelectionConfig = vi.fn(async () => ({
      registryVersion: 5,
      redundancyBuffer: 2,
      nodeCount: 3,
    }));

    const gw = new MolphaGateway("http://gw1", getRegistrySelectionConfig);
    const ctx = await gw.prepareContext();

    expect(ctx.registryVersion).toBe(5);
    expect(ctx.redundancyBuffer).toBe(2);
    expect(ctx.nodeCount).toBe(3);
    expect(ctx.nodes).toEqual(nodes);
    expect(getRegistrySelectionConfig).toHaveBeenCalledTimes(1);
  });

  it("encrypts for every cached node whatever the redundancy buffer", async () => {
    const verifyNodeKeys = vi.fn(async (_args: unknown) => undefined);
    const postedBodies: Record<string, unknown>[] = [];
    globalThis.fetch = mockFetch({
      execute: (_url, body) => {
        postedBodies.push(body);
        return completed();
      },
    }) as unknown as typeof fetch;
    const getRegistrySelectionConfig = vi.fn(async () => ({ registryVersion: 1, redundancyBuffer: 2 }));

    const gw = new MolphaGateway("http://gw1", getRegistrySelectionConfig, undefined, {
      verifyNodeKeys,
      defaultSubscriptionOwner: SUBSCRIPTION_OWNER,
    });
    await gw.requestSignedData({
      signaturesRequired: 1,
      apiConfig: privateApiConfig,
      encrypt: privateApiEncrypt,
      // A buffer of 0 would select a single node; the committee is unknown at encryption time, so
      // the envelope set cannot depend on it.
      context: { registryVersion: 1, redundancyBuffer: 0, nodes: encryptedNodes },
    });
    expect((verifyNodeKeys.mock.calls[0]?.[0] as { nodeIndexes: number[] }).nodeIndexes).toEqual([0, 1, 2]);
    const envelopes = (postedBodies[0]?.encKeyBundle as { envelopes: Record<string, string> }).envelopes;
    expect(Object.keys(envelopes).sort()).toEqual(["0", "1", "2"]);
  });

  it("throws by default when encrypt.secrets is used without a verifier", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const getRegistrySelectionConfig = vi.fn(registry);

    const gw = new MolphaGateway("http://gw1", getRegistrySelectionConfig);
    await expect(
      gw.requestSignedData({
        signaturesRequired: 1,
        apiConfig: privateApiConfig,
        encrypt: privateApiEncrypt,
      }),
    ).rejects.toThrow(/requires authenticated node keys/);
    expect(getRegistrySelectionConfig).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows unverified encrypted node keys only with the explicit unsafe flag", async () => {
    let postedBody: Record<string, unknown> | undefined;
    globalThis.fetch = mockFetch({
      execute: (_url, body) => {
        postedBody = body;
        return completed();
      },
    }) as unknown as typeof fetch;

    const gw = new MolphaGateway("http://gw1", registry, undefined, {
      allowUnverifiedNodeKeysForPrivateApi: true,
      defaultSubscriptionOwner: SUBSCRIPTION_OWNER,
    });
    await gw.requestSignedData({
      signaturesRequired: 1,
      apiConfig: privateApiConfig,
      encrypt: privateApiEncrypt,
      context: { registryVersion: 1, redundancyBuffer: 2, nodes: [encryptedNodes[0]!] },
    });

    expect(postedBody?.encKeyBundle).toMatchObject({
      envelopes: expect.objectContaining({ "0": expect.any(String) }),
    });
  });

  it("proceeds when a verifier accepts the selected nodes", async () => {
    const verifyNodeKeys = vi.fn(async (_args: unknown) => undefined);
    let postedBody: Record<string, unknown> | undefined;
    globalThis.fetch = mockFetch({
      execute: (_url, body) => {
        postedBody = body;
        return completed();
      },
    }) as unknown as typeof fetch;

    const gw = new MolphaGateway("http://gw1", registry, undefined, {
      verifyNodeKeys,
      defaultSubscriptionOwner: SUBSCRIPTION_OWNER,
    });
    await gw.requestSignedData({
      signaturesRequired: 3,
      apiConfig: privateApiConfig,
      encrypt: privateApiEncrypt,
      context: { registryVersion: 1, redundancyBuffer: 2, nodes: encryptedNodes },
    });

    expect(verifyNodeKeys).toHaveBeenCalledTimes(1);
    expect(verifyNodeKeys.mock.calls[0]?.[0]).toMatchObject({
      sourceId: deriveSourceIdString(privateApiConfig),
      registryVersion: 1,
      nodeIndexes: [0, 1, 2],
      nodes: encryptedNodes,
    });
    expect(postedBody?.sourceId).toBe(deriveSourceIdString(privateApiConfig));
    expect(postedBody?.encKeyBundle).toMatchObject({
      envelopes: expect.objectContaining({
        "0": expect.any(String),
        "1": expect.any(String),
        "2": expect.any(String),
      }),
    });
  });

  it("does not post the encrypted request when the verifier rejects", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const verifyNodeKeys = vi.fn(async () => {
      throw new Error("node key mismatch");
    });

    const gw = new MolphaGateway("http://gw1", registry, undefined, {
      verifyNodeKeys,
      defaultSubscriptionOwner: SUBSCRIPTION_OWNER,
    });
    await expect(
      gw.requestSignedData({
        signaturesRequired: 1,
        apiConfig: privateApiConfig,
        encrypt: privateApiEncrypt,
        context: { registryVersion: 1, redundancyBuffer: 2, nodes: [encryptedNodes[0]!] },
      }),
    ).rejects.toThrow(/node key mismatch/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects duplicate selected node indexes before encryption", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const duplicateNodes = [encryptedNodes[0]!, { ...encryptedNodes[1]!, index: 0 }];

    const gw = new MolphaGateway("http://gw1", registry, undefined, {
      allowUnverifiedNodeKeysForPrivateApi: true,
      defaultSubscriptionOwner: SUBSCRIPTION_OWNER,
    });
    await expect(
      gw.requestSignedData({
        signaturesRequired: 2,
        apiConfig: privateApiConfig,
        encrypt: privateApiEncrypt,
        context: { registryVersion: 1, redundancyBuffer: 2, nodes: duplicateNodes },
      }),
    ).rejects.toThrow(/duplicate node index/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects duplicate selected node public keys before encryption", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const duplicateKeyNodes = [
      encryptedNodes[0]!,
      { ...encryptedNodes[1]!, signingKey: encryptedNodes[0]!.signingKey },
    ];

    const gw = new MolphaGateway("http://gw1", registry, undefined, {
      allowUnverifiedNodeKeysForPrivateApi: true,
      defaultSubscriptionOwner: SUBSCRIPTION_OWNER,
    });
    await expect(
      gw.requestSignedData({
        signaturesRequired: 2,
        apiConfig: privateApiConfig,
        encrypt: privateApiEncrypt,
        context: { registryVersion: 1, redundancyBuffer: 2, nodes: duplicateKeyNodes },
      }),
    ).rejects.toThrow(/duplicate selected node signingKey/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects invalid secp256k1 node public keys before encryption", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const invalidNodes = [{ ...encryptedNodes[0]!, signingKey: "02".padEnd(66, "0") }];

    const gw = new MolphaGateway("http://gw1", registry, undefined, {
      allowUnverifiedNodeKeysForPrivateApi: true,
      defaultSubscriptionOwner: SUBSCRIPTION_OWNER,
    });
    await expect(
      gw.requestSignedData({
        signaturesRequired: 1,
        apiConfig: privateApiConfig,
        encrypt: privateApiEncrypt,
        context: { registryVersion: 1, redundancyBuffer: 2, nodes: invalidNodes },
      }),
    ).rejects.toThrow(/invalid secp256k1 public key/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("MolphaGateway.requestSignedData tolerance (median) mode", () => {
  const aggregation = {
    mode: "tolerance" as const,
    rule: "median" as const,
    maxDeviationBps: 50,
    maxAgeMs: 2000,
    numeric: { type: "int256" as const, decimals: 8 },
  };
  const toleranceConfig = { ...apiConfig, aggregation };
  const TOLERANCE_SOURCE_ID = deriveSourceIdString(toleranceConfig);
  // 42150.12345678 at 8 decimals, as a signed int256 word.
  const PACKED = "00".repeat(26) + "03d56250474e";

  const toleranceResponse = (extra: SignedResponseFields = {}) =>
    completed({
      sourceId: TOLERANCE_SOURCE_ID,
      configHash: TOLERANCE_SOURCE_ID,
      value: "stale-display-value",
      valuePacked: PACKED,
      signersBitmap: "00".repeat(31) + "0e",
      signaturesRequired: 3,
      ...extra,
    });

  it("renders a tolerance value from the nested attestation's signed payload.value", async () => {
    globalThis.fetch = mockFetch({
      execute: () =>
        jsonResponse({
          status: "completed",
          data: {
            attestation: {
              payload: {
                value: PACKED,
                sourceId: TOLERANCE_SOURCE_ID,
                registryVersion: 4,
                signaturesRequired: 3,
                timestamp: 1_700_000_123,
              },
              signature: {
                signature: "aa".repeat(32),
                commitment: "bb".repeat(20),
                signersBitmap: "00".repeat(31) + "0e",
              },
            },
            value: "stale-display-value",
            fresh: true,
            configHash: TOLERANCE_SOURCE_ID,
            aggregation,
          },
        }),
    }) as unknown as typeof fetch;

    const gw = new MolphaGateway("http://gw1", registry);
    const result = await gw.requestSignedData({ ...baseRequest, signaturesRequired: 3, apiConfig: toleranceConfig });

    expect(result.value).toBe("42150.12345678");
    expect(result.payload.value).toBe(PACKED);
    expect(result.signature.signersBitmap).toBe("00".repeat(31) + "0e");
  });

  it("derives the sourceId from the aggregation and forwards it in the canonical apiConfig", async () => {
    let postedBody: Record<string, unknown> | undefined;
    globalThis.fetch = mockFetch({
      execute: (_url, body) => {
        postedBody = body;
        return toleranceResponse();
      },
    }) as unknown as typeof fetch;

    const gw = new MolphaGateway("http://gw1", registry);
    const result = await gw.requestSignedData({
      ...baseRequest,
      signaturesRequired: 3,
      apiConfig: {
        ...apiConfig,
        // Deliberately shuffled input: the wire form must still be canonical.
        aggregation: {
          numeric: { decimals: 8, type: "int256" },
          maxAgeMs: 2000,
          maxDeviationBps: 50,
          rule: "median",
          mode: "tolerance",
        } as typeof aggregation,
      },
    });

    expect(TOLERANCE_SOURCE_ID).not.toBe(SOURCE_ID);
    expect(postedBody?.sourceId).toBe(TOLERANCE_SOURCE_ID);
    expect(JSON.stringify(postedBody?.apiConfig)).toBe(
      '{"url":"http://api","method":"GET","headers":{},"responseParser":"$.price","valueTransform":"",' +
        '"aggregation":{"mode":"tolerance","rule":"median","maxDeviationBps":50,"maxAgeMs":2000,"numeric":{"type":"int256","decimals":8}}}',
    );
    expect(result.payload.sourceId).toBe(TOLERANCE_SOURCE_ID);
  });

  it("omits aggregation from the wire body for exact mode", async () => {
    let postedBody: Record<string, unknown> | undefined;
    globalThis.fetch = mockFetch({
      execute: (_url, body) => {
        postedBody = body;
        return completed();
      },
    }) as unknown as typeof fetch;
    await new MolphaGateway("http://gw1", registry).requestSignedData(baseRequest);
    expect(postedBody?.apiConfig).not.toHaveProperty("aggregation");
  });

  it("rejects signaturesRequired < 3 client-side, before any request", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const gw = new MolphaGateway("http://gw1", registry);
    for (const signaturesRequired of [1, 2]) {
      await expect(
        gw.requestSignedData({ ...baseRequest, signaturesRequired, apiConfig: toleranceConfig }),
      ).rejects.toThrow(/tolerance aggregation requires signaturesRequired >= 3/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects mode "exact" and unsupported rules before any request', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const gw = new MolphaGateway("http://gw1", registry);
    await expect(
      gw.requestSignedData({
        ...baseRequest,
        signaturesRequired: 3,
        apiConfig: { ...apiConfig, aggregation: { ...aggregation, mode: "exact" } as never },
      }),
    ).rejects.toThrow(/mode "exact" is not accepted/);
    await expect(
      gw.requestSignedData({
        ...baseRequest,
        signaturesRequired: 3,
        apiConfig: { ...apiConfig, aggregation: { ...aggregation, rule: "mean" } as never },
      }),
    ).rejects.toThrow(/unsupported aggregation.rule/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders value from the signed valuePacked at the source's decimals", async () => {
    globalThis.fetch = mockFetch({ execute: () => toleranceResponse() }) as unknown as typeof fetch;
    const result = await new MolphaGateway("http://gw1", registry).requestSignedData({
      ...baseRequest,
      signaturesRequired: 3,
      apiConfig: toleranceConfig,
    });
    expect(result.value).toBe("42150.12345678");
    expect(result.payload.value).toBe(PACKED);
    // The final signing set comes from the response, not the request's selection bitmap.
    expect(result.signature.signersBitmap).toBe("00".repeat(31) + "0e");
  });

  it("renders negative values", async () => {
    globalThis.fetch = mockFetch({
      execute: () => toleranceResponse({ valuePacked: "ff".repeat(31) + "9c" }), // -100 @ 8dp
    }) as unknown as typeof fetch;
    const result = await new MolphaGateway("http://gw1", registry).requestSignedData({
      ...baseRequest,
      signaturesRequired: 3,
      apiConfig: toleranceConfig,
    });
    expect(result.value).toBe("-0.000001");
  });

  it("requires the signed fields in a tolerance response", async () => {
    const labels = { valuePacked: "value", signersBitmap: "signersBitmap", s: "s", commitmentAddr: "commitmentAddr" } as const;
    for (const missing of ["valuePacked", "signersBitmap", "s", "commitmentAddr"] as const) {
      globalThis.fetch = mockFetch({
        execute: () => toleranceResponse({ [missing]: undefined }),
      }) as unknown as typeof fetch;
      await expect(
        new MolphaGateway("http://gw1", registry).requestSignedData({
          ...baseRequest,
          signaturesRequired: 3,
          apiConfig: toleranceConfig,
          maxRetries: 1,
        }),
      ).rejects.toThrow(new RegExp(`missing ${labels[missing]}`));
    }
  });

  it("rejects a gateway that derived a different identity (e.g. dropped aggregation)", async () => {
    globalThis.fetch = mockFetch({
      execute: () => toleranceResponse({ sourceId: SOURCE_ID, configHash: SOURCE_ID }),
    }) as unknown as typeof fetch;
    await expect(
      new MolphaGateway("http://gw1", registry).requestSignedData({
        ...baseRequest,
        signaturesRequired: 3,
        apiConfig: toleranceConfig,
        maxRetries: 1,
      }),
    ).rejects.toThrow(/does not match the requested/);

    globalThis.fetch = mockFetch({
      execute: () => toleranceResponse({ configHash: SOURCE_ID }),
    }) as unknown as typeof fetch;
    await expect(
      new MolphaGateway("http://gw1", registry).requestSignedData({
        ...baseRequest,
        signaturesRequired: 3,
        apiConfig: toleranceConfig,
        maxRetries: 1,
      }),
    ).rejects.toThrow(/configHash .* does not match/);
  });

  it("checks the gateway's aggregation echo against the request", async () => {
    const request = () =>
      new MolphaGateway("http://gw1", registry).requestSignedData({
        ...baseRequest,
        signaturesRequired: 3,
        apiConfig: toleranceConfig,
        maxRetries: 1,
      });

    globalThis.fetch = mockFetch({
      execute: () => toleranceResponse({ aggregation }),
    }) as unknown as typeof fetch;
    await expect(request()).resolves.toMatchObject({ value: "42150.12345678" });

    globalThis.fetch = mockFetch({
      execute: () => toleranceResponse({ aggregation: { ...aggregation, maxDeviationBps: 51 } }),
    }) as unknown as typeof fetch;
    await expect(request()).rejects.toThrow(/aggregation .* does not match the requested/);

    // An exact request must not come back as a tolerance round.
    globalThis.fetch = mockFetch({
      execute: () => completed({ aggregation }),
    }) as unknown as typeof fetch;
    await expect(
      new MolphaGateway("http://gw1", registry).requestSignedData({ ...baseRequest, maxRetries: 1 }),
    ).rejects.toThrow(/request was exact mode/);
  });

  it("encrypts the tolerance config and the plaintext hashes to the sourceId", async () => {
    let postedBody: Record<string, unknown> | undefined;
    globalThis.fetch = mockFetch({
      execute: (_url, body) => {
        postedBody = body;
        return toleranceResponse();
      },
    }) as unknown as typeof fetch;
    const config = toleranceConfig;
    const gw = new MolphaGateway("http://gw1", registry, undefined, {
      allowUnverifiedNodeKeysForPrivateApi: true,
      defaultSubscriptionOwner: SUBSCRIPTION_OWNER,
    });
    await expect(
      gw.requestSignedData({
        signaturesRequired: 3,
        apiConfig: config,
        encrypt: { secrets: {} },
        context: { registryVersion: 1, redundancyBuffer: 2, nodes: encryptedNodes },
        maxRetries: 1,
      }),
    ).resolves.toMatchObject({ payload: { sourceId: TOLERANCE_SOURCE_ID } });
    expect(postedBody?.sourceId).toBe(deriveSourceIdString(config));
    expect((postedBody?.apiConfig as Record<string, unknown>).aggregation).toEqual(aggregation);
    expect(postedBody?.encKeyBundle).toBeDefined();
  });
});
