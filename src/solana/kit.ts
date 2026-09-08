import { web3 } from "@anchor-lang/core";
import { address, getAddressDecoder, getAddressEncoder, type Address } from "@solana/kit";

export type SolanaAddress = Address | string | InstanceType<typeof web3.PublicKey>;
export type SolanaConnection = InstanceType<typeof web3.Connection>;
export type SolanaKeypair = InstanceType<typeof web3.Keypair>;
export type SolanaInstruction = InstanceType<typeof web3.TransactionInstruction>;
export type SolanaAccountMeta = {
  pubkey: InstanceType<typeof web3.PublicKey>;
  isSigner: boolean;
  isWritable: boolean;
};

export const TOKEN_PROGRAM_ADDRESS = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ADDRESS = address(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);
export const SYSTEM_PROGRAM_ADDRESS = address("11111111111111111111111111111111");

const addressEncoder = getAddressEncoder();
const addressDecoder = getAddressDecoder();

export function toSolanaAddress(value: SolanaAddress): Address {
  return address(typeof value === "string" ? value : value.toBase58());
}

export function toPublicKey(value: SolanaAddress): InstanceType<typeof web3.PublicKey> {
  return value instanceof web3.PublicKey ? value : new web3.PublicKey(value);
}

export function addressBytes(value: SolanaAddress): Uint8Array {
  return Uint8Array.from(addressEncoder.encode(toSolanaAddress(value)));
}

/** Base58 `Address` from 32 raw bytes (e.g. a `Registry.nodes[i]` entry). */
export function addressFromBytes(bytes: Uint8Array): Address {
  return addressDecoder.decode(bytes);
}

export function findProgramAddressSync(
  seeds: Uint8Array[],
  programAddress: SolanaAddress,
): Address {
  const [pda] = web3.PublicKey.findProgramAddressSync(seeds, toPublicKey(programAddress));
  return toSolanaAddress(pda);
}

export function findProgramPublicKeySync(
  seeds: Uint8Array[],
  programAddress: SolanaAddress,
): InstanceType<typeof web3.PublicKey> {
  const [pda] = web3.PublicKey.findProgramAddressSync(seeds, toPublicKey(programAddress));
  return pda;
}

export function getAssociatedTokenAddressSync(
  mint: SolanaAddress,
  owner: SolanaAddress,
  tokenProgram: SolanaAddress = TOKEN_PROGRAM_ADDRESS,
): Address {
  return findProgramAddressSync(
    [addressBytes(owner), addressBytes(tokenProgram), addressBytes(mint)],
    ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  );
}

export function setComputeUnitLimit(units: number): SolanaInstruction {
  return web3.ComputeBudgetProgram.setComputeUnitLimit({ units });
}

export function keypairFromSecretKey(secretKey: Uint8Array): SolanaKeypair {
  return web3.Keypair.fromSecretKey(secretKey);
}

export function generateKeypair(): SolanaKeypair {
  return web3.Keypair.generate();
}
