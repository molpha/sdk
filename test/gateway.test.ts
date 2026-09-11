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
    if (url.endsWith("/nodes")) return jsonResponse(nodes);
    if (url.endsWith("/health")) return jsonResponse({ ok: true });
    throw new Error(`unexpected fetch: ${url}`);
  });
}

const completed = (extra: Record<string, unknown> = {}) =>
  jsonResponse({ status: "completed", value: "1", ...extra });

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
    timestamp: body.timestamp as number,
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
        jsonResponse({
          status: "completed",
          sourceId: SOURCE_ID,
          value: "100",
          valuePacked: "00".repeat(32),
          signersBitmap: "00".repeat(31) + "01",
          s: "aa".repeat(32),
          commitmentAddr: "bb".repeat(20),
          signaturesRequired: 1,
          fresh: true,
        }),
    }) as unknown as typeof fetch;

    const gw = new MolphaGateway("http://gw1", registry);
    const result = await gw.requestSignedData(baseRequest);
    expect(result.value).toBe("100");
    expect(result.sourceId).toBe(SOURCE_ID);
    expect(result.commitmentAddr).toBe("bb".repeat(20));
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
        : jsonResponse({ status: "completed", value: "7" }),
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
  it("uses defaultSigner over the program id and the endpoint's Gateway PDA", async () => {
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
        timestamp: postedBody!.timestamp as number,
      }),
    );
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

  it("times out a hanging /v1/info and fails over to the next endpoint", async () => {
    const { publicKey, signer } = ed25519Signer();
    let postedBody: Record<string, unknown> | undefined;
    globalThis.fetch = mockFetch({
      info: (url, init) => {
        if (url.startsWith("http://gw1")) {
          return new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) return;
            if (signal.aborted) {
              reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
              return;
            }
            signal.addEventListener("abort", () => {
              reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
            });
          });
        }
        return jsonResponse({ status: "ok", data: { gatewayAuthority: GATEWAY_AUTHORITY_2 } });
      },
      execute: (_url, body) => {
        postedBody = body;
        return completed({ value: "9" });
      },
    }) as unknown as typeof fetch;

    const gw = new MolphaGateway(["http://gw1", "http://gw2"], registry, signer, SUBSCRIPTION_OWNER);
    const result = await gw.requestSignedData({
      signaturesRequired: 1,
      apiConfig,
      timeoutMs: 50,
    });
    expect(result.value).toBe("9");
    expect(await expectedAuthSig(publicKey, postedBody!, GATEWAY_AUTHORITY_2)).toBe(true);
  });

  it("never contacts /v1/info without a signer", async () => {
    const fetchSpy = mockFetch({ execute: () => completed() });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const gw = new MolphaGateway("http://gw1", registry);
    await gw.requestSignedData(baseRequest);
    const fetched = fetchSpy.mock.calls.map(([input]) => String(input));
    expect(fetched.some((url) => url.endsWith("/v1/info"))).toBe(false);
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

  it("derives the selection from nodeCount when encrypting", async () => {
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
    // groupSize = min(3 + 5, nodeCount 3) = 3
    expect(
      (verifyNodeKeys.mock.calls[0]?.[0] as { selectedIndexes: number[] }).selectedIndexes,
    ).toEqual([0, 1, 2]);
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
      sourceId: SOURCE_ID,
      timestamp: 5,
      registryVersion: 0,
      signersBitmap: "00".repeat(31) + "02",
      fresh: false,
    });
  });
});

describe("MolphaGateway.requestSignedData cached context (short flow)", () => {
  it("skips the prelude fetches when a full context is supplied", async () => {
    const fetchSpy = mockFetch({ execute: () => completed({ value: "42" }) });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const getRegistrySelectionConfig = vi.fn(async () => ({ registryVersion: 1, redundancyBuffer: 2 }));

    const gw = new MolphaGateway("http://gw1", getRegistrySelectionConfig);
    const result = await gw.requestSignedData({
      ...baseRequest,
      context: { registryVersion: 7, redundancyBuffer: 2, nodes },
    });

    expect(result.value).toBe("42");
    expect(result.registryVersion).toBe(7);
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

  it("uses the cached redundancyBuffer for selection size", async () => {
    const verifyNodeKeys = vi.fn(async (_args: unknown) => undefined);
    globalThis.fetch = mockFetch({ execute: () => completed() }) as unknown as typeof fetch;
    const getRegistrySelectionConfig = vi.fn(async () => ({
      registryVersion: 1,
      redundancyBuffer: 2,
    }));

    const gw = new MolphaGateway("http://gw1", getRegistrySelectionConfig, undefined, {
      verifyNodeKeys,
      defaultSubscriptionOwner: SUBSCRIPTION_OWNER,
    });
    await gw.requestSignedData({
      signaturesRequired: 1,
      apiConfig: privateApiConfig,
      encrypt: privateApiEncrypt,
      context: {
        registryVersion: 1,
        // On-chain buffer lowered to 0 — select only signaturesRequired nodes.
        redundancyBuffer: 0,
        nodes: encryptedNodes,
      },
    });

    expect(getRegistrySelectionConfig).not.toHaveBeenCalled();
    expect((verifyNodeKeys.mock.calls[0]?.[0] as { selectedIndexes: number[] }).selectedIndexes)
      .toHaveLength(1);
  });
});

describe("MolphaGateway.requestSignedData private API encryption node key verification", () => {
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
      selectedIndexes: [0, 1, 2],
      selectedNodes: encryptedNodes,
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
