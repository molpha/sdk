---
"@molpha/sdk": minor
---

Browser entry points and the round ID.

- New subpath exports `@molpha/sdk/core`, `@molpha/sdk/evm` and `@molpha/sdk/starknet`. They depend only on
  `@noble/*`, so a browser app can use the attestation message hash, the verify calldata encoders and result
  parsers, and the reason codes without installing `@anchor-lang/core` or `bn.js`. The root entry is unchanged.
- `deriveRoundId` and `deriveRoundIdHex` (`core`): `keccak256(keccak256("MOLPHA_PULL_ROUND_V1") || sourceId ||
  u32be(signaturesRequired) || u32be(registryVersion) || u64be(timestamp ms))`, locked to the gateway's golden vector.
- `bitmapToIndices` moves from `solana/accounts` to `core/selection` (still exported from both), left-pads short hex
  such as the `"4"` the gateway sends, and throws on hex longer than 32 bytes instead of reading its first 32.
