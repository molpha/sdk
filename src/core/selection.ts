/**
 * Node selection: deterministic, verifiable, without replacement.
 *
 * Canonical bitmap representation = 32-byte big-endian word (bit `i` lives in
 * byte `31 - (i >> 3)`, mask `1 << (i & 7)`), matching the wire / on-chain form.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  concatBytes,
  ensureLength,
  hexToBytes,
  u32be,
  u64be,
  utf8,
} from "./encoding.js";

const SELECTION_SEED_DOMAIN = keccak_256(utf8("MOLPHA_SELECTION_V1"));
const SELECTION_DERIVE_DOMAIN = keccak_256(utf8("MOLPHA_SELECTION_DERIVE"));

/**
 * Width in milliseconds of the window selection reads from the timestamp. The timestamp
 * is unix milliseconds; the seed uses `floor(timestamp / SELECTION_WINDOW_MS)`, so
 * sub-second precision never changes the committee. Changing it is a consensus break and must
 * bump the selection prefix.
 */
export const SELECTION_WINDOW_MS = 1000n;

/** Maximum hashing rounds before giving up (matches on-chain cap). */
const MAX_ROUNDS = 65_536;

const BITMAP_BYTES = 32;
const MAX_NODES = BITMAP_BYTES * 8; // 256
/**
 * Bits `[0, 64)` of the signers bitmap are operator nodes; bits `[64, 256)` are provider signers.
 */
export const NODE_SLOTS = 64;
const U32_MAX = 0xffff_ffff;

/**
 * `seed = keccak256(keccak256("MOLPHA_SELECTION_V1") || sourceId || be32(rv) || be64(ts / 1000))`,
 * where `ts` is the timestamp in unix MILLISECONDS (its 1 s window index is hashed).
 */
export function deriveSelectionSeed(
  sourceId: Uint8Array,
  registryVersion: number,
  timestamp: number | bigint,
): Uint8Array {
  ensureLength(sourceId, 32, "sourceId");
  return keccak_256(
    concatBytes(
      SELECTION_SEED_DOMAIN,
      sourceId,
      u32be(registryVersion),
      u64be(BigInt(timestamp) / SELECTION_WINDOW_MS),
    ),
  );
}

/**
 * `min(signaturesRequired + redundancyBuffer, nodeCount)`. `nodeCount` is the number of members
 * the committee is drawn over: the live members, not the registry's slot count when it has holes.
 * For a provider round pass the {@link nodeQuorum} (`signaturesRequired - 1`), not the wire threshold.
 */
export function effectiveSelectionSize(
  signaturesRequired: number,
  redundancyBuffer: number,
  nodeCount: number,
): number {
  return Math.min(signaturesRequired + redundancyBuffer, nodeCount);
}

/**
 * How many **nodes** a round's committee holds: `signaturesRequired`, less one for a provider
 * round (a round the source's provider also signs). The provider counts toward `signaturesRequired`
 * like a node, so a provider round is `signaturesRequired - 1` nodes plus the provider.
 *
 * Selection, dispatch, tickets and slashing size the committee by this number, not by the wire
 * `signaturesRequired`, and the two draws are not nested (a node can sit in the `t - 1` draw and
 * not in the `t` draw), so a caller that draws with the wrong one disagrees with the gateway.
 * `provider` is `requireProvider` for a round about to be asked for, or the 32-byte signers bitmap
 * of an attestation (a provider round has a bit set in `[NODE_SLOTS, 256)`). Mirrors
 * `molpha_verifier::node_quorum`.
 */
export function nodeQuorum(
  signaturesRequired: number,
  provider: boolean | Uint8Array,
): number {
  const isProviderRound =
    typeof provider === "boolean" ? provider : hasProviderBit(provider);
  return isProviderRound ? Math.max(signaturesRequired - 1, 0) : signaturesRequired;
}

/** Is any provider bit (`>= NODE_SLOTS`) set in the 32-byte big-endian `bitmap`? */
export function hasProviderBit(bitmap: Uint8Array): boolean {
  return providerBitCount(bitmap) > 0;
}

/** Number of provider bits (`>= NODE_SLOTS`) set in the 32-byte big-endian `bitmap`. */
export function providerBitCount(bitmap: Uint8Array): number {
  let count = 0;
  for (let bit = NODE_SLOTS; bit < MAX_NODES; bit++) {
    if (bitmapBitSet(bitmap, bit)) count++;
  }
  return count;
}

/** Is bit `bit` set in the 32-byte big-endian `bitmap`? */
export function bitmapBitSet(bitmap: Uint8Array, bit: number): boolean {
  if (bit < 0 || bit >= MAX_NODES) return false;
  const byte = bitmap[BITMAP_BYTES - 1 - (bit >> 3)] ?? 0;
  return (byte & (1 << (bit & 7))) !== 0;
}

function setBit(bitmap: Uint8Array, bit: number): void {
  const idx = BITMAP_BYTES - 1 - (bit >> 3);
  bitmap[idx] = (bitmap[idx] ?? 0) | (1 << (bit & 7));
}

/** Indices of set bits in `[0, nodeCount)`, ascending. */
export function selectedIndices(
  bitmap: Uint8Array,
  nodeCount: number,
): number[] {
  const out: number[] = [];
  for (let i = 0; i < nodeCount; i++) {
    if (bitmapBitSet(bitmap, i)) out.push(i);
  }
  return out;
}

/**
 * Set-bit indices of a 32-byte big-endian bitmap given as hex (`0x` optional), full 256-bit scan.
 * Short hex is left-padded, the way the gateway sends it (a bitmap with only bit 2 set is `"4"`);
 * hex longer than 32 bytes throws instead of being read from its first 32 bytes.
 */
export function bitmapToIndices(signersBitmapHex: string): number[] {
  const clean = signersBitmapHex.replace(/^0[xX]/, "");
  if (clean.length > BITMAP_BYTES * 2) {
    throw new RangeError(
      `signersBitmap: expected at most ${BITMAP_BYTES} bytes, got ${Math.ceil(clean.length / 2)}`,
    );
  }
  return selectedIndices(
    hexToBytes(clean.padStart(BITMAP_BYTES * 2, "0")),
    MAX_NODES,
  );
}

/**
 * Rejection-sample `groupSize` distinct indices out of `nodeCount` from `seed`,
 * returning a 32-byte big-endian bitmap. Uses the complement optimization when
 * `groupSize > nodeCount / 2` (sample the smaller set, then invert).
 */
export function deriveGroupBitmap(
  seed: Uint8Array,
  nodeCount: number,
  groupSize: number,
): Uint8Array {
  if (!Number.isInteger(nodeCount) || nodeCount <= 0 || nodeCount > MAX_NODES) {
    throw new RangeError(
      `GroupBitmapDerivationFailed: invalid nodeCount ${nodeCount}`,
    );
  }
  if (!Number.isInteger(groupSize) || groupSize < 0 || groupSize > nodeCount) {
    throw new RangeError(
      `GroupBitmapDerivationFailed: invalid groupSize ${groupSize}`,
    );
  }
  const bitmap = new Uint8Array(BITMAP_BYTES);
  if (groupSize === 0) return bitmap;
  if (groupSize === nodeCount) {
    for (let i = 0; i < nodeCount; i++) setBit(bitmap, i);
    return bitmap;
  }

  // Complement optimization: sample the smaller half, invert at the end.
  const complement = groupSize > nodeCount - groupSize;
  const sampleCount = complement ? nodeCount - groupSize : groupSize;
  const limit = Math.floor(U32_MAX / nodeCount) * nodeCount;

  const chosen = new Set<number>();
  let round = 0;
  while (chosen.size < sampleCount && round < MAX_ROUNDS) {
    const counterWord = new Uint8Array(32);
    counterWord.set(u64be(round), 24);
    const block = keccak_256(
      concatBytes(seed, SELECTION_DERIVE_DOMAIN, counterWord),
    );
    for (
      let off = 0;
      off + 4 <= block.length && chosen.size < sampleCount;
      off += 4
    ) {
      const limb =
        ((block[off]! << 24) |
          (block[off + 1]! << 16) |
          (block[off + 2]! << 8) |
          block[off + 3]!) >>>
        0;
      if (limb < limit) {
        const idx = limb % nodeCount;
        chosen.add(idx);
      }
    }
    round++;
  }
  if (chosen.size < sampleCount) {
    throw new Error("GroupBitmapDerivationFailed: round cap reached");
  }

  if (complement) {
    for (let i = 0; i < nodeCount; i++) {
      if (!chosen.has(i)) setBit(bitmap, i);
    }
  } else {
    for (const i of chosen) setBit(bitmap, i);
  }
  return bitmap;
}

/**
 * Map a bitmap drawn over `liveSlots.length` ranks onto the slots they stand for: rank `r`
 * becomes slot `liveSlots[r]`. A registry whose members were removed leaves holes, and the
 * committee is drawn over the live nodes only. `liveSlots` are node slots, below {@link NODE_SLOTS}:
 * a provider record (slot 64 and up) is refused.
 */
export function mapRanksToSlots(
  ranks: Uint8Array,
  liveSlots: readonly number[],
): Uint8Array {
  // Every listed slot is checked, not only the drawn ones: a provider record in the list is a caller's
  // mistake whichever way the draw falls.
  for (const slot of liveSlots) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= NODE_SLOTS) {
      throw new RangeError(
        `invalid registry slot ${slot}: selection draws over node slots below ${NODE_SLOTS}, never over provider records`,
      );
    }
  }
  const out = new Uint8Array(BITMAP_BYTES);
  for (let rank = 0; rank < liveSlots.length; rank++) {
    if (bitmapBitSet(ranks, rank)) setBit(out, liveSlots[rank]!);
  }
  return out;
}

/**
 * Convenience orchestrator: derive the selection bitmap end-to-end.
 * `redundancy` defaults to 0; `ts` is the timestamp in unix MILLISECONDS and defaults
 * to now. The gateway assigns the real timestamp of a round, so this is for tests and tools.
 *
 * `nodeCount` is the registry's node slot count, holes included; at most {@link NODE_SLOTS} are drawn.
 * When `liveSlots` (ascending node slots that hold a member) is given and has fewer entries than
 * the node records, the draw runs over the live nodes and each drawn rank is mapped to its slot,
 * exactly as the program and the nodes do; without holes the result is the plain draw over the
 * slots. A count above {@link NODE_SLOTS} draws over the 64 node slots.
 *
 * `requireProvider` draws a **provider round**: the committee of {@link nodeQuorum} nodes
 * (`signaturesRequired - 1`) plus the buffer, which is not contained in the committee round's draw.
 */
export function deriveSelectionBitmap(
  sourceId: Uint8Array,
  registryVersion: number,
  nodeCount: number,
  signaturesRequired: number,
  redundancy = 0,
  ts: number | bigint = Date.now(),
  liveSlots?: readonly number[],
  requireProvider = false,
): Uint8Array {
  const seed = deriveSelectionSeed(sourceId, registryVersion, ts);
  const nodeRecords = Math.min(nodeCount, NODE_SLOTS);
  const drawn = liveSlots ? liveSlots.length : nodeRecords;
  const size = effectiveSelectionSize(
    nodeQuorum(signaturesRequired, requireProvider),
    redundancy,
    drawn,
  );
  const ranks = deriveGroupBitmap(seed, drawn, size);
  if (!liveSlots || liveSlots.length === nodeRecords) return ranks;
  return mapRanksToSlots(ranks, liveSlots);
}
