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
  MESSAGE_PREFIX,
  attestationMessageHash,
  attestationMessageHashFromResult,
} from "../src/core/message.js";
import type { DataUpdateResult } from "../src/core/types.js";

/** Immutable 12-node fixture pinned by Rust tests/fixtures/mod.rs and Go internal/round/message_test.go. */
const VECTOR = {
  sourceId: "41b87cd1b00231a5caebdfbc3e352d92bb0ec116335cc3544278a4bac95071a7",
  registryVersion: 12,
  signaturesRequired: 5,
  value: "12cd90a4cd4351a26f2bd02583d791ae1b1a3285853a3315e718db8d7b85a62d",
  canonicalTimestamp: 1_705_257_421,
  /** uint256(4008) — bits 3, 5, 7, 8, 9, 10, 11. */
  signersBitmap: "0000000000000000000000000000000000000000000000000000000000000fa8",
};
const EXPECTED = "52e92f58c9c128d2f7e0be6165c4d58f843c39e828c12fcad8cdc566152f2bb1";

describe("MESSAGE_PREFIX", () => {
  it('is keccak256("MOLPHA_MESSAGE_V1")', () => {
    expect(MESSAGE_PREFIX).toEqual(keccak_256(utf8("MOLPHA_MESSAGE_V1")));
    expect(bytesToHex(MESSAGE_PREFIX)).toBe(
      "a75523a2ab7b718d9cffd2fa97ed069fc12184eabee7d507854d0922f70e7fe7",
    );
  });
});

describe("attestationMessageHash", () => {
  it("matches the immutable Rust and Go golden vector", () => {
    expect(bytesToHex(attestationMessageHash(VECTOR))).toBe(EXPECTED);
  });

  it("encodes the 141-byte preimage in protocol order", () => {
    const preimage = concatBytes(
      MESSAGE_PREFIX,
      hexToBytes(VECTOR.value),
      hexToBytes(VECTOR.sourceId),
      u32be(VECTOR.registryVersion),
      Uint8Array.of(VECTOR.signaturesRequired),
      u64be(VECTOR.canonicalTimestamp),
      hexToBytes(VECTOR.signersBitmap),
    );
    expect(preimage).toHaveLength(141);
    expect(bytesToHex(keccak_256(preimage))).toBe(EXPECTED);
    expect(attestationMessageHash(VECTOR)).toEqual(keccak_256(preimage));
  });

  it("accepts bytes or hex, with or without 0x", () => {
    const asBytes = attestationMessageHash({
      ...VECTOR,
      sourceId: hexToBytes(VECTOR.sourceId),
      value: hexToBytes(VECTOR.value),
      signersBitmap: hexToBytes(VECTOR.signersBitmap),
      canonicalTimestamp: BigInt(VECTOR.canonicalTimestamp),
    });
    const with0x = attestationMessageHash({
      ...VECTOR,
      sourceId: `0x${VECTOR.sourceId}`,
      value: `0x${VECTOR.value}`,
    });
    expect(bytesToHex(asBytes)).toBe(EXPECTED);
    expect(bytesToHex(with0x)).toBe(EXPECTED);
  });

  it("is sensitive to every field", () => {
    const base = bytesToHex(attestationMessageHash(VECTOR));
    const variants = [
      { ...VECTOR, sourceId: "ff" + VECTOR.sourceId.slice(2) },
      { ...VECTOR, registryVersion: 13 },
      { ...VECTOR, signaturesRequired: 6 },
      { ...VECTOR, signersBitmap: VECTOR.signersBitmap.slice(0, -1) + "9" },
      { ...VECTOR, value: "00" + VECTOR.value.slice(2) },
      { ...VECTOR, canonicalTimestamp: VECTOR.canonicalTimestamp + 1 },
    ];
    for (const variant of variants) {
      expect(bytesToHex(attestationMessageHash(variant))).not.toBe(base);
    }
  });

  it("rejects wrong-length inputs", () => {
    expect(() => attestationMessageHash({ ...VECTOR, sourceId: "aa".repeat(31) })).toThrow();
    expect(() => attestationMessageHash({ ...VECTOR, value: "aa".repeat(33) })).toThrow();
    expect(() => attestationMessageHash({ ...VECTOR, signersBitmap: "aa" })).toThrow();
    expect(() => attestationMessageHash({ ...VECTOR, signaturesRequired: 256 })).toThrow();
    expect(() => attestationMessageHash({ ...VECTOR, signaturesRequired: -1 })).toThrow();
    expect(() => attestationMessageHash({ ...VECTOR, signaturesRequired: 1.5 })).toThrow();
  });
});

describe("attestationMessageHashFromResult", () => {
  it("hashes the signed fields of a gateway result", () => {
    const result: DataUpdateResult = {
      sourceId: VECTOR.sourceId,
      value: "1",
      valuePacked: VECTOR.value,
      timestamp: VECTOR.canonicalTimestamp,
      registryVersion: VECTOR.registryVersion,
      signaturesRequired: VECTOR.signaturesRequired,
      signersBitmap: VECTOR.signersBitmap,
      s: "cc".repeat(32),
      commitmentAddr: "dd".repeat(20),
      fresh: true,
    };
    expect(bytesToHex(attestationMessageHashFromResult(result))).toBe(EXPECTED);
  });
});
