import { Wallet } from "@anchor-lang/core";
import { describe, expect, it } from "vitest";
import { hashRequestAuth } from "../src/gateway/auth.js";
import { generateKeypair } from "../src/solana/kit.js";
import { gatewaySignerFromWallet, signerFromKeypair, type MolphaWallet } from "../src/wallet.js";

describe("gatewaySignerFromWallet", () => {
  it("derives auth signing from Anchor Wallet.payer", async () => {
    const keypair = generateKeypair();
    const wallet = new Wallet(keypair);
    const signer = gatewaySignerFromWallet(wallet);
    expect(signer).toBeDefined();
    const msg = hashRequestAuth({
      programId: new Uint8Array(32),
      gateway: new Uint8Array(32),
      sourceId: new Uint8Array(32),
      signaturesRequired: 1,
      timestamp: 1n,
    });
    const sig = await signer!(msg);
    expect(sig).toHaveLength(64);
    expect(await signerFromKeypair(keypair)(msg)).toEqual(sig);
  });

  it("prefers signAuthMessage when set", async () => {
    const keypair = generateKeypair();
    const wallet = new Wallet(keypair);
    const custom = async () => new Uint8Array(64);
    const molpha = Object.assign(wallet, { signAuthMessage: custom }) as MolphaWallet;
    const signer = gatewaySignerFromWallet(molpha);
    expect(await signer!(new Uint8Array(1))).toEqual(new Uint8Array(64));
  });
});
