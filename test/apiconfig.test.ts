import { describe, expect, it } from "vitest";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  canonicalizeAPIConfig,
  deriveSourceId,
  deriveSourceIdString,
} from "../src/core/apiconfig.js";
import { AggregationConfigError, assertAggregationQuorum } from "../src/core/aggregation.js";
import { bytesToHex, utf8 } from "../src/core/encoding.js";
import type { AggregationConfig, APIConfig } from "../src/core/types.js";

describe("canonicalizeAPIConfig", () => {
  it("fills gateway defaults for omitted optional fields", () => {
    expect(
      canonicalizeAPIConfig({
        url: "https://api.example.com/price",
        responseParser: "$.price",
      }),
    ).toEqual({
      url: "https://api.example.com/price",
      method: "GET",
      headers: {},
      responseParser: "$.price",
      valueTransform: "",
    });
  });

  it("sorts header names so insertion order does not change the hash", () => {
    const base = {
      url: "https://api.example.com/v1/finalized/rate",
      responseParser: "$.rate",
    };
    const a = canonicalizeAPIConfig({ ...base, headers: { "Z-Header": "z", "A-Header": "a" } });
    const b = canonicalizeAPIConfig({ ...base, headers: { "A-Header": "a", "Z-Header": "z" } });

    expect(a).toEqual(b);
    expect(deriveSourceIdString({ ...base, headers: { "Z-Header": "z", "A-Header": "a" } })).toBe(
      deriveSourceIdString({ ...base, headers: { "A-Header": "a", "Z-Header": "z" } }),
    );
  });

  it("sorts header names by UTF-16 code units, not host locale", () => {
    const base = {
      url: "https://api.example.com/v1/finalized/rate",
      responseParser: "$.rate",
    };
    const headers = { "If-Match": "etag", "idempotency-key": "key" };
    const canonical = canonicalizeAPIConfig({ ...base, headers });
    const keys = Object.keys(canonical.headers ?? {});

    // Code-unit order: 'I' (73) < 'i' (105), so If-Match before idempotency-key.
    expect(keys).toEqual(["If-Match", "idempotency-key"]);
    expect(keys).not.toEqual(
      ["idempotency-key", "If-Match"].sort((a, b) => a.localeCompare(b, "en")),
    );
  });
});

describe("deriveSourceId", () => {
  const minimal = {
    url: "https://api.example.com/price",
    responseParser: "$.price",
  };

  it("is keccak256(JSON.stringify(canonical apiConfig))", () => {
    const canonicalJson = JSON.stringify(canonicalizeAPIConfig(minimal));
    expect(deriveSourceId(minimal)).toEqual(keccak_256(utf8(canonicalJson)));
  });

  it("matches node test vector", () => {
    expect(bytesToHex(deriveSourceId(minimal))).toBe(
      "2f00de126dd0f45e8a7f0a9854139d64e47b2f9707235406dc1c9c32d6fb9582",
    );
    expect(deriveSourceIdString(minimal)).toBe(
      "2f00de126dd0f45e8a7f0a9854139d64e47b2f9707235406dc1c9c32d6fb9582",
    );
  });

  it("returns 64 lowercase hex chars without a 0x prefix", () => {
    expect(deriveSourceIdString(minimal)).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveSourceIdString(minimal)).toBe(bytesToHex(deriveSourceId(minimal)));
  });

  it("injects the backend-compatible empty valueTransform default", () => {
    const explicitDefault = {
      url: "https://api.example.com/price",
      method: "GET" as const,
      headers: {},
      responseParser: "$.price",
      valueTransform: "",
    };
    const explicit = {
      url: "https://api.example.com/price",
      method: "GET" as const,
      headers: {},
      responseParser: "$.price",
      valueTransform: "multiply:1e6",
    };
    expect(deriveSourceId(minimal)).toEqual(deriveSourceId(explicitDefault));
    expect(deriveSourceId(minimal)).not.toEqual(deriveSourceId(explicit));
  });

  it("is stable and sensitive to config changes", () => {
    const a = deriveSourceId(minimal);
    const b = deriveSourceId(minimal);
    const c = deriveSourceId({
      ...minimal,
      url: "https://api.example.com/other",
    });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a.length).toBe(32);
  });

  it("hashes placeholder templates, not resolved secrets", () => {
    const withSecret = deriveSourceId({
      url: "https://api.example.com/price",
      headers: { Authorization: "Bearer {{secret.apiKey}}" },
      responseParser: "$.price",
    });
    const withoutSecret = deriveSourceId({
      url: "https://api.example.com/price",
      responseParser: "$.price",
    });
    expect(withSecret).not.toEqual(withoutSecret);
    expect(bytesToHex(withSecret)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("aggregation (median tolerance mode)", () => {
  const aggregation: AggregationConfig = {
    mode: "tolerance",
    rule: "median",
    maxDeviationBps: 50,
    maxAgeMs: 2000,
    numeric: { type: "int256", decimals: 8 },
  };
  const base: APIConfig = { url: "https://example.test", method: "GET", headers: {}, responseParser: "" };

  /** Exact UTF-8 preimage pinned by Go `TestAggregationSourceIdentity` (molpha-node-client af9144e). */
  const GO_PREIMAGE =
    '{"url":"https://example.test","method":"GET","headers":{},"responseParser":"","valueTransform":"","aggregation":{"mode":"tolerance","rule":"median","maxDeviationBps":50,"maxAgeMs":2000,"numeric":{"type":"int256","decimals":8}}}';
  /** keccak256 of the exact-mode preimage (no `aggregation` key). */
  const EXACT_PREIMAGE =
    '{"url":"https://example.test","method":"GET","headers":{},"responseParser":"","valueTransform":""}';

  it("matches the node's known-answer source id (Go TestAggregationSourceIdentity)", () => {
    const config = { ...base, aggregation };
    expect(JSON.stringify(canonicalizeAPIConfig(config))).toBe(GO_PREIMAGE);
    expect(deriveSourceId(config)).toEqual(keccak_256(utf8(GO_PREIMAGE)));
    // Same digest computed independently with Go's keccak (golang.org/x/crypto/sha3).
    expect(deriveSourceIdString(config)).toBe(
      "6d06195928fe073cc2ee4421425616ca44eacca5843619e69d351b949b9d5c47",
    );
  });

  it("leaves five-field (exact) configs byte-identical", () => {
    expect(JSON.stringify(canonicalizeAPIConfig(base))).toBe(EXACT_PREIMAGE);
    expect(deriveSourceIdString(base)).toBe(
      "fa25f84e68176035e0d544d7680e13d4489f81c67cc3f1ffe517f191c72fc4a9",
    );
    expect(deriveSourceIdString(base)).not.toBe(deriveSourceIdString({ ...base, aggregation }));
    // `undefined` / `null` aggregation is exact mode: no key, same hash.
    expect(Object.keys(canonicalizeAPIConfig({ ...base, aggregation: undefined }))).not.toContain(
      "aggregation",
    );
    expect(deriveSourceIdString({ ...base, aggregation: null as unknown as undefined })).toBe(
      deriveSourceIdString(base),
    );
  });

  it("emits aggregation last, with keys in canonical order", () => {
    const canonical = canonicalizeAPIConfig({ ...base, aggregation });
    expect(Object.keys(canonical)).toEqual([
      "url",
      "method",
      "headers",
      "responseParser",
      "valueTransform",
      "aggregation",
    ]);
    expect(Object.keys(canonical.aggregation!)).toEqual([
      "mode",
      "rule",
      "maxDeviationBps",
      "maxAgeMs",
      "numeric",
    ]);
    expect(Object.keys(canonical.aggregation!.numeric)).toEqual(["type", "decimals"]);
  });

  it("rebuilds the nested object: user key order and extra keys cannot reach the hash", () => {
    const shuffled = {
      numeric: { decimals: 8, type: "int256", extra: 1 },
      maxAgeMs: 2000,
      leak: "x",
      maxDeviationBps: 50,
      rule: "median",
      mode: "tolerance",
    } as unknown as AggregationConfig;
    const canonical = canonicalizeAPIConfig({ ...base, aggregation: shuffled });
    expect(JSON.stringify(canonical)).toBe(GO_PREIMAGE);
    expect(canonical.aggregation).not.toBe(shuffled);
    // A top-level extra key is dropped.
    expect(
      JSON.stringify(
        canonicalizeAPIConfig({ ...base, aggregation, junk: 1 } as unknown as APIConfig),
      ),
    ).toBe(GO_PREIMAGE);
  });

  it("rejects mode \"exact\" (it would change the source identity)", () => {
    expect(() =>
      canonicalizeAPIConfig({
        ...base,
        aggregation: { ...aggregation, mode: "exact" } as unknown as AggregationConfig,
      }),
    ).toThrow(/mode "exact" is not accepted.*omit/);
    expect(() =>
      deriveSourceId({ ...base, aggregation: { mode: "exact" } as unknown as AggregationConfig }),
    ).toThrow(AggregationConfigError);
  });

  it("rejects unsupported mode, rule and numeric type", () => {
    const bad = (patch: Record<string, unknown>) =>
      canonicalizeAPIConfig({ ...base, aggregation: { ...aggregation, ...patch } as AggregationConfig });
    expect(() => bad({ mode: "mean" })).toThrow(/unsupported aggregation.mode/);
    expect(() => bad({ rule: "mean" })).toThrow(/unsupported aggregation.rule/);
    expect(() => bad({ numeric: { type: "uint256", decimals: 8 } })).toThrow(/numeric.type/);
    expect(() => bad({ numeric: undefined })).toThrow(/numeric must be an object/);
  });

  it("validates number ranges", () => {
    const bad = (patch: Record<string, unknown>) =>
      canonicalizeAPIConfig({ ...base, aggregation: { ...aggregation, ...patch } as AggregationConfig });
    expect(() => bad({ maxAgeMs: 0 })).toThrow(/maxAgeMs/);
    expect(() => bad({ maxAgeMs: -1 })).toThrow(/maxAgeMs/);
    expect(() => bad({ maxAgeMs: 1.5 })).toThrow(/maxAgeMs/);
    expect(() => bad({ maxAgeMs: 2n })).toThrow(/maxAgeMs/);
    expect(() => bad({ maxDeviationBps: -1 })).toThrow(/maxDeviationBps/);
    expect(() => bad({ maxDeviationBps: 2 ** 32 })).toThrow(/maxDeviationBps/);
    expect(() => bad({ maxDeviationBps: 0.5 })).toThrow(/maxDeviationBps/);
    expect(() => bad({ numeric: { type: "int256", decimals: 256 } })).toThrow(/decimals/);
    expect(() => bad({ numeric: { type: "int256", decimals: -1 } })).toThrow(/decimals/);
    // Boundaries are accepted.
    expect(() => bad({ maxDeviationBps: 0, maxAgeMs: 1 })).not.toThrow();
    expect(() => bad({ maxDeviationBps: 2 ** 32 - 1, numeric: { type: "int256", decimals: 255 } })).not.toThrow();
    expect(() => bad({ numeric: { type: "int256", decimals: 0 } })).not.toThrow();
  });

  it("requires signaturesRequired >= 3 in tolerance mode only", () => {
    expect(() => assertAggregationQuorum(aggregation, 2)).toThrow(
      /requires signaturesRequired >= 3, got 2/,
    );
    expect(() => assertAggregationQuorum(aggregation, 1)).toThrow(AggregationConfigError);
    expect(() => assertAggregationQuorum(aggregation, 3)).not.toThrow();
    expect(() => assertAggregationQuorum(undefined, 1)).not.toThrow();
  });
});
