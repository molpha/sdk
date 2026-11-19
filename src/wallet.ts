/**
 * Unified wallet surface: Anchor txs + gateway request-auth signing.
 */
import type { Wallet, web3 } from "@anchor-lang/core";
import { ed25519 } from "@noble/curves/ed25519.js";
import type { Signer } from "./core/types.js";
import type { SolanaKeypair } from "./solana/kit.js";

type SolanaTransaction =
  | InstanceType<typeof web3.Transaction>
  | InstanceType<typeof web3.VersionedTransaction>;

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
  return async (message: Uint8Array): Promise<Uint8Array> =>
    ed25519.sign(message, seed);
}

/** Resolve the gateway auth signer for a Molpha wallet, if available. */
export function gatewaySignerFromWallet(wallet: Wallet): Signer | undefined {
  const molpha = wallet as MolphaWallet;
  if (molpha.signAuthMessage) return molpha.signAuthMessage;
  if ("payer" in wallet && isKeypair(wallet.payer))
    return signerFromKeypair(wallet.payer);
  return undefined;
}

/**
 * Anchor `Wallet` backed by a local keypair: signs legacy and versioned transactions and
 * exposes `payer`, so gateway auth is derived from the same key.
 *
 * Same behaviour as Anchor's Node `Wallet`, implemented here so the SDK needs no runtime
 * import of it: `@anchor-lang/core` 1.2.2 exports `Wallet` through a getter that Node's
 * ESM loader cannot see as a named export of the CommonJS package.
 */
export class KeypairWallet implements Wallet {
  constructor(readonly payer: SolanaKeypair) {}

  get publicKey(): SolanaKeypair["publicKey"] {
    return this.payer.publicKey;
  }

  async signTransaction<T extends SolanaTransaction>(tx: T): Promise<T> {
    return this.sign(tx);
  }

  async signAllTransactions<T extends SolanaTransaction>(txs: T[]): Promise<T[]> {
    return txs.map((tx) => this.sign(tx));
  }

  private sign<T extends SolanaTransaction>(tx: T): T {
    if ("version" in tx) tx.sign([this.payer]);
    else tx.partialSign(this.payer);
    return tx;
  }
}
