/**
 * Coalition key: the affine sum of the signers' secp256k1 public keys.
 *
 * `submit_attestation` takes it as untrusted instruction data and checks it projectively
 * against its own sum of the signers' `Node` keys (`X ≡ x·Z²`, `Y ≡ y·Z³`), so a wrong key
 * only fails the transaction — it can never select another key. It is a property of the
 * point, not of any library's arithmetic: summing in any order with any secp256k1
 * implementation gives the same `(x, y)`. Mirrors `molpha_verifier::coalition_key`.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes, u256beFromBigInt } from "./encoding.js";

/** Affine coalition key, 32-byte big-endian coordinates (`CoalitionKey` in the program IDL). */
export interface CoalitionKey {
  x: Uint8Array;
  y: Uint8Array;
}

/** A signer's public key: SEC1 compressed / uncompressed (bytes or hex), or affine `(x, y)`. */
export type Secp256k1KeyInput =
  | Uint8Array
  | string
  | { x: Uint8Array | string; y: Uint8Array | string };

type Point = InstanceType<typeof secp256k1.Point>;

function coordinate(value: Uint8Array | string, label: string): bigint {
  const bytes = typeof value === "string" ? hexToBytes(value) : value;
  if (bytes.length !== 32) {
    throw new RangeError(`${label}: expected 32 bytes, got ${bytes.length}`);
  }
  return BigInt("0x" + bytesToHex(bytes));
}

function toPoint(key: Secp256k1KeyInput, index: number): Point {
  const label = `signer key ${index}`;
  try {
    if (typeof key === "string" || key instanceof Uint8Array) {
      return secp256k1.Point.fromBytes(typeof key === "string" ? hexToBytes(key) : key);
    }
    const point = secp256k1.Point.fromAffine({
      x: coordinate(key.x, `${label}.x`),
      y: coordinate(key.y, `${label}.y`),
    });
    point.assertValidity();
    return point;
  } catch (err) {
    throw new Error(
      `${label} is not a valid secp256k1 public key: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Affine sum of `keys` as a {@link CoalitionKey}.
 *
 * @throws {Error} on an empty set, an invalid point, or a sum at infinity (the verifier
 *   rejects both of the latter as `InvalidAggregateSignature`).
 */
export function computeCoalitionKey(keys: Iterable<Secp256k1KeyInput>): CoalitionKey {
  let sum: Point | undefined;
  let index = 0;
  for (const key of keys) {
    const point = toPoint(key, index++);
    sum = sum === undefined ? point : sum.add(point);
  }
  if (sum === undefined) throw new Error("coalition key needs at least one signer key");
  if (sum.is0()) throw new Error("coalition key is the point at infinity");
  const { x, y } = sum.toAffine();
  return { x: u256beFromBigInt(x), y: u256beFromBigInt(y) };
}
