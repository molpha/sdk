---
"@molpha/sdk": minor
---

EVM helpers target the current Molpha EVM verifier (`molpha-core-contracts` #23 and the selection
patch), `verify(Attestation attestation, uint64 maxAge) returns (bool success, uint8 code)`.
`MOLPHA_VERIFIER_ADDRESS` is unchanged and will be updated with the redeploy.

**Breaking**

- `MOLPHA_VERIFIER_ABI` describes `verify(Attestation, uint64) -> (bool, uint8)` in place of
  `verify(DataUpdate, SchnorrSignature) -> bool`.
- `buildEvmVerifierArgs(result, { maxAge })` now returns `{ attestation, maxAge }`, where
  `attestation` is the nested `{ payload, signature }` object with Solidity member names and viem
  primitive types, ready for `readContract` or an ethers `Contract`. `maxAge` is required: `0`
  disables the verifier's freshness check, which a stateless verifier should not do silently.
- `EvmDataUpdateTuple` / `EvmSchnorrSignatureTuple` are replaced by `EvmAttestationPayload` /
  `EvmSchnorrSignature` / `EvmAttestation`. Payload members follow ABI order (`value`, `sourceId`,
  `registryVersion`, `signaturesRequired`, `canonicalTimestamp`), `signaturesRequired` is `uint8`
  and `canonicalTimestamp` is a `bigint`.
- The builder range-checks every integer against its Solidity type and throws `RangeError`
  instead of producing calldata the ABI decoder would revert on.

**Added**

- `encodeEvmVerifyCalldata(args)` — calldata for a raw `eth_call`, pinned against Foundry's
  encoding of the contract's own attestation fixture.
- `parseEvmVerifyResult(returned)` — decodes `(bool, uint8)` from raw return data or a decoded
  viem/ethers tuple into `{ success, code, reason }`.
- `MOLPHA_VERIFIER_ABI` now includes every read-only registry view (`getTotalNodes`,
  `redundancyBuffer`, `getRegistryRoot`, `getRegistryPointer`, `activatesAt`, `retiredAt`,
  `isLatestVersion`, `nodeStatus`, `isNode`) and the `InvalidRegistryVersion` error.
- `u8` encoding helper.

**Fixed**

- `attestationMessageHash` / `attestationMessageHashFromResult` now hash
  `value ‖ sourceId ‖ u32 registryVersion ‖ u8 signaturesRequired ‖ u64 canonicalTimestamp ‖ signersBitmap`,
  the preimage the node signer produces and the EVM, Solana and Starknet verifiers check. The
  previous layout matched no current verifier. `signaturesRequired` outside `0..255` now throws
  instead of wrapping.
