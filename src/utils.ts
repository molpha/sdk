/**
 * `@molpha/sdk/utils` — Node.js-only helpers (fs + keypair files). Kept out of the main
 * entry so browser bundles never pull in `fs`.
 */
import { readFileSync } from "node:fs";
import { Wallet } from "@anchor-lang/core";
import { keypairFromSecretKey, type SolanaKeypair } from "./solana/kit.js";
import type { MolphaWallet } from "./wallet.js";

/** Load a Solana CLI keypair JSON file (array of 64 bytes) into a `Keypair`. */
export function loadKeypair(path: string): SolanaKeypair {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as number[];
  return keypairFromSecretKey(Uint8Array.from(raw));
}

/** Anchor `Wallet` backed by a keypair file (gateway auth derived from the same key). */
export function walletFromKeypairFile(path: string): MolphaWallet {
  return new Wallet(loadKeypair(path));
}

export { Wallet };
export type { MolphaWallet };
