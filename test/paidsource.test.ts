import { afterEach, describe, expect, it, vi } from "vitest";
import { base64ToBytes } from "../src/core/encoding.js";
import { createEvmSignerFromPrivateKey } from "../src/evm/eip712.js";
import { MolphaGateway, UpstreamPaymentRequiredError } from "../src/gateway/index.js";

const SUBSCRIPTION_OWNER = "9K9FknHzW7j8a88yKTrzxKfDrxnV2QLqSR58ETAVdc8P";
const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const SOURCE_URL = "https://paid.example/price";

const nodes = [
  { index: 0, peerId: "a", address: "n0", signingKey: "02".padEnd(66, "0") },
  { index: 1, peerId: "b", address: "n1", signingKey: "03".padEnd(66, "0") },
  { index: 2, peerId: "c", address: "n2", signingKey: "02".padEnd(66, "1") },
];

/** signaturesRequired 1 + redundancyBuffer 2, capped at 3 nodes → eligible set 3. */
const registry = async () => ({ registryVersion: 1, redundancyBuffer: 2 });

const apiConfig = { url: SOURCE_URL, responseParser: "$.price" };
const evmSigner = () => createEvmSignerFromPrivateKey("0x" + "01".repeat(32));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The source's own x402 terms, as a paywalled API answers an unpaid fetch. */
function sourceTerms(overrides: Record<string, unknown> = {}): Response {
  return jsonResponse(
    {
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "eip155:84532",
          asset: BASE_SEPOLIA_USDC,
          payTo: "0x1111111111111111111111111111111111111111",
          amount: "10000",
          maxTimeoutSeconds: 60,
          extra: { name: "USDC", version: "2" },
          ...overrides,
        },
      ],
    },
    402,
  );
}

/** The gateway's relayed quote: payment required, just not to Molpha. */
function upstreamQuote(eligibleSetSize: number, error?: string): Response {
  return jsonResponse(
    {
      x402Version: 2,
      error: "upstream source requires payment",
      accepts: [],
      extensions: {
        upstream: {
          resource: SOURCE_URL,
          signaturesRequired: 1,
          redundancyBuffer: 2,
          nodeCount: 3,
          eligibleSetSize,
          supportedX402Versions: [1, 2],
          ...(error ? { error } : {}),
        },
      },
    },
    402,
  );
}

const completed = () =>
  jsonResponse({
    status: "completed",
    value: "100",
    valuePacked: "00".repeat(32),
    signersBitmap: "00".repeat(31) + "01",
    s: "aa".repeat(32),
    commitmentAddr: "bb".repeat(20),
    fresh: true,
  });

/** Routes the SDK's three destinations: the source, /v1/nodes, and the round. */
function mockFetch(handlers: {
  source?: (probe: number) => Response;
  nodes?: () => Response;
  round: (body: Record<string, unknown>, attempt: number) => Response;
}) {
  const rounds: Record<string, unknown>[] = [];
  let probes = 0;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/nodes")) return handlers.nodes?.() ?? jsonResponse({ nodes });
    if (url.endsWith("/v1/round/execute")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      rounds.push(body);
      return handlers.round(body, rounds.length);
    }
    probes++;
    return handlers.source?.(probes) ?? sourceTerms();
  }) as unknown as typeof fetch;
  return { rounds, probes: () => probes };
}

const request = (extra: Record<string, unknown> = {}) => ({
  signaturesRequired: 1,
  apiConfig,
  subscriptionOwner: SUBSCRIPTION_OWNER,
  maxRetries: 3,
  ...extra,
});

/** The authorization nonces the caller signed, in wire order. */
function nonces(body: Record<string, unknown>): string[] {
  return (body.sourcePayments as string[]).map((raw) => {
    const payload = JSON.parse(new TextDecoder().decode(base64ToBytes(raw))) as {
      payload: { authorization: { nonce: string } };
    };
    return payload.payload.authorization.nonce;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("paywalled API sources", () => {
  it("funds the whole eligible set before dispatch, pricing the source once", async () => {
    const mock = mockFetch({ round: () => completed() });

    const result = await new MolphaGateway("http://gw1", registry).requestSignedData(
      request({ sourcePayment: { signer: evmSigner() } }),
    );

    expect(result.value).toBe("100");
    expect(mock.rounds).toHaveLength(1);
    // min(1 signature + 2 buffer, 3 nodes) = 3 — the caller pays per node fetch.
    expect((mock.rounds[0]!.sourcePayments as string[])).toHaveLength(3);
    expect(mock.probes()).toBe(1);
  });

  it("signs the source's terms into each authorization", async () => {
    const mock = mockFetch({ round: () => completed() });

    await new MolphaGateway("http://gw1", registry).requestSignedData(
      request({ sourcePayment: { signer: evmSigner() } }),
    );

    const payloads = (mock.rounds[0]!.sourcePayments as string[]).map(
      (raw) =>
        JSON.parse(new TextDecoder().decode(base64ToBytes(raw))) as Record<string, unknown>,
    );
    for (const payload of payloads) {
      expect(payload.x402Version).toBe(2);
      const auth = (payload.payload as { authorization: Record<string, string> }).authorization;
      expect(auth.to).toBe("0x1111111111111111111111111111111111111111");
      expect(auth.value).toBe("10000");
      expect(auth.from).toBe(evmSigner().address);
      expect((payload.payload as { signature: string }).signature).toMatch(/^0x[0-9a-f]{130}$/);
    }
    // A unique nonce per authorization is what prevents a double settle.
    expect(new Set(nonces(mock.rounds[0]!)).size).toBe(3);
  });

  it("re-signs with fresh nonces on a retry, as a new round", async () => {
    const mock = mockFetch({
      round: (_body, attempt) =>
        attempt === 1 ? jsonResponse({ error: "busy" }, 503) : completed(),
    });

    await new MolphaGateway("http://gw1", registry).requestSignedData(
      request({ sourcePayment: { signer: evmSigner() } }),
    );

    expect(mock.rounds).toHaveLength(2);
    // A dispatched round tuple cannot be replayed, so the retry is a new round.
    expect(mock.rounds[0]!.timestamp).not.toBe(mock.rounds[1]!.timestamp);
    const reused = nonces(mock.rounds[0]!).filter((n) => nonces(mock.rounds[1]!).includes(n));
    expect(reused).toEqual([]);
  });

  it("tells a caller with no source wallet what the source costs", async () => {
    const mock = mockFetch({ round: () => upstreamQuote(3) });

    await expect(
      new MolphaGateway("http://gw1", registry).requestSignedData(request()),
    ).rejects.toThrow(UpstreamPaymentRequiredError);

    expect(mock.rounds).toHaveLength(1);
    expect(mock.probes()).toBe(0);
  });

  it("carries the gateway's quote on the thrown error", async () => {
    mockFetch({ round: () => upstreamQuote(3, "api response status 402: pay up") });

    const error = await new MolphaGateway("http://gw1", registry)
      .requestSignedData(request())
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(UpstreamPaymentRequiredError);
    const quote = (error as UpstreamPaymentRequiredError).quote;
    expect(quote.eligibleSetSize).toBe(3);
    expect(quote.resource).toBe(SOURCE_URL);
    expect(quote.error).toBe("api response status 402: pay up");
  });

  it("recovers an undeclared paywall on a fresh round", async () => {
    const mock = mockFetch({
      // The source only reveals its paywall after the round has been dispatched.
      source: (probe) => (probe === 1 ? jsonResponse({ price: 1 }) : sourceTerms()),
      round: (_body, attempt) =>
        attempt === 1
          ? upstreamQuote(3, "api response status 402: pay up")
          : completed(),
    });

    const result = await new MolphaGateway("http://gw1", registry).requestSignedData(
      request({ sourcePayment: { signer: evmSigner() } }),
    );

    expect(result.value).toBe("100");
    expect(mock.rounds).toHaveLength(2);
    expect(mock.rounds[0]!.sourcePayments).toBeUndefined();
    expect((mock.rounds[1]!.sourcePayments as string[])).toHaveLength(3);
    expect(mock.rounds[0]!.timestamp).not.toBe(mock.rounds[1]!.timestamp);
  });

  it("rejects an upstream quote whose eligible set exceeds the round selection", async () => {
    mockFetch({
      round: () => upstreamQuote(5),
    });

    await expect(
      new MolphaGateway("http://gw1", registry).requestSignedData(
        request({ sourcePayment: { signer: evmSigner() } }),
      ),
    ).rejects.toThrow(/eligibleSetSize 5 does not match this round's selection size 3/);
  });

  it("stops instead of resigning forever against a source that keeps refusing", async () => {
    const mock = mockFetch({
      round: () => upstreamQuote(3, "source payment rejected"),
    });

    await expect(
      new MolphaGateway("http://gw1", registry).requestSignedData(
        request({ sourcePayment: { signer: evmSigner() }, maxRetries: 10 }),
      ),
    ).rejects.toThrow(/was not accepted/);

    expect(mock.rounds.length).toBeLessThanOrEqual(2);
  });

  it("fails fast when a discovered paywall wants terms the SDK cannot sign", async () => {
    const mock = mockFetch({
      // Looks free on the probe, then demands an asset this SDK will not sign.
      source: (probe) =>
        probe === 1
          ? jsonResponse({ price: 1 })
          : sourceTerms({ network: "eip155:1", asset: "0x" + "99".repeat(20) }),
      round: () => upstreamQuote(3, "api response status 402: pay up"),
    });

    await expect(
      new MolphaGateway("http://gw1", registry).requestSignedData(
        request({ sourcePayment: { signer: evmSigner() }, maxRetries: 10 }),
      ),
    ).rejects.toThrow(/Cannot pay .*unsupported payment scheme or network/);

    // Terminal: re-probing once per attempt would be pointless round trips.
    expect(mock.rounds).toHaveLength(1);
  });

  it("does not retry a 402 that carries no upstream quote", async () => {
    const mock = mockFetch({
      round: () => jsonResponse({ x402Version: 2, accepts: [] }, 402),
    });

    await expect(
      new MolphaGateway("http://gw1", registry).requestSignedData(
        request({ maxRetries: 10 }),
      ),
    ).rejects.toThrow(/no upstream source quote/);

    expect(mock.rounds).toHaveLength(1);
  });

  it("runs a source that is not paywalled as an ordinary round", async () => {
    const mock = mockFetch({
      source: () => jsonResponse({ price: 1 }),
      round: () => completed(),
    });

    await new MolphaGateway("http://gw1", registry).requestSignedData(
      request({ sourcePayment: { signer: evmSigner() } }),
    );

    expect(mock.rounds).toHaveLength(1);
    expect(mock.rounds[0]!.sourcePayments).toBeUndefined();
    // Declaring a paid source would force a quote round trip for nothing.
    expect(mock.rounds[0]!.x402Source).toBeUndefined();
  });

  it("skips the probe when the caller supplies terms", async () => {
    const mock = mockFetch({ round: () => completed() });

    await new MolphaGateway("http://gw1", registry).requestSignedData(
      request({
        sourcePayment: {
          signer: evmSigner(),
          terms: {
            x402Version: 2 as const,
            requirements: {
              scheme: "exact",
              network: "base-sepolia",
              asset: BASE_SEPOLIA_USDC,
              payTo: "0x2222222222222222222222222222222222222222",
              amount: "250",
              maxTimeoutSeconds: 60,
              extra: { name: "USDC", version: "2" },
            },
            network: "base-sepolia",
            chainId: 84532,
            asset: BASE_SEPOLIA_USDC,
            payTo: "0x2222222222222222222222222222222222222222",
            amount: "250",
            maxTimeoutSeconds: 60,
            domain: { name: "USDC", version: "2" },
            resource: SOURCE_URL,
          },
        },
      }),
    );

    expect(mock.probes()).toBe(0);
    const payload = JSON.parse(
      new TextDecoder().decode(base64ToBytes((mock.rounds[0]!.sourcePayments as string[])[0]!)),
    ) as { payload: { authorization: Record<string, string> } };
    expect(payload.payload.authorization.value).toBe("250");
  });

  it("refuses caller-supplied terms that fail the Base USDC allowlist", async () => {
    mockFetch({ round: () => completed() });

    const badTerms = {
      x402Version: 2 as const,
      requirements: {
        scheme: "exact",
        network: "eip155:1",
        asset: "0x" + "99".repeat(20),
        payTo: "0x2222222222222222222222222222222222222222",
        amount: "250",
        extra: { name: "USDC", version: "2" },
      },
      network: "eip155:84532",
      chainId: 84532,
      asset: BASE_SEPOLIA_USDC,
      payTo: "0x2222222222222222222222222222222222222222",
      amount: "250",
      maxTimeoutSeconds: 60,
      domain: { name: "USDC", version: "2" },
      resource: SOURCE_URL,
    };

    await expect(
      new MolphaGateway("http://gw1", registry).requestSignedData(
        request({ sourcePayment: { signer: evmSigner(), terms: badTerms } }),
      ),
    ).rejects.toThrow(/unsupported payment scheme or network/);
  });

  it("refuses a source asking for an asset or network the SDK cannot sign", async () => {
    mockFetch({
      source: () => sourceTerms({ network: "eip155:1", asset: "0x" + "99".repeat(20) }),
      round: () => completed(),
    });

    await expect(
      new MolphaGateway("http://gw1", registry).requestSignedData(
        request({ sourcePayment: { signer: evmSigner() } }),
      ),
    ).rejects.toThrow(/unsupported payment scheme or network/);
  });

  it("refuses a source that omits the EIP-712 asset domain", async () => {
    mockFetch({
      source: () => sourceTerms({ extra: undefined }),
      round: () => completed(),
    });

    await expect(
      new MolphaGateway("http://gw1", registry).requestSignedData(
        request({ sourcePayment: { signer: evmSigner() } }),
      ),
    ).rejects.toThrow(/supply sourcePayment.assetDomain/);
  });

  it("signs against an assetDomain override when the source omits one", async () => {
    const mock = mockFetch({
      source: () => sourceTerms({ extra: undefined }),
      round: () => completed(),
    });

    await new MolphaGateway("http://gw1", registry).requestSignedData(
      request({
        sourcePayment: { signer: evmSigner(), assetDomain: { name: "USDC", version: "2" } },
      }),
    );

    expect((mock.rounds[0]!.sourcePayments as string[])).toHaveLength(3);
  });
});

describe("GET /v1/nodes", () => {
  it("surfaces the advisory registry policy", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        status: "ok",
        data: { nodes, registry: { version: 7, nodeCount: 12, redundancyBuffer: 2 } },
      }),
    ) as unknown as typeof fetch;

    const info = await new MolphaGateway("http://gw1", registry).getNodesInfo();
    expect(info.nodes).toHaveLength(3);
    expect(info.registry).toEqual({ version: 7, nodeCount: 12, redundancyBuffer: 2 });
  });

  it("tolerates a gateway that reports no registry block", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ status: "ok", data: { nodes } }),
    ) as unknown as typeof fetch;

    const gw = new MolphaGateway("http://gw1", registry);
    expect((await gw.getNodesInfo()).registry).toBeUndefined();
    expect(await gw.getNodes()).toHaveLength(3);
  });

  it("still accepts a bare node array", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(nodes)) as unknown as typeof fetch;

    const info = await new MolphaGateway("http://gw1", registry).getNodesInfo();
    expect(info.nodes).toHaveLength(3);
    expect(info.registry).toBeUndefined();
  });
});
