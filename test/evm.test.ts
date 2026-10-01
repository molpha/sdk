import { keccak_256 } from "@noble/hashes/sha3.js";
import { decodeFunctionResult, encodeFunctionData, toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";
import { bytesToHex, utf8 } from "../src/core/encoding.js";
import { attestationMessageHashFromResult } from "../src/core/message.js";
import type { DataUpdateResult } from "../src/core/types.js";
import { VERIFY_CODES } from "../src/core/verifyCodes.js";
import { MOLPHA_VERIFIER_ABI } from "../src/evm/abi.js";
import { MOLPHA_VERIFIER_ADDRESS } from "../src/evm/constants.js";
import {
  buildEvmVerifierArgs,
  encodeEvmVerifyCalldata,
  parseEvmVerifyResult,
  signersBitmapToDecimal,
  signersBitmapToUint256,
  toFixedHex,
} from "../src/evm/helpers.js";

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
 * `molpha-core-contracts/test/fixtures/attestation.json`, case `kindA-int256`: a 12-node,
 * buffer-2 registry at version 12 where `Verifier.verify(attestation, 0)` returns `(true, 0)`
 * (`AttestationFixtureJson.t.sol`).
 */
const EVM_FIXTURE_RESULT: DataUpdateResult = {
  sourceId: "a6729f7c91f13795a38aa67f4bc816fae5bef9ffbeb4319c69a9242f2e68cdbc",
  value: "-1234",
  valuePacked: "fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffb2e",
  timestamp: 1_700_000_000,
  registryVersion: 12,
  signaturesRequired: 5,
  /** uint256(339) — bits 0, 1, 4, 6, 8. */
  signersBitmap: "00".repeat(30) + "0153",
  s: "c9dc93909c0274b7a84f6c82fd795b5a47b3c5d2e5d6a00b8c1605c456e7ff78",
  commitmentAddr: "4A4eEa2ec80f98472b13Fd4787e671e7A233bC5d",
  fresh: true,
};
const EVM_FIXTURE_MESSAGE_HASH = "840185b8abb1635e5e5f94df05e794c4708657c6a3a2cd354c0158dc91addeab";

/**
 * `EVM_FIXTURE_RESULT` with `maxAge: 300`, from Foundry independently of this SDK:
 * `cast calldata "verify(((bytes32,bytes32,uint32,uint8,uint64),(bytes32,address,uint256)),uint64)" ...`.
 * If this ever needs to change, the verifier interface changed — re-derive it from the
 * contract rather than updating the literal.
 */
const EVM_FIXTURE_CALLDATA =
  "0x67e2907b" +
  "fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffb2e" + // value
  "a6729f7c91f13795a38aa67f4bc816fae5bef9ffbeb4319c69a9242f2e68cdbc" + // sourceId
  "000000000000000000000000000000000000000000000000000000000000000c" + // registryVersion
  "0000000000000000000000000000000000000000000000000000000000000005" + // signaturesRequired
  "000000000000000000000000000000000000000000000000000000006553f100" + // canonicalTimestamp
  "c9dc93909c0274b7a84f6c82fd795b5a47b3c5d2e5d6a00b8c1605c456e7ff78" + // signature
  "0000000000000000000000004a4eea2ec80f98472b13fd4787e671e7a233bc5d" + // commitment
  "0000000000000000000000000000000000000000000000000000000000000153" + // signersBitmap
  "000000000000000000000000000000000000000000000000000000000000012c"; // maxAge

const VERIFY_SIGNATURE =
  "verify(((bytes32,bytes32,uint32,uint8,uint64),(bytes32,address,uint256)),uint64)";

describe("MOLPHA verifier address", () => {
  it("exports the CREATE2 address used on all EVM chains", () => {
    expect(MOLPHA_VERIFIER_ADDRESS).toBe(
      "0xE1fd792b7E54e0C8F0Cd1c8055E446ff36d233eB",
    );
  });
});

describe("MOLPHA_VERIFIER_ABI", () => {
  it("declares verify(Attestation, uint64) -> (bool, uint8)", () => {
    const verify = MOLPHA_VERIFIER_ABI.find((e) => e.type === "function" && e.name === "verify");
    expect(verify).toBeDefined();
    expect(toFunctionSelector(verify!)).toBe("0x67e2907b");
    expect(`0x${bytesToHex(keccak_256(utf8(VERIFY_SIGNATURE)).subarray(0, 4))}`).toBe(
      "0x67e2907b",
    );
  });

  it("carries no state-changing functions", () => {
    for (const entry of MOLPHA_VERIFIER_ABI) {
      if (entry.type === "function") expect(entry.stateMutability).toBe("view");
    }
  });
});

describe("toFixedHex", () => {
  it("normalizes hex with optional 0x prefix and quotes", () => {
    expect(toFixedHex("aa".repeat(20), 20, "commitment")).toBe(`0x${"aa".repeat(20)}`);
    expect(toFixedHex(`0x${"bb".repeat(32)}`, 32, "sourceId")).toBe(`0x${"bb".repeat(32)}`);
    expect(toFixedHex(`"${"cc".repeat(32)}"`, 32, "signature")).toBe(`0x${"cc".repeat(32)}`);
  });

  it("throws on wrong byte length", () => {
    expect(() => toFixedHex("abcd", 32, "sourceId")).toThrow(/expected 32 bytes/);
  });
});

describe("signersBitmap conversion", () => {
  it("converts a 32-byte bitmap to uint256", () => {
    expect(signersBitmapToUint256("00".repeat(31) + "01")).toBe(1n);
    expect(signersBitmapToDecimal("00".repeat(31) + "01")).toBe("1");
  });
});

describe("buildEvmVerifierArgs", () => {
  it("builds the nested Attestation from a DataUpdateResult, in Solidity member order", () => {
    const { attestation, maxAge } = buildEvmVerifierArgs(SAMPLE_RESULT, { maxAge: 300 });

    expect(attestation).toEqual({
      payload: {
        value: `0x${"bb".repeat(32)}`,
        sourceId: `0x${"aa".repeat(32)}`,
        registryVersion: 2,
        signaturesRequired: 3,
        canonicalTimestamp: 1_700_000_000n,
      },
      signature: {
        signature: `0x${"cc".repeat(32)}`,
        commitment: `0x${"dd".repeat(20)}`,
        signersBitmap: 1n,
      },
    });
    expect(Object.keys(attestation.payload)).toEqual([
      "value",
      "sourceId",
      "registryVersion",
      "signaturesRequired",
      "canonicalTimestamp",
    ]);
    expect(maxAge).toBe(300n);
  });

  it("accepts maxAge as number or bigint, including 0", () => {
    expect(buildEvmVerifierArgs(SAMPLE_RESULT, { maxAge: 0 }).maxAge).toBe(0n);
    expect(buildEvmVerifierArgs(SAMPLE_RESULT, { maxAge: 60n }).maxAge).toBe(60n);
  });

  it("range-checks every integer against its Solidity type", () => {
    const build = (patch: Partial<DataUpdateResult>, maxAge: number | bigint = 0) =>
      buildEvmVerifierArgs({ ...SAMPLE_RESULT, ...patch }, { maxAge });

    expect(() => build({ signaturesRequired: 256 })).toThrow(/signaturesRequired/);
    expect(() => build({ signaturesRequired: -1 })).toThrow(/signaturesRequired/);
    expect(() => build({ registryVersion: 2 ** 32 })).toThrow(/registryVersion/);
    expect(() => build({ timestamp: 1.5 })).toThrow(/timestamp/);
    expect(() => build({}, -1)).toThrow(/maxAge/);
    expect(() => build({}, 1n << 64n)).toThrow(/maxAge/);
    expect(() => build({ commitmentAddr: "dd".repeat(21) })).toThrow(/commitment/);
  });
});

describe("encodeEvmVerifyCalldata", () => {
  const args = buildEvmVerifierArgs(EVM_FIXTURE_RESULT, { maxAge: 300 });

  it("matches calldata computed independently by Foundry for the contract fixture", () => {
    expect(encodeEvmVerifyCalldata(args)).toBe(EVM_FIXTURE_CALLDATA);
  });

  it("matches viem's ABI encoder over MOLPHA_VERIFIER_ABI", () => {
    const viaViem = encodeFunctionData({
      abi: MOLPHA_VERIFIER_ABI,
      functionName: "verify",
      args: [args.attestation, args.maxAge],
    });
    expect(encodeEvmVerifyCalldata(args)).toBe(viaViem);
  });

  it("signs the message the verifier reconstructs from the same result", () => {
    expect(bytesToHex(attestationMessageHashFromResult(EVM_FIXTURE_RESULT))).toBe(
      EVM_FIXTURE_MESSAGE_HASH,
    );
  });

  it("puts maxAge in the final word", () => {
    const zero = encodeEvmVerifyCalldata({ ...args, maxAge: 0n });
    expect(zero.slice(0, -64)).toBe(EVM_FIXTURE_CALLDATA.slice(0, -64));
    expect(zero.slice(-64)).toBe("00".repeat(32));
  });

  it("rejects values that would not ABI-decode", () => {
    const { payload, signature } = args.attestation;
    expect(() =>
      encodeEvmVerifyCalldata({
        ...args,
        attestation: { payload: { ...payload, signaturesRequired: 256 }, signature },
      }),
    ).toThrow(/signaturesRequired/);
    expect(() =>
      encodeEvmVerifyCalldata({
        ...args,
        attestation: { payload: { ...payload, canonicalTimestamp: 1n << 64n }, signature },
      }),
    ).toThrow(/canonicalTimestamp/);
    expect(() =>
      encodeEvmVerifyCalldata({
        ...args,
        attestation: { payload, signature: { ...signature, signersBitmap: 1n << 256n } },
      }),
    ).toThrow(/signersBitmap/);
    expect(() =>
      encodeEvmVerifyCalldata({
        ...args,
        attestation: { payload, signature: { ...signature, commitment: `0x${"aa".repeat(32)}` } },
      }),
    ).toThrow(/commitment/);
  });
});

describe("parseEvmVerifyResult", () => {
  const encoded = (success: boolean, code: number) =>
    `0x${(success ? 1 : 0).toString(16).padStart(64, "0")}${code.toString(16).padStart(64, "0")}`;

  it("decodes raw eth_call return data", () => {
    expect(parseEvmVerifyResult(encoded(true, 0))).toEqual({ success: true, code: 0, reason: "OK" });
    expect(parseEvmVerifyResult(encoded(false, 9))).toEqual({
      success: false,
      code: VERIFY_CODES.BAD_SIGNATURE,
      reason: "BAD_SIGNATURE",
    });
  });

  it("agrees with viem's decoder on the same bytes", () => {
    const decoded = decodeFunctionResult({
      abi: MOLPHA_VERIFIER_ABI,
      functionName: "verify",
      data: encoded(false, 10) as `0x${string}`,
    });
    expect(parseEvmVerifyResult(decoded)).toEqual(parseEvmVerifyResult(encoded(false, 10)));
    expect(parseEvmVerifyResult(decoded).reason).toBe("STALE");
  });

  it("accepts decoded tuples with number or bigint codes", () => {
    expect(parseEvmVerifyResult([true, 0])).toEqual({ success: true, code: 0, reason: "OK" });
    expect(parseEvmVerifyResult([false, 7n])).toEqual({
      success: false,
      code: 7,
      reason: "BAD_QUORUM",
    });
  });

  it("reports a code newer than this SDK as UNKNOWN", () => {
    expect(parseEvmVerifyResult(encoded(false, 42))).toEqual({
      success: false,
      code: 42,
      reason: "UNKNOWN",
    });
  });

  it("throws on data that did not come from this verifier interface", () => {
    expect(() => parseEvmVerifyResult(encoded(true, 9))).toThrow(/inconsistent/);
    expect(() => parseEvmVerifyResult(encoded(false, 0))).toThrow(/inconsistent/);
    expect(() => parseEvmVerifyResult("0x01")).toThrow(/64 bytes/);
    expect(() => parseEvmVerifyResult(`0x${"00".repeat(31)}02${"00".repeat(32)}`)).toThrow(
      /success/,
    );
    expect(() => parseEvmVerifyResult(`0x${"00".repeat(32)}${"00".repeat(30)}0100`)).toThrow(
      /uint8/,
    );
  });
});
