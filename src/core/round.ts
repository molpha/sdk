/**
 * Round ID — what the gateway and the nodes key a pull round by:
 *
 *   roundId = keccak256(
 *     keccak256("MOLPHA_PULL_ROUND_V1") || sourceId || u32be(signaturesRequired) ||
 *     u32be(registryVersion) || u64be(timestamp)
 *   )
 *
 * `timestamp` is unix MILLISECONDS on the gateway's 100 ms grid. It uses the same fields as an
 * attestation, so anyone holding one can compute its round ID. Note `signaturesRequired` is a
 * u32 here and a single byte in the signed message. Go reference:
 * `gateway/internal/gateway/features/execute/mapping/mapping.go`, locked by its golden vector.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  bytesToHex0x,
  concatBytes,
  toFixedBytes,
  u32be,
  u64be,
  utf8,
} from "./encoding.js";

/** `keccak256("MOLPHA_PULL_ROUND_V1")` domain separator. */
export const ROUND_ID_PREFIX: Uint8Array = keccak_256(
  utf8("MOLPHA_PULL_ROUND_V1"),
);

export interface RoundIdFields {
  /** 32-byte source id (hex or bytes). */
  sourceId: string | Uint8Array;
  /** Encoded as a u32 (unlike the message hash, which uses one byte). */
  signaturesRequired: number;
  registryVersion: number;
  /** Unix milliseconds (u64). */
  timestamp: number | bigint;
}

/** Compute the round ID (32 bytes). */
export function deriveRoundId(fields: RoundIdFields): Uint8Array {
  return keccak_256(
    concatBytes(
      ROUND_ID_PREFIX,
      toFixedBytes(fields.sourceId, 32, "sourceId"),
      u32be(fields.signaturesRequired),
      u32be(fields.registryVersion),
      u64be(fields.timestamp),
    ),
  );
}

/** Round ID as `0x`-prefixed lowercase hex, the form used in URLs. */
export function deriveRoundIdHex(fields: RoundIdFields): string {
  return bytesToHex0x(deriveRoundId(fields));
}
