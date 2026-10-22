---
"@molpha/sdk": minor
---

Sources replace API configs.

**Breaking**

- `apiConfig` is gone. A request carries a `source`: one JSON document with up to four typed inputs
  (`http`, `evm`, `starknet`, `svm`), decoders, a transform over exact decimals, assertions and a
  declared output (`int256`, `uint256`, `bool`, `bytes32`, `string32`, `keccak256`). `sourceId` is the
  keccak256 of its canonical bytes: UTF-8, sorted keys, no whitespace, every number a string.
- Removed: `APIConfig`, `AggregationConfig`, `canonicalizeAPIConfig`, `deriveSourceIdString`,
  `canonicalizeAggregation`, `assertAggregationQuorum`, `AggregationConfigError`, and the `multiply:`
  value transform. Tolerance mode is `source.aggregation` over an `int256` output; there is no
  `numeric` block.
- A value is no longer hashed implicitly when it is longer than 32 bytes. Use a `keccak256` output:
  the response carries the preimage as `valuePreimage` (at most 1024 bytes), and `submitAttestation`
  passes it as `rawValue` when it is at most 256 bytes.
- `Attestation.value` is the signed word rendered by the source's output type, and the gateway no
  longer returns `configHash` or `aggregation`.
- A `{{secret.NAME}}` placeholder is accepted only in an `http` input's URL (after the scheme, host
  and port), a header value or a request body text.

**Added**

- `defineSource`, `jsonPriceSource`, the `sx.*` builders, `parseSource`, `deriveSourceId`,
  `deriveSourceIdHex`, `canonicalize`, `checkChains` and `CHAIN_LIST`, `lintSource`, `formatValue`,
  `verifyPreimage`, `SourceError`.
- Chain inputs: an EVM or Starknet call, storage slot or balance read at a block pinned from the
  round time, and a Solana account or token supply read with a fixed-layout decoder.
