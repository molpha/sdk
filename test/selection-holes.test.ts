import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes } from "../src/core/encoding.js";
import {
  bitmapBitSet,
  deriveSelectionBitmap,
  mapRanksToSlots,
} from "../src/core/selection.js";
import {
  decodeRegistryAccount,
  liveSlots,
  resolveRemainingAccounts,
  type RegistryView,
} from "../src/solana/accounts.js";
import { addressFromBytes } from "../src/solana/kit.js";

/** The vectors the verifier crate pins: `molpha-verifier/tests/fixtures/selection_holes.vectors`. */
const vectors = readFileSync(
  new URL("./fixtures/selection_holes.vectors", import.meta.url),
  "utf8",
)
  .trim()
  .split("\n")
  .map((line) => {
    const [live, source, version, timestamp, required, buffer, expected] =
      line.split(" ") as [string, string, string, string, string, string, string];
    return { live, source, version, timestamp, required, buffer, expected };
  });

function liveSlotsOfBitmap(liveHex: string): number[] {
  const live = hexToBytes(liveHex);
  const slots: number[] = [];
  for (let slot = 0; slot < 256; slot++) if (bitmapBitSet(live, slot)) slots.push(slot);
  return slots;
}

describe("selection over a registry with holes", () => {
  it("matches the shared verifier vectors", () => {
    expect(vectors).toHaveLength(48);
    for (const v of vectors) {
      const live = liveSlotsOfBitmap(v.live);
      const got = deriveSelectionBitmap(
        hexToBytes(v.source),
        Number(v.version),
        live[live.length - 1]! + 1,
        Number(v.required),
        Number(v.buffer),
        BigInt(v.timestamp),
        live,
      );
      expect(bytesToHex(got).replace(/^0x/, "")).toBe(v.expected);
    }
  });

  it("is the plain draw when no slot is a hole", () => {
    const source = new Uint8Array(32).fill(7);
    const ts = 1_705_257_421_000n;
    const dense = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    expect(deriveSelectionBitmap(source, 3, 12, 5, 2, ts, dense)).toEqual(
      deriveSelectionBitmap(source, 3, 12, 5, 2, ts),
    );
  });

  it("never selects a hole and keeps the committee size", () => {
    const live = [1, 2, 5, 6, 9, 10, 11, 14];
    for (let w = 0; w < 32; w++) {
      const bitmap = deriveSelectionBitmap(
        new Uint8Array(32).fill(w),
        1,
        15,
        3,
        2,
        BigInt(1_700_000_000 + w) * 1000n,
        live,
      );
      const picked = [...Array(15).keys()].filter((i) => bitmapBitSet(bitmap, i));
      expect(picked).toHaveLength(5);
      for (const slot of picked) expect(live).toContain(slot);
    }
  });

  it("maps ranks to slots", () => {
    const ranks = new Uint8Array(32);
    ranks[31] = 0b101; // ranks 0 and 2
    const mapped = mapRanksToSlots(ranks, [3, 7, 9]);
    expect([3, 7, 9].map((slot) => bitmapBitSet(mapped, slot))).toEqual([true, false, true]);
  });
});

describe("registry snapshots with holes", () => {
  function account(slots: Array<number | null>, version = 5): Uint8Array {
    const data = new Uint8Array(32 + slots.length * 96);
    const view = new DataView(data.buffer);
    view.setBigInt64(8, 0n, true);
    view.setBigInt64(16, 100n, true);
    view.setUint32(24, version, true);
    view.setUint16(28, slots.length, true);
    data[30] = 2;
    slots.forEach((fill, slot) => {
      if (fill !== null) data.fill(fill, 32 + slot * 96, 32 + slot * 96 + 32);
    });
    return data;
  }

  it("decodes holes as null and keeps the other slots in place", () => {
    const registry = decodeRegistryAccount(account([1, null, 3, 4]));
    expect(registry).toMatchObject({ version: 5, nodeCount: 4, redundancyBuffer: 2, activeFrom: 100n });
    expect(registry.nodes[1]).toBeNull();
    expect(registry.nodes[2]).toBe(addressFromBytes(new Uint8Array(32).fill(3)));
    expect(liveSlots(registry)).toEqual([0, 2, 3]);
  });

  it("rejects a table shorter than its slot count", () => {
    const data = account([1, 2, 3]);
    expect(() => decodeRegistryAccount(data.subarray(0, data.length - 1))).toThrow(/claims 3 slots/);
  });

  it("refuses a signer bit on a hole or past the last slot", () => {
    const registry: RegistryView = decodeRegistryAccount(account([1, null, 3]));
    const bitmap = (bits: number[]) => {
      const out = new Uint8Array(32);
      for (const bit of bits) out[31 - (bit >> 3)]! |= 1 << (bit & 7);
      return bytesToHex(out).replace(/^0x/, "");
    };
    expect(resolveRemainingAccounts(bitmap([0, 2]), registry)).toHaveLength(2);
    expect(() => resolveRemainingAccounts(bitmap([0, 1]), registry)).toThrow(/names no live node/);
    expect(() => resolveRemainingAccounts(bitmap([3]), registry)).toThrow(/names no live node/);
  });
});
