/**
 * Registry snapshot views and remaining-accounts construction.
 *
 * A snapshot is a table of slots. A node keeps its slot (the bit it signs with) for as long as it
 * is in the snapshot: removing a node leaves a hole (an all-zero record) instead of moving the
 * last member into it, and a later registration takes the lowest hole.
 */
import type { Address } from "@solana/kit";
import { hexToBytes } from "../core/encoding.js";
import { selectedIndices } from "../core/selection.js";
import {
  type SolanaAccountMeta,
  addressFromBytes,
  toPublicKey,
} from "./kit.js";

/** On-chain `RegistryState` (Anchor camelCase): pointer to the current immutable snapshot. */
export interface RegistryStateView {
  currentVersion: number;
  nextVersion: number;
}

/**
 * Immutable, version-addressed `Registry` snapshot. `nodes` holds the `[..nodeCount]` slots;
 * entry `i` is the `Node` account address for signer bit `i`, or `null` for a hole (a removed
 * member's slot).
 */
export interface RegistryView {
  version: number;
  /** Slots in the table, holes included; trailing holes are never stored. */
  nodeCount: number;
  /** Selection padding: `min(signaturesRequired + redundancyBuffer, live members)`. */
  redundancyBuffer: number;
  nodes: Array<Address | null>;
  /** Unix seconds until which this superseded snapshot still verifies; `0n` while current. */
  graceActiveUntil: bigint;
  /** Inclusive creation time (unix seconds): a version cannot verify a round dated before it existed. */
  activeFrom: bigint;
}

/** Bytes before the member table: the Anchor discriminator and the header. */
export const REGISTRY_HEADER_LEN = 32;
/** One member record: node account, then the signing key's `x` and `y`. */
export const REGISTRY_MEMBER_LEN = 96;

/** Slots that hold a live member, ascending. */
export function liveSlots(registry: Pick<RegistryView, "nodes">): number[] {
  const slots: number[] = [];
  registry.nodes.forEach((node, slot) => {
    if (node !== null) slots.push(slot);
  });
  return slots;
}

/** Decode a `Registry` account from its raw data: header, then one 96-byte record per slot. */
export function decodeRegistryAccount(data: Uint8Array): RegistryView {
  if (data.length < REGISTRY_HEADER_LEN) {
    throw new Error(`registry account is ${data.length} bytes, too short`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const nodeCount = view.getUint16(28, true);
  if (data.length < REGISTRY_HEADER_LEN + nodeCount * REGISTRY_MEMBER_LEN) {
    throw new Error(
      `registry claims ${nodeCount} slots but holds ${Math.floor((data.length - REGISTRY_HEADER_LEN) / REGISTRY_MEMBER_LEN)}`,
    );
  }
  const nodes: Array<Address | null> = [];
  for (let slot = 0; slot < nodeCount; slot++) {
    const at = REGISTRY_HEADER_LEN + slot * REGISTRY_MEMBER_LEN;
    const account = data.subarray(at, at + 32);
    nodes.push(
      account.every((byte) => byte === 0)
        ? null
        : addressFromBytes(Uint8Array.from(account)),
    );
  }
  return {
    version: view.getUint32(24, true),
    nodeCount,
    redundancyBuffer: data[30]!,
    nodes,
    graceActiveUntil: view.getBigInt64(8, true),
    activeFrom: view.getBigInt64(16, true),
  };
}

/** Set-bit indices of a 32-byte big-endian bitmap (full 256-bit scan). */
export function bitmapToIndices(signersBitmapHex: string): number[] {
  return selectedIndices(hexToBytes(signersBitmapHex), 256);
}

/**
 * Signer `Node` accounts, in ascending signers-bitmap bit order. Bit `i` resolves to
 * `registry.nodes[i]` of the snapshot the round was signed against; a bit at or beyond
 * `nodeCount`, or on a hole, names no node and can never verify, so it is rejected client-side.
 */
export function resolveRemainingAccounts(
  signersBitmapHex: string,
  registry: RegistryView,
): SolanaAccountMeta[] {
  return bitmapToIndices(signersBitmapHex).map((bit) => {
    const node = registry.nodes[bit];
    if (bit >= registry.nodeCount || node === undefined || node === null) {
      throw new Error(
        `InvalidNodeIndex: signer bit ${bit} names no live node of registry ${registry.version} (node_count ${registry.nodeCount}, holes included)`,
      );
    }
    return { pubkey: toPublicKey(node), isSigner: false, isWritable: false };
  });
}
