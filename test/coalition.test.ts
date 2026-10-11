import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";
import { computeCoalitionKey } from "../src/core/coalition.js";
import { bytesToHex, hexToBytes } from "../src/core/encoding.js";
import { PUBKEYS, RUST_VECTORS } from "./fixtures/registry12.js";

const pick = (signers: number[]) => signers.map((i) => PUBKEYS[i]!);
const hexKey = (key: { x: Uint8Array; y: Uint8Array }) => ({ x: bytesToHex(key.x), y: bytesToHex(key.y) });
const compressed = (p: { x: string; y: string }) =>
  bytesToHex(secp256k1.Point.fromAffine({ x: BigInt("0x" + p.x), y: BigInt("0x" + p.y) }).toBytes(true));

describe("computeCoalitionKey", () => {
  it.each(RUST_VECTORS)("matches the Rust verifier for signers $signers", ({ signers, x, y }) => {
    expect(hexKey(computeCoalitionKey(pick(signers)))).toEqual({ x, y });
  });

  it("is independent of signer order", () => {
    const { signers, x, y } = RUST_VECTORS[0]!;
    expect(hexKey(computeCoalitionKey(pick([...signers].reverse())))).toEqual({ x, y });
    expect(hexKey(computeCoalitionKey(pick([8, 3, 11, 5, 9, 7, 10])))).toEqual({ x, y });
  });

  it("returns 32-byte big-endian coordinates (leading zeros preserved)", () => {
    const key = computeCoalitionKey(pick([4]));
    expect(key.x).toHaveLength(32);
    expect(key.y).toHaveLength(32);
    // A single signer's own key is its coalition key.
    expect(hexKey(key)).toEqual(PUBKEYS[4]);
    const small = secp256k1.Point.BASE.multiply(5n).toAffine();
    expect(computeCoalitionKey([secp256k1.Point.BASE.multiply(5n).toBytes(false)]).x).toEqual(
      hexToBytes(small.x.toString(16).padStart(64, "0")),
    );
  });

  it("accepts compressed, uncompressed and affine inputs interchangeably", () => {
    const signers = [3, 5, 7];
    const expected = hexKey(computeCoalitionKey(pick(signers)));
    expect(
      hexKey(computeCoalitionKey(signers.map((i) => compressed(PUBKEYS[i]!)))),
    ).toEqual(expected);
    expect(
      hexKey(computeCoalitionKey(signers.map((i) => hexToBytes("04" + PUBKEYS[i]!.x + PUBKEYS[i]!.y)))),
    ).toEqual(expected);
    expect(
      hexKey(
        computeCoalitionKey(
          signers.map((i) => ({ x: hexToBytes(PUBKEYS[i]!.x), y: hexToBytes(PUBKEYS[i]!.y) })),
        ),
      ),
    ).toEqual(expected);
  });

  it("matches an independent noble point sum over random keys", () => {
    const points = Array.from({ length: 18 }, () =>
      secp256k1.Point.BASE.multiply(secp256k1.Point.Fn.fromBytes(secp256k1.utils.randomSecretKey())),
    );
    const sum = points.slice(1).reduce((acc, p) => acc.add(p), points[0]!).toAffine();
    expect(hexKey(computeCoalitionKey(points.map((p) => p.toBytes(true))))).toEqual({
      x: sum.x.toString(16).padStart(64, "0"),
      y: sum.y.toString(16).padStart(64, "0"),
    });
  });

  it("doubles a repeated signer like the verifier", () => {
    const p = secp256k1.Point.BASE.multiply(7n).toBytes(true);
    const doubled = secp256k1.Point.BASE.multiply(14n).toAffine();
    expect(hexKey(computeCoalitionKey([p, p]))).toEqual({
      x: doubled.x.toString(16).padStart(64, "0"),
      y: doubled.y.toString(16).padStart(64, "0"),
    });
  });

  it("rejects an empty set, a sum at infinity, and invalid keys", () => {
    expect(() => computeCoalitionKey([])).toThrow(/at least one/);
    const p = secp256k1.Point.BASE.multiply(9n);
    expect(() => computeCoalitionKey([p.toBytes(true), p.negate().toBytes(true)])).toThrow(/infinity/);
    expect(() => computeCoalitionKey([new Uint8Array(33)])).toThrow(/not a valid secp256k1 public key/);
    // Off-curve affine pair.
    expect(() =>
      computeCoalitionKey([{ x: new Uint8Array(32).fill(1), y: new Uint8Array(32).fill(2) }]),
    ).toThrow(/signer key 0 is not a valid/);
    expect(() => computeCoalitionKey([{ x: new Uint8Array(31), y: new Uint8Array(32) }])).toThrow(
      /expected 32 bytes/,
    );
  });
});
