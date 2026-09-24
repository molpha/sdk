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

/**
 * Shared fixture: `molpha-verifier/tests/fixtures/mod.rs`, pinned on EVM by
 * `MessageFormatSpec.t.sol::test_constructMessage_matchesRustAndSdkSharedVector`.
 */
const VECTOR = {
  sourceId: "41b87cd1b00231a5caebdfbc3e352d92bb0ec116335cc3544278a4bac95071a7",
  registryVersion: 12,
  signaturesRequired: 5,
  value: "12cd90a4cd4351a26f2bd02583d791ae1b1a3285853a3315e718db8d7b85a62d",
  canonicalTimestamp: 1_705_257_421,
  /** uint256(4008) — bits 3, 5, 7, 8, 9, 10, 11. */
  signersBitmap: "00".repeat(30) + "0fa8",
};
const EXPECTED = "52e92f58c9c128d2f7e0be6165c4d58f843c39e828c12fcad8cdc566152f2bb1";

/** Digests the EVM verifier (`molpha-core-contracts`) pins for other inputs. */
const EVM_VECTORS = [
  {
    name: "MessageFormatSpec.t.sol",
    fields: {
      sourceId: "00".repeat(31) + "01",
      registryVersion: 7,
      signaturesRequired: 3,
      value: "00".repeat(28) + "deadbeef",
      canonicalTimestamp: 1_699_965_440,
      signersBitmap: "00".repeat(31) + "83",
    },
    expected: "7527b765799e48db80cefdd8c8cf76fd1e8feed2838eee5ba7ab862d920b5e61",
  },
  {
    name: "fixtures/fixture.json",
    fields: {
      sourceId: "93893838ba3cf2a46fc061b4c3acfba3435fa61b0c29017fe78280146255b604",
      registryVersion: 12,
      signaturesRequired: 5,
      value: "c6d8f1c0fdb8997313cbc4bc43b46af78589ba4bb9036707097db8b33879d6c6",
      canonicalTimestamp: 1_700_034_927,
      signersBitmap: "00".repeat(30) + "07f0",
    },
    expected: "a3e58f5c157c98cad4fd8478fd39b18da85f4ad2d581db06b724f53b55afc5b3",
  },
  {
    name: "fixtures/attestation.json kindB-tuple",
    fields: {
      sourceId: "a6729f7c91f13795a38aa67f4bc816fae5bef9ffbeb4319c69a9242f2e68cdbc",
      registryVersion: 12,
      signaturesRequired: 5,
      value: "47869257dae795e85b30cb6a0ac7f82fe977ec5ced28d96a70f3fe2cb514ff1a",
      canonicalTimestamp: 1_700_000_000,
      signersBitmap: "00".repeat(30) + "0153",
    },
    expected: "0c9f7a402576e4df66820f04379b92039b9629b872d40aec0b3ec77d6b031a48",
  },
];

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

  it.each(EVM_VECTORS)("matches the EVM verifier's pinned digest ($name)", ({ fields, expected }) => {
    expect(bytesToHex(attestationMessageHash(fields))).toBe(expected);
  });

  it("follows abi.encodePacked(prefix, bytes32 value, bytes32 sourceId, u32, u8, u64, u256)", () => {
    const expected = keccak_256(
      concatBytes(
        MESSAGE_PREFIX,
        hexToBytes(VECTOR.value),
        hexToBytes(VECTOR.sourceId),
        u32be(VECTOR.registryVersion),
        Uint8Array.of(VECTOR.signaturesRequired),
        u64be(VECTOR.canonicalTimestamp),
        hexToBytes(VECTOR.signersBitmap),
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
      { ...VECTOR, signersBitmap: "00".repeat(30) + "0fa9" },
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

  it("rejects a signaturesRequired that does not fit the signed u8", () => {
    // `Uint8Array.of(261)` would silently hash as 5 and collide with the real vector.
    expect(() => attestationMessageHash({ ...VECTOR, signaturesRequired: 261 })).toThrow(/u8/);
    expect(() => attestationMessageHash({ ...VECTOR, signaturesRequired: -1 })).toThrow(/u8/);
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
