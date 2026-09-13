---
"@molpha/sdk": minor
---

Starknet helpers target the cross-VM parity release of the Molpha Starknet verifier,
`verify(attestation: Attestation, max_age: u64) -> (bool, u8)`.

**Breaking**

- `buildStarknetVerifierArgs(result, { maxAge })` now returns `{ attestation, maxAge }`, where
  `attestation` is the nested Cairo `Attestation { payload, signature }`. `maxAge` is required:
  `0` disables the verifier's freshness check, which a stateless verifier should not do silently.
- `StarknetDataUpdate` is replaced by `StarknetAttestationPayload`, with members in Cairo `Serde`
  order (`value`, `source_id`, `registry_version`, `signatures_required`, `canonical_timestamp`)
  and `signatures_required` narrowed to `u8`. `StarknetVerifierArgs` changes shape accordingly.
- The builder now range-checks every integer against its Cairo type and throws `RangeError`
  instead of producing calldata that would revert during deserialization.

**Added**

- `encodeStarknetVerifyCalldata(args)` — the 13-felt calldata for a raw `starknet_call`, pinned
  against the Cairo verifier using the EVM golden vector.
- `parseStarknetVerifyResult(response)` — decodes `(bool, u8)` from a raw call or an ABI-aware
  client into `{ success, code, reason }`.
- `VERIFY_CODES`, `VerifyCode`, `VerifyCodeName`, `verifyCodeName` — the verifier result codes
  shared across the EVM and Starknet verifier contracts.
