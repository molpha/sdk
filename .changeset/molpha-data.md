---
"@molpha/sdk": minor
---

Molpha Data client: `@molpha/sdk/data`.

- `MolphaDataClient` for the Molpha Data API (`https://data.molpha.io`): the template catalog, `derive` (template and
  parameters to a canonical source), unsigned `read`, `readSigned` paid with the caller's own session, RequestAuth or
  x402 payment, `batch`, `snapshot` and `verify`.
- Every source the service returns is parsed and re-hashed with this SDK's source code and refused when it does not
  hash to its `sourceId`; a signed envelope's attestation must name that source and value, and its EVM and Starknet
  calldata must equal what this SDK builds (`checkEnvelope`, `DataIntegrityError`).
- `decodePayload` decodes a snapshot's payload with its published layout; `toAttestation` turns a signed envelope into
  the SDK's `Attestation`; `requestAuthDigest` is the RequestAuth hash with base58 addresses.
- Browser-safe: `@noble/hashes` only.
