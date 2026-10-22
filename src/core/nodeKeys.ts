import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  bytesToHex,
  concatBytes,
  ensureLength,
  hexToBytes,
} from "./encoding.js";

const SECP256K1_COMPRESSED_PUBLIC_KEY_BYTES = 33;
const SECP256K1_UNCOMPRESSED_PUBLIC_KEY_BYTES = 65;

/**
 * Parse a secp256k1 public key and return canonical compressed lower-case hex.
 * Accepts compressed or uncompressed SEC1 public keys with an optional `0x`.
 */
export function normalizeSecp256k1PublicKeyHex(
  publicKeyHex: string,
  label = "secp256k1 public key",
): string {
  if (typeof publicKeyHex !== "string") {
    throw new Error(`${label}: expected hex string`);
  }

  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(publicKeyHex);
  } catch {
    throw new Error(`${label}: invalid hex`);
  }

  if (
    bytes.length !== SECP256K1_COMPRESSED_PUBLIC_KEY_BYTES &&
    bytes.length !== SECP256K1_UNCOMPRESSED_PUBLIC_KEY_BYTES
  ) {
    throw new Error(
      `${label}: expected ${SECP256K1_COMPRESSED_PUBLIC_KEY_BYTES}-byte compressed or ${SECP256K1_UNCOMPRESSED_PUBLIC_KEY_BYTES}-byte uncompressed public key`,
    );
  }

  try {
    return bytesToHex(secp256k1.Point.fromBytes(bytes).toBytes(true));
  } catch {
    throw new Error(`${label}: invalid secp256k1 public key`);
  }
}

/** Reconstruct a compressed secp256k1 public key from 32-byte affine X/Y coordinates. */
export function secp256k1PublicKeyFromCoordinates(
  x: Uint8Array,
  y: Uint8Array,
  label = "secp256k1 public key coordinates",
): string {
  ensureLength(x, 32, `${label}.x`);
  ensureLength(y, 32, `${label}.y`);
  return normalizeSecp256k1PublicKeyHex(
    bytesToHex(concatBytes(Uint8Array.of(0x04), x, y)),
    label,
  );
}
