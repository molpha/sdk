import { keccak_256 } from "@noble/hashes/sha3.js";
import { describe, expect, it } from "vitest";
import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  u32be,
  u64be,
  utf8,
} from "../src/core/encoding.js";
import {
  ROUND_ID_PREFIX,
  deriveRoundId,
  deriveRoundIdHex,
} from "../src/core/round.js";

/**
 * Golden vector shared with the gateway: `TestRoundIDGoldenVector` in
 * `gateway/internal/gateway/features/execute/mapping/mapping_test.go`, which is itself locked to
 * the node client's `internal/round/message_test.go`.
 */
const VECTOR = {
  sourceId: "11".repeat(32),
  signaturesRequired: 3,
  registryVersion: 4,
  timestamp: 1_700_000_000_000,
  roundId: "9037b9929cbb82f82a5f4f31438e749186f9e79fc6743ccb14074cc9b4ad1e99",
};

describe("deriveRoundId", () => {
  it("matches the gateway's golden vector", () => {
    expect(bytesToHex(deriveRoundId(VECTOR))).toBe(VECTOR.roundId);
    expect(deriveRoundIdHex(VECTOR)).toBe(`0x${VECTOR.roundId}`);
  });

  it("accepts the source id as bytes, with or without 0x", () => {
    const fromBytes = deriveRoundId({
      ...VECTOR,
      sourceId: hexToBytes(VECTOR.sourceId),
    });
    const fromHex0x = deriveRoundId({
      ...VECTOR,
      sourceId: `0x${VECTOR.sourceId}`,
    });
    expect(bytesToHex(fromBytes)).toBe(VECTOR.roundId);
    expect(bytesToHex(fromHex0x)).toBe(VECTOR.roundId);
  });

  it("accepts the timestamp as bigint", () => {
    const id = deriveRoundId({ ...VECTOR, timestamp: BigInt(VECTOR.timestamp) });
    expect(bytesToHex(id)).toBe(VECTOR.roundId);
  });

  it("hashes the quorum as a u32, not the single byte the signed message uses", () => {
    const preimage = concatBytes(
      keccak_256(utf8("MOLPHA_PULL_ROUND_V1")),
      hexToBytes(VECTOR.sourceId),
      u32be(VECTOR.signaturesRequired),
      u32be(VECTOR.registryVersion),
      u64be(VECTOR.timestamp),
    );
    expect(preimage.length).toBe(32 + 32 + 4 + 4 + 8);
    expect(bytesToHex(keccak_256(preimage))).toBe(VECTOR.roundId);
    expect(ROUND_ID_PREFIX.length).toBe(32);
  });

  it("changes with every field", () => {
    const base = deriveRoundIdHex(VECTOR);
    expect(deriveRoundIdHex({ ...VECTOR, signaturesRequired: 4 })).not.toBe(base);
    expect(deriveRoundIdHex({ ...VECTOR, registryVersion: 5 })).not.toBe(base);
    expect(deriveRoundIdHex({ ...VECTOR, timestamp: VECTOR.timestamp + 100 })).not.toBe(base);
    expect(deriveRoundIdHex({ ...VECTOR, sourceId: "12".repeat(32) })).not.toBe(base);
  });

  it("rejects a source id that is not 32 bytes", () => {
    expect(() => deriveRoundId({ ...VECTOR, sourceId: "11".repeat(31) })).toThrow(RangeError);
  });

  it("rejects out-of-range numbers", () => {
    expect(() => deriveRoundId({ ...VECTOR, signaturesRequired: -1 })).toThrow(RangeError);
    expect(() => deriveRoundId({ ...VECTOR, registryVersion: 2 ** 32 })).toThrow(RangeError);
    expect(() => deriveRoundId({ ...VECTOR, timestamp: -1 })).toThrow(RangeError);
  });
});
