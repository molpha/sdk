/**
 * Result codes returned by Molpha's stateless verifier contracts (`verify` on EVM and
 * Starknet). Shared across VMs: the same attestation yields the same code on every chain.
 *
 * Append-only — never renumber. Mirrors `VerifyCodes.sol` in `molpha-core-contracts` and
 * `verify_codes.cairo` in `molpha-starknet`. Two codes belong to mechanisms the verifiers
 * do not implement; they are kept so the numbering can never shift under them.
 */
export const VERIFY_CODES = {
  OK: 0,
  /** Reserved. Never returned. */
  FEED_WITNESS: 1,
  /** The payload's `registryVersion` does not exist on this verifier. */
  BAD_REGISTRY_VERSION: 2,
  /** Structurally invalid input, or a `canonicalTimestamp` in the future when `maxAge != 0`. */
  MALFORMED: 3,
  /** `canonicalTimestamp` predates the registry version's activation. */
  NOT_YET_ACTIVE: 4,
  /** The registry version was superseded more than the grace window before `canonicalTimestamp`. */
  VERSION_EXPIRED: 5,
  /** Reserved. Never returned. */
  COMPROMISED_QUORUM: 6,
  /** The signer set is not within the round's derived selection group. */
  BAD_QUORUM: 7,
  /** The signers' aggregate public key is the point at infinity. */
  BAD_AGGREGATE: 8,
  /** The aggregate Schnorr signature does not verify. */
  BAD_SIGNATURE: 9,
  /** Older than the caller's `maxAge`. */
  STALE: 10,
} as const;

export type VerifyCodeName = keyof typeof VERIFY_CODES;
export type VerifyCode = (typeof VERIFY_CODES)[VerifyCodeName];

const NAMES_BY_CODE: ReadonlyMap<number, VerifyCodeName> = new Map(
  (Object.entries(VERIFY_CODES) as [VerifyCodeName, VerifyCode][]).map(([name, code]) => [
    code,
    name,
  ]),
);

/**
 * Name of a verifier result code, or `undefined` for a code this SDK version does not know.
 * Codes are append-only, so an unknown code is a newer verifier, not a malformed response.
 */
export function verifyCodeName(code: number): VerifyCodeName | undefined {
  return NAMES_BY_CODE.get(code);
}
