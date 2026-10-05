/**
 * A `completed` gateway execute response (`AttestationResponse`: `{ status, data: { attestation:
 * { payload, signature }, value, fresh, configHash?, aggregation? } }`) built from flat field names.
 * A key set to `undefined` is omitted, so a test can drop one field from an otherwise valid body.
 */
export interface SignedResponseFields {
  sourceId?: string;
  /** Unsigned decimal rendering. */
  value?: string;
  /** Signed packed value: `attestation.payload.value`. */
  valuePacked?: string;
  /** Gateway-assigned timestamp, unix milliseconds. */
  timestamp?: number;
  registryVersion?: number;
  signaturesRequired?: number;
  signersBitmap?: string;
  /** `attestation.signature.signature`. */
  s?: string;
  /** `attestation.signature.commitment`. */
  commitmentAddr?: string;
  fresh?: boolean;
  configHash?: string;
  aggregation?: unknown;
}

const defined = (record: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));

export function signedResponseBody(flat: SignedResponseFields = {}): Record<string, unknown> {
  const f: SignedResponseFields = {
    value: "1",
    valuePacked: "00".repeat(32),
    timestamp: 1_750_000_000_000,
    registryVersion: 1,
    signersBitmap: "00".repeat(31) + "01",
    s: "aa".repeat(32),
    commitmentAddr: "bb".repeat(20),
    fresh: true,
    ...flat,
  };
  return {
    status: "completed",
    data: defined({
      attestation: {
        payload: defined({
          value: f.valuePacked,
          sourceId: f.sourceId,
          registryVersion: f.registryVersion,
          signaturesRequired: f.signaturesRequired,
          timestamp: f.timestamp,
        }),
        signature: defined({
          signature: f.s,
          commitment: f.commitmentAddr,
          signersBitmap: f.signersBitmap,
        }),
      },
      value: f.value,
      fresh: f.fresh,
      configHash: f.configHash,
      aggregation: f.aggregation,
    }),
  };
}
