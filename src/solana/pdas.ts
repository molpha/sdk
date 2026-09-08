/**
 * Consumer PDA derivations. Seed byte strings are cross-checked against the IDL const
 * seeds in `test/solana.test.ts` / `test/idl.test.ts`.
 */
import type { Address } from "@solana/kit";
import { ensureLength, u32le, utf8 } from "../core/encoding.js";
import {
  addressBytes,
  findProgramAddressSync,
  type SolanaAddress,
} from "./kit.js";

const SEED_CONFIG = utf8("molpha_config");
const SEED_REGISTRY = utf8("molpha_registry");
const SEED_NODE = utf8("molpha_node");
const SEED_PLAN = utf8("molpha_plan");
const SEED_SUBSCRIPTION = utf8("molpha_subscription");
const SEED_FEED = utf8("molpha_feed");
const SEED_GATEWAY = utf8("molpha_gateway");

const pda = (seeds: Uint8Array[], programId: SolanaAddress): Address =>
  findProgramAddressSync(seeds, programId);

export const protocolConfigPda = (programId: SolanaAddress): Address =>
  pda([SEED_CONFIG], programId);

/** Mutable pointer to the current registry snapshot: `["molpha_registry"]`. */
export const registryStatePda = (programId: SolanaAddress): Address =>
  pda([SEED_REGISTRY], programId);

/** Immutable, version-addressed registry snapshot: `["molpha_registry", version u32 LE]`. */
export const registryPda = (version: number, programId: SolanaAddress): Address =>
  pda([SEED_REGISTRY, u32le(version)], programId);

/**
 * Owner-keyed `Node` account: `["molpha_node", owner]`. Registry snapshots store these
 * addresses directly in `nodes[i]`, so consumers rarely need to derive them.
 */
export const nodePda = (owner: SolanaAddress, programId: SolanaAddress): Address =>
  pda([SEED_NODE, addressBytes(owner)], programId);

/** Bonded gateway account: `["molpha_gateway", gatewayAuthority]` — the `gateway` bound into `RequestAuth`. */
export const gatewayPda = (authority: SolanaAddress, programId: SolanaAddress): Address =>
  pda([SEED_GATEWAY, addressBytes(authority)], programId);

/** Plan PDA is `[b"molpha_plan", [planType as u8]]`. */
export const planPda = (planId: number, programId: SolanaAddress): Address =>
  pda([SEED_PLAN, Uint8Array.of(planId)], programId);

export const subscriptionPda = (owner: SolanaAddress, programId: SolanaAddress): Address =>
  pda([SEED_SUBSCRIPTION, addressBytes(owner)], programId);

/**
 * Feed state, keyed per `(sourceId, signaturesRequired, submitter)`:
 * `["molpha_feed", sourceId, [signaturesRequired], submitter]`. Created lazily by the
 * first `submit_attestation` from that submitter.
 */
export function feedPda(
  sourceId: Uint8Array,
  signaturesRequired: number,
  submitter: SolanaAddress,
  programId: SolanaAddress,
): Address {
  ensureLength(sourceId, 32, "sourceId");
  if (!Number.isInteger(signaturesRequired) || signaturesRequired < 0 || signaturesRequired > 255) {
    throw new RangeError(`signaturesRequired out of u8 range: ${signaturesRequired}`);
  }
  return pda(
    [SEED_FEED, sourceId, Uint8Array.of(signaturesRequired), addressBytes(submitter)],
    programId,
  );
}
