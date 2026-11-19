import { Wallet, web3 } from "@anchor-lang/core";
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { hashRequestAuth } from "../src/gateway/auth.js";
import { generateKeypair } from "../src/solana/kit.js";
import {
  gatewaySignerFromWallet,
  KeypairWallet,
  signerFromKeypair,
  type MolphaWallet,
} from "../src/wallet.js";

const BLOCKHASH = "11111111111111111111111111111111";

const transfer = (from: web3.PublicKey) =>
  web3.SystemProgram.transfer({ fromPubkey: from, toPubkey: from, lamports: 1 });

const legacyTx = (payer: web3.PublicKey) => {
  const tx = new web3.Transaction({ feePayer: payer, recentBlockhash: BLOCKHASH });
  return tx.add(transfer(payer));
};

const versionedTx = (payer: web3.PublicKey) =>
  new web3.VersionedTransaction(
    new web3.TransactionMessage({
      payerKey: payer,
      recentBlockhash: BLOCKHASH,
      instructions: [transfer(payer)],
    }).compileToV0Message(),
  );

describe("KeypairWallet", () => {
  it("exposes the keypair as payer and publicKey", () => {
    const keypair = generateKeypair();
    const wallet = new KeypairWallet(keypair);
    expect(wallet.payer).toBe(keypair);
    expect(wallet.publicKey.equals(keypair.publicKey)).toBe(true);
  });

  it("signs legacy and versioned transactions like Anchor's Node Wallet", async () => {
    const keypair = generateKeypair();
    const ours = new KeypairWallet(keypair);
    const anchor = new Wallet(keypair);

    const legacy = await ours.signTransaction(legacyTx(keypair.publicKey));
    expect(legacy.verifySignatures()).toBe(true);
    const anchorLegacy = await anchor.signTransaction(legacyTx(keypair.publicKey));
    expect(legacy.signature).toEqual(anchorLegacy.signature);

    const v0 = await ours.signTransaction(versionedTx(keypair.publicKey));
    expect(
      ed25519.verify(v0.signatures[0]!, v0.message.serialize(), keypair.publicKey.toBytes()),
    ).toBe(true);
    const anchorV0 = await anchor.signTransaction(versionedTx(keypair.publicKey));
    expect(v0.signatures[0]).toEqual(anchorV0.signatures[0]);
  });

  it("signs every transaction in signAllTransactions", async () => {
    const keypair = generateKeypair();
    const wallet = new KeypairWallet(keypair);
    const [a, b] = await wallet.signAllTransactions([
      legacyTx(keypair.publicKey),
      versionedTx(keypair.publicKey),
    ]);
    expect((a as web3.Transaction).verifySignatures()).toBe(true);
    expect((b as web3.VersionedTransaction).signatures[0]!.some((x) => x !== 0)).toBe(true);
  });

  it("derives the gateway signer from its payer", async () => {
    const keypair = generateKeypair();
    const msg = new Uint8Array(32).fill(7);
    const signer = gatewaySignerFromWallet(new KeypairWallet(keypair));
    expect(await signer!(msg)).toEqual(await signerFromKeypair(keypair)(msg));
  });
});

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
      authTimestamp: 1n,
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
