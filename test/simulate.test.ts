import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonPriceSource } from "../src/core/sourcebuild.js";
import { deriveRoundIdHex } from "../src/core/round.js";
import { MolphaGateway, SimulateError, simulateSource } from "../src/gateway/index.js";
import { signedResponseBody } from "./fixtures/gatewayResponse.js";

const source = jsonPriceSource({ url: "https://api.example.com/p", path: "$.price", decimals: 0 });

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const simulation = {
  sourceId: source.idHex.slice(2),
  source: source.doc,
  inputs: [{ name: "price", kind: "http", fields: [{ name: "price", type: "decimal", value: "100" }] }],
  value: { encoded: "0x" + "00".repeat(31) + "64", display: "100", type: "int256", decimals: 0 },
};

afterEach(() => vi.restoreAllMocks());

describe("simulateSource", () => {
  it("posts the source, inputs and timestamp and returns the simulation", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ status: "ok", data: simulation }));
    const got = await simulateSource("https://gw.example/", source.doc, { price: { body: '{"price":100}' } }, {
      timestampMs: 1_795_000_000_500,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(got.value?.display).toBe("100");
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://gw.example/v1/source/simulate");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      source: source.doc,
      inputs: { price: { body: '{"price":100}' } },
      timestampMs: 1_795_000_000_500,
    });
  });

  it("leaves the timestamp to the gateway when none is given", async () => {
    const fetch = vi.fn(async () => jsonResponse({ status: "ok", data: simulation }));
    await simulateSource("https://gw.example", source.doc, { price: { error: "fetch" } }, { fetch: fetch as unknown as typeof globalThis.fetch });
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body))).not.toHaveProperty("timestampMs");
  });

  it("throws the gateway's refusal with its status and Retry-After", async () => {
    const refuse = (status: number, headers: Record<string, string> = {}) =>
      vi.fn(async () => jsonResponse({ error: "inputs.price is missing" }, status, headers)) as unknown as typeof globalThis.fetch;
    await expect(simulateSource("https://gw", source.doc, {}, { fetch: refuse(400) })).rejects.toMatchObject({
      name: "SimulateError",
      status: 400,
      message: "inputs.price is missing",
    });
    const err = await simulateSource("https://gw", source.doc, {}, { fetch: refuse(429, { "Retry-After": "2" }) }).catch((e) => e);
    expect(err).toBeInstanceOf(SimulateError);
    expect(err.retryAfterMs).toBe(2000);
  });

  it("refuses an answer without a simulation", async () => {
    const fetch = vi.fn(async () => jsonResponse({ status: "ok" })) as unknown as typeof globalThis.fetch;
    await expect(simulateSource("https://gw", source.doc, {}, { fetch })).rejects.toThrow(/without a simulation/);
  });

  it("refuses an answer about another source", async () => {
    const other = { ...simulation, sourceId: "ab".repeat(32) };
    const fetch = vi.fn(async () => jsonResponse({ status: "ok", data: other })) as unknown as typeof globalThis.fetch;
    await expect(simulateSource("https://gw", source.doc, {}, { fetch })).rejects.toThrow(/not the source sent/);
  });

  it("accepts the source ID with or without 0x, and returns the timestamp", async () => {
    const data = { ...simulation, sourceId: source.idHex.toUpperCase().replace("0X", "0x"), timestampMs: 1_795_000_000_500 };
    const fetch = vi.fn(async () => jsonResponse({ status: "ok", data })) as unknown as typeof globalThis.fetch;
    expect((await simulateSource("https://gw", source.doc, {}, { fetch })).timestampMs).toBe(1_795_000_000_500);
  });

  it("is a method of the gateway client, on its first gateway", async () => {
    const fetch = vi.fn(async () => jsonResponse({ status: "ok", data: simulation }));
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    const gw = new MolphaGateway(["http://gw1", "http://gw2"], async () => ({ registryVersion: 1, redundancyBuffer: 2 }));
    await gw.simulateSource(source.doc, { price: { body: "{}" } });
    expect(String((fetch.mock.calls[0] as unknown as [string])[0])).toBe("http://gw1/v1/source/simulate");
  });
});

describe("Attestation.roundId", () => {
  it("is derived from the signed payload, whatever the gateway says", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" && url.endsWith("/execute")) {
        const body = signedResponseBody({ sourceId: source.idHex.slice(2), valuePacked: "00".repeat(31) + "64", signaturesRequired: 1 });
        (body as { data: Record<string, unknown> }).data.roundId = "ff".repeat(32);
        return jsonResponse(body);
      }
      if (url.endsWith("/nodes")) return jsonResponse({ status: "ok", data: { nodes: [] } });
      return jsonResponse({ ok: true });
    }) as unknown as typeof globalThis.fetch;
    const gw = new MolphaGateway("http://gw1", async () => ({ registryVersion: 1, redundancyBuffer: 2 }));
    const r = await gw.requestSignedData({ signaturesRequired: 1, source, subscriptionOwner: "9K9FknHzW7j8a88yKTrzxKfDrxnV2QLqSR58ETAVdc8P" });
    expect(r.roundId).toBe(
      deriveRoundIdHex({
        sourceId: r.payload.sourceId,
        signaturesRequired: 1,
        registryVersion: r.payload.registryVersion,
        timestamp: r.payload.timestamp,
      }),
    );
    expect(r.roundId).not.toBe("0x" + "ff".repeat(32));
  });
});
