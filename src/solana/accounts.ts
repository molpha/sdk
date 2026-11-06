/**
 * Registry snapshot views and signer-key resolution.
 *
 * A snapshot is a table of slots. A node keeps its slot (the bit it signs with) for as long as it
 * is in the snapshot: removing a node leaves a hole (an all-zero record) instead of moving the
 * last member into it, and a later registration takes the lowest hole. Each record carries the
 * secp256k1 key its member signs with under this version, which is what `submit_attestation`
 * verifies against: the program takes no signer accounts.
 */
import type { Address } from "@solana/kit";
import { NODE_SLOTS, bitmapToIndices } from "../core/selection.js";
import { addressFromBytes } from "./kit.js";

/** A member's secp256k1 signing key as the registry record stores it: affine, 32-byte big-endian. */
export interface RegistryMemberKey {
  x: Uint8Array;
  y: Uint8Array;
}

/** On-chain `RegistryState` (Anchor camelCase): pointer to the current immutable snapshot. */
export interface RegistryStateView {
  currentVersion: number;
  nextVersion: number;
}

/**
 * Immutable, version-addressed `Registry` snapshot: two tables, as the account stores them.
 * `nodes` holds the `nodeCount` node slots (entry `i` is the `Node` account address for signer
 * bit `i`), `providers` the `providerCount` provider slots (entry `p` is the `Provider` PDA for
 * signer bit {@link NODE_SLOTS} + `p`; slot 0 is reserved). `null` is a hole (a removed member's
 * slot).
 */
export interface RegistryView {
  version: number;
  /** Node slots, holes included; trailing holes are never stored. */
  nodeCount: number;
  /** Provider slots, holes included; trailing holes are never stored. */
  providerCount: number;
  /** Selection padding: `min(signaturesRequired + redundancyBuffer, live members)`. */
  redundancyBuffer: number;
  nodes: Array<Address | null>;
  providers: Array<Address | null>;
  /**
   * Signing key of each node slot under this version (`null` for a hole). A key rotation publishes a
   * new version, so this can differ from the `Node` account's current key.
   */
  nodeKeys: Array<RegistryMemberKey | null>;
  /** Signing key of each provider slot under this version (`null` for a hole). */
  providerKeys: Array<RegistryMemberKey | null>;
  /** Unix seconds until which this superseded snapshot still verifies; `0n` while current. */
  graceActiveUntil: bigint;
  /** Inclusive creation time (unix seconds): a version cannot verify a round dated before it existed. */
  activeFrom: bigint;
}

/** Bytes before the member table: the Anchor discriminator and the header. */
export const REGISTRY_HEADER_LEN = 32;
/** One member record: node account, then the signing key's `x` and `y`. */
export const REGISTRY_MEMBER_LEN = 96;

/**
 * Node slots that hold a live member, ascending. Providers are in their own table and never part of
 * a selection.
 */
export function liveSlots(registry: Pick<RegistryView, "nodes">): number[] {
  const slots: number[] = [];
  registry.nodes.forEach((node, slot) => {
    if (node !== null && slot < NODE_SLOTS) slots.push(slot);
  });
  return slots;
}

/**
 * Decode a `Registry` account from its raw data: the header (`node_count` and `provider_count`, a
 * byte each at offsets 28 and 29), then the node records, then the provider records, 96 bytes each.
 */
export function decodeRegistryAccount(data: Uint8Array): RegistryView {
  if (data.length < REGISTRY_HEADER_LEN) {
    throw new Error(`registry account is ${data.length} bytes, too short`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const nodeCount = data[28]!;
  const providerCount = data[29]!;
  if (nodeCount > NODE_SLOTS || providerCount > 256 - NODE_SLOTS) {
    throw new Error(
      `registry claims ${nodeCount} node and ${providerCount} provider slots: past the 256-bit bitmap`,
    );
  }
  const records = nodeCount + providerCount;
  if (data.length < REGISTRY_HEADER_LEN + records * REGISTRY_MEMBER_LEN) {
    throw new Error(
      `registry claims ${records} slots but holds ${Math.floor((data.length - REGISTRY_HEADER_LEN) / REGISTRY_MEMBER_LEN)}`,
    );
  }
  const account = (index: number): Address | null => {
    const at = REGISTRY_HEADER_LEN + index * REGISTRY_MEMBER_LEN;
    const bytes = data.subarray(at, at + 32);
    return bytes.every((byte) => byte === 0)
      ? null
      : addressFromBytes(Uint8Array.from(bytes));
  };
  const key = (index: number): RegistryMemberKey | null => {
    if (account(index) === null) return null;
    const at = REGISTRY_HEADER_LEN + index * REGISTRY_MEMBER_LEN + 32;
    return {
      x: Uint8Array.from(data.subarray(at, at + 32)),
      y: Uint8Array.from(data.subarray(at + 32, at + 64)),
    };
  };
  const nodes = Array.from({ length: nodeCount }, (_, i) => account(i));
  const providers = Array.from({ length: providerCount }, (_, p) =>
    account(nodeCount + p),
  );
  const nodeKeys = Array.from({ length: nodeCount }, (_, i) => key(i));
  const providerKeys = Array.from({ length: providerCount }, (_, p) =>
    key(nodeCount + p),
  );
  return {
    version: view.getUint32(24, true),
    nodeCount,
    providerCount,
    redundancyBuffer: data[30]!,
    nodes,
    providers,
    nodeKeys,
    providerKeys,
    graceActiveUntil: view.getBigInt64(8, true),
    activeFrom: view.getBigInt64(16, true),
  };
}

// `bitmapToIndices` lives in `core` so browsers can import it without the Solana surface.
export { bitmapToIndices };

/**
 * The member account signing at `bit` in `registry`: node slot `bit` below {@link NODE_SLOTS},
 * else provider slot `bit - NODE_SLOTS`. `undefined` for a hole or a slot past its table.
 */
export function registrySigner(
  registry: RegistryView,
  bit: number,
): Address | undefined {
  const member =
    bit < NODE_SLOTS
      ? bit < registry.nodeCount
        ? registry.nodes[bit]
        : undefined
      : bit - NODE_SLOTS < registry.providerCount
        ? registry.providers[bit - NODE_SLOTS]
        : undefined;
  return member ?? undefined;
}

/**
 * The signing key at `bit` in `registry`: node slot `bit` below {@link NODE_SLOTS}, else provider
 * slot `bit - NODE_SLOTS`. `undefined` for a hole or a slot past its table.
 */
export function registrySignerKey(
  registry: Pick<
    RegistryView,
    "nodeCount" | "providerCount" | "nodeKeys" | "providerKeys"
  >,
  bit: number,
): RegistryMemberKey | undefined {
  const key =
    bit < NODE_SLOTS
      ? bit < registry.nodeCount
        ? registry.nodeKeys[bit]
        : undefined
      : bit - NODE_SLOTS < registry.providerCount
        ? registry.providerKeys[bit - NODE_SLOTS]
        : undefined;
  return key ?? undefined;
}

/**
 * Signing keys of an attestation's signers, in ascending signers-bitmap bit order, read from the
 * snapshot the round was signed against ({@link registrySignerKey}). Their sum is the coalition key
 * `submit_attestation` checks. A bit past its table, or on a hole, names nobody and can never
 * verify, so it is rejected client-side.
 */
export function resolveSignerKeys(
  signersBitmapHex: string,
  registry: RegistryView,
): RegistryMemberKey[] {
  return bitmapToIndices(signersBitmapHex).map((bit) => {
    const key = registrySignerKey(registry, bit);
    if (key === undefined) {
      throw new Error(
        `InvalidNodeIndex: signer bit ${bit} names no live member of registry ${registry.version} (node_count ${registry.nodeCount}, provider_count ${registry.providerCount}, holes included)`,
      );
    }
    return key;
  });
}
