/**
 * Attestation message hash — the digest the node coalition Schnorr-signs and every verifier
 * (Solana program, EVM `VerifierLib.constructMessage`, Starknet) recomputes:
 *
 *   message = keccak256(
 *     keccak256("MOLPHA_MESSAGE_V1") || value || sourceId || u32be(registryVersion) ||
 *     u8(signaturesRequired) || u64be(canonicalTimestamp) || signersBitmap
 *   )
 *
 * The preimage is 141 bytes. Widths follow the Rust, Solidity, Solana, and node encoders.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { concatBytes, toFixedBytes, u32be, u64be, utf8 } from "./encoding.js";
import type { DataUpdateResult } from "./types.js";

/** `keccak256("MOLPHA_MESSAGE_V1")` domain separator. */
export const MESSAGE_PREFIX: Uint8Array = keccak_256(utf8("MOLPHA_MESSAGE_V1"));

export interface AttestationMessageFields {
  /** 32-byte source id (hex or bytes). */
  sourceId: string | Uint8Array;
  registryVersion: number;
  /** Encoded as one byte in the message. */
  signaturesRequired: number;
  /** 32-byte big-endian signers bitmap (hex or bytes). */
  signersBitmap: string | Uint8Array;
  /** 32-byte packed value (hex or bytes). */
  value: string | Uint8Array;
  /** Unix seconds (u64). */
  canonicalTimestamp: number | bigint;
}

/** Compute the attestation message hash (32 bytes). */
export function attestationMessageHash(fields: AttestationMessageFields): Uint8Array {
  if (!Number.isInteger(fields.signaturesRequired) || fields.signaturesRequired < 0 || fields.signaturesRequired > 255) {
    throw new RangeError(`signaturesRequired out of u8 range: ${fields.signaturesRequired}`);
  }
  return keccak_256(
    concatBytes(
      MESSAGE_PREFIX,
      toFixedBytes(fields.value, 32, "value"),
      toFixedBytes(fields.sourceId, 32, "sourceId"),
      u32be(fields.registryVersion),
      Uint8Array.of(fields.signaturesRequired),
      u64be(fields.canonicalTimestamp),
      toFixedBytes(fields.signersBitmap, 32, "signersBitmap"),
    ),
  );
}

/** Message hash of a completed gateway round (`valuePacked` is the signed value). */
export function attestationMessageHashFromResult(result: DataUpdateResult): Uint8Array {
  return attestationMessageHash({
    sourceId: result.sourceId,
    registryVersion: result.registryVersion,
    signaturesRequired: result.signaturesRequired,
    signersBitmap: result.signersBitmap,
    value: result.valuePacked,
    canonicalTimestamp: result.timestamp,
  });
}
