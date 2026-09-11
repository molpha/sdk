/**
 * Gateway request authentication (`RequestAuth`, program `state/receipt.rs`).
 *
 *   hash = keccak256("MOLPHA_REQAUTH_V1" || borsh(RequestAuth))
 *   RequestAuth { program_id: Pubkey, gateway: Pubkey, source_id: [u8; 32],
 *                 signatures_required: u8, timestamp: u64 }
 *
 * i.e. `domain || programId(32) || gatewayPda(32) || sourceId(32) || u8 || u64le`.
 * The consumer authority / delegate ed25519-signs the 32-byte hash. Binding the program id
 * and the Gateway PDA means a signature is only redeemable by the gateway the consumer
 * chose, on the deployment they meant to pay — never a bearer token.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { concatBytes, ensureLength, toFixedBytes, utf8, u64le } from "../core/encoding.js";

export type { Signer } from "../core/types.js";

export const REQUEST_AUTH_DOMAIN: Uint8Array = utf8("MOLPHA_REQAUTH_V1");

export interface RequestAuthFields {
  /** Program id, 32 bytes (see `addressToBytes` for base58). */
  programId: Uint8Array;
  /** Gateway PDA `["molpha_gateway", gatewayAuthority]`, 32 bytes (see `deriveGatewayPda`). */
  gateway: Uint8Array;
  /** 32-byte source id, hex or bytes. */
  sourceId: Uint8Array | string;
  /** u8 — the per-request quorum. */
  signaturesRequired: number;
  /** u64 unix seconds. */
  timestamp: number | bigint;
}

/** Borsh encoding of `RequestAuth` — the hash body, without the domain. */
export function encodeRequestAuth(fields: RequestAuthFields): Uint8Array {
  if (
    !Number.isInteger(fields.signaturesRequired) ||
    fields.signaturesRequired < 1 ||
    fields.signaturesRequired > 255
  ) {
    throw new RangeError(`signaturesRequired out of u8 range: ${fields.signaturesRequired}`);
  }
  return concatBytes(
    ensureLength(fields.programId, 32, "programId"),
    ensureLength(fields.gateway, 32, "gateway"),
    toFixedBytes(fields.sourceId, 32, "sourceId"),
    Uint8Array.of(fields.signaturesRequired),
    u64le(fields.timestamp),
  );
}

/** `keccak256(REQUEST_AUTH_DOMAIN || encodeRequestAuth(fields))` — the message the consumer signs. */
export function hashRequestAuth(fields: RequestAuthFields): Uint8Array {
  return keccak_256(concatBytes(REQUEST_AUTH_DOMAIN, encodeRequestAuth(fields)));
}
