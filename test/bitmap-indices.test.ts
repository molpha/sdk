import { describe, expect, it } from "vitest";
import { bitmapToIndices } from "../src/core/selection.js";
import { bitmapToIndices as fromAccounts } from "../src/solana/accounts.js";

describe("bitmapToIndices", () => {
  it("reads set bits from a full 32-byte big-endian word", () => {
    expect(bitmapToIndices("00".repeat(31) + "07")).toEqual([0, 1, 2]);
  });

  it("left-pads short hex, the way the gateway sends bitmaps", () => {
    expect(bitmapToIndices("4")).toEqual([2]);
    expect(bitmapToIndices("0x4")).toEqual([2]);
    expect(bitmapToIndices("0Xe")).toEqual([1, 2, 3]);
    expect(bitmapToIndices("")).toEqual([]);
  });

  it("scans all 256 bits, including provider bits from 64", () => {
    expect(bitmapToIndices("1" + "0".repeat(16))).toEqual([64]);
    expect(bitmapToIndices("80" + "00".repeat(31))).toEqual([255]);
    expect(bitmapToIndices("0x" + "00".repeat(31) + "ff")).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("throws on hex longer than 32 bytes instead of reading its first 32", () => {
    expect(() => bitmapToIndices("00".repeat(33))).toThrow(RangeError);
  });

  it("is still exported from the solana accounts module", () => {
    expect(fromAccounts).toBe(bitmapToIndices);
  });
});
