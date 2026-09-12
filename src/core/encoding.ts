/**
 * Byte encoding primitives. Isomorphic — no `Buffer`, no `fs`. All byte work is
 * `Uint8Array` + `@noble/hashes/utils.js`. The canonical selection-bitmap and value
 * representation is a 32-byte big-endian word; `bigint` is used only for internal
 * sampling/packing math and is never exposed on the wire.
 */
import {
  bytesToHex as nobleBytesToHex,
  hexToBytes as nobleHexToBytes,
  utf8ToBytes as nobleUtf8ToBytes,
  concatBytes as nobleConcatBytes,
} from "@noble/hashes/utils.js";

export const utf8 = (s: string): Uint8Array => nobleUtf8ToBytes(s);
export const concatBytes = (...arrays: Uint8Array[]): Uint8Array =>
  nobleConcatBytes(...arrays);

/** Lower-case hex, no `0x` prefix. */
export const bytesToHex = (bytes: Uint8Array): string => nobleBytesToHex(bytes);

/** Accepts an optional leading `0x`; case-insensitive. */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  return nobleHexToBytes(clean);
}

/** Hex with a leading `0x`. */
export const bytesToHex0x = (bytes: Uint8Array): string => "0x" + bytesToHex(bytes);

/** Big-endian u32 → 4 bytes. */
export function u32be(value: number): Uint8Array {
  assertUint(value, 0xffffffff, "u32");
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

/** Little-endian u32 → 4 bytes (used for PDA seeds like the registry index). */
export function u32le(value: number): Uint8Array {
  assertUint(value, 0xffffffff, "u32");
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

/** Big-endian u64 → 8 bytes. Accepts `number` or `bigint`. */
export function u64be(value: number | bigint): Uint8Array {
  const v = typeof value === "bigint" ? value : BigInt(value);
  if (v < 0n || v > 0xffffffffffffffffn) {
    throw new RangeError(`u64 out of range: ${v}`);
  }
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, false);
  return out;
}

/** Little-endian u64 → 8 bytes. Accepts `number` or `bigint`. */
export function u64le(value: number | bigint): Uint8Array {
  const v = typeof value === "bigint" ? value : BigInt(value);
  if (v < 0n || v > 0xffffffffffffffffn) {
    throw new RangeError(`u64 out of range: ${v}`);
  }
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, true);
  return out;
}

/** Big-endian 32-byte word ← bigint (0 ≤ v < 2^256). */
export function u256beFromBigInt(value: bigint): Uint8Array {
  if (value < 0n) throw new RangeError("u256 cannot be negative");
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0 && v > 0n; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v > 0n) throw new RangeError("u256 overflow (>= 2^256)");
  return out;
}

/** bigint ← big-endian byte word (any length). */
export function bigIntFromBytesBe(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

/** Throw unless `bytes.length === len`. Returns the input for chaining. */
export function ensureLength(bytes: Uint8Array, len: number, label: string): Uint8Array {
  if (bytes.length !== len) {
    throw new RangeError(`${label}: expected ${len} bytes, got ${bytes.length}`);
  }
  return bytes;
}

/** Coerce hex string or bytes to a fixed-length byte array. */
export function toFixedBytes(
  value: string | Uint8Array,
  len: number,
  label: string,
): Uint8Array {
  const bytes = typeof value === "string" ? hexToBytes(value) : value;
  return ensureLength(bytes, len, label);
}

function assertUint(value: number, max: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${label} out of range: ${value}`);
  }
}

/**
 * Standard base64 (padded, no line breaks). Isomorphic: `btoa` is available in
 * Node 20+ and every browser, so no `Buffer` is pulled into browser bundles.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  // Chunked to keep a large payload off the argument stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Accepts padded or unpadded standard base64. */
export function base64ToBytes(value: string): Uint8Array {
  const padded = value.length % 4 === 0 ? value : value + "=".repeat(4 - (value.length % 4));
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
