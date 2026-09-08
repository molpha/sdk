/**
 * Unified wallet surface: Anchor txs + optional gateway authSig signing.
 */
import type { Wallet } from "@anchor-lang/core";
import { ed25519 } from "@noble/curves/ed25519.js";
import type { Signer } from "./core/types.js";
import type { SolanaKeypair } from "./solana/kit.js";

/** Anchor `Wallet` plus optional gateway auth override. */
export type MolphaWallet = Wallet & {
  /**
   * Signs gateway request-auth hashes (`hashRequestAuth`). When omitted, derived from Anchor
   * `Wallet.payer` when the keypair secret is available (Node `Wallet`, etc.).
   */
  signAuthMessage?: Signer;
};

const isKeypair = (value: unknown): value is SolanaKeypair =>
  typeof value === "object" &&
  value !== null &&
  "secretKey" in value &&
  value.secretKey instanceof Uint8Array;

/** ed25519 gateway signer from a Solana keypair's 32-byte seed. */
export function signerFromKeypair(keypair: SolanaKeypair): Signer {
  const seed = keypair.secretKey.slice(0, 32);
  return async (message: Uint8Array): Promise<Uint8Array> => ed25519.sign(message, seed);
}

/** Resolve the gateway auth signer for a Molpha wallet, if available. */
export function gatewaySignerFromWallet(wallet: Wallet): Signer | undefined {
  const molpha = wallet as MolphaWallet;
  if (molpha.signAuthMessage) return molpha.signAuthMessage;
  if ("payer" in wallet && isKeypair(wallet.payer)) return signerFromKeypair(wallet.payer);
  return undefined;
}
