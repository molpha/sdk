import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  DataIntegrityError,
  MolphaDataClient,
  MolphaDataError,
  checkEnvelope,
  decodePayload,
  requestAuthDigest,
  toAttestation,
  type Envelope,
  type PayloadField,
} from "../src/data/index.js";
import { hashRequestAuth } from "../src/gateway/auth.js";

// Fixtures: unsigned envelopes and a derivation from a molpha-data service reading mainnet (2026-11-11),
// and a signed envelope from molpha-data's signed path with a gateway that signs with test keys.
const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`./fixtures/data/${name}`, import.meta.url), "utf8")) as T;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

type Call = { url: string; init: RequestInit };

function fakeFetch(respond: (c: Call) => { status?: number; body: unknown; headers?: Record<string, string> }) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL, init: RequestInit = {}) => {
    const c = { url: String(url), init };
    calls.push(c);
    const r = respond(c);
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json", ...(r.headers ?? {}) },
    });
  }) as typeof fetch;
  return { fn, calls };
}

describe("checkEnvelope", () => {
  it("accepts the live envelopes and the signed one", () => {
    for (const name of ["unsigned-pool-price.json", "unsigned-token-snapshot-solana.json", "signed-lst-rate.json"]) {
      const env = fixture<Envelope>(name);
      expect(checkEnvelope(env).idHex).toBe(env.source.sourceId);
    }
  });

  it("refuses a source that does not hash to its id", () => {
    const env = clone(fixture<Envelope>("unsigned-pool-price.json"));
    (env.source.config as { output: { decimals: string } }).output.decimals = "17";
    expect(() => checkEnvelope(env)).toThrow(DataIntegrityError);
  });

  it("refuses a payload that does not hash to the value", () => {
    const env = clone(fixture<Envelope>("unsigned-token-snapshot-solana.json"));
    env.payload = env.payload!.replace(/.$/, (c) => (c === "0" ? "1" : "0"));
    expect(() => checkEnvelope(env)).toThrow(/payload does not hash/);
  });

  it("refuses an attestation for another source or value, and calldata that is not its own", () => {
    const base = fixture<Envelope>("signed-lst-rate.json");
    const a = clone(base);
    a.attestation!.sourceId = "0x" + "11".repeat(32);
    expect(() => checkEnvelope(a)).toThrow(/another source/);
    const b = clone(base);
    b.attestation!.value = "0x" + "00".repeat(31) + "2b";
    expect(() => checkEnvelope(b)).toThrow(/another value/);
    const c = clone(base);
    c.verifierArgs!.evm.calldata = c.verifierArgs!.evm.calldata.slice(0, -1) + "f";
    expect(() => checkEnvelope(c)).toThrow(/EVM verify calldata/);
    const d = clone(base);
    d.verifierArgs!.starknet.calldata[12] = "0x1";
    expect(() => checkEnvelope(d)).toThrow(/Starknet verify calldata/);
  });

  it("turns a signed envelope into the SDK's Attestation", () => {
    const env = fixture<Envelope>("signed-lst-rate.json");
    const att = toAttestation(env);
    expect(att.payload.sourceId).toBe(env.source.sourceId);
    expect(att.signature.commitmentAddr).toBe(env.signature!.commitment);
    expect(() => toAttestation(fixture<Envelope>("unsigned-pool-price.json"))).toThrow(DataIntegrityError);
  });
});

describe("decodePayload", () => {
  it("decodes a live SPL mint snapshot exactly as the service did", () => {
    const env = fixture<Envelope>("unsigned-token-snapshot-solana.json");
    expect(decodePayload(env.layout as PayloadField[], env.payload!)).toEqual(env.fields);
  });

  it("matches the service's own decoder test", () => {
    // molpha-data internal/catalog/payload_test.go TestDecodePayload, byte for byte.
    const p = new Uint8Array(148);
    p[30] = 0x42;
    p[31] = 0x0f;
    p.fill(0xff, 32, 64);
    p[63] = 0xfe;
    p.set([0x10, 0x27, 0, 0, 0, 0, 0, 0], 64);
    p.set([0xfe, 0xff, 0xff, 0xff], 72);
    p.set([1, 0, 0, 0], 112);
    p.set(Uint8Array.from(Buffer.from("c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61", "hex")), 116);
    const got = decodePayload(
      [
        { name: "u", offset: 0, length: 32, type: "uint", decimals: 3 },
        { name: "i", offset: 32, length: 32, type: "int" },
        { name: "a", offset: 0, length: 32, type: "address" },
        { name: "le", offset: 64, length: 8, type: "u64le", decimals: 4 },
        { name: "tick", offset: 72, length: 4, type: "i32le" },
        { name: "none", offset: 76, length: 36, type: "optionPubkey" },
        { name: "some", offset: 112, length: 36, type: "optionPubkey" },
      ],
      p,
    );
    expect(got).toEqual({
      u: "16.911",
      i: "-2",
      a: "0x000000000000000000000000000000000000420f",
      le: "1",
      tick: "-2",
      none: "",
      some: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    });
    expect(() => decodePayload([{ name: "x", offset: 140, length: 32, type: "uint" }], p)).toThrow(RangeError);
  });
});

describe("requestAuthDigest", () => {
  it("is the gateway's RequestAuth hash, with base58 addresses", () => {
    const fields = {
      programId: "dzemhcTeUnUEhDcyUssWP8GfcMCYwKezVg4U1hvdEJe",
      gatewayPda: "9iepoS911JJYYLuJ6LWemaKsgdz8tGoyLKMCPTaTz6gb",
      sourceId: "0x13564c7e2f2ca3619e40120c51e742f88d8bfb2974260cc1a953ee9dc356c094",
      signatures: 3,
      authTimestamp: 1794394621,
    };
    // 32-byte forms of the two addresses (base58-decoded independently with Buffer arithmetic).
    const b58 = (s: string) => {
      const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
      let n = 0n;
      for (const c of s) n = n * 58n + BigInt(A.indexOf(c));
      return Uint8Array.from(Buffer.from(n.toString(16).padStart(64, "0"), "hex"));
    };
    const want = hashRequestAuth({
      programId: b58(fields.programId),
      gateway: b58(fields.gatewayPda),
      sourceId: fields.sourceId,
      signaturesRequired: 3,
      authTimestamp: 1794394621,
    });
    expect(requestAuthDigest(fields)).toEqual(want);
  });
});

describe("MolphaDataClient", () => {
  it("derives, re-hashes and parses the source", async () => {
    const derived = fixture<{ sourceId: string }>("derive-aave-reserve.json");
    const { fn, calls } = fakeFetch(() => ({ body: derived }));
    const c = new MolphaDataClient({ baseUrl: "https://data.example/", fetch: fn, apiKey: "k-0000000000000001" });
    const d = await c.derive({ template: "lending.aave.reserve", params: { chain: "ethereum", asset: "0xa0b8" } });
    expect(d.parsed.idHex).toBe(derived.sourceId);
    expect(calls[0]!.url).toBe("https://data.example/v1/sources/derive");
    expect((calls[0]!.init.headers as Record<string, string>)["x-api-key"]).toBe("k-0000000000000001");
    expect(calls[0]!.init.credentials).toBe("omit");

    const bad = { ...derived, sourceId: "0x" + "00".repeat(32) };
    const c2 = new MolphaDataClient({ fetch: fakeFetch(() => ({ body: bad })).fn });
    await expect(c2.derive({ template: "x" })).rejects.toThrow(DataIntegrityError);
  });

  it("reads unsigned and signed, sending the caller's authorization", async () => {
    const unsigned = fixture<Envelope>("unsigned-pool-price.json");
    const signed = fixture<Envelope>("signed-lst-rate.json");
    const { fn, calls } = fakeFetch((c) => ({ body: JSON.parse(c.init.body as string).attest ? signed : unsigned }));
    const client = new MolphaDataClient({ fetch: fn });
    expect((await client.read({ template: "dex.pool.price", params: {} })).signed).toBe(false);
    expect(JSON.parse(calls[0]!.init.body as string).attest).toBe(false);

    const key = ed25519.utils.randomSecretKey();
    const sig = Buffer.from(ed25519.sign(new Uint8Array(32), key)).toString("hex");
    const env = await client.readSigned(
      { template: "lst.rate", params: {} },
      { requestAuth: { consumerAuthority: "Auth111", authSig: "0x" + sig, authTimestamp: 1794394621 } },
      { signatures: 3, verifierMaxAge: 60 },
    );
    expect(env.signed).toBe(true);
    const h = calls[1]!.init.headers as Record<string, string>;
    expect(h["x-molpha-consumer-authority"]).toBe("Auth111");
    expect(h["x-molpha-subscription-owner"]).toBe("Auth111");
    expect(h["x-molpha-auth-timestamp"]).toBe("1794394621");
    expect(JSON.parse(calls[1]!.init.body as string)).toMatchObject({ attest: true, signatures: 3, verifierMaxAge: 60 });

    await client.readSigned({ template: "lst.rate" }, { bearer: "tok" });
    expect((calls[2]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    await client.readSigned({ template: "lst.rate" }, { payment: "cGF5" });
    expect((calls[3]!.init.headers as Record<string, string>)["payment-signature"]).toBe("cGF5");
  });

  it("surfaces the gateway's 402 quote and the service's error codes", async () => {
    const quote = { x402Version: 2, accepts: [{ scheme: "exact", amount: "100000" }] };
    const c402 = new MolphaDataClient({
      fetch: fakeFetch(() => ({ status: 402, body: quote, headers: { "PAYMENT-REQUIRED": "ZW52" } })).fn,
    });
    const e402 = await c402.readSigned({ template: "lst.rate" }, { x402: true }).catch((e) => e);
    expect(e402).toBeInstanceOf(MolphaDataError);
    expect(e402.status).toBe(402);
    expect(e402.detail.paymentRequired).toBe("ZW52");
    expect(e402.detail.body).toEqual(quote);

    const c503 = new MolphaDataClient({
      fetch: fakeFetch(() => ({
        status: 503,
        body: { error: { code: "ROUND_FAILED", message: "gateway: round timeout", likelyDiverged: true } },
        headers: { "Retry-After": "2" },
      })).fn,
    });
    const e503 = await c503.read({ template: "x" }).catch((e) => e);
    expect(e503).toMatchObject({ status: 503, code: "ROUND_FAILED", detail: { likelyDiverged: true, retryAfter: 2 } });
  });

  it("checks every envelope of a batch", async () => {
    const env = clone(fixture<Envelope>("unsigned-pool-price.json"));
    env.source.sourceId = "0x" + "22".repeat(32);
    const c = new MolphaDataClient({ fetch: fakeFetch(() => ({ body: { results: [{ index: 0, status: 200, envelope: env }] } })).fn });
    await expect(c.batch([{ template: "dex.pool.price" }])).rejects.toThrow(DataIntegrityError);
  });

  it("lists the catalog with filters", async () => {
    const t = fixture<{ id: string }>("template-price-median.json");
    const { fn, calls } = fakeFetch(() => ({ body: { templates: [t] } }));
    const list = await new MolphaDataClient({ fetch: fn }).catalog({ chain: "solana" });
    expect(list[0]!.id).toBe("price.median");
    expect(calls[0]!.url).toBe("https://data.molpha.io/v1/catalog?chain=solana");
  });
});
