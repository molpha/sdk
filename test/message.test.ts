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

/** Shared fixture: molpha-solana-program/molpha-tests/fixtures/verify-answer-evm.json. */
const VECTOR = {
  sourceId: "93893838ba3cf2a46fc061b4c3acfba3435fa61b0c29017fe78280146255b604",
  registryVersion: 12,
  signaturesRequired: 5,
  value: "c6d8f1c0fdb8997313cbc4bc43b46af78589ba4bb9036707097db8b33879d6c6",
  canonicalTimestamp: 1_700_034_927,
  /** uint256(2032) — bits 4..10. */
  signersBitmap: "00".repeat(30) + "07f0",
};
const EXPECTED = "0cea740d877fc5ba51c244ee6172f51e0862fb42972c6d008e8cffb486b67d16";

describe("MESSAGE_PREFIX", () => {
  it('is keccak256("MOLPHA_MESSAGE_V1")', () => {
    expect(MESSAGE_PREFIX).toEqual(keccak_256(utf8("MOLPHA_MESSAGE_V1")));
    expect(bytesToHex(MESSAGE_PREFIX)).toBe(
      "a75523a2ab7b718d9cffd2fa97ed069fc12184eabee7d507854d0922f70e7fe7",
    );
  });
});

describe("attestationMessageHash", () => {
  it("matches the cross-VM fixture", () => {
    expect(bytesToHex(attestationMessageHash(VECTOR))).toBe(EXPECTED);
  });

  it("follows abi.encodePacked(prefix, sourceId, u32, u32, u256, bytes32, u64)", () => {
    const expected = keccak_256(
      concatBytes(
        MESSAGE_PREFIX,
        hexToBytes(VECTOR.sourceId),
        u32be(VECTOR.registryVersion),
        u32be(VECTOR.signaturesRequired),
        hexToBytes(VECTOR.signersBitmap),
        hexToBytes(VECTOR.value),
        u64be(VECTOR.canonicalTimestamp),
      ),
    );
    expect(attestationMessageHash(VECTOR)).toEqual(expected);
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
      { ...VECTOR, signersBitmap: "00".repeat(30) + "07f1" },
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
