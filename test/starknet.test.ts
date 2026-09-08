import { describe, expect, it } from "vitest";
import type { DataUpdateResult } from "../src/core/types.js";
import {
  MOLPHA_VERIFIER_STARKNET_ADDRESSES,
  MOLPHA_VERIFIER_STARKNET_SEPOLIA,
  getMolphaStarknetVerifierAddress,
} from "../src/starknet/constants.js";
import {
  buildStarknetVerifierArgs,
  commitmentAddressToStarknetFelt,
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

  it("builds verifier structs from DataUpdateResult", () => {
    const { dataUpdate, signature } = buildStarknetVerifierArgs(SAMPLE_RESULT);

    expect(dataUpdate).toEqual({
      source_id: BigInt(`0x${"aa".repeat(32)}`),
      registry_version: 2,
      signatures_required: 3,
      value: BigInt(`0x${"bb".repeat(32)}`),
      canonical_timestamp: 1_700_000_000,
    });

    expect(signature).toEqual({
      signature: BigInt(`0x${"cc".repeat(32)}`),
      commitment: BigInt(`0x${"dd".repeat(20)}`),
      signers_bitmap: 1n,
    });
  });
});
