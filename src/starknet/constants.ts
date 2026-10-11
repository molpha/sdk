/**
 * Deployed Molpha verifier contract addresses on Starknet testnets.
 *
 * Address comes from the active deployment profile (`config/deployments.json`).
 * When `MOLPHA_DEV_VERIFIERS_PROVISIONAL` is true, the value is a stable fallback
 * and should not be treated as the live Attestation-interface deployment.
 */

export { MOLPHA_VERIFIER_STARKNET_SEPOLIA } from "../deployment.generated.js";

import { MOLPHA_VERIFIER_STARKNET_SEPOLIA } from "../deployment.generated.js";

/** Supported Starknet testnet identifiers. */
export type MolphaStarknetNetwork = "starknet-sepolia";

/** Network id -> deployed verifier address. */
export const MOLPHA_VERIFIER_STARKNET_ADDRESSES: Record<
  MolphaStarknetNetwork,
  `0x${string}`
> = {
  "starknet-sepolia": MOLPHA_VERIFIER_STARKNET_SEPOLIA,
};

/** Resolve the deployed verifier address for a supported Starknet network. */
export function getMolphaStarknetVerifierAddress(
  network: MolphaStarknetNetwork,
): `0x${string}` {
  return MOLPHA_VERIFIER_STARKNET_ADDRESSES[network];
}
