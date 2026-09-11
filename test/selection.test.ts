import { keccak_256 } from "@noble/hashes/sha3.js";
import { describe, expect, it } from "vitest";
import { concatBytes, u32be, u64be, utf8 } from "../src/core/encoding.js";
import {
  bitmapBitSet,
  deriveGroupBitmap,
  deriveSelectionSeed,
  effectiveSelectionSize,
  selectedIndices,
} from "../src/core/selection.js";

const sourceId = new Uint8Array(32).fill(7);

describe("deriveSelectionSeed", () => {
  it("matches the documented construction", () => {
    const expected = keccak_256(
      concatBytes(
        keccak_256(utf8("MOLPHA_SELECTION_V1")),
        sourceId,
        u32be(3),
        u64be(1_700_000_000),
      ),
    );
    expect(deriveSelectionSeed(sourceId, 3, 1_700_000_000)).toEqual(expected);
  });
});

describe("effectiveSelectionSize", () => {
  it("clamps to nodeCount", () => {
    expect(effectiveSelectionSize(3, 2, 100)).toBe(5);
    expect(effectiveSelectionSize(3, 2, 4)).toBe(4);
  });
});

describe("bitmap bit helpers", () => {
  it("round-trips set bits in the 32-byte big-endian word", () => {
    const bitmap = new Uint8Array(32);
    // bit 0 lives in the last byte, lsb.
    bitmap[31] = 0b0000_0101; // bits 0 and 2
    bitmap[30] = 0b0000_0010; // bit 9
    expect(bitmapBitSet(bitmap, 0)).toBe(true);
    expect(bitmapBitSet(bitmap, 1)).toBe(false);
    expect(bitmapBitSet(bitmap, 2)).toBe(true);
    expect(bitmapBitSet(bitmap, 9)).toBe(true);
    expect(selectedIndices(bitmap, 16)).toEqual([0, 2, 9]);
  });
});

describe("deriveGroupBitmap", () => {
  const seed = deriveSelectionSeed(sourceId, 1, 1234);

  it("selects exactly groupSize distinct nodes (no replacement)", () => {
    for (const [nodeCount, groupSize] of [
      [10, 3],
      [10, 7], // exercises the complement path
      [50, 25],
      [4, 4],
    ] as const) {
      const bitmap = deriveGroupBitmap(seed, nodeCount, groupSize);
      const idxs = selectedIndices(bitmap, nodeCount);
      expect(idxs.length).toBe(groupSize);
      expect(new Set(idxs).size).toBe(groupSize);
      expect(idxs.every((i) => i >= 0 && i < nodeCount)).toBe(true);
    }
  });

  it("is deterministic", () => {
    expect(deriveGroupBitmap(seed, 20, 8)).toEqual(deriveGroupBitmap(seed, 20, 8));
  });

  it("returns all-zero for empty selection", () => {
    expect(selectedIndices(deriveGroupBitmap(seed, 10, 0), 10)).toEqual([]);
  });

  it("throws when groupSize > nodeCount", () => {
    expect(() => deriveGroupBitmap(seed, 5, 9)).toThrow(/GroupBitmapDerivationFailed/);
  });

  it("matches on-chain vector fixtures", () => {
    const seed = new Uint8Array(32).fill(0x11);
    const cases = [
      [8, 3, "0000000000000000000000000000000000000000000000000000000000000038"],
      [10, 7, "00000000000000000000000000000000000000000000000000000000000003d3"],
      [16, 5, "0000000000000000000000000000000000000000000000000000000000002c30"],
      [32, 20, "00000000000000000000000000000000000000000000000000000000d7ddb3a1"],
    ] as const;

    for (const [nodeCount, groupSize, expectedHex] of cases) {
      const got = deriveGroupBitmap(seed, nodeCount, groupSize);
      expect(Buffer.from(got).toString("hex")).toBe(expectedHex);
    }
  });
});
