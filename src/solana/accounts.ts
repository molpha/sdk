/**
 * Account views and remaining-accounts construction for `submit_attestation`.
 */
import type { Address } from "@solana/kit";
import { hexToBytes } from "../core/encoding.js";
import { selectedIndices } from "../core/selection.js";
import { type SolanaAccountMeta, toPublicKey } from "./kit.js";

/** On-chain `RegistryState` (Anchor camelCase): pointer to the current immutable snapshot. */
export interface RegistryStateView {
  currentVersion: number;
  nextVersion: number;
}

/**
 * Immutable, version-addressed `Registry` snapshot. `nodes` holds only the populated
 * `[..nodeCount]` entries; entry `i` is the `Node` account address for signer bit `i`.
 */
export interface RegistryView {
  version: number;
  nodeCount: number;
  /** Selection padding: `min(signaturesRequired + redundancyBuffer, nodeCount)`. */
  redundancyBuffer: number;
  nodes: Address[];
  /** Unix seconds until which this superseded snapshot still verifies; `0n` while current. */
  graceActiveUntil: bigint;
}

/** Set-bit indices of a 32-byte big-endian bitmap (full 256-bit scan). */
export function bitmapToIndices(signersBitmapHex: string): number[] {
  return selectedIndices(hexToBytes(signersBitmapHex), 256);
}

/**
 * Signer `Node` accounts for `submit_attestation`, in ascending signers-bitmap bit order.
 * Bit `i` resolves to `registry.nodes[i]` of the snapshot the round was signed against;
 * a bit at or beyond `nodeCount` can never verify, so it is rejected client-side.
 */
export function resolveRemainingAccounts(
  signersBitmapHex: string,
  registry: RegistryView,
): SolanaAccountMeta[] {
  return bitmapToIndices(signersBitmapHex).map((bit) => {
    const node = registry.nodes[bit];
    if (bit >= registry.nodeCount || node === undefined) {
      throw new Error(
        `InvalidNodeIndex: signer bit ${bit} is outside registry ${registry.version} node_count ${registry.nodeCount}`,
      );
    }
    return { pubkey: toPublicKey(node), isSigner: false, isWritable: false };
  });
}
