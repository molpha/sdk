/**
 * Signed `int256` helpers for tolerance-mode values.
 *
 * In tolerance mode the signed `value` is a two's-complement `bytes32` integer: the source's
 * decimal string scaled by `10^decimals`, rounded half to even, bounds-checked against
 * `int256`. Mirrors `new/tolerance` (`Encode` / `Decode` / `Format`) in molpha-node-client
 * byte for byte.
 */
import { bigIntFromBytesBe, hexToBytes, u256beFromBigInt } from "./encoding.js";

/** `2^255 - 1`. */
export const INT256_MAX: bigint = (1n << 255n) - 1n;
/** `-2^255`. */
export const INT256_MIN: bigint = -(1n << 255n);

const TWO_256 = 1n << 256n;
/** Input digit cap, matching the node, before any big-integer allocation. */
const MAX_DECIMAL_DIGITS = 10_000;

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new RangeError(`decimals must be an integer in 0..255, got ${decimals}`);
  }
}

function toBytes32(value: Uint8Array | string, label: string): Uint8Array {
  const bytes = typeof value === "string" ? hexToBytes(value) : value;
  if (bytes.length !== 32) {
    throw new RangeError(`${label}: expected 32 bytes, got ${bytes.length}`);
  }
  return bytes;
}

/** Two's-complement `bytes32` (big-endian) of a signed integer in `[-2^255, 2^255)`. */
export function encodeInt256(value: bigint): Uint8Array {
  if (value > INT256_MAX || value < INT256_MIN) {
    throw new RangeError("int256 overflow");
  }
  return u256beFromBigInt(value < 0n ? value + TWO_256 : value);
}

/** Signed integer of a two's-complement `bytes32` (bytes or hex, optional `0x`). */
export function decodeInt256(value: Uint8Array | string): bigint {
  const n = bigIntFromBytesBe(toBytes32(value, "int256 value"));
  return n >= 1n << 255n ? n - TWO_256 : n;
}

/**
 * Parse an ordinary decimal string (`[+-]digits[.digits]`, no exponent, no whitespace),
 * scale by `10^decimals`, round half to even, and return the `int256` two's-complement
 * `bytes32` the nodes sign for a tolerance-mode source.
 *
 * @throws {Error} `invalid decimal`, `decimal too long`, or `int256 overflow`.
 */
export function encodeInt256Decimal(decimal: string, decimals: number): Uint8Array {
  assertDecimals(decimals);
  if (typeof decimal !== "string" || decimal === "" || decimal.trim() !== decimal) {
    throw new Error("invalid decimal");
  }
  let s = decimal;
  const negative = s.startsWith("-");
  if (negative || s.startsWith("+")) s = s.slice(1);

  const parts = s.split(".");
  if (parts.length > 2 || parts[0] === "" || (parts.length === 2 && parts[1] === "")) {
    throw new Error("invalid decimal");
  }
  for (const part of parts) {
    if (!/^[0-9]*$/.test(part)) throw new Error("invalid decimal");
  }
  const frac = parts.length === 2 ? parts[1]! : "";
  if (parts[0]!.length + frac.length > MAX_DECIMAL_DIGITS) {
    throw new Error("decimal too long");
  }

  let scaled = BigInt(parts[0]! + frac);
  const shift = decimals - frac.length;
  if (shift >= 0) {
    scaled *= 10n ** BigInt(shift);
  } else {
    const divisor = 10n ** BigInt(-shift);
    let q = scaled / divisor;
    const r = scaled % divisor;
    const twice = r * 2n;
    if (twice > divisor || (twice === divisor && (q & 1n) === 1n)) q += 1n;
    scaled = q;
  }
  if (negative) scaled = -scaled;
  return encodeInt256(scaled);
}

/**
 * Render a signed integer — a two's-complement `bytes32` (bytes or hex), or an already
 * decoded `bigint` — at the source's scale: `decimals` fractional places with trailing zeros
 * trimmed (`-1.2`, `42`, `0.00000005`). Inverse of {@link encodeInt256Decimal} up to
 * rounding.
 */
export function formatInt256Decimal(value: Uint8Array | string | bigint, decimals: number): string {
  assertDecimals(decimals);
  const n = typeof value === "bigint" ? value : decodeInt256(value);
  if (n > INT256_MAX || n < INT256_MIN) throw new RangeError("int256 overflow");
  if (decimals === 0) return n.toString();
  const negative = n < 0n;
  let digits = (negative ? -n : n).toString();
  while (digits.length <= decimals) digits = "0" + digits;
  const point = digits.length - decimals;
  const fraction = digits.slice(point).replace(/0+$/, "");
  const text = fraction === "" ? digits.slice(0, point) : `${digits.slice(0, point)}.${fraction}`;
  return negative ? `-${text}` : text;
}
