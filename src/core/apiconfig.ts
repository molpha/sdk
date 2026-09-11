/**
 * API config canonicalization + source-id derivation. Must stay byte-identical with
 * gateway/node verification: `sourceId = keccak256(JSON.stringify(canonical apiConfig))`.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8 } from "./encoding.js";
import type { APIConfig } from "./types.js";

function sortHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).sort(([a], [b]) => a.localeCompare(b)));
}

/** Gateway wire shape — defaults applied before hash / encryption. */
export function canonicalizeAPIConfig(apiConfig: APIConfig): APIConfig {
  const headers = apiConfig.headers ?? {};
  return {
    url: apiConfig.url,
    method: apiConfig.method ?? "GET",
    headers: Object.keys(headers).length === 0 ? headers : sortHeaders(headers),
    responseParser: apiConfig.responseParser,
    valueTransform: apiConfig.valueTransform ?? "",
  };
}

/**
 * `sourceId = keccak256(JSON.stringify(canonical apiConfig))` — the 32-byte identity of a
 * data source. Hash the same config (including `{{secret.*}}` placeholders) you send to
 * `MolphaGateway.requestSignedData`; the gateway and every verifier recompute it from
 * `apiConfig`.
 */
export function deriveSourceId(apiConfig: APIConfig): Uint8Array {
  return keccak_256(utf8(JSON.stringify(canonicalizeAPIConfig(apiConfig))));
}

/** Hex-encoded {@link deriveSourceId} (64 lowercase hex chars, no `0x`). */
export function deriveSourceIdString(apiConfig: APIConfig): string {
  return bytesToHex(deriveSourceId(apiConfig));
}

/** @deprecated Renamed to {@link deriveSourceId}; identical bytes. */
export const deriveApiConfigHash = deriveSourceId;
