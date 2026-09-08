import { describe, expect, it } from "vitest";
import type { DataUpdateResult } from "../src/core/types.js";
import { MOLPHA_VERIFIER_ADDRESS } from "../src/evm/constants.js";
import {
  buildEvmVerifierArgs,
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

describe("MOLPHA verifier address", () => {
  it("exports the CREATE2 address used on all EVM chains", () => {
    expect(MOLPHA_VERIFIER_ADDRESS).toBe(
      "0xE1fd792b7E54e0C8F0Cd1c8055E446ff36d233eB",
    );
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
  it("builds verifier tuples from DataUpdateResult", () => {
    const { dataUpdate, signature } = buildEvmVerifierArgs(SAMPLE_RESULT);

    expect(dataUpdate).toEqual([
      `0x${"aa".repeat(32)}`,
      2,
      3,
      `0x${"bb".repeat(32)}`,
      1_700_000_000,
    ]);

    expect(signature).toEqual([
      `0x${"cc".repeat(32)}`,
      `0x${"dd".repeat(20)}`,
      1n,
    ]);
  });
});
