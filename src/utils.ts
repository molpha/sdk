/**
 * `@molpha/sdk/utils` — Node.js-only helpers (fs + keypair files). Kept out of the main
 * entry so browser bundles never pull in `fs`.
 */
import { readFileSync } from "node:fs";
import { keypairFromSecretKey, type SolanaKeypair } from "./solana/kit.js";
import { KeypairWallet, type MolphaWallet } from "./wallet.js";

/** Load a Solana CLI keypair JSON file (array of 64 bytes) into a `Keypair`. */
export function loadKeypair(path: string): SolanaKeypair {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as number[];
  return keypairFromSecretKey(Uint8Array.from(raw));
}

/** Anchor `Wallet` backed by a keypair file (gateway auth derived from the same key). */
export function walletFromKeypairFile(path: string): MolphaWallet {
  return new KeypairWallet(loadKeypair(path));
}

/**
 * Drop-in for Anchor's Node `Wallet`, which this entry point used to re-export:
 * `new Wallet(keypair)` and `Wallet.local()` (reads the `ANCHOR_WALLET` keypair file).
 */
export class Wallet extends KeypairWallet {
  static local(): Wallet {
    const path = process.env.ANCHOR_WALLET;
    if (!path) throw new Error("expected environment variable `ANCHOR_WALLET` is not set.");
    return new Wallet(loadKeypair(path));
  }
}

export { KeypairWallet };
export type { MolphaWallet };
