import { describe, expect, it, vi } from "vitest";
import { MolphaSDK, SubmitFailedError } from "../src/index.js";
import type { Attestation } from "../src/core/types.js";

// requestAndSubmit only composes the gateway and Solana clients, so exercise it on a bare instance.
function sdkWith(gatewayResult: Attestation | Error, submit: () => Promise<unknown>): MolphaSDK {
  const sdk = Object.create(MolphaSDK.prototype) as { gateway: unknown; solana: unknown };
  sdk.gateway = {
    requestSignedData: vi.fn(async () => {
      if (gatewayResult instanceof Error) throw gatewayResult;
      return gatewayResult;
    }),
  };
  sdk.solana = { submitAttestation: vi.fn(submit) };
  return sdk as unknown as MolphaSDK;
}

const attestation = { value: "42", payload: { sourceId: "ab".repeat(32) } } as unknown as Attestation;
const opts = { signaturesRequired: 1, apiConfig: { url: "http://api", responseParser: "$.price" } };

describe("requestAndSubmit", () => {
  it("returns the result, signature and feed on success", async () => {
    const sdk = sdkWith(attestation, async () => ({ signature: "sig", feed: "feed" }));
    await expect(sdk.requestAndSubmit(opts)).resolves.toEqual({ result: attestation, signature: "sig", feed: "feed" });
  });

  it("keeps the paid, signed result when the submit fails", async () => {
    const boom = new Error("blockhash not found");
    const sdk = sdkWith(attestation, async () => { throw boom; });
    const err = await sdk.requestAndSubmit(opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SubmitFailedError);
    expect((err as SubmitFailedError).result).toBe(attestation);
    expect((err as SubmitFailedError).cause).toBe(boom);
    expect((err as SubmitFailedError).message).toContain("blockhash not found");
  });

  it("a gateway failure is not a submit failure and passes through unchanged", async () => {
    const gw = new Error("Gateway unavailable (503)");
    const sdk = sdkWith(gw, async () => ({ signature: "x", feed: "y" }));
    await expect(sdk.requestAndSubmit(opts)).rejects.toBe(gw);
  });
});
