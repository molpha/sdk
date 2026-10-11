/**
 * Deployed Molpha verifier contract address on EVM chains.
 * Deployed via CREATE2 for the same address on every supported chain.
 *
 * Address comes from the active deployment profile (`config/deployments.json`).
 * When `MOLPHA_DEV_VERIFIERS_PROVISIONAL` is true, the value is a stable fallback
 * and should not be treated as the live Attestation-interface deployment.
 */

export { MOLPHA_VERIFIER_ADDRESS } from "../deployment.generated.js";

/** Supported EVM testnet identifiers (chain selection only). */
export type MolphaEvmNetwork =
  | "evm-sepolia"
  | "arbitrum-sepolia"
  | "avalanche-fuji"
  | "bsc-testnet";
