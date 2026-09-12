import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  bigIntFromBytesBe,
  bytesToBase64,
  bytesToHex,
  hexToBytes,
  toFixedBytes,
  u256beFromBigInt,
  u32be,
  u32le,
  u64be,
  utf8,
} from "../src/core/encoding.js";

describe("encoding", () => {
  it("round-trips hex/bytes (with and without 0x)", () => {
    const bytes = Uint8Array.of(0xde, 0xad, 0xbe, 0xef);
    expect(bytesToHex(bytes)).toBe("deadbeef");
    expect(hexToBytes("deadbeef")).toEqual(bytes);
    expect(hexToBytes("0xDEADBEEF")).toEqual(bytes);
  });

  it("encodes utf8", () => {
    expect(bytesToHex(utf8("MOLPHA"))).toBe("4d4f4c504841");
  });

  it("u32be / u32le", () => {
    expect(Array.from(u32be(0x01020304))).toEqual([1, 2, 3, 4]);
    expect(Array.from(u32le(0x01020304))).toEqual([4, 3, 2, 1]);
    expect(Array.from(u32le(0xffffffff))).toEqual([255, 255, 255, 255]);
  });

  it("u64be accepts number and bigint", () => {
    expect(Array.from(u64be(1))).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(Array.from(u64be(0x0102030405060708n))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("u256 round-trips through bigint", () => {
    const v = 0x1234567890abcdefn;
    const word = u256beFromBigInt(v);
    expect(word.length).toBe(32);
    expect(bigIntFromBytesBe(word)).toBe(v);
  });

  it("rejects out-of-range values", () => {
    expect(() => u32be(-1)).toThrow();
    expect(() => u32be(0x1_0000_0000)).toThrow();
    expect(() => u64be(2n ** 64n)).toThrow();
  });

  it("toFixedBytes enforces length", () => {
    expect(toFixedBytes("0x0102", 2, "x")).toEqual(Uint8Array.of(1, 2));
    expect(() => toFixedBytes("0102", 3, "x")).toThrow();
  });

  it("base64 round-trips arbitrary bytes", () => {
    for (const bytes of [
      Uint8Array.of(),
      Uint8Array.of(0),
      Uint8Array.of(1, 2, 3),
      Uint8Array.of(0xff, 0xfe, 0xfd, 0xfc),
      Uint8Array.from({ length: 256 }, (_, i) => i),
    ]) {
      expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    }
  });

  it("base64 matches known vectors and accepts unpadded input", () => {
    expect(bytesToBase64(new TextEncoder().encode("Molpha"))).toBe("TW9scGhh");
    expect(new TextDecoder().decode(base64ToBytes("TW9scGhh"))).toBe("Molpha");
    // A JSON x402 payload arrives padded; a hand-trimmed one must still decode.
    expect(new TextDecoder().decode(base64ToBytes("eyJhIjoxfQ=="))).toBe('{"a":1}');
    expect(new TextDecoder().decode(base64ToBytes("eyJhIjoxfQ"))).toBe('{"a":1}');
  });
});
