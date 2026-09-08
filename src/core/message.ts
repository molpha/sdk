/**
 * Attestation message hash — the digest the node coalition Schnorr-signs and every verifier
 * (Solana program, EVM `VerifierLib.constructMessage`, Starknet) recomputes:
 *
 *   message = keccak256(
 *     keccak256("MOLPHA_MESSAGE_V1") || sourceId || u32be(registryVersion) ||
 *     u32be(signaturesRequired) || signersBitmap || value || u64be(canonicalTimestamp)
 *   )
 *
 * Widths follow Solidity `abi.encodePacked`: `bytes32, uint32, uint32, uint256, bytes32, uint64`.
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
  /** Encoded as `uint32` in the message even though the program stores a `u8`. */
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
  return keccak_256(
    concatBytes(
      MESSAGE_PREFIX,
      toFixedBytes(fields.sourceId, 32, "sourceId"),
      u32be(fields.registryVersion),
      u32be(fields.signaturesRequired),
      toFixedBytes(fields.signersBitmap, 32, "signersBitmap"),
      toFixedBytes(fields.value, 32, "value"),
      u64be(fields.canonicalTimestamp),
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
