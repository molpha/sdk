import { describe, expect, it } from "vitest";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  canonicalizeAPIConfig,
  deriveApiConfigHash,
  deriveSourceId,
  deriveSourceIdString,
} from "../src/core/apiconfig.js";
import { bytesToHex, utf8 } from "../src/core/encoding.js";

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
});

describe("deriveApiConfigHash", () => {
  const minimal = {
    url: "https://api.example.com/price",
    responseParser: "$.price",
  };

  it("is keccak256(JSON.stringify(canonical apiConfig))", () => {
    const canonicalJson = JSON.stringify(canonicalizeAPIConfig(minimal));
    expect(deriveApiConfigHash(minimal)).toEqual(keccak_256(utf8(canonicalJson)));
  });

  it("matches node test vector", () => {
    expect(bytesToHex(deriveApiConfigHash(minimal))).toBe(
      "2f00de126dd0f45e8a7f0a9854139d64e47b2f9707235406dc1c9c32d6fb9582",
    );
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
    expect(deriveApiConfigHash(minimal)).toEqual(deriveApiConfigHash(explicitDefault));
    expect(deriveApiConfigHash(minimal)).not.toEqual(
      deriveApiConfigHash(explicit),
    );
  });

  it("is stable and sensitive to config changes", () => {
    const a = deriveApiConfigHash(minimal);
    const b = deriveApiConfigHash(minimal);
    const c = deriveApiConfigHash({
      ...minimal,
      url: "https://api.example.com/other",
    });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a.length).toBe(32);
  });

  it("hashes placeholder templates, not resolved secrets", () => {
    const withSecret = deriveApiConfigHash({
      url: "https://api.example.com/price",
      headers: { Authorization: "Bearer {{secret.apiKey}}" },
      responseParser: "$.price",
    });
    const withoutSecret = deriveApiConfigHash({
      url: "https://api.example.com/price",
      responseParser: "$.price",
    });
    expect(withSecret).not.toEqual(withoutSecret);
    expect(bytesToHex(withSecret)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("deriveSourceId", () => {
  const minimal = {
    url: "https://api.example.com/price",
    responseParser: "$.price",
  };

  it("is the canonical apiConfig hash (same bytes as the deprecated deriveApiConfigHash)", () => {
    expect(deriveSourceId(minimal)).toEqual(deriveApiConfigHash(minimal));
    expect(deriveSourceIdString(minimal)).toBe(
      "2f00de126dd0f45e8a7f0a9854139d64e47b2f9707235406dc1c9c32d6fb9582",
    );
  });

  it("returns 64 lowercase hex chars without a 0x prefix", () => {
    expect(deriveSourceIdString(minimal)).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveSourceIdString(minimal)).toBe(bytesToHex(deriveSourceId(minimal)));
  });
});
