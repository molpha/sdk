import { describe, expect, it } from "vitest";
import type { DataUpdateResult } from "../src/core/types.js";
import { VERIFY_CODES, verifyCodeName } from "../src/core/verifyCodes.js";
import {
  MOLPHA_VERIFIER_STARKNET_ADDRESSES,
  MOLPHA_VERIFIER_STARKNET_SEPOLIA,
  getMolphaStarknetVerifierAddress,
} from "../src/starknet/constants.js";
import {
  buildStarknetVerifierArgs,
  commitmentAddressToStarknetFelt,
  encodeStarknetVerifyCalldata,
  parseStarknetVerifyResult,
  signersBitmapToStarknetUint256,
} from "../src/starknet/helpers.js";

const SAMPLE_RESULT: DataUpdateResult = {
  sourceId: "aa".repeat(32),
  value: "100",
  valuePacked: "bb".repeat(32),
  timestamp: 1_700_000_000,
  registryVersion: 2,
  signaturesRequired: 3,
  signersBitmap: "00".repeat(31) + "01",
  s: "cc".repeat(32),
  commitmentAddr: "dd".repeat(20),
  fresh: true,
};

/**
 * The EVM golden vector (`molpha-core-contracts/test/fixtures/fixture.json`): a 12-node round
 * the Solidity and Rust verifiers both accept.
 */
const EVM_FIXTURE_RESULT: DataUpdateResult = {
  sourceId: "93893838ba3cf2a46fc061b4c3acfba3435fa61b0c29017fe78280146255b604",
  value: "",
  valuePacked: "c6d8f1c0fdb8997313cbc4bc43b46af78589ba4bb9036707097db8b33879d6c6",
  timestamp: 1_700_034_927,
  registryVersion: 12,
  signaturesRequired: 5,
  signersBitmap: "00".repeat(30) + "07f0",
  s: "9f52f4fd6b2f82086803269007cbda35cf024c40af57160b7472817e2691ef73",
  commitmentAddr: "aff31ae9e8f7624c9f8c149f1f12bb00f1606c10",
  fresh: true,
};

/**
 * Flat calldata for `EVM_FIXTURE_RESULT` with `maxAge: 0`, computed from `fixture.json`
 * independently of this SDK and then submitted to the Cairo verifier (`molpha-starknet`),
 * which returned `(1, 0)`. Flipping `value.low` returned `(0, 9)`, and a non-zero final
 * felt was read as `max_age`. If this expectation ever needs to change, the Starknet
 * interface changed — re-prove it against the contract rather than updating the literal.
 */
const EVM_FIXTURE_CALLDATA = [
  "0x8589ba4bb9036707097db8b33879d6c6", // value.low
  "0xc6d8f1c0fdb8997313cbc4bc43b46af7", // value.high
  "0x435fa61b0c29017fe78280146255b604", // source_id.low
  "0x93893838ba3cf2a46fc061b4c3acfba3", // source_id.high
  "0xc", // registry_version
  "0x5", // signatures_required
  "0x6554796f", // canonical_timestamp
  "0xcf024c40af57160b7472817e2691ef73", // signature.low
  "0x9f52f4fd6b2f82086803269007cbda35", // signature.high
  "0xaff31ae9e8f7624c9f8c149f1f12bb00f1606c10", // commitment
  "0x7f0", // signers_bitmap.low
  "0x0", // signers_bitmap.high
  "0x0", // max_age
];

describe("Molpha Starknet verifier addresses", () => {
  it("exports the expected deployed addresses", () => {
    expect(MOLPHA_VERIFIER_STARKNET_SEPOLIA).toBe(
      "0x0378df4dbecf8f0c7daa801282932f7011c7a5e5773bab9eaf68f5fa5e7530ef",
    );
  });

  it("maps network ids to addresses", () => {
    expect(MOLPHA_VERIFIER_STARKNET_ADDRESSES["starknet-sepolia"]).toBe(
      MOLPHA_VERIFIER_STARKNET_SEPOLIA,
    );
    expect(getMolphaStarknetVerifierAddress("starknet-sepolia")).toBe(
      MOLPHA_VERIFIER_STARKNET_SEPOLIA,
    );
  });
});

describe("Starknet verifier argument helpers", () => {
  it("converts commitment and signer bitmap to bigint", () => {
    expect(commitmentAddressToStarknetFelt("00".repeat(19) + "01")).toBe(1n);
    expect(signersBitmapToStarknetUint256("00".repeat(31) + "01")).toBe(1n);
  });

  it("builds the nested Attestation from a DataUpdateResult, in Cairo member order", () => {
    const { attestation, maxAge } = buildStarknetVerifierArgs(SAMPLE_RESULT, { maxAge: 300 });

    expect(attestation).toEqual({
      payload: {
        value: BigInt(`0x${"bb".repeat(32)}`),
        source_id: BigInt(`0x${"aa".repeat(32)}`),
        registry_version: 2,
        signatures_required: 3,
        canonical_timestamp: 1_700_000_000,
      },
      signature: {
        signature: BigInt(`0x${"cc".repeat(32)}`),
        commitment: BigInt(`0x${"dd".repeat(20)}`),
        signers_bitmap: 1n,
      },
    });
    // Key order is the Cairo `Serde` order; an ABI-aware client may rely on it.
    expect(Object.keys(attestation.payload)).toEqual([
      "value",
      "source_id",
      "registry_version",
      "signatures_required",
      "canonical_timestamp",
    ]);
    expect(maxAge).toBe(300);
  });

  it("passes maxAge 0 through rather than substituting a default", () => {
    expect(buildStarknetVerifierArgs(SAMPLE_RESULT, { maxAge: 0 }).maxAge).toBe(0);
  });

  it("rejects integers that would fail Cairo Serde and revert before verify runs", () => {
    const build = (patch: Partial<DataUpdateResult>, maxAge = 0) =>
      buildStarknetVerifierArgs({ ...SAMPLE_RESULT, ...patch }, { maxAge });

    expect(() => build({ signaturesRequired: 256 })).toThrow(/signaturesRequired/);
    expect(() => build({ registryVersion: 2 ** 32 })).toThrow(/registryVersion/);
    expect(() => build({ registryVersion: -1 })).toThrow(/registryVersion/);
    expect(() => build({ timestamp: 1.5 })).toThrow(/timestamp/);
    expect(() => build({}, -1)).toThrow(/maxAge/);
    expect(() => build({}, Number.NaN)).toThrow(/maxAge/);
    expect(() => build({ commitmentAddr: "dd".repeat(21) })).toThrow(/commitment/);
  });
});

describe("encodeStarknetVerifyCalldata", () => {
  it("matches the calldata proven against the Cairo verifier for the EVM golden vector", () => {
    const args = buildStarknetVerifierArgs(EVM_FIXTURE_RESULT, { maxAge: 0 });
    expect(encodeStarknetVerifyCalldata(args)).toEqual(EVM_FIXTURE_CALLDATA);
  });

  it("places max_age last and splits u256 values low limb first", () => {
    const calldata = encodeStarknetVerifyCalldata(
      buildStarknetVerifierArgs(
        { ...SAMPLE_RESULT, signersBitmap: "00".repeat(15) + "01" + "00".repeat(15) + "02" },
        { maxAge: 3600 },
      ),
    );
    expect(calldata).toHaveLength(13);
    expect(calldata[10]).toBe("0x2"); // signers_bitmap.low
    expect(calldata[11]).toBe("0x1"); // signers_bitmap.high
    expect(calldata[12]).toBe("0xe10"); // max_age = 3600
  });

  it("rejects hand-built args that the contract could not deserialize", () => {
    const args = buildStarknetVerifierArgs(SAMPLE_RESULT, { maxAge: 0 });
    const withPayload = (patch: object) => ({
      ...args,
      attestation: { ...args.attestation, payload: { ...args.attestation.payload, ...patch } },
    });
    const withSignature = (patch: object) => ({
      ...args,
      attestation: {
        ...args.attestation,
        signature: { ...args.attestation.signature, ...patch },
      },
    });

    expect(() => encodeStarknetVerifyCalldata(withPayload({ value: 1n << 256n }))).toThrow(/value/);
    expect(() => encodeStarknetVerifyCalldata(withPayload({ source_id: -1n }))).toThrow(
      /source_id/,
    );
    expect(() => encodeStarknetVerifyCalldata(withPayload({ signatures_required: 300 }))).toThrow(
      /signatures_required/,
    );
    expect(() => encodeStarknetVerifyCalldata(withSignature({ commitment: 1n << 160n }))).toThrow(
      /commitment/,
    );
  });
});

describe("parseStarknetVerifyResult", () => {
  it("decodes the raw two-felt starknet_call response", () => {
    expect(parseStarknetVerifyResult(["0x1", "0x0"])).toEqual({
      success: true,
      code: VERIFY_CODES.OK,
      reason: "OK",
    });
    expect(parseStarknetVerifyResult(["0x0", "0x9"])).toEqual({
      success: false,
      code: VERIFY_CODES.BAD_SIGNATURE,
      reason: "BAD_SIGNATURE",
    });
    expect(parseStarknetVerifyResult(["0", "10"]).reason).toBe("STALE");
  });

  it("decodes an ABI-client tuple", () => {
    expect(parseStarknetVerifyResult({ 0: false, 1: 7n })).toEqual({
      success: false,
      code: VERIFY_CODES.BAD_QUORUM,
      reason: "BAD_QUORUM",
    });
    expect(parseStarknetVerifyResult([true, 0])).toMatchObject({ success: true, reason: "OK" });
  });

  it("reports codes newer than this SDK as UNKNOWN instead of failing", () => {
    expect(parseStarknetVerifyResult(["0x0", "0x2a"])).toEqual({
      success: false,
      code: 42,
      reason: "UNKNOWN",
    });
  });

  it("throws on responses that cannot come from a Molpha verifier", () => {
    expect(() => parseStarknetVerifyResult(["0x1", "0x9"])).toThrow(/inconsistent/);
    expect(() => parseStarknetVerifyResult(["0x0", "0x0"])).toThrow(/inconsistent/);
    expect(() => parseStarknetVerifyResult(["0x2", "0x0"])).toThrow(/0 or 1/);
    expect(() => parseStarknetVerifyResult(["0x0", "0x100"])).toThrow(/u8/);
    expect(() => parseStarknetVerifyResult(["0x1"])).toThrow(/2 felts/);
    expect(() => parseStarknetVerifyResult(["0x1", "nope"])).toThrow(/not a felt/);
  });
});

describe("VERIFY_CODES", () => {
  it("pins the cross-VM numbering (VerifyCodes.sol / verify_codes.cairo)", () => {
    expect(VERIFY_CODES).toEqual({
      OK: 0,
      FEED_WITNESS: 1,
      BAD_REGISTRY_VERSION: 2,
      MALFORMED: 3,
      NOT_YET_ACTIVE: 4,
      VERSION_EXPIRED: 5,
      COMPROMISED_QUORUM: 6,
      BAD_QUORUM: 7,
      BAD_AGGREGATE: 8,
      BAD_SIGNATURE: 9,
      STALE: 10,
    });
  });

  it("names known codes and leaves unknown ones undefined", () => {
    expect(verifyCodeName(8)).toBe("BAD_AGGREGATE");
    expect(verifyCodeName(11)).toBeUndefined();
  });
});
